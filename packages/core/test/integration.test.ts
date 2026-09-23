import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Detector,
  LocalRunner,
  checkEquivalence,
  exportSmtlib,
  loadConfig,
  probe,
  repair,
  verify,
} from '@verifier/core';
import { ReplayRunner, StaticDetector, loadRecording } from '@verifier/core/testing';
import type { EngineId, Finding, VerifyResult } from '@verifier/shared';
import {
  EQ_CHECKS,
  EQ_SCENARIOS,
  REPAIR_SCENARIOS,
  ScriptedProposer,
  applyEdits,
  recordingPath,
  sourcePath,
} from './scenarios';

// Runs the real engines. Tools that are not installed are skipped, unless
// VERIFIER_REQUIRE lists them (CI does), in which case their absence fails.

const config = loadConfig({});
const detector = new Detector(config);
const deps = { config, runner: new LocalRunner(config.concurrency), detector };
const engines = await detector.get();
const z3 = (await probe('z3', ['--version'])) !== null;
// The behavior proof also needs CBMC's compiler and instrumenter.
const gotoTools =
  (await probe('goto-cc', ['--version'])) !== null &&
  (await probe('goto-instrument', ['--version'])) !== null;

const required = (process.env.VERIFIER_REQUIRE ?? '').split(',').filter(Boolean);
const installed: Record<string, boolean> = {
  cbmc: engines.cbmc.available,
  esbmc: engines.esbmc.available,
  z3,
  'goto-tools': gotoTools,
};
for (const s of engines.cbmc.solvers) installed[`cbmc:${s.id}`] = s.available;

it('has every tool this environment requires', () => {
  expect(required.filter((t) => !installed[t])).toEqual([]);
});

const source = (file: string) => fs.readFileSync(sourcePath(file), 'utf8');
const INT32_MAX = 2n ** 31n - 1n;
const INT32_MIN = -(2n ** 31n);
const inputValue = (f: Finding, name: string) =>
  BigInt(f.model.find((m) => m.role === 'input' && m.name === name)!.value);

function solveWithZ3(formula: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vw-smt-')), 'q.smt2');
  fs.writeFileSync(file, formula);
  try {
    return execFileSync('z3', [file], { encoding: 'utf8', timeout: 60_000 }).split('\n')[0]!.trim();
  } catch (e) {
    // z3 exits non-zero after printing "sat" when a later (get-model)-style command is rejected.
    return String((e as { stdout?: string }).stdout ?? '')
      .split('\n')[0]!
      .trim();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

for (const engine of ['cbmc', 'esbmc'] as EngineId[]) {
  const info = engines[engine];
  describe.skipIf(!info.available)(`${engine} (real)`, () => {
    for (const solver of info.solvers.filter((s) => s.available)) {
      it(`finds both sample bugs with ${solver.id}`, async () => {
        const r = await verify(
          { code: source('arith.c'), fileName: 'arith.c', engine, solver: solver.id },
          deps,
        );
        expect(r.status).toBe('refuted');
        expect(r.solver?.id).toBe(solver.id);
        const avg = r.findings.find((f) => f.entry === 'avg' && f.status === 'refuted')!;
        const sum = inputValue(avg, 'a') + inputValue(avg, 'b');
        expect(sum > INT32_MAX || sum < INT32_MIN).toBe(true);
        const store = r.findings.find((f) => f.entry === 'store' && f.status === 'refuted')!;
        expect(inputValue(store, 'idx')).toBe(16n);
      });
    }

    it('never proves past the unwind bound', async () => {
      const r = await verify({ code: source('loop.c'), fileName: 'loop.c', engine, unwind: 4 }, deps);
      expect(r.status).toBe('inconclusive');
      expect(r.findings.some((f) => f.status === 'proved')).toBe(false);
    });

    it('finds the bug once the bound reaches it', async () => {
      // table has 8 entries, so the read at i = 8 happens on the 9th iteration.
      const r = await verify({ code: source('loop.c'), fileName: 'loop.c', engine, unwind: 12 }, deps);
      expect(r.status).toBe('refuted');
      const bug = r.findings.find((f) => f.status === 'refuted')!;
      expect(bug.kind).toBe('bounds');
      expect(inputValue(bug, 'n')).toBeGreaterThanOrEqual(9n);
    });

    it.skipIf(!z3)('exports SMT-LIB that z3 decides: sat when refuted, unsat when proved', async () => {
      const code = source('fixes.c');
      const r: VerifyResult = await verify({ code, fileName: 'fixes.c', engine }, deps);
      const refuted = r.findings.find((f) => f.status === 'refuted' && f.exportRef)!;
      const proved = r.findings.find(
        (f) => f.entry === 'store_fixed' && f.status === 'proved' && f.exportRef,
      )!;
      for (const [finding, expected] of [
        [refuted, 'sat'],
        [proved, 'unsat'],
      ] as const) {
        const out = await exportSmtlib(
          { code, fileName: 'fixes.c', engine, function: finding.entry, ref: finding.exportRef! },
          deps,
        );
        expect(out.text).toMatch(/^; SMT-LIB formula exported by Verifier Workbench/);
        expect(solveWithZ3(out.text)).toBe(expected);
      }
    });
  });
}

// The recorded scenarios the replay tests use must still describe what the
// installed engines do; a new CBMC or ESBMC that changes a verdict fails here,
// and `npm run record-fixtures` brings the recordings up to date.

const replayDeps = (name: string) => {
  const recording = loadRecording(recordingPath(name));
  return {
    config,
    runner: new ReplayRunner(recording.runs),
    detector: new StaticDetector(recording.engines),
  };
};

describe.skipIf(!engines.cbmc.available || !gotoTools)('behavior proofs (real)', () => {
  for (const s of EQ_SCENARIOS) {
    it(`${s.name} matches its recording`, async () => {
      const original = source(s.file);
      const opts = {
        original,
        candidate: applyEdits(original, s.edits),
        fileName: s.file,
        checks: [...EQ_CHECKS],
        unwind: config.defaultUnwind,
        solver: s.solver,
      };
      const [live, recorded] = await Promise.all([
        checkEquivalence(opts, deps),
        checkEquivalence(opts, replayDeps(s.name)),
      ]);
      const verdict = (r: typeof live) => ({
        rejection: r.rejection?.guard,
        results: r.results.map((e) => [e.function, e.status]),
      });
      expect(verdict(live)).toEqual(verdict(recorded));
    });
  }
});

describe.skipIf(!engines.cbmc.available || !engines.esbmc.available || !gotoTools)('repairs (real)', () => {
  for (const s of REPAIR_SCENARIOS.filter((x) => !x.recording)) {
    it(`${s.name} matches its recording`, async () => {
      const code = source(s.file);
      const request = { ...s.request, code, fileName: s.file };
      const repairConfig = loadConfig({ REPAIR_MAX_ITERS: '6' });
      const run = (d: {
        config: typeof config;
        runner: LocalRunner | ReplayRunner;
        detector: typeof detector | StaticDetector;
      }) => repair(request, { ...d, config: repairConfig, proposer: new ScriptedProposer(code, s.answers) });
      const [live, recorded] = await Promise.all([run(deps), run(replayDeps(s.name))]);
      const outcomes = (r: typeof live) => r.iterations.map((i) => i.rejection?.guard ?? i.outcome);
      expect(outcomes(live)).toEqual(outcomes(recorded));
      expect(live.status).toBe(recorded.status);
    });
  }
});
