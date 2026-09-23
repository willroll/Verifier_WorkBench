import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  Detector,
  EngineError,
  LocalRunner,
  RequestError,
  exportSmtlib,
  loadConfig,
  repair,
  verify,
  type CoreConfig,
  type EngineDetector,
  type Runner,
  type VerifierDeps,
} from '@verifier/core';
import { createProposer, describeProviders, loadLlmConfig, type LlmConfig } from '@verifier/llm';
import {
  CHECK_IDS,
  ENGINE_IDS,
  PROVIDER_IDS,
  SOLVER_IDS,
  type EnginesResponse,
  type Proposer,
  type ProviderId,
  type RepairEvent,
  type RepairRequest,
  type RepairResult,
  type SmtlibRequest,
  type VerifyRequest,
} from '@verifier/shared';
import pkg from '../package.json' with { type: 'json' };
import type { ServerConfig } from './config';
import { loadUi } from './ui';

export interface AppOptions {
  server: ServerConfig;
  core?: CoreConfig;
  llm?: LlmConfig;
  runner?: Runner;
  detector?: EngineDetector;
  /** The model a repair uses (tests pass a scripted one). */
  proposer?: (provider: ProviderId) => Proposer;
  logger?: boolean;
}

const identifier = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 256 } as const;
const sourceFields = {
  code: { type: 'string' },
  fileName: { type: 'string', maxLength: 128 },
  engine: { type: 'string', enum: [...ENGINE_IDS] },
  solver: { type: 'string', enum: [...SOLVER_IDS] },
  unwind: { type: 'integer', minimum: 1 },
  checks: {
    type: 'array',
    items: { type: 'string', enum: [...CHECK_IDS] },
    uniqueItems: true,
    maxItems: CHECK_IDS.length,
  },
} as const;

const verifySchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: {
    ...sourceFields,
    functions: { type: 'array', items: identifier, uniqueItems: true, maxItems: 1024 },
  },
} as const;

const repairSchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: {
    ...sourceFields,
    provider: { type: 'string', enum: [...PROVIDER_IDS] },
    maxIters: { type: 'integer', minimum: 1 },
  },
} as const;

const smtlibSchema = {
  type: 'object',
  required: ['code', 'function', 'ref'],
  additionalProperties: false,
  properties: {
    ...sourceFields,
    function: identifier,
    ref: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const core = opts.core ?? loadConfig();
  const deps: VerifierDeps = {
    config: core,
    runner: opts.runner ?? new LocalRunner(core.concurrency),
    detector: opts.detector ?? new Detector(core),
  };
  const llm = opts.llm ?? loadLlmConfig();
  const proposerFor = opts.proposer ?? ((id: ProviderId) => createProposer(id, llm));
  const ui = opts.server.uiHtml ? await loadUi(opts.server.uiHtml) : null;

  const app = Fastify({
    logger: opts.logger === false ? false : { level: opts.server.logLevel },
    bodyLimit: opts.server.bodyLimit,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof RequestError) return reply.code(400).send({ error: err.message });
    if (err instanceof EngineError) return reply.code(502).send({ error: err.message });
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    // Fastify's own 4xx errors (validation, body too large, bad JSON) are safe to show.
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: message ?? 'bad request' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/api/health', (_req, reply) => reply.send({ ok: true, version: pkg.version }));

  app.get('/api/engines', async (): Promise<EnginesResponse> => {
    const engines = await deps.detector.get();
    const preferred = engines[core.defaultEngine];
    const fallback = ENGINE_IDS.find((id) => engines[id].available);
    return {
      default: preferred.available || !fallback ? core.defaultEngine : fallback,
      engines,
      limits: {
        maxUnwind: core.maxUnwind,
        defaultUnwind: core.defaultUnwind,
        maxCodeBytes: core.maxCodeBytes,
      },
    };
  });

  app.post<{ Body: VerifyRequest }>('/api/verify', { schema: { body: verifySchema } }, async (req) =>
    verify(req.body, deps),
  );

  app.post<{ Body: SmtlibRequest }>('/api/smtlib', { schema: { body: smtlibSchema } }, async (req, reply) => {
    const out = await exportSmtlib(req.body, deps);
    return reply
      .type('text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="${out.fileName}"`)
      .send(out.text);
  });

  app.get('/api/providers', (_req, reply) => reply.send(describeProviders(llm)));

  // Each repair spends model tokens, so only a few run at once; the rest are
  // turned away rather than queued behind minutes of work. A repair stops
  // (and its model request is cancelled) when the client goes away.
  let activeRepairs = 0;
  const busy = (): RepairResult => ({
    status: 'error',
    iterations: [],
    error: `The server is already running ${opts.server.repairConcurrency} repair(s); try again shortly.`,
  });
  const runRepair = async (body: RepairRequest, reply: FastifyReply, onEvent?: (e: RepairEvent) => void) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on('close', cancel);
    activeRepairs++;
    try {
      const proposer = proposerFor(body.provider ?? llm.defaultProvider);
      return await repair(
        body,
        { ...deps, proposer },
        { signal: controller.signal, ...(onEvent ? { onEvent } : {}) },
      );
    } finally {
      activeRepairs--;
      reply.raw.off('close', cancel);
    }
  };

  app.post<{ Body: RepairRequest }>('/api/repair', { schema: { body: repairSchema } }, async (req, reply) => {
    if (activeRepairs >= opts.server.repairConcurrency) return reply.code(429).send(busy());
    return runRepair(req.body, reply);
  });

  // The same repair as server-sent events: checking, proposing and iteration
  // events as it goes, then the result. A request the loop rejects before its
  // first event gets an ordinary 400.
  app.post<{ Body: RepairRequest }>(
    '/api/repair/stream',
    { schema: { body: repairSchema } },
    async (req, reply) => {
      if (activeRepairs >= opts.server.repairConcurrency) return reply.code(429).send(busy());
      const res = reply.raw;
      let open = false;
      const send = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (open && !res.writableEnded) res.write(': keepalive\n\n');
      }, 15_000);
      try {
        await runRepair(req.body, reply, (e) => {
          if (!open) {
            open = true;
            reply.hijack();
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
              'x-accel-buffering': 'no',
            });
          }
          send(e.type, e);
        });
      } catch (e) {
        if (!open) throw e;
        if (!(e instanceof RequestError)) req.log.error(e);
        send('error', { error: e instanceof RequestError ? e.message : 'internal error' });
      } finally {
        clearInterval(heartbeat);
        if (open) res.end();
      }
    },
  );

  if (ui) {
    const sendUi = async (_req: unknown, reply: FastifyReply) =>
      reply.type('text/html; charset=utf-8').send(ui);
    app.get('/', sendUi);
    app.get('/index.html', sendUi);
  }

  return app;
}
