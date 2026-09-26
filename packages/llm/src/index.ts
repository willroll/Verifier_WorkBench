import type Anthropic from '@anthropic-ai/sdk';
import {
  PROVIDER_IDS,
  type ProposalOutcome,
  type Proposer,
  type ProviderId,
  type ProvidersResponse,
} from '@verifier/shared';
import { AnthropicProposer } from './anthropic';
import type { LlmConfig } from './config';
import { GeminiProposer } from './gemini';
import { OpenAiProposer } from './openai';

export { EFFORTS, loadLlmConfig, type Effort, type LlmConfig } from './config';
export { ANSWER_SCHEMA, FORMAT_INSTRUCTION, parseAnswer, type ParsedAnswer } from './answer';
export { AnthropicProposer } from './anthropic';
export { GeminiProposer, type GeminiSettings } from './gemini';
export { OpenAiProposer, type OpenAiSettings } from './openai';

// The prototype UI's names for the providers.
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  gemini: 'Gemini',
  custom: 'Self-hosted',
};

/** The environment variable a provider still needs, if any. */
function missing(id: ProviderId, c: LlmConfig): string | undefined {
  switch (id) {
    case 'anthropic':
      return c.anthropic.configured ? undefined : 'ANTHROPIC_API_KEY';
    case 'openai':
      return c.openai.apiKey ? undefined : 'OPENAI_API_KEY';
    case 'gemini':
      return c.gemini.apiKey ? undefined : 'GEMINI_API_KEY';
    case 'custom':
      return c.custom.baseUrl ? undefined : 'LLM_BASE_URL';
  }
}

const modelOf = (id: ProviderId, c: LlmConfig) => c[id].model;

export function describeProviders(c: LlmConfig): ProvidersResponse {
  return {
    default: c.defaultProvider,
    providers: PROVIDER_IDS.map((id) => {
      const need = missing(id, c);
      return {
        id,
        label: PROVIDER_LABELS[id],
        configured: need === undefined,
        model: modelOf(id, c),
        ...(need ? { missing: need } : {}),
      };
    }),
  };
}

export interface ProposerDeps {
  fetch?: typeof fetch;
  /** A preconfigured Anthropic client (tests pass a fake). */
  anthropic?: Anthropic;
}

/**
 * The proposer for a provider. One that is not configured still returns a
 * proposer, whose answers are a 'config' failure naming the missing variable:
 * the repair loop reports it after verifying the original, so code that is
 * already proved never needs a key.
 */
export function createProposer(id: ProviderId, c: LlmConfig, deps: ProposerDeps = {}): Proposer {
  const need = missing(id, c);
  if (need) {
    const error = `${PROVIDER_LABELS[id]} is not configured on this server: set ${need}.`;
    return {
      provider: id,
      model: modelOf(id, c),
      propose: (): Promise<ProposalOutcome> => Promise.resolve({ ok: false, kind: 'config', error }),
    };
  }
  const fetchImpl = deps.fetch ?? fetch;
  switch (id) {
    case 'anthropic':
      return deps.anthropic
        ? new AnthropicProposer(c.anthropic, c.timeoutMs, deps.anthropic)
        : new AnthropicProposer(c.anthropic, c.timeoutMs);
    case 'openai':
      return new OpenAiProposer(
        {
          provider: 'openai',
          label: PROVIDER_LABELS.openai,
          baseUrl: c.openai.baseUrl,
          model: c.openai.model,
          apiKey: c.openai.apiKey!,
          maxTokens: c.openai.maxTokens,
          strictSchema: true,
          timeoutMs: c.timeoutMs,
        },
        fetchImpl,
      );
    case 'custom':
      return new OpenAiProposer(
        {
          provider: 'custom',
          label: PROVIDER_LABELS.custom,
          baseUrl: c.custom.baseUrl!,
          model: c.custom.model,
          ...(c.custom.apiKey ? { apiKey: c.custom.apiKey } : {}),
          ...(c.custom.maxTokens ? { maxTokens: c.custom.maxTokens } : {}),
          strictSchema: false,
          timeoutMs: c.timeoutMs,
        },
        fetchImpl,
      );
    case 'gemini':
      return new GeminiProposer(
        {
          baseUrl: c.gemini.baseUrl,
          model: c.gemini.model,
          apiKey: c.gemini.apiKey!,
          maxTokens: c.gemini.maxTokens,
          timeoutMs: c.timeoutMs,
        },
        fetchImpl,
      );
  }
}
