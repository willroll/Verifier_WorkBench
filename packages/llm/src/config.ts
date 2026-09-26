import { PROVIDER_IDS, type ProviderId } from '@verifier/shared';

// Model providers, configured from the environment. The variable names are
// the design handoff's (hosted-example/README.md), so an existing setup keeps
// working; the Claude default moves to the current model. Settings added since
// carry REPAIR in their names: Claude Code sets CLAUDE_EFFORT and similar for
// itself, and a server started from its terminal would inherit them.

type Env = Record<string, string | undefined>;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface LlmConfig {
  defaultProvider: ProviderId;
  /** Longest a single proposal may take, including the model's thinking. */
  timeoutMs: number;
  anthropic: {
    /** Some credential the SDK resolves: an API key, an auth token, a profile or workload identity. */
    configured: boolean;
    model: string;
    maxTokens: number;
    effort: Effort;
    /** Server-side refusal fallbacks ("default" routing). */
    fallbacks: boolean;
  };
  openai: { apiKey?: string; model: string; baseUrl: string; maxTokens: number };
  gemini: { apiKey?: string; model: string; baseUrl: string; maxTokens: number };
  /** Any server that speaks OpenAI's /chat/completions (vLLM, Ollama, LM Studio, llama.cpp). */
  custom: { baseUrl?: string; model: string; apiKey?: string; maxTokens?: number };
}

const set = (env: Env, name: string) => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = set(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = set(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw as T;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function loadLlmConfig(env: Env = process.env): LlmConfig {
  const customMax = set(env, 'LLM_MAX_TOKENS');
  return {
    defaultProvider: oneOf(env, 'LLM_PROVIDER', PROVIDER_IDS, 'anthropic'),
    timeoutMs: int(env, 'LLM_TIMEOUT_MS', 300_000, 10_000, 3_600_000),
    anthropic: {
      configured: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_PROFILE',
        'ANTHROPIC_FEDERATION_RULE_ID',
      ].some((n) => set(env, n) !== undefined),
      model: set(env, 'CLAUDE_MODEL') ?? 'claude-opus-5',
      maxTokens: int(env, 'CLAUDE_REPAIR_MAX_TOKENS', 64_000, 1_024, 128_000),
      effort: oneOf(env, 'CLAUDE_REPAIR_EFFORT', EFFORTS, 'high'),
      fallbacks: oneOf(env, 'CLAUDE_REPAIR_FALLBACKS', ['default', 'off'] as const, 'default') === 'default',
    },
    openai: {
      ...(set(env, 'OPENAI_API_KEY') ? { apiKey: set(env, 'OPENAI_API_KEY')! } : {}),
      model: set(env, 'OPENAI_MODEL') ?? 'gpt-4o',
      baseUrl: trimSlash(set(env, 'OPENAI_BASE_URL') ?? 'https://api.openai.com/v1'),
      maxTokens: int(env, 'OPENAI_MAX_TOKENS', 32_000, 1_024, 1_000_000),
    },
    gemini: {
      ...(set(env, 'GEMINI_API_KEY') ? { apiKey: set(env, 'GEMINI_API_KEY')! } : {}),
      model: set(env, 'GEMINI_MODEL') ?? 'gemini-2.5-flash',
      baseUrl: trimSlash(set(env, 'GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta'),
      maxTokens: int(env, 'GEMINI_MAX_TOKENS', 32_000, 1_024, 1_000_000),
    },
    custom: {
      ...(set(env, 'LLM_BASE_URL') ? { baseUrl: trimSlash(set(env, 'LLM_BASE_URL')!) } : {}),
      model: set(env, 'LLM_MODEL') ?? 'local-model',
      ...(set(env, 'LLM_API_KEY') ? { apiKey: set(env, 'LLM_API_KEY')! } : {}),
      ...(customMax ? { maxTokens: int(env, 'LLM_MAX_TOKENS', 0, 256, 1_000_000) } : {}),
    },
  };
}
