import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@verifier/core';
import { ReplayRunner, StaticDetector, loadRecording } from '@verifier/core/testing';
import type { EnginesResponse, VerifyResult } from '@verifier/shared';
import { buildApp } from '../src/app';
import { loadServerConfig } from '../src/config';
import { recordingPath, sourcePath } from '../../core/test/scenarios';

// The HTTP layer over replayed engine runs: no CBMC/ESBMC needed.

const recording = loadRecording(recordingPath('arith-cbmc-z3'));
const arith = fs.readFileSync(sourcePath('arith.c'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-ui-'));
const uiFile = path.join(tmp, 'index.html');
fs.writeFileSync(uiFile, '<!DOCTYPE html><html><head><title>t</title></head><body>prototype</body></html>');

let app: FastifyInstance;
let apiOnly: FastifyInstance;

beforeAll(async () => {
  const server = { ...loadServerConfig({}), uiHtml: uiFile, bodyLimit: 64 * 1024 };
  const deps = {
    core: loadConfig({}),
    runner: new ReplayRunner(recording.runs),
    detector: new StaticDetector(recording.engines),
    logger: false,
  };
  app = await buildApp({ server, ...deps });
  apiOnly = await buildApp({ server: { ...server, uiHtml: null }, ...deps });
});

afterAll(async () => {
  await app.close();
  await apiOnly.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/engines', () => {
  it('reports engines, solvers and limits', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/engines' });
    expect(res.statusCode).toBe(200);
    const body = res.json<EnginesResponse>();
    expect(body.default).toBe('cbmc');
    expect(body.engines.cbmc).toMatchObject({ id: 'cbmc', label: 'CBMC', available: true });
    expect(body.engines.cbmc.solvers.map((s) => s.id)).toContain('z3');
    expect(body.limits).toMatchObject({ defaultUnwind: 16, maxUnwind: 256 });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/verify', () => {
  it('returns the prototype-compatible result shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/verify',
      payload: { code: arith, fileName: 'arith.c', engine: 'cbmc', solver: 'z3' },
    });
    expect(res.statusCode).toBe(200);
    const r = res.json<VerifyResult>();
    // Fields the prototype UI reads.
    expect(r).toMatchObject({ engine: 'cbmc', engineLabel: 'CBMC', available: true, status: 'refuted' });
    expect(r.counts).toMatchObject({ refuted: 2, proved: 0 });
    for (const f of r.findings) {
      expect(f).toEqual(
        expect.objectContaining({
          status: 'refuted',
          kind: expect.any(String),
          message: expect.any(String),
          function: expect.any(String),
          file: 'arith.c',
          line: expect.any(Number),
        }),
      );
      expect(f.model.length).toBeGreaterThan(0);
    }
  });

  it.each([
    [{}, /required property 'code'/],
    [{ code: 'int f(void){return 0;}', engine: 'klee' }, /engine/],
    [{ code: 'int f(void){return 0;}', unwind: 0 }, /unwind/],
    [{ code: 'int f(void){return 0;}', unwind: 100000 }, /unwind must be an integer from 1 to 256/],
    [{ code: 'int f(void){return 0;}', solver: 'boolector' }, /CBMC cannot use the boolector solver/],
    [{ code: 'int f(void){return 0;}', checks: ['bounds', 'bounds'] }, /duplicate/],
  ])('rejects %j', async (payload, message) => {
    const res = await app.inject({ method: 'POST', url: '/api/verify', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(message);
  });

  it('refuses oversized bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/verify',
      payload: { code: 'x'.repeat(100 * 1024) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('refuses includes that would read host files', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/verify',
      payload: { code: '#include "/etc/passwd"\nint f(void) { return 0; }' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<VerifyResult>()).toMatchObject({ status: 'error', diagnostics: [{ line: 1 }] });
  });
});

describe('POST /api/smtlib', () => {
  it('rejects a malformed export reference', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/smtlib',
      payload: {
        code: arith,
        fileName: 'arith.c',
        engine: 'cbmc',
        solver: 'z3',
        function: 'avg',
        ref: 'nope',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/not a CBMC export reference/);
  });
});

describe('POST /api/repair', () => {
  it('says the verified repair loop is not available yet', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/repair', payload: { code: arith } });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ status: 'error', iterations: [] });
  });
});

describe('the old open LLM proxy', () => {
  it('is gone', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/complete', payload: { messages: [] } });
    expect(res.statusCode).toBe(404);
  });
});

describe('prototype UI', () => {
  it('is served with the API shim injected into <head>', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/<head>\s*<script>[\s\S]*window\.verifier = \{/);
    expect(res.body).not.toMatch(/window\.claude/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is absent in API-only mode', async () => {
    const res = await apiOnly.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/health', () => {
  it('answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toMatchObject({ ok: true, version: expect.any(String) });
  });
});
