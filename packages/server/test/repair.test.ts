import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@verifier/core';
import { ReplayRunner, StaticDetector, loadRecording } from '@verifier/core/testing';
import { loadLlmConfig } from '@verifier/llm';
import type { ProposalOutcome, Proposer, ProvidersResponse, RepairResult } from '@verifier/shared';
import { buildApp } from '../src/app';
import { loadServerConfig } from '../src/config';
import { SHIM } from '../src/ui';
import { REPAIR_SCENARIOS, ScriptedProposer, recordingPath, sourcePath } from '../../core/test/scenarios';

// The repair endpoints over replayed engine runs and a scripted model.

const arith = fs.readFileSync(sourcePath('arith.c'), 'utf8');
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function appFor(recordingName: string, proposer?: Proposer, repairConcurrency = 2, env = {}) {
  const recording = loadRecording(recordingPath(recordingName));
  const app = await buildApp({
    server: { ...loadServerConfig({}), uiHtml: null, webDist: null, repairConcurrency },
    core: loadConfig({}),
    llm: loadLlmConfig(env),
    runner: new ReplayRunner(recording.runs),
    detector: new StaticDetector(recording.engines),
    ...(proposer ? { proposer: () => proposer } : {}),
    logger: false,
  });
  apps.push(app);
  return app;
}

const partial = REPAIR_SCENARIOS.find((s) => s.name === 'repair-arith-partial')!;
const partialRequest = { ...partial.request, code: arith, fileName: 'arith.c' };

describe('GET /api/providers', () => {
  it('lists providers and which are configured, without secrets', async () => {
    const app = await appFor('arith-cbmc-z3', undefined, 2, { ANTHROPIC_API_KEY: 'sk-ant-secret' });
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProvidersResponse>();
    expect(body.default).toBe('anthropic');
    expect(body.providers[0]).toEqual({
      id: 'anthropic',
      label: 'Claude',
      configured: true,
      model: 'claude-opus-5',
    });
    expect(res.body).not.toContain('sk-ant-secret');
  });
});

describe('POST /api/repair', () => {
  it('runs the verified repair loop', async () => {
    const app = await appFor('repair-arith-partial', new ScriptedProposer(arith, partial.answers));
    const res = await app.inject({ method: 'POST', url: '/api/repair', payload: partialRequest });
    expect(res.statusCode).toBe(200);
    const body = res.json<RepairResult>();
    expect(body.status).toBe('unrepaired');
    expect(body.remaining).toBe(1);
    expect(body.iterations.map((i) => i.outcome)).toEqual(['baseline', 'improved', 'rejected']);
  });

  it('reports an unconfigured provider after verifying the original', async () => {
    const app = await appFor('arith-cbmc-z3');
    const res = await app.inject({
      method: 'POST',
      url: '/api/repair',
      payload: { code: arith, fileName: 'arith.c', engine: 'cbmc', solver: 'z3', provider: 'gemini' },
    });
    const body = res.json<RepairResult>();
    expect(body.status).toBe('error');
    expect(body.error).toBe('Gemini is not configured on this server: set GEMINI_API_KEY.');
    expect(body.iterations[0]?.counts?.refuted).toBe(2);
  });

  it('rejects bad requests with 400', async () => {
    const app = await appFor('arith-cbmc-z3', new ScriptedProposer(arith, []));
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/repair',
      payload: { code: arith, maxIters: 99 },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toEqual({ error: 'maxIters must be an integer from 1 to 3' });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/repair',
      payload: { code: arith, provider: 'mistral' },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('turns away repairs beyond the concurrency limit', async () => {
    let release!: (o: ProposalOutcome) => void;
    let started!: () => void;
    const proposing = new Promise<void>((r) => (started = r));
    const slow: Proposer = {
      provider: 'anthropic',
      model: 'slow',
      propose: () => {
        started();
        return new Promise((r) => (release = r));
      },
    };
    const app = await appFor('arith-cbmc-z3', slow, 1);
    const payload = { code: arith, fileName: 'arith.c', engine: 'cbmc', solver: 'z3', maxIters: 1 };
    const first = app.inject({ method: 'POST', url: '/api/repair', payload });
    await proposing;
    const second = await app.inject({ method: 'POST', url: '/api/repair', payload });
    expect(second.statusCode).toBe(429);
    expect(second.json<RepairResult>()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('already running 1'),
    });
    release({ ok: false, kind: 'invalid', error: 'no answer' });
    expect((await first).json<RepairResult>().status).toBe('unrepaired');
  });
});

describe('POST /api/repair/stream', () => {
  it('streams progress events and ends with the result', async () => {
    const app = await appFor('repair-arith-partial', new ScriptedProposer(arith, partial.answers));
    const res = await app.inject({ method: 'POST', url: '/api/repair/stream', payload: partialRequest });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const events = res.body
      .trim()
      .split('\n\n')
      .map((chunk) => {
        const [event, data] = chunk.split('\n');
        return {
          event: event!.replace('event: ', ''),
          data: JSON.parse(data!.replace('data: ', '')) as { type: string },
        };
      });
    expect(events.map((e) => e.event)).toEqual([
      'checking',
      'iteration',
      'proposing',
      'checking',
      'checking',
      'checking',
      'iteration',
      'proposing',
      'checking',
      'iteration',
      'result',
    ]);
    expect(events.every((e) => e.event === e.data.type)).toBe(true);
    expect((events.at(-1)!.data as unknown as { result: RepairResult }).result.status).toBe('unrepaired');
  });

  it('answers a request the loop rejects with an ordinary 400', async () => {
    const app = await appFor('arith-cbmc-z3', new ScriptedProposer(arith, []));
    const res = await app.inject({
      method: 'POST',
      url: '/api/repair/stream',
      payload: { code: arith, maxIters: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });
});

describe('prototype UI shim', () => {
  it('never lets a rejected patch read as proved', () => {
    expect(SHIM).toContain("'rejected: ' + it.rejection.message");
    expect(SHIM).toContain('delete it.counts');
  });
});
