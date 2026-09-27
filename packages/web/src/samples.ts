import type { CheckId, EngineId, SolverId } from '@verifier/shared';
// The cFS example sources are the shipped files themselves (examples/cfs),
// imported verbatim so the samples and the repo files never drift.
import cfeTimeAdd from '../../../examples/cfs/cfe_time_add.c?raw';
import cfeTimeSubtract from '../../../examples/cfs/cfe_time_subtract.c?raw';
import cfeTimeCompare from '../../../examples/cfs/cfe_time_compare.c?raw';
import cfeTimeCompareOrder from '../../../examples/cfs/cfe_time_compare_order.c?raw';
import lcWatchResultBounds from '../../../examples/cfs/lc_watch_result_bounds.c?raw';
import { SAMPLE_CODE, SAMPLE_FILE } from './sample';

// Curated examples offered on the New Run page. Each carries the engine
// settings and check set that make its point, plus a note when the checks
// differ from the default (so a proof or counterexample is never misread).

export interface Sample {
  id: string;
  label: string;
  fileName: string;
  code: string;
  engine?: EngineId;
  solver?: SolverId;
  /** Overrides the default safety checks for this example. */
  checks?: CheckId[];
  /** One line shown when the sample is loaded, e.g. why checks are scoped. */
  note?: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'arith',
    label: 'arith.c — two defects and a clean function',
    fileName: SAMPLE_FILE,
    code: SAMPLE_CODE,
  },
  {
    id: 'cfe-time-add',
    label: 'cFS · CFE_TIME_Add — proof',
    fileName: 'cfe_time_add.c',
    code: cfeTimeAdd,
    checks: ['bounds', 'pointer', 'div-by-zero'],
    note: 'Real NASA cFS code. Overflow checks are off: cFS time is modular and wraps by contract, so the proof is about the carry logic, not overflow.',
  },
  {
    id: 'cfe-time-subtract',
    label: 'cFS · CFE_TIME_Subtract — proof',
    fileName: 'cfe_time_subtract.c',
    code: cfeTimeSubtract,
    checks: ['bounds', 'pointer', 'div-by-zero'],
    note: 'Real NASA cFS code. Overflow checks are off: cFS time wraps by contract, so the proof is about the borrow logic, not underflow.',
  },
  {
    id: 'cfe-time-compare',
    label: 'cFS · CFE_TIME_Compare — counterexample',
    fileName: 'cfe_time_compare.c',
    code: cfeTimeCompare,
    note: 'Real NASA cFS code. A natural-looking spec is refuted; the witness shows the deliberate ~68-year clock rollover.',
  },
  {
    id: 'cfe-time-compare-order',
    label: 'cFS · CFE_TIME_Compare — order proof',
    fileName: 'cfe_time_compare_order.c',
    code: cfeTimeCompareOrder,
    note: 'Real NASA cFS code. Proves Compare is a consistent order (A after B iff B before A), rollover included.',
  },
  {
    id: 'lc-watch-bounds',
    label: 'cFS · LC watchpoint table — bounds',
    fileName: 'lc_watch_result_bounds.c',
    code: lcWatchResultBounds,
    note: 'Real NASA cFS types and table size. The correct guard proves the indexed write in bounds; an off-by-one guard is refuted with the one-past-the-end index.',
  },
];

export const DEFAULT_SAMPLE = SAMPLES[0]!;
export const getSample = (id: string | null | undefined) => SAMPLES.find((s) => s.id === id);
