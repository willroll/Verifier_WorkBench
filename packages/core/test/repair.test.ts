import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, loadConfig, repair } from '@verifier/core';
import { ReplayRunner, StaticDetector, loadRecording } from '@verifier/core/testing';
import type { RepairEvent, RepairResult } from '@verifier/shared';
import { REPAIR_SCENARIOS, ScriptedProposer, recordingPath, sourcePath } from './scenarios';

// The repair loop end to end, with a scripted model and replayed checker runs.
// These are the exit criteria of Phase 2 (docs/PLAN.md): every way of making
// the checker say "proved" without fixing the code is rejected with a reason
// the model gets back, and the honest fix is accepted.

async function replay(name: string) {
  const s = REPAIR_SCENARIOS.find((x) => x.name === name)!;
  const recording = loadRecording(recordingPath(s.recording ?? s.name));
  const code = fs.readFileSync(sourcePath(s.file), 'utf8');
  const proposer = new ScriptedProposer(code, s.answers);
  const events: RepairEvent[] = [];
  const result = await repair(
    { ...s.request, code, fileName: s.file },
    {
      config: loadConfig({ REPAIR_MAX_ITERS: '6' }),
      runner: new ReplayRunner(recording.runs),
      detector: new StaticDetector(recording.engines),
      proposer,
    },
    { onEvent: (e) => events.push(e) },
  );
  return { result, proposer, events, code };
}

const outcomes = (r: RepairResult) => r.iterations.map((i) => i.rejection?.guard ?? i.outcome);

describe('repair loop', () => {
  it('rejects every cheat with a reason and accepts the honest fix', async () => {
    const { result, proposer } = await replay('repair-arith');
    expect(outcomes(result)).toEqual([
      'baseline',
      'no-progress', // the design prototype's fix still overflows
      'behavior', // the overflow-free version of it computes something else
      'behavior', // gutting store
      'verifier-intrinsics', // __CPROVER_assume
      'signature', // widening the interface
      'accepted',
    ]);
    expect(result.status).toBe('repaired');
    expect(result.remaining).toBe(0);
    expect(result.rationale).toBe('Widen the sum to 64 bits and bound the index.');
    expect(result.finalCode).toContain('return (int32_t)(((int64_t)a + b) / 2);');
    expect(result.finalCode).toContain('if (idx < 16) {');
    expect(result.diff?.filter((d) => d.type !== ' ' && d.type !== '@')).toEqual([
      { type: '-', text: '    return (a + b) / 2;', oldLine: 5 },
      { type: '+', text: '    return (int32_t)(((int64_t)a + b) / 2);', newLine: 5 },
      { type: '-', text: '    if (idx <= 16) {', oldLine: 12 },
      { type: '+', text: '    if (idx < 16) {', newLine: 12 },
    ]);
    // The accepted code's own verification comes with the result.
    expect(result.finalResult?.counts).toEqual({ proved: 3, refuted: 0, inconclusive: 0 });
    expect(result.finalResult?.functions.map((f) => [f.name, f.status])).toEqual([
      ['avg', 'proved'],
      ['store', 'proved'],
      ['clamp', 'no-obligations'],
    ]);
    expect(result.equivalence?.map((e) => [e.function, e.status])).toEqual([
      ['avg', 'equivalent'],
      ['store', 'equivalent'],
    ]);
    expect(result.engineLabel).toBe('CBMC');
    expect(result.model).toBe('scripted');

    const [, , widened, gutted, , signature, accepted] = result.iterations;
    expect(widened?.rejection?.message).toMatch(
      /^`avg\(a = -?\d+, b = -?\d+\)` is well-defined in the original, but the return value differs \(original: -?\d+, patched: -?\d+\)/,
    );
    expect(gutted?.rejection?.message).toMatch(
      /^`store\(idx = \d+, v = \d+\)` .* the global buf differs at buf\[\d+\]/,
    );
    expect(gutted?.counts?.refuted).toBe(0); // it would have "verified"
    expect(signature?.rejection?.message).toMatch(/signature of `avg` changed/);
    expect(accepted?.equivalence).toEqual(result.equivalence);

    // Each attempt is told why the previous one failed; the stable part never changes.
    const [first, second, third, fourth] = proposer.requests;
    expect(new Set(proposer.requests.map((r) => r.system))).toEqual(new Set([SYSTEM_PROMPT]));
    expect(new Set(proposer.requests.map((r) => r.stable)).size).toBe(1);
    expect(first?.stable).toContain('refuted 2 obligation(s)');
    expect(first?.attempt).toBe('Attempt 1 of 6.\n\nReturn the complete patched file.');
    expect(second?.attempt).toContain('still left 2 obligation(s) refuted');
    expect(second?.attempt).toContain('+    return a + (b - a) / 2;');
    expect(third?.attempt).toContain(`was rejected: ${widened?.rejection?.message}`);
    expect(fourth?.attempt).toContain(gutted?.rejection?.message);
  });

  it('builds on a partial fix and stops when the model repeats itself', async () => {
    const { result, proposer } = await replay('repair-arith-partial');
    expect(outcomes(result)).toEqual(['baseline', 'improved', 'unchanged']);
    expect(result.status).toBe('unrepaired');
    expect(result.remaining).toBe(1);
    expect(result.finalCode).toContain('return (int32_t)(((int64_t)a + b) / 2);');
    expect(result.finalCode).toContain('if (idx <= 16) {');
    expect(result.rationale).toBe('Widen the sum.');
    expect(result.iterations[1]?.equivalence?.map((e) => [e.function, e.status])).toEqual([
      ['avg', 'equivalent'],
    ]);
    expect(proposer.requests).toHaveLength(2); // stopped before the third attempt
    expect(proposer.requests[1]?.attempt).toContain('reduced the refuted obligations from 2 to 1');
    expect(proposer.requests[1]?.attempt).toContain("array 'buf' upper bound");
  });

  it('verifies with ESBMC and still proves behavior with CBMC', async () => {
    const { result } = await replay('repair-arith-esbmc');
    expect(outcomes(result)).toEqual(['baseline', 'behavior', 'accepted']);
    expect(result.status).toBe('repaired');
    expect(result.engineLabel).toBe('ESBMC');
  });

  it('rejects textual cheats before running anything', async () => {
    const { result } = await replay('repair-source-guards');
    expect(outcomes(result)).toEqual([
      'baseline',
      'termination',
      'assertions',
      'includes',
      'empty',
      'unchanged',
    ]);
    expect(result.iterations[1]?.rejection?.message).toMatch(/call to `exit`/);
    expect(result.iterations[2]?.rejection?.message).toMatch(/`#define NDEBUG`/);
    expect(result.iterations.slice(1).every((i) => i.counts === undefined)).toBe(true);
    expect(result.status).toBe('unrepaired');
    expect(result.finalCode).toBeUndefined();
  });

  it('stops on provider errors that another attempt would not fix', async () => {
    const { result, proposer } = await replay('repair-provider-errors');
    expect(outcomes(result)).toEqual(['baseline', 'error', 'error', 'error']);
    expect(result.status).toBe('error');
    expect(result.error).toBe('The API key was rejected.');
    expect(proposer.requests[1]?.attempt).toContain(
      'Your previous answer could not be used: The answer was cut off at the output limit.',
    );
  });

  it('reports unrepaired when every answer was unusable', async () => {
    const { result } = await replay('repair-model-gives-up');
    expect(result.status).toBe('unrepaired');
    expect(result.remaining).toBe(2);
    expect(result.diff).toBeUndefined();
  });

  it('does not call the model when everything is already proved', async () => {
    const { result, proposer } = await replay('repair-already-proved');
    expect(result.status).toBe('already-proved');
    expect(proposer.requests).toHaveLength(0);
  });

  it('refuses to repair when nothing is refuted but the bound is too small', async () => {
    const { result, proposer } = await replay('repair-inconclusive');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Nothing is refuted, but 6 obligation\(s\) are inconclusive/);
    expect(proposer.requests).toHaveLength(0);
  });

  it('reports progress as it goes', async () => {
    const { result, events } = await replay('repair-arith-partial');
    expect(
      events.map((e) => (e.type === 'checking' ? `${e.type}:${e.iter}:${e.step}` : `${e.type}`)),
    ).toEqual([
      'checking:0:verify',
      'iteration',
      'proposing',
      'checking:1:guards',
      'checking:1:verify',
      'checking:1:equivalence',
      'iteration',
      'proposing',
      'checking:2:guards',
      'iteration',
      'result',
    ]);
    expect(events.at(-1)).toEqual({ type: 'result', result });
  });

  it('validates the attempt limit', async () => {
    const s = REPAIR_SCENARIOS.find((x) => x.name === 'repair-already-proved')!;
    const code = fs.readFileSync(sourcePath(s.file), 'utf8');
    const deps = {
      config: loadConfig({}),
      runner: new ReplayRunner([]),
      detector: new StaticDetector(loadRecording(recordingPath('proved-cbmc')).engines),
      proposer: new ScriptedProposer(code, []),
    };
    await expect(repair({ code, maxIters: 4 }, deps)).rejects.toThrow(
      'maxIters must be an integer from 1 to 3',
    );
    await expect(repair({ code, maxIters: 0 }, deps)).rejects.toThrow('maxIters');
  });
});
