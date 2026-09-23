import { describe, expect, it } from 'vitest';
import type { RepairResult, VerifyResult } from '@verifier/shared';
import recording from '../src/demo/arith-demo.json';
import {
  engineText,
  findingId,
  hexText,
  inputSummary,
  obligationList,
  proved,
  refuted,
  seconds,
  solverText,
} from '../src/format';
import type { Run } from '../src/runs';
import { SAMPLE_CODE } from '../src/sample';
import { logLines, verdictOf } from '../src/views/workbench/agentLog';
import { buildModel, functionAt, hunkHeader } from '../src/views/workbench/model';

// The Workbench's view of a run, on the recorded demo: a real CBMC run of the
// sample and the real repair loop that fixed it.

const data = recording as unknown as { verify: VerifyResult; repair: RepairResult };
const request = { code: SAMPLE_CODE, fileName: 'arith.c', engine: 'cbmc', solver: 'z3' } as const;
const original: Run = { id: '1', number: 1, createdAt: '', request, result: data.verify };
const patched: Run = {
  id: '2',
  number: 2,
  createdAt: '',
  request: { ...request, code: data.repair.finalCode! },
  result: data.repair.finalResult!,
  repair: data.repair,
  parentId: '1',
};

describe('buildModel', () => {
  it('numbers refuted findings and maps them to source lines', () => {
    const m = buildModel(original);
    expect(m.refuted.map((f) => [f.entry, f.line, f.kind])).toEqual([
      ['avg', 5, 'overflow'],
      ['store', 13, 'bounds'],
    ]);
    expect([...m.lineToFinding]).toEqual([
      [5, 0],
      [13, 1],
    ]);
    expect(m.functions.map((f) => [f.name, f.status])).toEqual([
      ['avg', 'refuted'],
      ['store', 'refuted'],
      ['clamp', 'no-obligations'],
    ]);
    expect(m.fixedLines.size).toBe(0);
  });

  it('marks the lines the patch changed, numbered in the patched file', () => {
    const m = buildModel(patched);
    expect(m.refuted).toEqual([]);
    expect([...m.fixedLines]).toEqual([5, 12]);
    const lines = patched.request.code.split('\n');
    expect(lines[4]).toContain('(int64_t)a');
    expect(lines[11]).toContain('idx < 16');
  });
});

describe('diff hunks', () => {
  const diff = data.repair.diff!;
  const fns = buildModel(patched).functions;

  it('name the function and line of the first change in each hunk', () => {
    const hunks = diff.flatMap((d, i) => (d.type === '@' ? [i] : []));
    expect([-1, ...hunks].map((at) => hunkHeader(diff, at, fns)).filter((h) => h !== '@@')).toEqual([
      '@@ avg() — line 5',
      '@@ store() — line 12',
    ]);
  });

  it('attribute a line to the last function starting at or before it', () => {
    expect(functionAt(fns, 3)).toBeUndefined();
    expect(functionAt(fns, 4)).toBe('avg');
    expect(functionAt(fns, 16)).toBe('store');
    expect(functionAt(fns, 99)).toBe('clamp');
  });
});

describe('format', () => {
  it('writes times, ids, engines and solvers as the design does', () => {
    expect(seconds(810)).toBe('0.81 s');
    expect(seconds(4200)).toBe('4.2 s');
    expect(seconds(undefined)).toBe('');
    expect(findingId(0)).toBe('F-01');
    expect(findingId(11)).toBe('F-12');
    expect(engineText(data.verify)).toBe('CBMC 5.95.1');
    expect(solverText(data.verify)).toMatch(/^z3 \d+\.\d+\.\d+$/);
    expect(solverText({ solver: null })).toBe('');
  });

  it('summarises counterexamples and obligations', () => {
    const [overflow, bounds] = refuted(data.verify);
    expect(inputSummary(bounds!)).toBe('idx=16 v=0');
    const a = overflow!.model.find((m) => m.name === 'a')!;
    expect(hexText(a)).toMatch(/^#x[0-9a-f]{8}$/);
    expect(hexText({ name: 'p', value: '?', role: 'state' })).toBe('—');
    expect(obligationList(proved(data.repair.finalResult!))).toEqual([
      'avg#overflow',
      'avg#conversion',
      'store#bounds',
    ]);
    expect(obligationList([bounds!, bounds!])).toEqual(['store#bounds ×2']);
  });
});

describe('agent log', () => {
  it('shows every attempt, with the reason a patch was rejected', () => {
    const lines = logLines(data.repair.iterations);
    expect(lines.map((l) => l.tone)).toEqual(['red', 'amber', 'green']);
    expect(lines[0]!.text).toMatch(/^iter 0 · verify · 2 refuted · \d/);
    expect(lines[1]!.text).toMatch(/^iter 1 · repair → rejected \(behavior changed\) · \d/);
    expect(lines[1]!.detail).toContain('well-defined in the original');
    expect(lines[2]!.text).toMatch(/^iter 2 · repair → re-verify · all 3 proved ✓ · \d/);
  });

  it('states the verdict only the checker can give', () => {
    expect(verdictOf(data.repair, 'CBMC')).toEqual({
      text: 'Verified — patch held (re-checked by CBMC).',
      tone: 'green',
    });
    const unrepaired: RepairResult = { ...data.repair, status: 'unrepaired', remaining: 1 };
    expect(verdictOf(unrepaired, 'CBMC')).toEqual({
      text: 'Could not repair — 1 obligation(s) still refuted after 2 attempt(s).',
      tone: 'red',
    });
  });
});
