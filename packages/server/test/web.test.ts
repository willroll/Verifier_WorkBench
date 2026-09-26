import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@verifier/core';
import { ReplayRunner, StaticDetector, loadRecording } from '@verifier/core/testing';
import { buildApp } from '../src/app';
import { loadServerConfig } from '../src/config';
import { recordingPath } from '../../core/test/scenarios';

// Serving the built web app: its routes live in the browser, so every page
// path answers with index.html; the API keeps its own 404s.

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-web-'));
fs.mkdirSync(path.join(dist, 'assets'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head></head><body>app</body></html>');
fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1);');
const proto = path.join(dist, '..', `${path.basename(dist)}-proto.html`);
fs.writeFileSync(proto, '<!DOCTYPE html><html><head><title>p</title></head><body>prototype</body></html>');

let app: FastifyInstance;

beforeAll(async () => {
  const recording = loadRecording(recordingPath('arith-cbmc-z3'));
  app = await buildApp({
    server: { ...loadServerConfig({}), webDist: dist, uiHtml: proto },
    core: loadConfig({}),
    runner: new ReplayRunner(recording.runs),
    detector: new StaticDetector(recording.engines),
    logger: false,
  });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(proto, { force: true });
});

describe('web app', () => {
  it('serves index.html at / and for client-side routes, under a strict CSP', async () => {
    for (const url of ['/', '/new', '/runs/7', '/runs/7/report', '/misra']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<body>app</body>');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('answers HEAD for page paths and keeps the CSP on /index.html', async () => {
    const head = await app.inject({ method: 'HEAD', url: '/runs/7' });
    expect(head.statusCode).toBe(200);
    const index = await app.inject({ method: 'GET', url: '/index.html' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    expect(index.headers['x-frame-options']).toBe('DENY');
  });

  it('caches hashed assets for good', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps JSON 404s for the API', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no route for GET /api/nope' });
    expect((await app.inject({ method: 'GET', url: '/api' })).statusCode).toBe(404);
  });

  it('answers missing files with a 404, not the app', async () => {
    for (const url of ['/assets/index-old999.js', '/favicon.ico', '/robots.txt']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  it('keeps the prototype at /prototype', async () => {
    const res = await app.inject({ method: 'GET', url: '/prototype' });
    expect(res.body).toContain('prototype');
    expect(res.body).toContain('window.verifier = {');
  });
});
