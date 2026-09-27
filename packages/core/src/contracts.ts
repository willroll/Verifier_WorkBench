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
//
// When another function in the same file *calls* a contracted one, the callee's
// precondition is instead expanded to a marked assert in that caller's run
// (see expandContractsForEntry): the caller must prove it passes arguments the
// callee's contract allows. This is assume/guarantee reasoning — assume a
// function's own precondition when verifying it, assert it at every call site.

export const CONTRACT_MACROS = ['VW_REQUIRE', 'VW_ASSUME'] as const;

/** Description on a callee-precondition assert, so a caller run can spot it. */
export const CONTRACT_MARKER = 'vw-precondition';

const ASSUME: Record<EngineId, string> = {
  cbmc: '__CPROVER_assume',
  esbmc: '__ESBMC_assume',
};
const ASSERT: Record<EngineId, string> = {
  cbmc: '__CPROVER_assert',
  esbmc: '__ESBMC_assert',
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

/** A precondition macro with the character offsets of its call, for rewriting. */
interface ContractSite extends Precondition {
  /** Index of the macro name. */
  nameStart: number;
  /** Index of the '(' opening the argument. */
  open: number;
  /** Index of the matching ')'. */
  close: number;
}

/**
 * Every precondition macro with its offsets. Comments and string literals are
 * blanked first (keeping positions), so a macro name in either does not count
 * and a `)` inside a string does not close the argument early.
 */
function contractSites(code: string): ContractSite[] {
  const blanked = blankCommentsAndStrings(code);
  const out: ContractSite[] = [];
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
    out.push({
      macro: m[1]!,
      expr,
      line: code.slice(0, m.index).split('\n').length,
      nameStart: m.index,
      open,
      close: i,
    });
    re.lastIndex = i + 1;
  }
  return out;
}

/**
 * The preconditions a source states, in order.
 */
export function parseContracts(code: string): Precondition[] {
  return contractSites(code).map(({ macro, expr, line }) => ({ macro, expr, line }));
}

/** A function's name and 1-based definition line, enough to locate contracts. */
export interface FnLine {
  name: string;
  line: number;
}

/** The function whose body a source line falls in: the last one defined at or before it. */
function ownerOf(line: number, byLine: FnLine[]): string | undefined {
  let fn: string | undefined;
  for (const f of byLine) if (f.line <= line) fn = f.name;
  return fn;
}

/**
 * Which of `candidates` the function `entry` calls, by a textual scan of its
 * body (from its definition line to the next function's). Conservative: an
 * indirect call through a function pointer is not matched, so that call simply
 * goes unchecked rather than being reported wrongly.
 */
function calledCallees(code: string, entry: string, byLine: FnLine[], candidates: Set<string>): Set<string> {
  const out = new Set<string>();
  if (candidates.size === 0) return out;
  const idx = byLine.findIndex((f) => f.name === entry);
  if (idx < 0) return out;
  const start = byLine[idx]!.line;
  const end = idx + 1 < byLine.length ? byLine[idx + 1]!.line : Infinity;
  const lines = blankCommentsAndStrings(code).split('\n');
  const body = lines.slice(start - 1, end === Infinity ? undefined : end - 1).join('\n');
  for (const name of candidates) {
    // C identifiers only (from the symbol table), so no regex escaping needed.
    if (new RegExp(`\\b${name}\\s*\\(`).test(body)) out.add(name);
  }
  return out;
}

/**
 * Expand contracts for one entry function's run. The entry's own precondition
 * becomes an assume (it is verified only where its contract holds); the
 * precondition of every *other* contracted function the entry calls becomes a
 * marked assert, so the entry must prove it honors that callee's contract. All
 * substitutions stay on their original line, so counterexample lines hold.
 */
export function expandContractsForEntry(
  code: string,
  engine: EngineId,
  entry: string,
  functions: FnLine[],
): string {
  const sites = contractSites(code);
  if (sites.length === 0) return code;
  const byLine = [...functions].sort((a, b) => a.line - b.line);
  const contractedCallees = new Set(
    sites.map((s) => ownerOf(s.line, byLine)).filter((f): f is string => !!f && f !== entry),
  );
  const called = calledCallees(code, entry, byLine, contractedCallees);

  let out = '';
  let pos = 0;
  for (const s of sites) {
    const owner = ownerOf(s.line, byLine);
    const asAssert = owner !== undefined && owner !== entry && called.has(owner);
    out += code.slice(pos, s.nameStart);
    out += asAssert
      ? `${ASSERT[engine]}${code.slice(s.open, s.close)}, "${CONTRACT_MARKER}")`
      : `${ASSUME[engine]}${code.slice(s.open, s.close + 1)}`;
    pos = s.close + 1;
  }
  return out + code.slice(pos);
}

/** The contracted callees `entry` calls in this source (those whose contract it must honor). */
export function contractedCallsFrom(code: string, entry: string, functions: FnLine[]): string[] {
  const sites = contractSites(code);
  if (sites.length === 0) return [];
  const byLine = [...functions].sort((a, b) => a.line - b.line);
  const contracted = new Set(
    sites.map((s) => ownerOf(s.line, byLine)).filter((f): f is string => !!f && f !== entry),
  );
  return [...calledCallees(code, entry, byLine, contracted)];
}

/** The precondition expression stated by a given function, if any (its first VW_REQUIRE). */
export function preconditionOf(code: string, fn: string, functions: FnLine[]): string | undefined {
  const byLine = [...functions].sort((a, b) => a.line - b.line);
  return contractSites(code).find((s) => ownerOf(s.line, byLine) === fn)?.expr;
}

/** A precondition that can never hold, e.g. VW_REQUIRE(0) — every proof under it is vacuous. */
export const isTriviallyFalse = (expr: string) => /^(0|false|0[uU]?[lL]{0,2})$/.test(expr.trim());
