import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { ProposalRequest } from '@verifier/shared';
import {
  AnthropicProposer,
  FORMAT_INSTRUCTION,
  GeminiProposer,
  OpenAiProposer,
  createProposer,
  describeProviders,
  loadLlmConfig,
  parseAnswer,
  type OpenAiSettings,
} from '@verifier/llm';

const ANSWER = { rationale: 'Widen the sum.', code: 'int f(void) { return 0; }\n' };
const REQUEST: ProposalRequest = { system: 'SYSTEM', stable: 'STABLE', attempt: 'ATTEMPT' };

describe('answer parsing', () => {
  it('reads the JSON answer, bare or wrapped', () => {
    expect(parseAnswer(JSON.stringify(ANSWER))).toEqual({ ok: true, ...ANSWER, rationale: 'Widen the sum.' });
    expect(parseAnswer('```json\n' + JSON.stringify(ANSWER) + '\n```')).toMatchObject({
      ok: true,
      code: ANSWER.code,
    });
    expect(parseAnswer(`Here it is: ${JSON.stringify(ANSWER)} Done.`)).toMatchObject({
      ok: true,
      code: ANSWER.code,
    });
  });

  it('falls back to the longest fenced C block', () => {
    const text = 'The bug is the bound.\n```c\nint a;\n```\nFull file:\n```c\nint a;\nint b;\n```\n';
    const a = parseAnswer(text);
    expect(a).toMatchObject({ ok: true, code: 'int a;\nint b;\n' });
    expect(a.ok && a.rationale).toMatch(/^The bug is the bound\./);
  });

  it('reports answers without code', () => {
    expect(parseAnswer('   ')).toEqual({ ok: false, error: 'The answer was empty.' });
    expect(parseAnswer('I cannot help with that.').ok).toBe(false);
    expect(parseAnswer('{"rationale": "x", "code": 42}').ok).toBe(false);
  });
});

describe('configuration', () => {
  it('defaults to Claude on the current model', () => {
    const c = loadLlmConfig({});
    expect(c.defaultProvider).toBe('anthropic');
    expect(c.anthropic).toEqual({
      configured: false,
      model: 'claude-opus-5',
      maxTokens: 64_000,
      effort: 'high',
      fallbacks: true,
    });
    expect(c.timeoutMs).toBe(300_000);
    expect(c.custom).toEqual({ model: 'local-model' });
  });

  it('reads the handoff’s variables', () => {
    const c = loadLlmConfig({
      LLM_PROVIDER: 'custom',
      ANTHROPIC_AUTH_TOKEN: 't',
      CLAUDE_MODEL: 'claude-opus-4-8',
      CLAUDE_REPAIR_EFFORT: 'xhigh',
      CLAUDE_REPAIR_FALLBACKS: 'off',
      OPENAI_BASE_URL: 'https://proxy.example/v1/',
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_MAX_TOKENS: '4096',
    });
    expect(c.defaultProvider).toBe('custom');
    expect(c.anthropic).toMatchObject({
      configured: true,
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      fallbacks: false,
    });
    expect(c.openai.baseUrl).toBe('https://proxy.example/v1');
    expect(c.custom).toEqual({ baseUrl: 'http://localhost:11434/v1', model: 'local-model', maxTokens: 4096 });
  });

  it('rejects invalid values instead of guessing', () => {
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'mistral' })).toThrow(/LLM_PROVIDER must be one of/);
    expect(() => loadLlmConfig({ CLAUDE_REPAIR_EFFORT: 'extreme' })).toThrow(/CLAUDE_REPAIR_EFFORT/);
    expect(() => loadLlmConfig({ CLAUDE_REPAIR_MAX_TOKENS: '500' })).toThrow(/CLAUDE_REPAIR_MAX_TOKENS/);
  });
});

describe('provider registry', () => {
  it('lists every provider with what it still needs', () => {
    const r = describeProviders(loadLlmConfig({ ANTHROPIC_API_KEY: 'k', GEMINI_MODEL: 'gemini-x' }));
    expect(r.default).toBe('anthropic');
    expect(r.providers).toEqual([
      { id: 'anthropic', label: 'Claude', configured: true, model: 'claude-opus-5' },
      { id: 'openai', label: 'ChatGPT', configured: false, model: 'gpt-4o', missing: 'OPENAI_API_KEY' },
      { id: 'gemini', label: 'Gemini', configured: false, model: 'gemini-x', missing: 'GEMINI_API_KEY' },
      {
        id: 'custom',
        label: 'Self-hosted',
        configured: false,
        model: 'local-model',
        missing: 'LLM_BASE_URL',
      },
    ]);
  });

  it('answers with a configuration error for an unconfigured provider', async () => {
    const p = createProposer('openai', loadLlmConfig({}));
    expect(p.provider).toBe('openai');
    expect(await p.propose(REQUEST)).toEqual({
      ok: false,
      kind: 'config',
      error: 'ChatGPT is not configured on this server: set OPENAI_API_KEY.',
    });
  });
});

// ---- Claude -------------------------------------------------------------------

type Reply = (params: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<unknown>;

function fakeAnthropic(reply: Reply) {
  const calls: { params: Record<string, unknown>; options: { signal?: AbortSignal } }[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>, options: { signal?: AbortSignal }) => {
          calls.push({ params, options });
          return { finalMessage: () => reply(params, options) };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const message = (over: Record<string, unknown>) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: JSON.stringify(ANSWER) }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  ...over,
});

const claudeSettings = loadLlmConfig({ ANTHROPIC_API_KEY: 'k' }).anthropic;
const claude = (reply: Reply, over: Partial<typeof claudeSettings> = {}, timeoutMs = 60_000) => {
  const fake = fakeAnthropic(reply);
  return {
    proposer: new AnthropicProposer({ ...claudeSettings, ...over }, timeoutMs, fake.client),
    calls: fake.calls,
  };
};

describe('Claude', () => {
  it('streams one request with the schema, caching and default fallbacks', async () => {
    const { proposer, calls } = claude(() => Promise.resolve(message({})));
    const controller = new AbortController();
    expect(await proposer.propose({ ...REQUEST, signal: controller.signal })).toEqual({
      ok: true,
      ...ANSWER,
      model: 'claude-opus-5',
    });
    const { params, options } = calls[0]!;
    expect(params).toEqual({
      model: 'claude-opus-5',
      max_tokens: 64_000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: {
          type: 'json_schema',
          schema: expect.objectContaining({ required: ['rationale', 'code'], additionalProperties: false }),
        },
      },
      system: 'SYSTEM',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'ATTEMPT' },
          ],
        },
      ],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    controller.abort();
    expect(options.signal?.aborted).toBe(true); // the caller's cancellation reaches the request
  });

  it('can run without fallbacks', async () => {
    const { proposer, calls } = claude(() => Promise.resolve(message({})), { fallbacks: false });
    await proposer.propose(REQUEST);
    expect(calls[0]!.params).not.toHaveProperty('fallbacks');
    expect(calls[0]!.params).not.toHaveProperty('betas');
  });

  it('checks the stop reason before reading the answer', async () => {
    const refused = claude(() =>
      Promise.resolve(
        message({
          content: [],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber' },
        }),
      ),
    );
    expect(await refused.proposer.propose(REQUEST)).toEqual({
      ok: false,
      kind: 'refused',
      error: 'Claude declined to answer (cyber).',
    });
    const cut = claude(() => Promise.resolve(message({ stop_reason: 'max_tokens' })));
    expect(await cut.proposer.propose(REQUEST)).toMatchObject({ ok: false, kind: 'truncated' });
  });

  it('reads only what follows a fallback, and reports the model that answered', async () => {
    const { proposer } = claude(() =>
      Promise.resolve(
        message({
          model: 'claude-opus-4-8',
          content: [
            { type: 'text', text: '{"rationale": "partial' },
            { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
            { type: 'text', text: JSON.stringify(ANSWER) },
          ],
        }),
      ),
    );
    expect(await proposer.propose(REQUEST)).toEqual({ ok: true, ...ANSWER, model: 'claude-opus-4-8' });
  });

  it('maps SDK errors to outcomes the loop can act on', async () => {
    const apiError = (status: number, msg: string) =>
      Anthropic.APIError.generate(
        status,
        { type: 'error', error: { type: 'x', message: msg } },
        undefined,
        new Headers(),
      );
    const outcome = async (err: Error) => await claude(() => Promise.reject(err)).proposer.propose(REQUEST);
    expect(await outcome(apiError(401, 'invalid x-api-key'))).toMatchObject({ kind: 'auth' });
    expect(await outcome(apiError(403, 'no access'))).toMatchObject({
      kind: 'auth',
      error: expect.stringContaining('no access'),
    });
    expect(await outcome(apiError(404, 'model not found'))).toMatchObject({
      kind: 'config',
      error: expect.stringContaining('CLAUDE_MODEL'),
    });
    expect(await outcome(apiError(429, 'slow down'))).toMatchObject({ kind: 'rate-limit' });
    expect(await outcome(apiError(400, 'bad field'))).toEqual({
      ok: false,
      kind: 'api',
      error: 'Anthropic rejected the request: bad field',
    });
    expect(await outcome(apiError(529, 'Overloaded'))).toMatchObject({
      kind: 'api',
      error: expect.stringContaining('529'),
    });
    expect(await outcome(new Anthropic.APIConnectionError({ message: 'Connection error.' }))).toMatchObject({
      kind: 'network',
    });
    expect(await outcome(new Anthropic.APIUserAbortError())).toMatchObject({ kind: 'aborted' });
    expect(await outcome(new Error('Could not resolve authentication method.'))).toMatchObject({
      kind: 'config',
    });
  });

  it('gives up after LLM_TIMEOUT_MS', async () => {
    const { proposer } = claude(
      (_params, { signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
        }),
      {},
      20,
    );
    expect(await proposer.propose(REQUEST)).toMatchObject({
      ok: false,
      kind: 'network',
      error: expect.stringContaining('did not answer'),
    });
  });
});

// ---- OpenAI-compatible and Gemini -----------------------------------------------

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  // The proposers call fetch(url: string, { body: string }).
  const impl = (async (input: string, init?: RequestInit) => {
    const call = {
      url: input,
      init: init ?? {},
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const chat = (content: string | null, extra: Record<string, unknown> = {}) =>
  json({ model: 'gpt-served', choices: [{ finish_reason: 'stop', message: { content, ...extra } }] });

const openAi = (
  respond: (call: Call) => Response | Promise<Response>,
  over: Partial<OpenAiSettings> = {},
) => {
  const f = fakeFetch(respond);
  const settings: OpenAiSettings = {
    provider: 'openai',
    label: 'ChatGPT',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    maxTokens: 32_000,
    strictSchema: true,
    timeoutMs: 60_000,
    ...over,
  };
  return { proposer: new OpenAiProposer(settings, f.impl), calls: f.calls };
};

describe('OpenAI-compatible', () => {
  it('sends the schema to OpenAI and reads the served model', async () => {
    const { proposer, calls } = openAi(() => chat(JSON.stringify(ANSWER)));
    expect(await proposer.propose(REQUEST)).toEqual({ ok: true, ...ANSWER, model: 'gpt-served' });
    const [call] = calls;
    expect(call!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(new Headers(call!.init.headers).get('authorization')).toBe('Bearer sk-test');
    expect(call!.body).toMatchObject({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'STABLE' },
        { role: 'user', content: 'ATTEMPT' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'patch', strict: true } },
      max_completion_tokens: 32_000,
    });
  });

  it('asks a self-hosted server for the format in words', async () => {
    const { proposer, calls } = openAi(() => chat('```c\nint x;\n```'), {
      provider: 'custom',
      label: 'Self-hosted',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama',
      strictSchema: false,
      apiKey: undefined,
      maxTokens: undefined,
    });
    expect(await proposer.propose(REQUEST)).toMatchObject({ ok: true, code: 'int x;\n' });
    const body = calls[0]!.body;
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('max_tokens');
    expect((body.messages as { content: string }[])[0]!.content).toBe(`SYSTEM\n\n${FORMAT_INSTRUCTION}`);
    expect(new Headers(calls[0]!.init.headers).has('authorization')).toBe(false);
  });

  it('maps stops, refusals and HTTP errors', async () => {
    const outcome = async (res: () => Response) => openAi(res).proposer.propose(REQUEST);
    expect(
      await outcome(() => json({ choices: [{ finish_reason: 'length', message: { content: '{"co' } }] })),
    ).toMatchObject({
      kind: 'truncated',
      error: expect.stringContaining('OPENAI_MAX_TOKENS'),
    });
    expect(await outcome(() => chat(null, { refusal: 'I can’t help with that.' }))).toMatchObject({
      kind: 'refused',
    });
    expect(
      await outcome(() => json({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] })),
    ).toMatchObject({
      kind: 'refused',
    });
    expect(await outcome(() => json({ error: { message: 'Incorrect API key' } }, 401))).toMatchObject({
      kind: 'auth',
    });
    expect(await outcome(() => json({ error: { message: 'no such model' } }, 404))).toMatchObject({
      kind: 'config',
      error: expect.stringContaining('OPENAI_MODEL'),
    });
    expect(await outcome(() => json({}, 429))).toMatchObject({ kind: 'rate-limit' });
    expect(await outcome(() => json({ error: { message: 'boom' } }, 500))).toEqual({
      ok: false,
      kind: 'api',
      error: 'ChatGPT returned HTTP 500: boom',
    });
  });

  it('tells network failures from cancellation', async () => {
    const down = openAi(() => Promise.reject(new TypeError('fetch failed')));
    expect(await down.proposer.propose(REQUEST)).toMatchObject({
      kind: 'network',
      error: expect.stringContaining('fetch failed'),
    });
    const controller = new AbortController();
    controller.abort();
    const cancelled = openAi(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    expect(await cancelled.proposer.propose({ ...REQUEST, signal: controller.signal })).toMatchObject({
      kind: 'aborted',
    });
  });
});

describe('Gemini', () => {
  const gemini = (respond: (call: Call) => Response) => {
    const f = fakeFetch(respond);
    const p = new GeminiProposer(
      {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.5-flash',
        apiKey: 'g-key',
        maxTokens: 32_000,
        timeoutMs: 60_000,
      },
      f.impl,
    );
    return { proposer: p, calls: f.calls };
  };
  const candidate = (parts: { text: string; thought?: boolean }[], finishReason = 'STOP') =>
    json({ modelVersion: 'gemini-2.5-flash-001', candidates: [{ finishReason, content: { parts } }] });

  it('keeps the key out of the URL and enforces the schema', async () => {
    const { proposer, calls } = gemini(() =>
      candidate([{ text: 'thinking…', thought: true }, { text: JSON.stringify(ANSWER) }]),
    );
    expect(await proposer.propose(REQUEST)).toEqual({ ok: true, ...ANSWER, model: 'gemini-2.5-flash-001' });
    const [call] = calls;
    expect(call!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(call!.url).not.toContain('g-key');
    expect(new Headers(call!.init.headers).get('x-goog-api-key')).toBe('g-key');
    expect(call!.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'SYSTEM' }] },
      contents: [{ role: 'user', parts: [{ text: 'STABLE' }, { text: 'ATTEMPT' }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 32_000 },
    });
  });

  it('maps stops, blocks and HTTP errors', async () => {
    const outcome = async (res: () => Response) => gemini(res).proposer.propose(REQUEST);
    expect(await outcome(() => candidate([{ text: '{"co' }], 'MAX_TOKENS'))).toMatchObject({
      kind: 'truncated',
    });
    expect(await outcome(() => candidate([], 'SAFETY'))).toMatchObject({ kind: 'refused' });
    expect(await outcome(() => json({ promptFeedback: { blockReason: 'OTHER' } }))).toMatchObject({
      kind: 'refused',
    });
    expect(
      await outcome(() =>
        json(
          {
            error: {
              message: 'API key not valid.',
              status: 'INVALID_ARGUMENT',
              details: [{ reason: 'API_KEY_INVALID' }],
            },
          },
          400,
        ),
      ),
    ).toMatchObject({ kind: 'auth' });
    expect(await outcome(() => json({ error: { message: 'not found' } }, 404))).toMatchObject({
      kind: 'config',
      error: expect.stringContaining('GEMINI_MODEL'),
    });
    expect(await outcome(() => json({}, 429))).toMatchObject({ kind: 'rate-limit' });
  });
});
