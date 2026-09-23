import type { ProposalOutcome } from '@verifier/shared';

// The answer every provider is asked for: the complete patched file and a
// short rationale. Providers that support it enforce the schema; the parser
// still checks the shape, and for servers that cannot enforce it, it also
// accepts JSON inside a fence or a fenced C block.

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    rationale: {
      type: 'string',
      description: 'Two or three sentences: what was wrong and how the patch fixes it.',
    },
    code: { type: 'string', description: 'The complete patched C file.' },
  },
  required: ['rationale', 'code'],
  additionalProperties: false,
} as const;

/** For servers without schema enforcement: the format, spelled out. */
export const FORMAT_INSTRUCTION =
  'Reply with a single JSON object and nothing else: {"rationale": "...", "code": "..."}, where "code" is the complete patched file.';

export type ParsedAnswer = { ok: true; code: string; rationale: string } | { ok: false; error: string };

function fromObject(value: unknown): ParsedAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const { code, rationale } = value as Record<string, unknown>;
  if (typeof code !== 'string') return null;
  return { ok: true, code, rationale: typeof rationale === 'string' ? rationale.trim() : '' };
}

function tryJson(text: string): ParsedAnswer | null {
  try {
    return fromObject(JSON.parse(text));
  } catch {
    return null;
  }
}

export function parseAnswer(text: string): ParsedAnswer {
  const t = text.trim();
  if (!t) return { ok: false, error: 'The answer was empty.' };
  const direct = tryJson(t);
  if (direct) return direct;
  const fencedJson = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(t);
  const inFence = fencedJson ? tryJson(fencedJson[1]!) : null;
  if (inFence) return inFence;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  const embedded = start >= 0 && end > start ? tryJson(t.slice(start, end + 1)) : null;
  if (embedded) return embedded;

  // A fenced C block: the longest one is the file.
  const blocks = [...t.matchAll(/```(?:c|h|cpp|C)?[ \t]*\n([\s\S]*?)\n```/g)];
  if (blocks.length) {
    const longest = blocks.reduce((a, b) => (b[1]!.length > a[1]!.length ? b : a));
    const rationale = t.replace(longest[0], '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    return { ok: true, code: `${longest[1]!}\n`, rationale };
  }
  return { ok: false, error: 'The answer contained neither the expected JSON nor a code block.' };
}

/** Parsed text as a proposal outcome. */
export function toOutcome(text: string, model: string): ProposalOutcome {
  const a = parseAnswer(text);
  return a.ok
    ? { ok: true, code: a.code, rationale: a.rationale, model }
    : { ok: false, kind: 'invalid', error: a.error };
}

/**
 * A signal that aborts on the caller's signal or after `ms`, and says which.
 * Timeouts are reported as network failures, cancellation as 'aborted'.
 */
export function deadline(signal: AbortSignal | undefined, ms: number) {
  const timer = AbortSignal.timeout(ms);
  return {
    signal: signal ? AbortSignal.any([signal, timer]) : timer,
    timedOut: () => timer.aborted && !signal?.aborted,
  };
}
