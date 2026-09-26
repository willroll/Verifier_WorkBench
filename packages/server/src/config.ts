import fs from 'node:fs';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  /** Largest accepted request body. The source-size limit itself is VERIFY_MAX_CODE_BYTES. */
  bodyLimit: number;
  /** The built web app (packages/web/dist), served at /; null when it is not built. */
  webDist: string | null;
  /** The design prototype, served at /prototype for comparison; null to leave it out. */
  uiHtml: string | null;
  logLevel: string;
  /** Repairs allowed to run at once; each one spends model tokens. Further requests get 429. */
  repairConcurrency: number;
}

type Env = Record<string, string | undefined>;

const WEB_CANDIDATES = ['packages/web/dist', '../web/dist', '/app/web'];

const UI_CANDIDATES = [
  'design/Verifier Workbench (standalone).html',
  '../../design/Verifier Workbench (standalone).html',
];

export function loadServerConfig(env: Env = process.env, cwd = process.cwd()): ServerConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`PORT must be a port number, got "${env.PORT}"`);
  const bodyLimit = Number(env.BODY_LIMIT_BYTES ?? 512 * 1024);
  if (!Number.isInteger(bodyLimit) || bodyLimit < 1024)
    throw new Error('BODY_LIMIT_BYTES must be an integer >= 1024');

  const repairConcurrency = Number(env.REPAIR_CONCURRENCY ?? 2);
  if (!Number.isInteger(repairConcurrency) || repairConcurrency < 1 || repairConcurrency > 64)
    throw new Error('REPAIR_CONCURRENCY must be an integer from 1 to 64');

  let webDist: string | null;
  if (env.WEB_DIST !== undefined) {
    webDist = env.WEB_DIST.trim() ? path.resolve(cwd, env.WEB_DIST) : null;
  } else {
    webDist =
      WEB_CANDIDATES.map((c) => path.resolve(cwd, c)).find((p) =>
        fs.existsSync(path.join(p, 'index.html')),
      ) ?? null;
  }

  let uiHtml: string | null;
  if (env.UI_HTML !== undefined) {
    uiHtml = env.UI_HTML.trim() ? path.resolve(cwd, env.UI_HTML) : null;
  } else {
    uiHtml = UI_CANDIDATES.map((c) => path.resolve(cwd, c)).find((p) => fs.existsSync(p)) ?? null;
  }

  return {
    port,
    // Local-first: listen on loopback unless told otherwise (the Docker image sets HOST=0.0.0.0).
    host: env.HOST ?? '127.0.0.1',
    bodyLimit,
    webDist,
    uiHtml,
    logLevel: env.LOG_LEVEL ?? 'info',
    repairConcurrency,
  };
}
