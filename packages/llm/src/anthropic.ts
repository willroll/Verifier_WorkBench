import Anthropic from '@anthropic-ai/sdk';
import type { ProposalOutcome, ProposalRequest, Proposer } from '@verifier/shared';
import { ANSWER_SCHEMA, deadline, toOutcome } from './answer';
import type { LlmConfig } from './config';

// Claude through the official SDK. One streamed request per attempt (large
// max_tokens needs streaming), with the answer's JSON schema enforced by
// structured outputs, the original source marked cacheable (identical across
// attempts), and server-side refusal fallbacks on by default: a request a
// safety classifier declines is re-run on the model Anthropic recommends for
// that category instead of failing the attempt.

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicProposer implements Proposer {
  readonly provider = 'anthropic' as const;
  readonly model: string;

  constructor(
    private readonly settings: LlmConfig['anthropic'],
    private readonly timeoutMs: number,
    private readonly client: Anthropic = new Anthropic({ maxRetries: 2 }),
  ) {
    this.model = settings.model;
  }

  async propose(req: ProposalRequest): Promise<ProposalOutcome> {
    const { model, maxTokens, effort, fallbacks } = this.settings;
    const limit = deadline(req.signal, this.timeoutMs);
    try {
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          thinking: { type: 'adaptive' },
          output_config: { effort, format: { type: 'json_schema', schema: { ...ANSWER_SCHEMA } } },
          system: req.system,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: req.stable, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: req.attempt },
              ],
            },
          ],
          ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        { signal: limit.signal },
      );
      const message = await stream.finalMessage();

      // Check why it stopped before reading anything.
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        return {
          ok: false,
          kind: 'refused',
          error: `Claude declined to answer${category ? ` (${category})` : ''}.`,
        };
      }
      if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
        return {
          ok: false,
          kind: 'truncated',
          error: `The answer was cut off at ${maxTokens} output tokens; raise CLAUDE_REPAIR_MAX_TOKENS.`,
        };
      }
      // After a fallback mid-answer, the declined model's partial output precedes
      // the last fallback marker; only what follows it is the answer.
      const lastSwitch = message.content.findLastIndex((b) => b.type === 'fallback');
      const text = message.content
        .slice(lastSwitch + 1)
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('');
      return toOutcome(text, message.model);
    } catch (e) {
      return failure(e, model, limit.timedOut(), this.timeoutMs);
    }
  }
}

function failure(e: unknown, model: string, timedOut: boolean, timeoutMs: number): ProposalOutcome {
  if (timedOut) {
    return {
      ok: false,
      kind: 'network',
      error: `Claude did not answer within ${Math.round(timeoutMs / 1000)} s (LLM_TIMEOUT_MS).`,
    };
  }
  if (e instanceof Anthropic.APIUserAbortError)
    return { ok: false, kind: 'aborted', error: 'The repair was cancelled.' };
  if (e instanceof Anthropic.AuthenticationError) {
    return { ok: false, kind: 'auth', error: 'Anthropic rejected the credentials; check ANTHROPIC_API_KEY.' };
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return { ok: false, kind: 'auth', error: `This API key may not use ${model}: ${apiMessage(e)}` };
  }
  if (e instanceof Anthropic.NotFoundError) {
    return {
      ok: false,
      kind: 'config',
      error: `Anthropic does not know the model ${model}; check CLAUDE_MODEL.`,
    };
  }
  if (e instanceof Anthropic.RateLimitError) {
    return { ok: false, kind: 'rate-limit', error: `Anthropic's rate limit was reached: ${apiMessage(e)}` };
  }
  if (e instanceof Anthropic.BadRequestError) {
    return { ok: false, kind: 'api', error: `Anthropic rejected the request: ${apiMessage(e)}` };
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return { ok: false, kind: 'network', error: `Could not reach Anthropic: ${e.message}` };
  }
  if (e instanceof Anthropic.APIError) {
    return {
      ok: false,
      kind: 'api',
      error: `Anthropic API error${e.status ? ` ${e.status}` : ''}: ${apiMessage(e)}`,
    };
  }
  // The SDK found no credentials at all, or something else failed before a request was made.
  return { ok: false, kind: 'config', error: e instanceof Error ? e.message : String(e) };
}

/** The API's own error message when the response body carried one, else the SDK's summary. */
function apiMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const body = (e as { error?: unknown }).error;
  const inner =
    body && typeof body === 'object' ? (body as { error?: { message?: unknown } }).error : undefined;
  return typeof inner?.message === 'string' ? inner.message : e.message.replace(/^\d{3}\s+/, '');
}
