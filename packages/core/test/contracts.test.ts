import { describe, expect, it } from 'vitest';
import {
  contractedCallsFrom,
  expandContracts,
  expandContractsForEntry,
  hasContracts,
  isTriviallyFalse,
  parseContracts,
  preconditionOf,
} from '../src/contracts';
import { sourceGuards } from '../src/repair/guards';

// Preconditions: VW_REQUIRE(expr) / VW_ASSUME(expr) state a caller contract.
// These are pure tests of the parse/expand/guard mechanics; the end-to-end
// "proved under the precondition, refuted without it" lives in cfs-examples.

const SRC = `#include <stdint.h>
void store(uint16_t i, uint8_t v) {
    VW_REQUIRE(i < 176);
    table[i] = v;
}
`;

describe('contracts: detection', () => {
  it('reports whether any precondition macro is present', () => {
    expect(hasContracts(SRC)).toBe(true);
    expect(hasContracts('int f(void) { return 0; }')).toBe(false);
    expect(hasContracts('int VW_REQUIREMENT = 1;')).toBe(false); // word boundary, not a prefix
  });
});

describe('contracts: expandContracts', () => {
  it('rewrites the macro to the engine assume builtin', () => {
    expect(expandContracts(SRC, 'cbmc')).toContain('__CPROVER_assume(i < 176)');
    expect(expandContracts(SRC, 'esbmc')).toContain('__ESBMC_assume(i < 176)');
  });

  it('preserves the line count exactly so counterexample lines stay true', () => {
    const out = expandContracts(SRC, 'cbmc');
    expect(out.split('\n')).toHaveLength(SRC.split('\n').length);
    // The macro sits on the same line it did before.
    expect(out.split('\n')[2]).toContain('__CPROVER_assume(i < 176)');
  });

  it('expands the VW_ASSUME alias too, and leaves other code untouched', () => {
    const code = 'VW_ASSUME(n > 0);\nx = n;';
    expect(expandContracts(code, 'cbmc')).toBe('__CPROVER_assume(n > 0);\nx = n;');
  });
});

describe('contracts: parseContracts', () => {
  it('extracts the macro, expression and 1-based line', () => {
    expect(parseContracts(SRC)).toEqual([{ macro: 'VW_REQUIRE', expr: 'i < 176', line: 3 }]);
  });

  it('collapses inner whitespace in the expression', () => {
    expect(parseContracts('VW_REQUIRE(  a   &&\n  b  );')[0]!.expr).toBe('a && b');
  });

  it('balances nested parentheses in the argument', () => {
    const [p] = parseContracts('VW_REQUIRE(f(x) < g(y, z));');
    expect(p!.expr).toBe('f(x) < g(y, z)');
  });

  it('ignores a macro name inside a comment or string literal', () => {
    const code = ['// VW_REQUIRE(0) in a comment', 'const char *s = "VW_REQUIRE(0)";', 'VW_REQUIRE(x);'].join(
      '\n',
    );
    const got = parseContracts(code);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ expr: 'x', line: 3 });
  });

  it('returns nothing for code with no preconditions', () => {
    expect(parseContracts('int f(void){return 0;}')).toEqual([]);
  });
});

describe('contracts: isTriviallyFalse', () => {
  it('flags constants that can never hold', () => {
    for (const e of ['0', ' false ', '0u', '0UL', '0LL']) expect(isTriviallyFalse(e)).toBe(true);
  });
  it('does not flag a real condition or a true constant', () => {
    for (const e of ['1', 'i < 176', 'x != 0', '']) expect(isTriviallyFalse(e)).toBe(false);
  });
});

describe('contracts: repair guard keeps the precondition fixed', () => {
  const patch = (from: string, to: string) => SRC.replace(from, to);

  it('passes a patch that repairs the body but keeps the precondition', () => {
    const fixed = patch('table[i] = v;', 'if (i < 176) table[i] = v;');
    expect(sourceGuards(SRC, fixed, SRC)).toBeNull();
  });

  it('rejects weakening the precondition', () => {
    const weak = patch('VW_REQUIRE(i < 176);', 'VW_REQUIRE(i < 1000000);');
    expect(sourceGuards(SRC, weak, SRC)?.guard).toBe('contracts');
  });

  it('rejects dropping the precondition', () => {
    const dropped = patch('    VW_REQUIRE(i < 176);\n', '');
    expect(sourceGuards(SRC, dropped, SRC)?.guard).toBe('contracts');
  });

  it('rejects adding a precondition that was not given', () => {
    const added = patch('table[i] = v;', 'VW_REQUIRE(v != 0);\n    table[i] = v;');
    expect(sourceGuards(SRC, added, SRC)?.guard).toBe('contracts');
  });
});

describe('contracts: per-entry transform (assume/guarantee)', () => {
  // A callee with a precondition and two callers of it, one guarded correctly.
  const CALLER = `#include <stdint.h>
void store(uint16_t i, uint8_t v) {
    VW_REQUIRE(i < 176);
    table[i] = v;
}
void process(uint16_t idx, uint8_t v) {
    if (idx < 176) store(idx, v);
}
`;
  const fns = [
    { name: 'store', line: 2 },
    { name: 'process', line: 6 },
  ];

  it('assumes a function’s own precondition when it is the entry', () => {
    const out = expandContractsForEntry(CALLER, 'cbmc', 'store', fns);
    expect(out).toContain('__CPROVER_assume(i < 176)');
    expect(out).not.toContain('__CPROVER_assert');
  });

  it('asserts a called callee’s precondition, with the marker, in the caller’s run', () => {
    const out = expandContractsForEntry(CALLER, 'cbmc', 'process', fns);
    expect(out).toContain('__CPROVER_assert(i < 176, "vw-precondition")');
    expect(out).not.toContain('__CPROVER_assume');
  });

  it('uses the engine’s assert builtin', () => {
    expect(expandContractsForEntry(CALLER, 'esbmc', 'process', fns)).toContain('__ESBMC_assert(i < 176,');
  });

  it('keeps the line count exact so counterexample lines stay true', () => {
    for (const entry of ['store', 'process']) {
      const out = expandContractsForEntry(CALLER, 'cbmc', entry, fns);
      expect(out.split('\n')).toHaveLength(CALLER.split('\n').length);
    }
  });

  it('reports the contracted callees a function calls', () => {
    expect(contractedCallsFrom(CALLER, 'process', fns)).toEqual(['store']);
    expect(contractedCallsFrom(CALLER, 'store', fns)).toEqual([]);
  });

  it('does not assert the precondition of a callee the entry never calls', () => {
    // `other` does not call store, so store's precondition stays an assume.
    const twoCallers = CALLER + `void other(void) { return; }\n`;
    const out = expandContractsForEntry(twoCallers, 'cbmc', 'other', [...fns, { name: 'other', line: 9 }]);
    expect(out).not.toContain('__CPROVER_assert');
  });

  it('exposes a function’s precondition expression', () => {
    expect(preconditionOf(CALLER, 'store', fns)).toBe('i < 176');
    expect(preconditionOf(CALLER, 'process', fns)).toBeUndefined();
  });
});
