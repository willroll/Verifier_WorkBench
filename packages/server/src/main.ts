import { loadConfig } from '@verifier/core';
import { buildApp } from './app';
import { loadServerConfig } from './config';

const server = loadServerConfig();
const core = loadConfig();
const app = await buildApp({ server, core });

const shutdown = (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await app.listen({ port: server.port, host: server.host });
app.log.info(
  server.webDist
    ? `web app: ${server.webDist}`
    : 'web app not built (npm run build, or set WEB_DIST)' +
        (server.uiHtml ? '; serving the prototype at /' : ''),
);
if (server.uiHtml) app.log.info(`prototype UI at /prototype: ${server.uiHtml}`);
