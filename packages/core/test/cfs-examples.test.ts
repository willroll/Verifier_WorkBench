import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Detector, LocalRunner, loadConfig, verify } from '@verifier/core';
import type { CheckId, Finding } from '@verifier/shared';

// The shipped cFS examples (examples/cfs) must keep verifying as their README
// claims: the CFE_TIME_Add proof holds, and the CFE_TIME_Compare spec is
// refuted with a witness that is the deliberate rollover. Runs real CBMC;
// skipped when CBMC is absent, required in CI via VERIFIER_REQUIRE=cbmc.

const config = loadConfig({});
const detector = new Detector(config);
const deps = { config, runner: new LocalRunner(config.concurrency), detector };
const cbmc = (await detector.get()).cbmc.available;
const CFS = path.resolve(import.meta.dirname, '../../../examples/cfs');
const read = (file: string) => fs.readFileSync(path.join(CFS, file), 'utf8');
const num = (f: Finding, name: string) =>
  BigInt(f.model.find((m) => m.role === 'input' && m.name === name)!.value);

const SAFE_CHECKS: CheckId[] = ['bounds', 'pointer', 'div-by-zero'];
const CFE_TIME_NEGATIVE = 0x80000000n;

describe.skipIf(!cbmc)('cFS examples', () => {
  it('proves CFE_TIME_Add equals a 64-bit addition (overflow checks off)', async () => {
    const r = await verify(
      {
        code: read('cfe_time_add.c'),
        fileName: 'cfe_time_add.c',
        engine: 'cbmc',
        solver: 'minisat',
        checks: SAFE_CHECKS,
      },
      deps,
    );
    expect(r.status).toBe('proved');
    expect(r.counts.refuted).toBe(0);
    const proof = r.findings.find((f) => f.entry === 'prove_add_is_64bit_addition')!;
    expect(proof.status).toBe('proved');
  });

  it('refutes the naive Compare spec with the rollover witness', async () => {
    const r = await verify(
      { code: read('cfe_time_compare.c'), fileName: 'cfe_time_compare.c', engine: 'cbmc', solver: 'minisat' },
      deps,
    );
    expect(r.status).toBe('refuted');

    // The two guarded subtractions inside Compare are proved not to underflow.
    const proved = r.findings.filter((f) => f.entry === 'CFE_TIME_Compare' && f.status === 'proved');
    expect(proved.length).toBeGreaterThanOrEqual(2);

    // The naive spec is refuted, and its witness is two times more than the
    // ~68-year rollover apart, with the "greater" one holding fewer seconds.
    const spec = r.findings.find(
      (f) => f.entry === 'assume_gt_means_larger_seconds' && f.status === 'refuted',
    )!;
    const aSec = num(spec, 'a_sec');
    const bSec = num(spec, 'b_sec');
    expect(aSec).toBeLessThan(bSec);
    expect(bSec - aSec).toBeGreaterThan(CFE_TIME_NEGATIVE);
  });
});
