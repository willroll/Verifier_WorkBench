import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, verify } from '@verifier/core';
import { ReplayRunner, StaticDetector, loadRecording } from '@verifier/core/testing';
import type { Finding, VerifyResult } from '@verifier/shared';
import { SCENARIOS, recordingPath, sourcePath } from './scenarios';

// Replays real CBMC/ESBMC output through the full verify() pipeline. These are
// the truthfulness guarantees from docs/PLAN.md (V1-V7), pinned so a parser or
// harness change cannot quietly bring back a false "proved".

async function replay(name: string): Promise<VerifyResult> {
  const scenario = SCENARIOS.find((s) => s.name === name)!;
  const recording = loadRecording(recordingPath(name));
  const code = fs.readFileSync(sourcePath(scenario.file), 'utf8');
  return verify(
    { ...scenario.request, code, fileName: scenario.file },
    {
      config: loadConfig({}),
      runner: new ReplayRunner(recording.runs),
      detector: new StaticDetector(recording.engines),
    },
  );
}

const INT32_MIN = -(2n ** 31n);
const INT32_MAX = 2n ** 31n - 1n;

function input(f: Finding, name: string): bigint {
  const w = f.model.find((m) => m.role === 'input' && m.name === name);
  if (!w) throw new Error(`no input ${name} in ${f.id}: ${JSON.stringify(f.model)}`);
  return BigInt(w.value);
}

const statusOf = (r: VerifyResult) => Object.fromEntries(r.functions.map((f) => [f.name, f.status]));
const findingsIn = (r: VerifyResult, fn: string) => r.findings.filter((f) => f.entry === fn);

describe.each(['arith-cbmc-z3', 'arith-cbmc-minisat', 'arith-esbmc-z3'])('%s: the handoff sample', (name) => {
  it('verifies library code with no main (V1)', async () => {
    const r = await replay(name);
    expect(r.status).toBe('refuted');
    expect(statusOf(r)).toEqual({ avg: 'refuted', store: 'refuted', clamp: 'no-obligations' });
  });

  it('reports the real witness, not static initializers (V2)', async () => {
    const r = await replay(name);
    const [avgBug] = findingsIn(r, 'avg').filter((f) => f.status === 'refuted');
    const sum = input(avgBug!, 'a') + input(avgBug!, 'b');
    expect(sum > INT32_MAX || sum < INT32_MIN).toBe(true);
    expect(avgBug!.model.some((m) => m.name.startsWith('buf['))).toBe(false);

    const [storeBug] = findingsIn(r, 'store').filter((f) => f.status === 'refuted');
    expect(input(storeBug!, 'idx')).toBe(16n);
    expect(storeBug!.model.find((m) => m.name === 'idx')?.hex).toBe('0x10');
    expect(storeBug!.kind).toBe('bounds');
    expect(storeBug!.line).toBe(13);
  });

  it('never reports another function’s obligations as proved (V3)', async () => {
    const r = await replay(name);
    for (const f of r.findings) expect(f.function).toBe(f.entry);
    expect(r.counts.refuted).toBe(2);
  });

  it('can export every decided obligation as SMT-LIB', async () => {
    const r = await replay(name);
    for (const f of r.findings) expect(f.exportRef).toMatch(/^(property|claim):/);
  });
});

describe('solver back ends are real, and reported', () => {
  it('CBMC + Z3 uses SMT-LIB', async () => {
    const r = await replay('arith-cbmc-z3');
    expect(r.solver).toMatchObject({ id: 'z3', label: 'Z3', encoding: 'SMT-LIB QF_AUFBV' });
  });
  it('CBMC + MiniSAT bit-blasts to SAT', async () => {
    const r = await replay('arith-cbmc-minisat');
    expect(r.solver).toMatchObject({ id: 'minisat', label: 'MiniSAT', encoding: 'SAT (bit-blasted)' });
  });
  it('ESBMC + Z3 reports its linked Z3', async () => {
    const r = await replay('arith-esbmc-z3');
    expect(r.solver).toMatchObject({ id: 'z3', label: 'Z3' });
    expect(r.solver?.version).toMatch(/^\d+\.\d+/);
  });
  it('CBMC signatures keep typedef names', async () => {
    const r = await replay('arith-cbmc-z3');
    expect(r.functions.find((f) => f.name === 'avg')?.signature).toBe('int32_t avg(int32_t a, int32_t b)');
  });
});

describe.each(['loop-cbmc', 'loop-esbmc'])('%s: bug past the unwind bound', (name) => {
  it('is inconclusive, never proved (V4)', async () => {
    const r = await replay(name);
    expect(r.status).toBe('inconclusive');
    expect(r.bounds).toEqual({ unwind: 4, unwindingAssertions: true });
    expect(r.findings.filter((f) => f.status === 'proved')).toEqual([]);
    expect(r.findings.some((f) => f.kind === 'unwind')).toBe(true);
    for (const f of r.findings) expect(f.reason).toBe('unwind-bound');
  });
});

describe.each(['fixes-cbmc', 'fixes-esbmc'])('%s: candidate fixes', (name) => {
  it('refutes the design prototype’s “verified” fix (V6)', async () => {
    const r = await replay(name);
    expect(statusOf(r).avg_design).toBe('refuted');
    const bugs = findingsIn(r, 'avg_design').filter((f) => f.status === 'refuted');
    expect(bugs.length).toBeGreaterThanOrEqual(1);
    for (const b of bugs) expect(b.kind).toBe('overflow');
  });

  it('proves the widening fix and the bounds fix', async () => {
    const r = await replay(name);
    expect(statusOf(r)).toMatchObject({ avg_widened: 'proved', store_fixed: 'proved' });
  });
});

describe.each(['calls-cbmc', 'calls-esbmc'])('%s: calls, library code and pointers', (name) => {
  it('reports a callee’s bug once, under the callee', async () => {
    const r = await replay(name);
    expect(statusOf(r)).toMatchObject({ bump: 'refuted', twice: 'no-obligations' });
    const [bug] = findingsIn(r, 'bump');
    expect(input(bug!, 'x')).toBe(INT32_MAX);
  });

  it('catches an overflow inside library code (memcpy)', async () => {
    const r = await replay(name);
    expect(statusOf(r).fill).toBe('refuted');
    expect(findingsIn(r, 'fill').some((f) => f.status === 'refuted')).toBe(true);
  });

  it('flags pointer findings that depend on arbitrary pointer inputs', async () => {
    const r = await replay(name);
    const derefs = findingsIn(r, 'deref').filter((f) => f.status === 'refuted');
    expect(derefs.length).toBeGreaterThanOrEqual(1);
    for (const f of derefs) {
      expect(f.kind).toBe('pointer');
      expect(f.note).toMatch(/arbitrary pointer/);
    }
  });
});

describe.each(['syntax-cbmc', 'syntax-esbmc'])('%s: code that does not compile', (name) => {
  it('is an error with a located diagnostic', async () => {
    const r = await replay(name);
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/does not compile: line 3/);
    expect(r.diagnostics.some((d) => d.severity === 'error' && d.line === 3)).toBe(true);
    expect(r.findings).toEqual([]);
  });
});
