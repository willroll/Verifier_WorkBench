import { describe, expect, it } from 'vitest';
import { bitsToHex, checkIncludes, classify, safeFileName } from '@verifier/core';
import { cbmcWitness, parseJsonUi, signatureFrom } from '../src/engines/cbmc';
import {
  esbmcCheckArgs,
  esbmcFunctions,
  esbmcHarness,
  parseClaims,
  parseCounterexamples,
  parseResults,
  parseSymbolTable,
  splitFunctionType,
} from '../src/engines/esbmc';

describe('classify', () => {
  it.each([
    ['arithmetic overflow on signed + in a + b', 'avg.overflow.1', 'overflow'],
    ["array 'buf' upper bound in buf[(signed long int)idx]", 'store.array_bounds.1', 'bounds'],
    ["array bounds violated: array `buf' upper bound", 'store.array-bounds-violated.2', 'bounds'],
    ['unwinding assertion loop 0', 'f.unwind.0', 'unwind'],
    ['unwinding assertion loop 3', 'f.assertion.1', 'unwind'],
    ['arithmetic overflow on signed type conversion in (int8_t)x', 'f.overflow.2', 'conversion'],
    ['dereference failure: pointer outside object bounds in *p', 'f.pointer_dereference.5', 'pointer'],
    ['dereference failure: pointer NULL in *p', 'f.pointer_dereference.1', 'pointer'],
    ['memcpy destination region writeable', 'fill.precondition_instance.3', 'bounds'],
    ['division by zero in x / y', 'f.division-by-zero.1', 'div-by-zero'],
    ['shift distance is negative in x << n', 'f.undefined-shift.1', 'shift'],
    ['assertion x > 0', 'f.assertion.1', 'assertion'],
  ])('%s -> %s', (description, id, kind) => {
    expect(classify(description, id)).toBe(kind);
  });

  it('ignores the function name inside the property id', () => {
    expect(classify('arithmetic overflow on signed + in a + b', 'shift_left.overflow.1')).toBe('overflow');
  });
});

describe('bitsToHex', () => {
  it('converts bit strings, keeping the width', () => {
    expect(bitsToHex('00010000')).toBe('0x10');
    expect(bitsToHex('10000000000000000000000000000000')).toBe('0x80000000');
    expect(bitsToHex('11111111 11111111 11111111 11111111')).toBe('0xffffffff');
    expect(bitsToHex('101')).toBe('0x5');
  });
  it('rejects anything else', () => {
    expect(bitsToHex(undefined)).toBeUndefined();
    expect(bitsToHex('12')).toBeUndefined();
    expect(bitsToHex('')).toBeUndefined();
  });
});

describe('safeFileName', () => {
  it.each([
    ['arith.c', 'arith.c'],
    ['arith', 'arith.c'],
    ['util.h', 'util.c'],
    ['../../etc/passwd', 'passwd.c'],
    ['my file (2).c', 'my_file__2_.c'],
    ['.hidden.c', 'hidden.c'],
    ['', 'input.c'],
    [undefined, 'input.c'],
  ])('%s -> %s', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });
});

describe('checkIncludes', () => {
  it('allows ordinary headers', () => {
    expect(checkIncludes('#include <stdint.h>\n#include "util.h"\n# include <sys/types.h>')).toEqual([]);
  });
  it('rejects absolute paths, parent escapes and computed includes', () => {
    const problems = checkIncludes(
      [
        '#include "/etc/passwd"',
        '#include <../../secret.h>',
        '#include HEADER',
        '#include "C:\\\\x.h"',
        '#include_next "a/../../b.h"',
      ].join('\n'),
    );
    expect(problems.map((p) => p.line)).toEqual([1, 2, 3, 4, 5]);
    expect(problems.every((p) => p.severity === 'error')).toBe(true);
  });
});

describe('CBMC helpers', () => {
  it('builds signatures from prettyType', () => {
    expect(signatureFrom('int32_t (int32_t a, int32_t b)', 'avg')).toBe('int32_t avg(int32_t a, int32_t b)');
    expect(signatureFrom('void (void)', 'f')).toBe('void f(void)');
    expect(signatureFrom('int (*(int x))(int)', 'g')).toBeUndefined();
    expect(signatureFrom(undefined, 'h')).toBeUndefined();
  });

  it('parses JSON-UI, including a run killed mid-array', () => {
    expect(parseJsonUi('[{"program":"CBMC"}]')).toEqual([{ program: 'CBMC' }]);
    expect(parseJsonUi('[{"program":"CBMC"},\n{"messageText":"x"},')).toHaveLength(2);
    expect(parseJsonUi('')).toBeNull();
    expect(parseJsonUi('not json')).toBeNull();
  });

  it('takes inputs from the entry call and skips static initialization', () => {
    const v = (data: string, binary: string) => ({ data, binary, type: 'int32_t', width: 32 });
    const trace = [
      { stepType: 'function-call', function: { identifier: '__CPROVER_initialize' } },
      { stepType: 'assignment', assignmentType: 'variable', lhs: 'buf[0l]', value: v('0', '0') },
      { stepType: 'function-return', function: { identifier: '__CPROVER_initialize' } },
      { stepType: 'function-call', function: { identifier: 'f' } },
      {
        stepType: 'assignment',
        assignmentType: 'actual-parameter',
        lhs: 'a',
        value: v('-1', '1'.repeat(32)),
      },
      {
        stepType: 'assignment',
        assignmentType: 'variable',
        lhs: 'arr',
        value: { name: 'array', elements: [] },
      },
      { stepType: 'assignment', assignmentType: 'variable', lhs: 'arr[0l]', value: v('1', '1') },
      { stepType: 'assignment', assignmentType: 'variable', lhs: 'f#return_value', value: v('0', '0') },
      { stepType: 'function-call', function: { identifier: 'g' } },
      { stepType: 'assignment', assignmentType: 'actual-parameter', lhs: 'a', value: v('7', '111') },
    ];
    const w = cbmcWitness(trace, 'f');
    expect(w[0]).toMatchObject({ name: 'a', value: '-1', role: 'input', hex: '0xffffffff', width: 32 });
    expect(w.map((x) => x.name)).toEqual(['a', 'arr', 'g::a']);
  });
});

describe('ESBMC parsers', () => {
  it('splits function types at top-level commas', () => {
    expect(splitFunctionType('signed int (signed int, signed int)')).toEqual({
      ret: 'signed int',
      params: ['signed int', 'signed int'],
    });
    expect(splitFunctionType('void ()')).toEqual({ ret: 'void', params: [] });
    expect(splitFunctionType('void (void)')).toEqual({ ret: 'void', params: [] });
    expect(splitFunctionType('signed int (signed int (*)(signed int), signed int *, ...)')).toEqual({
      ret: 'signed int',
      params: ['signed int (*)(signed int)', 'signed int *'],
    });
    expect(splitFunctionType('signed int')).toBeNull();
  });

  it('parses the multi-property results block, including right-aligned lines', () => {
    const text = [
      '** Results:',
      'arith.c, function avg',
      '  FAILED       [avg.arithmetic-overflow.1]  line   5  arithmetic overflow on add',
      '  PASSED       [avg.arithmetic-overflow.2]  line   5  arithmetic overflow on div',
      '<esbmc>/pthread.c, function __ESBMC_pthread_end_main_hook',
      '  PASSED       [__ESBMC_pthread_end_main_hook.arithmetic-overflow.1]  line 191  arithmetic overflow on sub',
      '  NOT CHECKED  [avg.assertion.1]  line 7  x',
      '',
      '** 1 of 4 properties failed, 2 passed',
    ].join('\n');
    const r = parseResults(text);
    expect(r.map((x) => [x.status, x.id, x.line, x.function])).toEqual([
      ['FAILED', 'avg.arithmetic-overflow.1', 5, 'avg'],
      ['PASSED', 'avg.arithmetic-overflow.2', 5, 'avg'],
      ['PASSED', '__ESBMC_pthread_end_main_hook.arithmetic-overflow.1', 191, '__ESBMC_pthread_end_main_hook'],
      ['NOT CHECKED', 'avg.assertion.1', 7, '__ESBMC_pthread_end_main_hook'],
    ]);
  });

  it('parses counterexample states and the violated property', () => {
    const text = [
      '[Counterexample]',
      '',
      'State 1 file h.c line 26 column 25 function __vw_h_avg thread 0',
      '----------------------------------------------------',
      '  a = -1 (11111111 11111111 11111111 11111111)',
      '',
      'State 2 file h.c line 5 column 5 function avg thread 0',
      '----------------------------------------------------',
      'Violated property:',
      '  file h.c line 5 column 5 function avg',
      '  arithmetic overflow on add',
      '  !overflow("+", a, b)',
    ].join('\n');
    const [c] = parseCounterexamples(text);
    expect(c?.states).toEqual([
      { file: 'h.c', line: 26, function: '__vw_h_avg', name: 'a', value: '-1', bits: '1'.repeat(32) },
    ]);
    expect(c?.violated).toEqual({
      file: 'h.c',
      line: 5,
      function: 'avg',
      message: 'arithmetic overflow on add',
    });
  });

  it('parses claims', () => {
    const text =
      "Claim 3:\n  file h.c line 13 column 9 function store\n  array bounds violated: array `buf' lower bound\n  x >= 0\n";
    expect(parseClaims(text)).toEqual([
      {
        number: 3,
        file: 'h.c',
        line: 13,
        function: 'store',
        message: "array bounds violated: array `buf' lower bound",
      },
    ]);
  });

  it('finds functions and parameter names, and writes a wrapper per function', () => {
    const table = [
      'Symbol......: c:@F@avg',
      'Type........: signed int (signed int, signed int)',
      'Value.......: ',
      '{',
      'return (a + b) / 2;',
      '}',
      'Location....: file a.c line 4 column 1',
      '',
      'Symbol......: c:a.c@120@F@avg@b',
      'Type........: signed int',
      'Location....: file a.c line 4 column 24 function avg',
      '',
      'Symbol......: c:a.c@86@F@avg@a',
      'Type........: signed int',
      'Location....: file a.c line 4 column 13 function avg',
      '',
      'Symbol......: c:a.c@150@F@avg@tmp',
      'Type........: signed int',
      'Location....: file a.c line 5 column 5 function avg',
      '',
      'Symbol......: c:a.c@F@helper',
      'Type........: void ( struct pt)',
      'Value.......: ',
      '{ }',
      'Location....: file a.c line 9 column 1',
      '',
      'Symbol......: c:@F@declared_only',
      'Type........: signed int (void)',
      'Value.......: ',
      'Location....: file a.c line 2 column 1',
    ].join('\n');
    const fns = esbmcFunctions(parseSymbolTable(table), 'a.c');
    expect(fns.map((f) => f.name)).toEqual(['avg', 'helper']);
    expect(fns[0]).toMatchObject({
      signature: 'signed int avg(signed int a, signed int b)',
      params: [
        { type: 'signed int', local: 'a', display: 'a' },
        { type: 'signed int', local: 'b', display: 'b' },
      ],
    });
    const harness = esbmcHarness(fns);
    expect(harness).toContain('__typeof__(signed int) a = __vw_nd_avg_0();');
    expect(harness).toContain('(void)avg(a, b);');
    expect(harness).toContain('__typeof__(struct pt) arg0 = __vw_nd_helper_0();');
  });

  it('maps checks to ESBMC flags (bounds, pointer, division are on by default)', () => {
    expect(esbmcCheckArgs(['bounds', 'pointer', 'div-by-zero', 'signed-overflow'])).toEqual([
      '--overflow-check',
    ]);
    expect(esbmcCheckArgs(['signed-overflow', 'unsigned-overflow', 'undefined-shift'])).toEqual([
      '--no-bounds-check',
      '--no-pointer-check',
      '--no-div-by-zero-check',
      '--overflow-check',
      '--unsigned-overflow-check',
      '--ub-shift-check',
    ]);
  });
});
