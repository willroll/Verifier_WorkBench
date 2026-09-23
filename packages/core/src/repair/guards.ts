import type { EquivalenceResult, FunctionSummary, Rejection, VerifyResult } from '@verifier/shared';
import type { FunctionInfo } from '../engines/types';
import { checkIncludes } from '../source';
import {
  added,
  assertionConditions,
  assertionMacros,
  removed,
  terminatingCalls,
  verifierConstructs,
} from './text';

// Rules a candidate patch must pass before its verification result counts.
// Each one closes a way to make the checker report "proved" without fixing
// the code. Messages are written for the model (as feedback on its next
// attempt) and for the person reading the audit trail alike.

const quoteList = (items: string[]) => items.map((x) => `\`${x}\``).join(', ');

const normalized = (code: string) =>
  code
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

/** Checks on the candidate's text, before anything is compiled. */
export function sourceGuards(original: string, candidate: string, baseline: string): Rejection | null {
  if (!candidate.trim()) return { guard: 'empty', message: 'The answer contained no code.' };
  if (normalized(candidate) === normalized(baseline)) {
    return { guard: 'unchanged', message: 'The code came back unchanged.' };
  }
  const include = checkIncludes(candidate)[0];
  if (include) return { guard: 'includes', message: `Line ${include.line}: ${include.message}.` };

  const constructs = added(verifierConstructs(original), verifierConstructs(candidate));
  if (constructs.length) {
    return {
      guard: 'verifier-intrinsics',
      message:
        `The patch adds verifier-specific code (${quoteList(constructs)}). That changes what the ` +
        'checker assumes, not what the program does; fix the code itself.',
    };
  }
  const macros = added(assertionMacros(original), assertionMacros(candidate));
  if (macros.length) {
    return {
      guard: 'assertions',
      message: `The patch adds ${quoteList(macros)}, which would switch assertions off; keep every assertion in force.`,
    };
  }
  const asserts = removed(assertionConditions(original), assertionConditions(candidate));
  if (asserts.length) {
    return {
      guard: 'assertions',
      message: `The patch removes or changes ${quoteList(asserts)}; keep every assertion exactly as written.`,
    };
  }
  const exits = added(terminatingCalls(original), terminatingCalls(candidate));
  if (exits.length) {
    return {
      guard: 'termination',
      message:
        `The patch adds a call to ${quoteList(exits)}. Ending the program is not accepted as a fix; ` +
        'handle the case inside the function (for example, return early) so it still returns normally.',
    };
  }
  return null;
}

/** Every function of the original must still be defined, with the same type. */
export function signatureGuard(original: FunctionInfo[], candidate: FunctionInfo[]): Rejection | null {
  const byName = new Map(candidate.map((f) => [f.name, f]));
  for (const f of original) {
    const c = byName.get(f.name);
    if (!c) {
      return {
        guard: 'signature',
        message: `The function \`${f.name}\` is no longer defined; keep every function of the original.`,
      };
    }
    const same =
      f.typeKey !== undefined && c.typeKey !== undefined
        ? f.typeKey === c.typeKey
        : f.signature === c.signature;
    if (!same) {
      const was = f.signature ? ` (was \`${f.signature}\`, now \`${c.signature ?? '?'}\`)` : '';
      return {
        guard: 'signature',
        message: `The signature of \`${f.name}\` changed${was}; keep every signature exactly.`,
      };
    }
  }
  return null;
}

const total = (s: FunctionSummary) => s.counts.proved + s.counts.refuted + s.counts.inconclusive;

/**
 * Nothing the original decided may become undecided. A patch that adds a loop
 * the checker cannot finish, or that times it out, would otherwise turn
 * refuted obligations into inconclusive ones and look like progress.
 */
export function inconclusiveGuard(original: VerifyResult, candidate: VerifyResult): Rejection | null {
  const before = new Map(original.functions.map((f) => [f.name, f.counts.inconclusive]));
  for (const f of candidate.functions) {
    const was = before.get(f.name) ?? 0;
    if (f.counts.inconclusive <= was) continue;
    const timedOut = f.error !== undefined && /timed out/.test(f.error);
    const why = timedOut
      ? 'checking it timed out'
      : `a loop needs more than ${candidate.bounds.unwind} iterations, the unwinding bound`;
    return {
      guard: 'inconclusive',
      message:
        `The checker could not decide ${f.counts.inconclusive} obligation(s) in \`${f.name}\` ` +
        `(the original had ${was}): ${why}. Keep loops bounded so every obligation can still be decided.`,
    };
  }
  return null;
}

/**
 * A function whose checks all vanished must be proved to behave as before;
 * otherwise deleting the code that could fail would count as a fix.
 */
export function obligationsGuard(
  original: VerifyResult,
  candidate: VerifyResult,
  equivalence: EquivalenceResult[],
): Rejection | null {
  const after = new Map(candidate.functions.map((f) => [f.name, f]));
  for (const f of original.functions) {
    const c = after.get(f.name);
    if (!c || total(f) === 0 || total(c) > 0) continue;
    const eq = equivalence.find((e) => e.function === f.name);
    if (eq?.status === 'equivalent') continue;
    const why = eq?.reason ? ` (${eq.reason})` : '';
    return {
      guard: 'obligations',
      message:
        `Every check in \`${f.name}\` disappeared (the original had ${total(f)}), and its behavior ` +
        `could not be proved unchanged${why}. Fix the defect rather than removing the code that has it.`,
    };
  }
  return null;
}

/** The first behavior difference, as a rejection. */
export function behaviorRejection(equivalence: EquivalenceResult[]): Rejection | null {
  const d = equivalence.find((e) => e.status === 'different');
  if (!d) return null;
  const args = (d.inputs ?? []).map((i) => `${i.name} = ${i.value}`).join(', ');
  const values = d.original !== undefined ? ` (original: ${d.original}, patched: ${d.candidate ?? '?'})` : '';
  return {
    guard: 'behavior',
    message:
      `\`${d.function}(${args})\` is well-defined in the original, but ${d.reason ?? 'the behavior differs'}` +
      `${values}. Change behavior only on inputs where the original has undefined behavior or fails an assertion.`,
  };
}
