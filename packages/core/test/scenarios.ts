import path from 'node:path';
import type {
  ProposalOutcome,
  ProposalRequest,
  Proposer,
  RepairRequest,
  SolverId,
  VerifyRequest,
} from '@verifier/shared';

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
  { name: 'proved-cbmc', file: 'proved.c', request: { engine: 'cbmc', solver: 'z3' } },
];

export const recordingPath = (name: string) => path.join(FIXTURES, 'recorded', `${name}.json.br`);
export const sourcePath = (file: string) => path.join(FIXTURES, 'c', file);

// ---- Behavior proofs and repairs ---------------------------------------------

/** [find, replace] on the fixture source, first occurrence; the find text must exist. */
export type Edit = [string, string];

export function applyEdits(code: string, edits: Edit[]): string {
  return edits.reduce((c, [find, replace]) => {
    if (!c.includes(find)) throw new Error(`edit target not found: ${JSON.stringify(find)}`);
    return c.replace(find, replace);
  }, code);
}

const AVG_HONEST: Edit = ['return (a + b) / 2;', 'return (int32_t)(((int64_t)a + b) / 2);'];
const STORE_HONEST: Edit = ['idx <= 16', 'idx < 16'];
const STORE_GUTTED: Edit = ['if (idx <= 16) {\n        buf[idx] = v;\n    }', '(void)idx;\n    (void)v;'];

export interface EquivalenceScenario {
  name: string;
  file: string;
  /** The candidate: the fixture with these edits. */
  edits: Edit[];
  solver: SolverId;
}

// Every check the behavior proof turns into assumptions for the original.
export const EQ_CHECKS = [
  'bounds',
  'pointer',
  'div-by-zero',
  'signed-overflow',
  'unsigned-overflow',
  'conversion',
  'undefined-shift',
] as const;

export const EQ_SCENARIOS: EquivalenceScenario[] = [
  // z3: CBMC's SMT encoding of __CPROVER_array_equal reported this honest fix as different.
  { name: 'eq-arith-honest', file: 'arith.c', edits: [AVG_HONEST, STORE_HONEST], solver: 'z3' },
  {
    name: 'eq-arith-wrong',
    file: 'arith.c',
    edits: [['return (a + b) / 2;', 'return a / 2 + b / 2;'], STORE_GUTTED],
    solver: 'minisat',
  },
  {
    name: 'eq-arith-exit',
    file: 'arith.c',
    edits: [
      AVG_HONEST,
      ['if (idx <= 16) {\n        buf[idx] = v;\n    }', 'if (idx >= 16) exit(1);\n    buf[idx] = v;'],
    ],
    solver: 'z3',
  },
  {
    name: 'eq-arith-abort-ub',
    file: 'arith.c',
    edits: [
      ['#include <stdint.h>', '#include <stdint.h>\n#include <stdlib.h>'],
      AVG_HONEST,
      ['if (idx <= 16) {', 'if (idx == 16) abort();\n    if (idx <= 16) {'],
    ],
    solver: 'z3',
  },
  {
    name: 'eq-arith-global-removed',
    file: 'arith.c',
    edits: [['static uint8_t buf[16];\n', ''], STORE_GUTTED],
    solver: 'z3',
  },
  {
    name: 'eq-arith-reformat',
    file: 'arith.c',
    edits: [
      [
        'int32_t clamp(int32_t x, int32_t lo, int32_t hi) {',
        '/* Clamp x to [lo, hi]. */\nint32_t clamp(int32_t x,\n              int32_t lo, int32_t hi)\n{',
      ],
    ],
    solver: 'z3',
  },
  {
    name: 'eq-behavior-fixed',
    file: 'behavior.c',
    edits: [
      ['c <= 3', 'c < 3'],
      ['int r = a * 2;', 'int r = a < 50 ? a * 2 : 98;'],
      ['return x * 2.0f;', 'return x + x;'],
      ['return p[0];', 'return *p;'],
    ],
    solver: 'cvc5',
  },
  {
    name: 'eq-behavior-wrong',
    file: 'behavior.c',
    edits: [
      ['if (r >= 0 && r < 2 && c >= 0 && c <= 3) grid[r][c] = v;', '(void)r; (void)c; (void)v;'],
      ['int r = a * 2;', 'int r = a < 40 ? a * 2 : 98;'],
      ['return x * 2.0f;', 'return x * 3.0f;'],
    ],
    solver: 'z3',
  },
  {
    name: 'eq-calls',
    file: 'calls.c',
    edits: [
      ['return x + 1;', 'return 1 + x;'],
      ['return *p;', 'return p[0];'],
      ['void fill(void) {', 'extern void log_fill(void);\nvoid fill(void) {\n    log_fill();'],
    ],
    solver: 'minisat',
  },
];

type FailureKind = Extract<ProposalOutcome, { ok: false }>['kind'];

/** One scripted model answer: edits to the fixture, a whole file, or a failure. */
export type ScriptedAnswer =
  { edits: Edit[]; rationale?: string } | { code: string } | { fail: FailureKind; error: string };

export interface RepairScenario {
  name: string;
  file: string;
  request: Omit<RepairRequest, 'code' | 'fileName'>;
  answers: ScriptedAnswer[];
  /** Replay another scenario's recording: the loop runs nothing beyond that verification. */
  recording?: string;
}

export const REPAIR_SCENARIOS: RepairScenario[] = [
  {
    // The exit criteria of Phase 2: every cheat is rejected with a reason, the honest fix is accepted.
    name: 'repair-arith',
    file: 'arith.c',
    request: { engine: 'cbmc', solver: 'z3', maxIters: 6 },
    answers: [
      // The design prototype's fix: still overflows.
      { edits: [['return (a + b) / 2;', 'return a + (b - a) / 2;'], STORE_HONEST] },
      // The same fix without the overflow: it computes something else.
      { edits: [['return (a + b) / 2;', 'return (int32_t)(a + ((int64_t)b - a) / 2);'], STORE_HONEST] },
      // Deleting the store makes every check pass.
      { edits: [AVG_HONEST, STORE_GUTTED] },
      // Telling the checker to assume the bug away.
      { edits: [AVG_HONEST, ['if (idx <= 16) {', '__CPROVER_assume(idx < 16);\n    if (idx <= 16) {']] },
      // Widening the interface instead of the arithmetic.
      {
        edits: [['int32_t avg(int32_t a, int32_t b) {', 'int64_t avg(int64_t a, int64_t b) {'], STORE_HONEST],
      },
      { edits: [AVG_HONEST, STORE_HONEST], rationale: 'Widen the sum to 64 bits and bound the index.' },
    ],
  },
  {
    name: 'repair-arith-partial',
    file: 'arith.c',
    request: { engine: 'cbmc', solver: 'z3', maxIters: 3 },
    answers: [{ edits: [AVG_HONEST], rationale: 'Widen the sum.' }, { edits: [AVG_HONEST] }],
  },
  {
    name: 'repair-arith-esbmc',
    file: 'arith.c',
    request: { engine: 'esbmc', solver: 'z3', maxIters: 2 },
    answers: [{ edits: [AVG_HONEST, STORE_GUTTED] }, { edits: [AVG_HONEST, STORE_HONEST] }],
  },
  {
    name: 'repair-source-guards',
    file: 'arith.c',
    recording: 'arith-cbmc-z3',
    request: { engine: 'cbmc', solver: 'z3', maxIters: 5 },
    answers: [
      { edits: [AVG_HONEST, ['if (idx <= 16) {', 'if (idx > 15) exit(0);\n    if (idx <= 16) {']] },
      { edits: [['#include <stdint.h>', '#define NDEBUG\n#include <stdint.h>'], AVG_HONEST, STORE_HONEST] },
      { edits: [['#include <stdint.h>', '#include "/etc/passwd"\n#include <stdint.h>']] },
      { code: '   \n' },
      { edits: [] },
    ],
  },
  {
    name: 'repair-provider-errors',
    file: 'arith.c',
    recording: 'arith-cbmc-z3',
    request: { engine: 'cbmc', solver: 'z3', maxIters: 3 },
    answers: [
      { fail: 'truncated', error: 'The answer was cut off at the output limit.' },
      { fail: 'invalid', error: 'The answer was not valid JSON.' },
      { fail: 'auth', error: 'The API key was rejected.' },
    ],
  },
  {
    name: 'repair-model-gives-up',
    file: 'arith.c',
    recording: 'arith-cbmc-z3',
    request: { engine: 'cbmc', solver: 'z3', maxIters: 2 },
    answers: [
      { fail: 'truncated', error: 'The answer was cut off at the output limit.' },
      { fail: 'refused', error: 'The model declined to answer.' },
    ],
  },
  {
    name: 'repair-already-proved',
    file: 'proved.c',
    recording: 'proved-cbmc',
    request: { engine: 'cbmc', solver: 'z3' },
    answers: [],
  },
  {
    name: 'repair-inconclusive',
    file: 'loop.c',
    recording: 'loop-cbmc',
    request: { engine: 'cbmc', solver: 'minisat', unwind: 4 },
    answers: [],
  },
];

/** A model that answers from a script and keeps every request it was sent. */
export class ScriptedProposer implements Proposer {
  readonly provider = 'anthropic' as const;
  readonly model = 'scripted';
  readonly requests: ProposalRequest[] = [];

  constructor(
    private readonly original: string,
    private readonly answers: ScriptedAnswer[],
  ) {}

  propose(req: ProposalRequest): Promise<ProposalOutcome> {
    this.requests.push(req);
    const n = this.requests.length;
    const a = this.answers[n - 1];
    if (!a) return Promise.resolve({ ok: false, kind: 'invalid', error: 'the script has no answer left' });
    if ('fail' in a) return Promise.resolve({ ok: false, kind: a.fail, error: a.error });
    const code = 'code' in a ? a.code : applyEdits(this.original, a.edits);
    const rationale = 'rationale' in a && a.rationale ? a.rationale : `Scripted answer ${n}.`;
    return Promise.resolve({ ok: true, code, rationale, model: this.model });
  }
}
