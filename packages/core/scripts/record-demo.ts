// Records the web app's demo run: the design's sample verified by the real
// CBMC, then repaired by the real loop. The model's answers are scripted (one
// patch the behavior proof rejects, then the honest fix) so the demo shows
// both outcomes. Run from the repo root after changing the sample or the
// result shapes:  npm run record-demo
import fs from 'node:fs';
import { Detector, LocalRunner, loadConfig, repair, verify } from '@verifier/core';
import type { VerifyResult } from '@verifier/shared';
import { SAMPLE_CODE, SAMPLE_FILE } from '../../web/src/sample';
import { ScriptedProposer, type Edit } from '../test/scenarios';

const OUT = 'packages/web/src/demo/arith-demo.json';
const config = loadConfig({ REPAIR_MAX_ITERS: '3' });
const deps = { config, runner: new LocalRunner(config.concurrency), detector: new Detector(config) };
const request = { code: SAMPLE_CODE, fileName: SAMPLE_FILE, engine: 'cbmc', solver: 'z3' } as const;

const avg: Edit = ['return (a + b) / 2;', 'return (int32_t)(((int64_t)a + b) / 2);'];
const proposer = new ScriptedProposer(SAMPLE_CODE, [
  {
    edits: [avg, ['if (idx <= 16) {\n        buf[idx] = v;\n    }', '(void)idx;\n    (void)v;']],
    rationale: 'Widen the sum, and drop the out-of-bounds store.',
  },
  {
    edits: [avg, ['idx <= 16', 'idx < 16']],
    rationale:
      'The sum a + b overflows int32_t; computing it in 64 bits keeps every result of the original and cannot overflow. ' +
      'The guard idx <= 16 admits idx = 16, one past the end of buf[16]; idx < 16 bounds it.',
  },
]);

const trim = (r: VerifyResult): VerifyResult => ({ ...r, ...(r.raw ? { raw: r.raw.slice(0, 16_000) } : {}) });
const verified = await verify(request, deps);
const repaired = await repair({ ...request, maxIters: 3 }, { ...deps, proposer });
if (verified.counts.refuted !== 2 || repaired.status !== 'repaired' || !repaired.finalResult) {
  throw new Error(
    `unexpected demo: ${verified.status} ${JSON.stringify(verified.counts)} / ${repaired.status}`,
  );
}
fs.writeFileSync(
  OUT,
  `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    verify: trim(verified),
    repair: { ...repaired, finalResult: trim(repaired.finalResult) },
  })}\n`,
);
console.log(
  `${OUT}: ${verified.counts.refuted} refuted → ${repaired.status} in ${repaired.iterations.length - 1} attempts, ` +
    `${Math.round(fs.statSync(OUT).size / 1024)} KB`,
);
