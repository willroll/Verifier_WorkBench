import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkEquivalence, loadConfig, type EquivalenceReport } from '@verifier/core';
import { ReplayRunner, StaticDetector, loadRecording } from '@verifier/core/testing';
import type { EquivalenceResult } from '@verifier/shared';
import { EQ_CHECKS, EQ_SCENARIOS, applyEdits, recordingPath, sourcePath } from './scenarios';

// The behavior proof, replayed from real CBMC runs. A candidate may differ
// from the original only where the original is undefined or fails an
// assertion; these pin each way a patch can get that wrong, and the cases
// that must not be flagged.

async function replay(name: string): Promise<EquivalenceReport> {
  const s = EQ_SCENARIOS.find((x) => x.name === name)!;
  const recording = loadRecording(recordingPath(name));
  const original = fs.readFileSync(sourcePath(s.file), 'utf8');
  const config = loadConfig({});
  return checkEquivalence(
    {
      original,
      candidate: applyEdits(original, s.edits),
      fileName: s.file,
      checks: [...EQ_CHECKS],
      unwind: config.defaultUnwind,
      solver: s.solver,
    },
    { config, runner: new ReplayRunner(recording.runs), detector: new StaticDetector(recording.engines) },
  );
}

const byFunction = (r: EquivalenceReport) =>
  Object.fromEntries(r.results.map((e): [string, EquivalenceResult] => [e.function, e]));
const statuses = (r: EquivalenceReport) => r.results.map((e) => [e.function, e.status]);
const inputs = (e: EquivalenceResult | undefined) =>
  Object.fromEntries((e?.inputs ?? []).map((i) => [i.name, Number(i.value)]));

describe('behavior proof', () => {
  it('proves the honest fix equivalent (z3, which array_equal used to fool)', async () => {
    const r = await replay('eq-arith-honest');
    expect(r.rejection).toBeUndefined();
    expect(statuses(r)).toEqual([
      ['avg', 'equivalent'],
      ['store', 'equivalent'],
    ]);
  });

  it('shows a changed return value with the inputs and both results', async () => {
    const avg = byFunction(await replay('eq-arith-wrong')).avg!;
    expect(avg.status).toBe('different');
    expect(avg.reason).toBe('the return value differs');
    const { a, b } = inputs(avg);
    // Both halves round toward zero separately, so odd pairs lose one.
    expect(Math.trunc((a! + b!) / 2)).toBe(Number(avg.original));
    expect(Math.trunc(a! / 2) + Math.trunc(b! / 2)).toBe(Number(avg.candidate));
    expect(avg.original).not.toBe(avg.candidate);
  });

  it('shows the global element a gutted function no longer writes', async () => {
    const store = byFunction(await replay('eq-arith-wrong')).store!;
    expect(store.status).toBe('different');
    const { idx, v } = inputs(store);
    expect(idx).toBeLessThan(16);
    expect(store.reason).toBe(`the global buf differs at buf[${idx}]`);
    expect(store.original).toBe(String(v));
    expect(store.candidate).toBe('0');
  });

  it('counts ending the program where the original returns as a difference', async () => {
    const r = await replay('eq-arith-exit');
    const store = byFunction(r).store!;
    expect(store.status).toBe('different');
    expect(store.reason).toMatch(/ends the program/);
    expect(inputs(store).idx).toBeGreaterThan(16);
    expect(byFunction(r).avg?.status).toBe('equivalent');
  });

  it('allows any change, even abort, where the original is undefined', async () => {
    const r = await replay('eq-arith-abort-ub');
    expect(statuses(r)).toEqual([
      ['avg', 'equivalent'],
      ['store', 'equivalent'],
    ]);
  });

  it('rejects a removed global instead of comparing around it', async () => {
    const r = await replay('eq-arith-global-removed');
    expect(r.results).toEqual([]);
    expect(r.rejection).toEqual({
      guard: 'globals',
      message: 'The global variable buf was removed; keep every global variable.',
    });
  });

  it('proves nothing when only formatting and comments changed', async () => {
    const r = await replay('eq-arith-reformat');
    expect(r).toEqual({ results: [] });
  });

  it('treats the original’s failing assertions like undefined behavior', async () => {
    const r = await replay('eq-behavior-fixed');
    expect(statuses(r)).toEqual([
      ['put', 'equivalent'], // 2-D global, compared element by element
      ['doubled', 'equivalent'], // differs only where assert(r < 100) failed
      ['twice', 'equivalent'], // x + x == x * 2 for every float, NaN included
      ['first', 'skipped'],
    ]);
    expect(byFunction(r).first?.reason).toMatch(/pointer/);
  });

  it('catches a fix that changes more than the failing inputs', async () => {
    const r = byFunction(await replay('eq-behavior-wrong'));
    expect(r.doubled?.status).toBe('different');
    const { a } = inputs(r.doubled);
    expect(a).toBeGreaterThanOrEqual(40);
    expect(a).toBeLessThan(50); // where the original was still well-defined
    expect(r.doubled?.original).toBe(String(a! * 2));
    expect(r.doubled?.candidate).toBe('98');

    expect(r.put?.status).toBe('different');
    expect(r.put?.reason).toMatch(/^the global grid differs at grid\[\d\]\[\d\]$/);
    expect(r.twice?.status).toBe('different');
  });

  it('propagates a change to callers and skips what it cannot model', async () => {
    const r = await replay('eq-calls');
    expect(statuses(r)).toEqual([
      ['bump', 'equivalent'],
      ['twice', 'equivalent'], // unchanged itself, but calls bump
      ['fill', 'skipped'],
      ['deref', 'skipped'],
    ]);
    expect(byFunction(r).fill?.reason).toMatch(/without a body \(log_fill\)/);
  });
});
