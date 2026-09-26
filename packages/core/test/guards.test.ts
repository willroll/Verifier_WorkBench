import { describe, expect, it } from 'vitest';
import type { Counts, Finding, FunctionSummary, VerifyResult } from '@verifier/shared';
import type { FunctionInfo } from '../src/engines/types';
import { hunks, lineDiff, sameLayout } from '../src/repair/diff';
import {
  changedFunctions,
  globalsRejection,
  interpretProof,
  type EqFunction,
  type EqGlobal,
  type EqProgram,
} from '../src/repair/equivalence';
import {
  behaviorRejection,
  inconclusiveGuard,
  obligationsGuard,
  signatureGuard,
  sourceGuards,
} from '../src/repair/guards';
import { attemptPrompt, describeRefuted, stablePrompt } from '../src/repair/prompt';
import {
  added,
  assertionConditions,
  assertionMacros,
  blankCommentsAndStrings,
  removed,
  terminatingCalls,
  verifierConstructs,
} from '../src/repair/text';

const ORIGINAL = `#include <assert.h>
int f(int a) {
    assert(a != 3);
    return a + 1;
}
`;

describe('source scanning', () => {
  it('blanks comments and literals but keeps positions and newlines', () => {
    const code = "a = \"x // y\"; // __CPROVER_assume(0)\n/* abort(); */ b = '\\'';";
    const out = blankCommentsAndStrings(code);
    expect(out).toHaveLength(code.length);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toMatch(/CPROVER|abort|x/);
    expect(out).toContain('a = "');
  });

  it('counts verifier constructs in code only', () => {
    const code = [
      '// __CPROVER_assume(x) in a comment',
      'const char *s = "__ESBMC_assume";',
      '__CPROVER_assume(x > 0); __CPROVER_assume(y);',
      '#pragma CPROVER check disable "bounds"',
      'int __vw_x;',
      '__builtin_unreachable();',
    ].join('\n');
    expect(Object.fromEntries(verifierConstructs(code))).toEqual({
      __CPROVER_assume: 2,
      '#pragma CPROVER check disable "bounds"': 1,
      __vw_x: 1,
      __builtin_unreachable: 1,
    });
  });

  it('reads assertion conditions regardless of spacing', () => {
    const code = 'assert( f(a, (b)) );\n/* assert(0); */\nstatic_assert(sizeof(int) == 4, "x");';
    expect([...assertionConditions(code).keys()]).toEqual([
      'assert(f(a,(b)))',
      'static_assert(sizeof(int)==4,"")',
    ]);
  });

  it('finds macros that switch assertions off, and terminating calls', () => {
    expect([...assertionMacros('#define NDEBUG\n# undef assert\n#define ASSERTS 1').keys()]).toEqual([
      '#define NDEBUG',
      '#undef assert',
    ]);
    const calls = terminatingCalls('abort(); exit (1); exit_code(2); puts("exit(3)"); longjmp(env, 1);');
    expect(Object.fromEntries(calls)).toEqual({ abort: 1, exit: 1, longjmp: 1 });
  });

  it('compares counts', () => {
    const before = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    const after = new Map([
      ['b', 1],
      ['c', 1],
    ]);
    expect(added(before, after)).toEqual(['c']);
    expect(removed(before, after)).toEqual(['a', 'b']);
  });
});

describe('source guards', () => {
  const patch = (from: string, to: string) => ORIGINAL.replace(from, to);
  const guard = (candidate: string, baseline = ORIGINAL) =>
    sourceGuards(ORIGINAL, candidate, baseline)?.guard;

  it('passes an ordinary fix', () => {
    expect(
      sourceGuards(ORIGINAL, patch('return a + 1;', 'return a < 2147483647 ? a + 1 : a;'), ORIGINAL),
    ).toBeNull();
  });

  it('rejects empty and unchanged answers', () => {
    expect(guard(' \n')).toBe('empty');
    expect(guard(ORIGINAL.replace(/\n/g, '   \n') + '\n\n')).toBe('unchanged');
    const better = patch('a + 1', 'a + 1u');
    expect(guard(better, better)).toBe('unchanged');
  });

  it('rejects includes that could read host files', () => {
    expect(guard(`#include "../secret.h"\n${ORIGINAL}`)).toBe('includes');
  });

  it('rejects added verifier constructs but keeps ones the original had', () => {
    expect(guard(patch('return', '__CPROVER_assume(a < 100);\n    return'))).toBe('verifier-intrinsics');
    expect(guard(patch('return', '__builtin_assume(a < 100);\n    return'))).toBe('verifier-intrinsics');
    expect(guard(patch('return', '#pragma CPROVER check disable "signed-overflow"\n    return'))).toBe(
      'verifier-intrinsics',
    );
    const withIntrinsic = patch('return', '__CPROVER_assume(a < 100);\n    return');
    expect(sourceGuards(withIntrinsic, withIntrinsic.replace('a + 1', 'a + 2'), withIntrinsic)).toBeNull();
  });

  it('rejects pragmas in any form and inline assembly', () => {
    expect(guard(patch('return', '_Pragma("CPROVER check disable \\"signed-overflow\\"")\n    return'))).toBe(
      'verifier-intrinsics',
    );
    expect(guard(patch('return a + 1;', 'int r; __asm__("" : "=r"(r)); return r;'))).toBe(
      'verifier-intrinsics',
    );
  });

  it('rejects macros that redefine existing names or keywords, but allows new ones', () => {
    const withMacro = (line: string) => `${ORIGINAL}${line}\n`;
    const r = sourceGuards(ORIGINAL, withMacro('#define f(x) 0'), ORIGINAL);
    expect(r?.guard).toBe('macros');
    expect(r?.message).toMatch(/redefines `f` with a macro/);
    expect(guard(withMacro('#define sizeof(x) 0'))).toBe('macros');
    expect(guard(withMacro('#  undef __typeof__'))).toBe('macros');
    expect(
      guard(patch('return a + 1;', 'return a < LIMIT ? a + 1 : a;') + '#define LIMIT 100\n'),
    ).toBeUndefined();
    const withLimit = `#define LIMIT 100\n${ORIGINAL}`;
    expect(sourceGuards(withLimit, withLimit.replace('LIMIT 100', 'LIMIT 99'), withLimit)).toBeNull();
  });

  it('rejects removed, changed or disabled assertions', () => {
    expect(guard(patch('    assert(a != 3);\n', ''))).toBe('assertions');
    expect(guard(patch('a != 3', 'a != 4'))).toBe('assertions');
    expect(guard(`#define NDEBUG\n${ORIGINAL}`)).toBe('assertions');
    expect(guard(patch('assert(a != 3);', 'assert( a!=3 );'))).toBeUndefined();
  });

  it('rejects ending the program to avoid a defect', () => {
    const r = sourceGuards(ORIGINAL, patch('return', 'if (a == 2147483647) exit(1);\n    return'), ORIGINAL);
    expect(r?.guard).toBe('termination');
    expect(r?.message).toMatch(/call to `exit`/);
  });
});

const fn = (name: string, typeKey?: string, signature?: string): FunctionInfo => ({
  name,
  line: 1,
  obligations: [],
  ...(typeKey ? { typeKey } : {}),
  ...(signature ? { signature } : {}),
});

describe('signature guard', () => {
  it('requires every original function with the same type', () => {
    expect(signatureGuard([fn('f', 'k1')], [fn('f', 'k1'), fn('helper', 'k2')])).toBeNull();
    expect(signatureGuard([fn('f', 'k1'), fn('g', 'k2')], [fn('f', 'k1')])?.message).toMatch(
      /`g` is no longer defined/,
    );
    const changed = signatureGuard([fn('f', 'k1', 'int f(int a)')], [fn('f', 'k2', 'long f(long a)')]);
    expect(changed?.message).toBe(
      'The signature of `f` changed (was `int f(int a)`, now `long f(long a)`); keep every signature exactly.',
    );
  });

  it('falls back to the printed signature when there is no type key', () => {
    expect(signatureGuard([fn('f', undefined, 'int f(int)')], [fn('f', undefined, 'int f(int)')])).toBeNull();
    expect(
      signatureGuard([fn('f', undefined, 'int f(int)')], [fn('f', undefined, 'int f(long)')])?.guard,
    ).toBe('signature');
  });
});

const counts = (proved: number, refuted: number, inconclusive: number): Counts => ({
  proved,
  refuted,
  inconclusive,
});
const summary = (name: string, c: Counts, error?: string): FunctionSummary => ({
  name,
  line: 1,
  status: 'proved',
  counts: c,
  durationMs: 0,
  ...(error ? { error } : {}),
});
const result = (functions: FunctionSummary[]): VerifyResult => ({
  engine: 'cbmc',
  engineLabel: 'CBMC',
  engineVersion: '5.95.1',
  available: true,
  status: 'refuted',
  counts: counts(0, 0, 0),
  findings: [],
  functions,
  solver: null,
  harness: 'per-function',
  bounds: { unwind: 16, unwindingAssertions: true },
  checks: ['bounds'],
  diagnostics: [],
  durationMs: 0,
});

describe('result guards', () => {
  it('rejects obligations that became undecided', () => {
    const before = result([summary('f', counts(1, 1, 0))]);
    expect(inconclusiveGuard(before, result([summary('f', counts(2, 0, 0))]))).toBeNull();
    const looped = inconclusiveGuard(before, result([summary('f', counts(0, 0, 2))]));
    expect(looped?.guard).toBe('inconclusive');
    expect(looped?.message).toMatch(/more than 16 iterations/);
    const timedOut = inconclusiveGuard(
      before,
      result([summary('f', counts(0, 0, 1), 'timed out after 60 s')]),
    );
    expect(timedOut?.message).toMatch(/timed out/);
    expect(
      inconclusiveGuard(before, result([summary('f', counts(2, 0, 0)), summary('h', counts(0, 0, 1))]))
        ?.message,
    ).toMatch(/in `h` \(the original had 0\)/);
  });

  it('rejects vanished obligations unless behavior was proved unchanged', () => {
    const before = result([summary('f', counts(1, 1, 0)), summary('g', counts(0, 0, 0))]);
    const after = result([summary('f', counts(0, 0, 0)), summary('g', counts(0, 0, 0))]);
    expect(obligationsGuard(before, after, [])?.message).toMatch(
      /Every check in `f` disappeared \(the original had 2\)/,
    );
    expect(
      obligationsGuard(before, after, [
        { function: 'f', status: 'skipped', reason: 'it takes pointer parameters' },
      ])?.message,
    ).toMatch(/\(it takes pointer parameters\)/);
    expect(obligationsGuard(before, after, [{ function: 'f', status: 'equivalent' }])).toBeNull();
  });

  it('rejects a patch whose behavior proof did not finish', () => {
    const r = behaviorRejection([
      { function: 'f', status: 'equivalent' },
      { function: 'g', status: 'inconclusive', reason: 'the proof timed out' },
    ]);
    expect(r?.guard).toBe('behavior');
    expect(r?.message).toMatch(
      /^The proof that `g` behaves as before did not finish \(the proof timed out\)/,
    );
    expect(
      behaviorRejection([{ function: 'h', status: 'skipped', reason: 'pointer parameters' }]),
    ).toBeNull();
  });

  it('turns the first behavior difference into a rejection', () => {
    expect(behaviorRejection([{ function: 'f', status: 'equivalent' }])).toBeNull();
    const r = behaviorRejection([
      { function: 'g', status: 'skipped' },
      {
        function: 'f',
        status: 'different',
        reason: 'the return value differs',
        inputs: [{ name: 'a', value: '1', role: 'input' }],
        original: '2',
        candidate: '3',
      },
    ]);
    expect(r).toEqual({
      guard: 'behavior',
      message:
        '`f(a = 1)` is well-defined in the original, but the return value differs (original: 2, patched: 3). ' +
        'Change behavior only on inputs where the original has undefined behavior or fails an assertion.',
    });
  });
});

describe('diff', () => {
  it('diffs lines and keeps context around changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    const d = lineDiff(before, after);
    expect(d.filter((x) => x.type !== ' ')).toEqual([
      { type: '-', text: 'b', oldLine: 2 },
      { type: '+', text: 'B', newLine: 2 },
      { type: '+', text: 'i', newLine: 9 },
    ]);
    // Context lines know both positions.
    expect(d.find((x) => x.text === 'h')).toEqual({ type: ' ', text: 'h', oldLine: 8, newLine: 8 });
    expect(hunks(d, 1).map((x) => (x.type === '@' ? '@@' : `${x.type}${x.text}`))).toEqual([
      ' a',
      '-b',
      '+B',
      ' c',
      '@@',
      ' h',
      '+i',
    ]);
  });

  it("gives a model's answer the original's line endings and final newline", () => {
    expect(sameLayout('a\nb', 'a\nB\n')).toBe('a\nB');
    expect(sameLayout('a\nb\n', 'a\nB')).toBe('a\nB\n');
    expect(sameLayout('a\r\nb\r\n', 'a\nB')).toBe('a\r\nB\r\n');
    expect(sameLayout('a\nb\n', 'a\r\nB\r\n\n\n')).toBe('a\nB\n');
    expect(lineDiff('a\nb', sameLayout('a\nb', 'a\nB\n')).filter((x) => x.type !== ' ')).toEqual([
      { type: '-', text: 'b', oldLine: 2 },
      { type: '+', text: 'B', newLine: 2 },
    ]);
  });

  it('stays correct when the changed middle is too large for the table', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `x${i}`).join('\n');
    const after = Array.from({ length: 2100 }, (_, i) => `y${i}`).join('\n');
    const d = lineDiff(before, after);
    expect(d.filter((x) => x.type === '-')).toHaveLength(2100);
    expect(d.filter((x) => x.type === '+')).toHaveLength(2100);
  });
});

const finding = (over: Partial<Finding>): Finding => ({
  id: 'f.overflow.1',
  status: 'refuted',
  kind: 'overflow',
  message: 'arithmetic overflow on signed + in a + b',
  file: 'x.c',
  line: 5,
  function: 'f',
  entry: 'f',
  model: [],
  trace: [],
  ...over,
});

describe('prompt', () => {
  it('lists refuted obligations with their counterexamples', () => {
    const text = describeRefuted([
      finding({
        model: [
          { name: 'a', value: '2147483647', role: 'input' },
          { name: 'b', value: '1', role: 'input' },
          ...Array.from({ length: 8 }, (_, i) => ({
            name: `s${i}`,
            value: String(i),
            role: 'state' as const,
          })),
        ],
      }),
      finding({ status: 'proved', message: 'not listed' }),
      finding({ function: 'memcpy', entry: 'fill', line: 30, message: 'bounds', note: 'Arbitrary pointer.' }),
    ]);
    expect(text).toBe(
      [
        '1. `f`, line 5: arithmetic overflow on signed + in a + b',
        '   Inputs: a = 2147483647, b = 1',
        '   Values on the failing path: s0 = 0, s1 = 1, s2 = 2, s3 = 3, s4 = 4, s5 = 5',
        '2. `memcpy`, line 30 (reached from `fill`): bounds',
        '   Note: Arbitrary pointer.',
      ].join('\n'),
    );
    expect(describeRefuted(Array.from({ length: 23 }, () => finding({})))).toMatch(/\n… and 3 more\.$/);
  });

  it('puts the source and settings in the stable part', () => {
    const r = { ...result([]), counts: counts(0, 1, 0), findings: [finding({})] };
    const text = stablePrompt({ fileName: 'x.c', code: 'int f(void);\n', result: r });
    expect(text).toContain('File `x.c`:\n\n```c\nint f(void);\n```');
    expect(text).toContain(
      '(CBMC 5.95.1; loops unwound up to 16 times; checks: bounds) refuted 1 obligation(s):',
    );
  });

  it('feeds back what happened to the previous attempt', () => {
    const rejected = attemptPrompt({
      iter: 2,
      maxIters: 3,
      feedback: {
        kind: 'rejected',
        rejection: { guard: 'signature', message: 'The signature of `f` changed.' },
        diff: [
          { type: '-', text: 'int f(int a) {' },
          { type: '+', text: 'long f(long a) {' },
        ],
      },
    });
    expect(rejected).toBe(
      [
        'Attempt 2 of 3.',
        '',
        'Your previous attempt was rejected: The signature of `f` changed.',
        '',
        'It made this change:',
        '',
        '```diff\n-int f(int a) {\n+long f(long a) {\n```',
        '',
        'Return the complete patched file.',
      ].join('\n'),
    );
    const building = attemptPrompt({
      iter: 3,
      maxIters: 3,
      best: {
        code: 'int f(int a);\n',
        result: { ...result([]), counts: counts(1, 1, 0), findings: [finding({})] },
        before: 2,
      },
    });
    expect(building).toContain('reduced the refuted obligations from 2 to 1');
    expect(building).toContain('```c\nint f(int a);\n```');
    expect(building.endsWith('building on the version above.')).toBe(true);
  });
});

const eqFn = (name: string, body: string, callees: string[] = []): EqFunction => ({
  name,
  line: 1,
  typeKey: 'k',
  params: [{ name: 'a', declType: 'int', scalar: true }],
  returns: 'scalar',
  body,
  callees,
  undefinedCalls: [],
  variadic: false,
});
const program = (functions: EqFunction[], globals: EqGlobal[] = []): EqProgram => ({
  functions: new Map(functions.map((f) => [f.name, f])),
  globals: new Map(globals.map((g) => [g.name, g])),
});
const global = (name: string, initializer = '0', typeKey = 't'): EqGlobal => ({
  name,
  typeKey,
  kind: 'scalar',
  initializer,
});

describe('what the behavior proof covers', () => {
  it('proves changed functions and everything that calls them', () => {
    const original = program([
      eqFn('leaf', 'x'),
      eqFn('mid', 'y', ['leaf']),
      eqFn('top', 'z', ['mid']),
      eqFn('other', 'w'),
    ]);
    expect(changedFunctions(original, program([...original.functions.values()]))).toEqual([]);
    const candidate = program([
      eqFn('leaf', 'x2'),
      eqFn('mid', 'y', ['leaf']),
      eqFn('top', 'z', ['mid']),
      eqFn('other', 'w'),
    ]);
    expect(changedFunctions(original, candidate)).toEqual(['leaf', 'mid', 'top']);
    // A new helper counts as changed, and so does its caller.
    const helper = program([
      eqFn('leaf', 'x'),
      eqFn('mid', 'y', ['leaf']),
      eqFn('top', 'z', ['mid']),
      eqFn('other', 'w2', ['helper']),
      eqFn('helper', 'h'),
    ]);
    expect(changedFunctions(original, helper)).toEqual(['other']);
  });

  it('treats a changed initializer as changing every function', () => {
    const original = program([eqFn('f', 'x'), eqFn('g', 'y')], [global('n', '0')]);
    const candidate = program([eqFn('f', 'x'), eqFn('g', 'y')], [global('n', '1')]);
    expect(changedFunctions(original, candidate)).toEqual(['f', 'g']);
  });

  it('rejects removed or retyped globals', () => {
    const original = program([], [global('n')]);
    expect(globalsRejection(original, program([], [global('n')]))).toBeNull();
    expect(globalsRejection(original, program([]))?.message).toBe(
      'The global variable n was removed; keep every global variable.',
    );
    expect(globalsRejection(original, program([], [global('n', '0', 't2')]))?.message).toBe(
      'The type of the global variable n changed; keep its type.',
    );
  });
});

describe('reading a proof', () => {
  const f = eqFn('f', 'x');
  const run = { timedOut: false };

  it('is inconclusive when the proof did not finish', () => {
    expect(interpretProof(f, null, { timedOut: true })).toEqual({
      function: 'f',
      status: 'inconclusive',
      reason: 'the proof timed out',
    });
    expect(interpretProof(f, [{ messageType: 'ERROR', messageText: 'out of memory' }], run).reason).toBe(
      'the proof did not run: out of memory',
    );
    const unwound = [
      { result: [{ property: 'p', status: 'FAILURE', description: 'unwinding assertion loop 0' }] },
    ];
    expect(interpretProof(f, unwound, run).status).toBe('inconclusive');
  });

  it('reports a difference with its inputs', () => {
    const msgs = [
      {
        result: [
          {
            property: 'p',
            status: 'FAILURE',
            description: 'vw-equivalence: return value',
            trace: [
              { stepType: 'assignment', lhs: '__vw_a0', value: { data: '7', binary: '00000111' } },
              { stepType: 'assignment', lhs: '__vw_ro', value: { data: '8' } },
              { stepType: 'assignment', lhs: '__vw_rc', value: { data: '9ul' } },
            ],
          },
        ],
      },
    ];
    expect(interpretProof(f, msgs, run)).toEqual({
      function: 'f',
      status: 'different',
      reason: 'the return value differs',
      inputs: [{ name: 'a', value: '7', role: 'input', hex: '0x07' }],
      original: '8',
      candidate: '9',
    });
  });

  it('is equivalent when every comparison holds', () => {
    const msgs = [
      { result: [{ property: 'p', status: 'SUCCESS', description: 'vw-equivalence: return value' }] },
    ];
    expect(interpretProof(f, msgs, run)).toEqual({ function: 'f', status: 'equivalent' });
  });
});
