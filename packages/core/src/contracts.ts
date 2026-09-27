import type { EngineId } from '@verifier/shared';
import { blankCommentsAndStrings } from './repair/text';

// Preconditions. `VW_REQUIRE(expr)` (alias `VW_ASSUME(expr)`) inside a function
// states a precondition the caller is responsible for — the contracts real
// code relies on, such as an index already bounded by its caller. The checker
// then verifies the function only for inputs where the expression holds,
// instead of for every possible input, so an honestly-guarded caller does not
// look like a defect.
//
// A macro is expanded to the engine's assume builtin as a same-line textual
// substitution, so source line numbers are preserved exactly.

export const CONTRACT_MACROS = ['VW_REQUIRE', 'VW_ASSUME'] as const;

const ASSUME: Record<EngineId, string> = {
  cbmc: '__CPROVER_assume',
  esbmc: '__ESBMC_assume',
};

const MACRO = /\b(VW_REQUIRE|VW_ASSUME)\b/;
const MACRO_G = /\b(VW_REQUIRE|VW_ASSUME)\b/g;

/** True if the source uses any precondition macro. */
export const hasContracts = (code: string) => MACRO.test(code);

/** Replace the precondition macros with the engine's assume builtin. */
export function expandContracts(code: string, engine: EngineId): string {
  return code.replace(MACRO_G, ASSUME[engine]);
}

export interface Precondition {
  /** The macro used, e.g. "VW_REQUIRE". */
  macro: string;
  /** The C expression asserted as a precondition. */
  expr: string;
  /** 1-based line in the user's source. */
  line: number;
}

/**
 * The preconditions a source states, in order. Comments and string literals
 * are blanked first (keeping positions), so a macro name in either does not
 * count and a `)` inside a string does not close the argument early.
 */
export function parseContracts(code: string): Precondition[] {
  const blanked = blankCommentsAndStrings(code);
  const out: Precondition[] = [];
  const re = /\b(VW_REQUIRE|VW_ASSUME)\b[ \t]*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked))) {
    const open = m.index + m[0].length - 1; // the '(' after the macro name
    let depth = 0;
    let i = open;
    for (; i < blanked.length; i++) {
      const c = blanked[i];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (depth !== 0) break; // unbalanced; leave the rest to the compiler
    const expr = code
      .slice(open + 1, i)
      .trim()
      .replace(/\s+/g, ' ');
    out.push({ macro: m[1]!, expr, line: code.slice(0, m.index).split('\n').length });
    re.lastIndex = i + 1;
  }
  return out;
}

/** A precondition that can never hold, e.g. VW_REQUIRE(0) — every proof under it is vacuous. */
export const isTriviallyFalse = (expr: string) => /^(0|false|0[uU]?[lL]{0,2})$/.test(expr.trim());
