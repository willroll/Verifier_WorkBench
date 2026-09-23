import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  Detector,
  EngineError,
  LocalRunner,
  RequestError,
  exportSmtlib,
  loadConfig,
  verify,
  type CoreConfig,
  type EngineDetector,
  type Runner,
  type VerifierDeps,
} from '@verifier/core';
import {
  CHECK_IDS,
  ENGINE_IDS,
  SOLVER_IDS,
  type EnginesResponse,
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
  runner?: Runner;
  detector?: EngineDetector;
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

  // The verified repair loop is being rebuilt with enforced guards (docs/PLAN.md, Phase 2).
  app.post('/api/repair', async (_req, reply) => {
    const body: RepairResult = {
      status: 'error',
      iterations: [],
      error:
        'Verified repair is being rebuilt with enforced anti-cheat guards (Phase 2). ' +
        'Verification, counterexamples and SMT-LIB export work now.',
    };
    return reply.code(501).send(body);
  });

  if (ui) {
    const sendUi = async (_req: unknown, reply: FastifyReply) =>
      reply.type('text/html; charset=utf-8').send(ui);
    app.get('/', sendUi);
    app.get('/index.html', sendUi);
  }

  return app;
}
