import type { RepairResult, VerifyResult } from '@verifier/shared';
import recording from './demo/arith-demo.json';
import { registerDemoRuns, type Run } from './runs';
import { SAMPLE_CODE, SAMPLE_FILE } from './sample';

// Demo mode: a real CBMC run of the sample and a real repair loop over it
// (with scripted model answers), recorded by `npm run record-demo` and
// replayed when no server is reachable. It is labelled as recorded wherever
// it appears.

export const DEMO_RUN_ID = 'demo';
export const DEMO_PATCHED_ID = 'demo-patched';

const data = recording as unknown as { recordedAt: string; verify: VerifyResult; repair: RepairResult };
const request = { code: SAMPLE_CODE, fileName: SAMPLE_FILE, engine: 'cbmc', solver: 'z3' } as const;

const original: Run = {
  id: DEMO_RUN_ID,
  number: 0,
  createdAt: data.recordedAt,
  request,
  result: data.verify,
  demo: true,
};

const patched: Run = {
  id: DEMO_PATCHED_ID,
  number: 0,
  createdAt: data.recordedAt,
  request: { ...request, code: data.repair.finalCode ?? SAMPLE_CODE },
  result: data.repair.finalResult ?? data.verify,
  repair: data.repair,
  parentId: DEMO_RUN_ID,
  demo: true,
};

registerDemoRuns([original, patched]);

export const demoRepair = (): RepairResult => data.repair;
export const demoRecordedAt = data.recordedAt;
