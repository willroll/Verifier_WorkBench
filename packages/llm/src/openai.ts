import type { ProposalOutcome, ProposalRequest, Proposer, ProviderId } from '@verifier/shared';
import { ANSWER_SCHEMA, FORMAT_INSTRUCTION, deadline, toOutcome } from './answer';

// OpenAI's /chat/completions, which many self-hosted servers also speak
// (vLLM, Ollama, LM Studio, llama.cpp). OpenAI enforces the answer schema;
// a self-hosted server gets the format as an instruction instead, since not
// all of them accept a JSON schema.

export interface OpenAiSettings {
  provider: Extract<ProviderId, 'openai' | 'custom'>;
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  /** Enforce the answer schema with response_format (OpenAI does; self-hosted servers may not). */
  strictSchema: boolean;
  timeoutMs: number;
}

interface ChatResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  error?: { message?: string };
}

export class OpenAiProposer implements Proposer {
  readonly provider: OpenAiSettings['provider'];
  readonly model: string;

  constructor(
    private readonly s: OpenAiSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.provider = s.provider;
    this.model = s.model;
  }

  async propose(req: ProposalRequest): Promise<ProposalOutcome> {
    const s = this.s;
    const limit = deadline(req.signal, s.timeoutMs);
    const body = {
      model: s.model,
      messages: [
        { role: 'system', content: s.strictSchema ? req.system : `${req.system}\n\n${FORMAT_INSTRUCTION}` },
        // The stable part first and on its own, so prefix caching can reuse it.
        { role: 'user', content: req.stable },
        { role: 'user', content: req.attempt },
      ],
      ...(s.strictSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'patch', strict: true, schema: ANSWER_SCHEMA },
            },
          }
        : {}),
      // OpenAI counts reasoning in max_completion_tokens; other servers know max_tokens.
      ...(s.maxTokens
        ? s.provider === 'openai'
          ? { max_completion_tokens: s.maxTokens }
          : { max_tokens: s.maxTokens }
        : {}),
    };
    let res: Response;
    let json: ChatResponse;
    try {
      res = await this.fetchImpl(`${s.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: limit.signal,
      });
      json = (await res.json().catch(() => ({}))) as ChatResponse;
    } catch (e) {
      if (limit.timedOut()) {
        return {
          ok: false,
          kind: 'network',
          error: `${s.label} did not answer within ${Math.round(s.timeoutMs / 1000)} s (LLM_TIMEOUT_MS).`,
        };
      }
      if (req.signal?.aborted) return { ok: false, kind: 'aborted', error: 'The repair was cancelled.' };
      return {
        ok: false,
        kind: 'network',
        error: `Could not reach ${s.label} at ${s.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!res.ok) return httpFailure(s, res.status, json.error?.message);

    const choice = json.choices?.[0];
    if (!choice) return { ok: false, kind: 'invalid', error: `${s.label} returned no answer.` };
    if (choice.message?.refusal) {
      return { ok: false, kind: 'refused', error: `${s.label} declined: ${choice.message.refusal}` };
    }
    if (choice.finish_reason === 'content_filter') {
      return { ok: false, kind: 'refused', error: `${s.label}'s content filter stopped the answer.` };
    }
    if (choice.finish_reason === 'length') {
      const knob = s.provider === 'openai' ? 'OPENAI_MAX_TOKENS' : 'LLM_MAX_TOKENS';
      return {
        ok: false,
        kind: 'truncated',
        error: `The answer was cut off at the output limit; raise ${knob}.`,
      };
    }
    return toOutcome(choice.message?.content ?? '', json.model ?? s.model);
  }
}

function httpFailure(s: OpenAiSettings, status: number, message: string | undefined): ProposalOutcome {
  const why = message ? `: ${message}` : '';
  const keyVar = s.provider === 'openai' ? 'OPENAI_API_KEY' : 'LLM_API_KEY';
  const modelVar = s.provider === 'openai' ? 'OPENAI_MODEL' : 'LLM_MODEL';
  if (status === 401 || status === 403) {
    return {
      ok: false,
      kind: 'auth',
      error: `${s.label} rejected the credentials (${status}); check ${keyVar}${why}`,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      kind: 'config',
      error: `${s.label} does not know the model ${s.model}; check ${modelVar}${why}`,
    };
  }
  if (status === 429)
    return { ok: false, kind: 'rate-limit', error: `${s.label}'s rate limit was reached${why}` };
  return { ok: false, kind: 'api', error: `${s.label} returned HTTP ${status}${why}` };
}
