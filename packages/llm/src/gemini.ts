import type { ProposalOutcome, ProposalRequest, Proposer } from '@verifier/shared';
import { deadline, toOutcome } from './answer';

// Gemini's generateContent. The key goes in a header, never the URL (URLs
// end up in logs). The answer schema is enforced with responseSchema, which
// takes OpenAPI-style type names.

export interface GeminiSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  timeoutMs: number;
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    rationale: {
      type: 'STRING',
      description: 'Two or three sentences: what was wrong and how the patch fixes it.',
    },
    code: { type: 'STRING', description: 'The complete patched C file.' },
  },
  required: ['rationale', 'code'],
  propertyOrdering: ['rationale', 'code'],
};

// Finish reasons that mean a filter stopped the answer, rather than the model finishing it.
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

interface GeminiResponse {
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  error?: { message?: string; status?: string; details?: { reason?: string }[] };
}

export class GeminiProposer implements Proposer {
  readonly provider = 'gemini' as const;
  readonly model: string;

  constructor(
    private readonly s: GeminiSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.model = s.model;
  }

  async propose(req: ProposalRequest): Promise<ProposalOutcome> {
    const s = this.s;
    const limit = deadline(req.signal, s.timeoutMs);
    let res: Response;
    let json: GeminiResponse;
    try {
      res = await this.fetchImpl(`${s.baseUrl}/models/${encodeURIComponent(s.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': s.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.stable }, { text: req.attempt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: s.maxTokens,
          },
        }),
        signal: limit.signal,
      });
      json = (await res.json().catch(() => ({}))) as GeminiResponse;
    } catch (e) {
      if (limit.timedOut()) {
        return {
          ok: false,
          kind: 'network',
          error: `Gemini did not answer within ${Math.round(s.timeoutMs / 1000)} s (LLM_TIMEOUT_MS).`,
        };
      }
      if (req.signal?.aborted) return { ok: false, kind: 'aborted', error: 'The repair was cancelled.' };
      return {
        ok: false,
        kind: 'network',
        error: `Could not reach Gemini: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (!res.ok) return httpFailure(s, res.status, json.error);

    if (json.promptFeedback?.blockReason) {
      return {
        ok: false,
        kind: 'refused',
        error: `Gemini blocked the request (${json.promptFeedback.blockReason}).`,
      };
    }
    const candidate = json.candidates?.[0];
    if (!candidate) return { ok: false, kind: 'invalid', error: 'Gemini returned no answer.' };
    const reason = candidate.finishReason ?? '';
    if (BLOCKED.has(reason))
      return { ok: false, kind: 'refused', error: `Gemini stopped the answer (${reason}).` };
    if (reason === 'MAX_TOKENS') {
      return {
        ok: false,
        kind: 'truncated',
        error: 'The answer was cut off at the output limit; raise GEMINI_MAX_TOKENS.',
      };
    }
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    return toOutcome(text, json.modelVersion ?? s.model);
  }
}

function httpFailure(s: GeminiSettings, status: number, err: GeminiResponse['error']): ProposalOutcome {
  const why = err?.message ? `: ${err.message}` : '';
  const badKey = err?.details?.some((d) => d.reason === 'API_KEY_INVALID');
  if (status === 401 || status === 403 || badKey) {
    return { ok: false, kind: 'auth', error: `Gemini rejected the credentials; check GEMINI_API_KEY${why}` };
  }
  if (status === 404) {
    return {
      ok: false,
      kind: 'config',
      error: `Gemini does not know the model ${s.model}; check GEMINI_MODEL${why}`,
    };
  }
  if (status === 429)
    return { ok: false, kind: 'rate-limit', error: `Gemini's rate limit was reached${why}` };
  return { ok: false, kind: 'api', error: `Gemini returned HTTP ${status}${why}` };
}
