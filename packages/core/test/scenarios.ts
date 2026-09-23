import path from 'node:path';
import type { VerifyRequest } from '@verifier/shared';

export const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

export interface Scenario {
  name: string;
  /** C source under fixtures/c. */
  file: string;
  request: Omit<VerifyRequest, 'code' | 'fileName'>;
}

// Each scenario pins engine and solver so a replay never depends on what the
// recording host had installed.
export const SCENARIOS: Scenario[] = [
  { name: 'arith-cbmc-z3', file: 'arith.c', request: { engine: 'cbmc', solver: 'z3' } },
  { name: 'arith-cbmc-minisat', file: 'arith.c', request: { engine: 'cbmc', solver: 'minisat' } },
  { name: 'arith-esbmc-z3', file: 'arith.c', request: { engine: 'esbmc', solver: 'z3' } },
  { name: 'loop-cbmc', file: 'loop.c', request: { engine: 'cbmc', solver: 'minisat', unwind: 4 } },
  { name: 'loop-esbmc', file: 'loop.c', request: { engine: 'esbmc', solver: 'bitwuzla', unwind: 4 } },
  { name: 'fixes-cbmc', file: 'fixes.c', request: { engine: 'cbmc', solver: 'minisat' } },
  { name: 'fixes-esbmc', file: 'fixes.c', request: { engine: 'esbmc', solver: 'bitwuzla' } },
  { name: 'calls-cbmc', file: 'calls.c', request: { engine: 'cbmc', solver: 'minisat' } },
  { name: 'calls-esbmc', file: 'calls.c', request: { engine: 'esbmc', solver: 'bitwuzla' } },
  { name: 'syntax-cbmc', file: 'syntax-error.c', request: { engine: 'cbmc', solver: 'minisat' } },
  { name: 'syntax-esbmc', file: 'syntax-error.c', request: { engine: 'esbmc', solver: 'bitwuzla' } },
];

export const recordingPath = (name: string) => path.join(FIXTURES, 'recorded', `${name}.json.gz`);
export const sourcePath = (file: string) => path.join(FIXTURES, 'c', file);
