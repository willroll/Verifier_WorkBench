import type { DiffLine, Finding, Rejection, VerifyResult } from '@verifier/shared';

// What the model is told. Every rule it is given is also enforced in code
// (guards.ts, equivalence.ts), so the prompt explains the checks rather than
// relying on the model to follow them. Each attempt is a single turn: the
// system prompt and the stable part (the original and its counterexamples)
// are identical across attempts and cacheable; only the attempt part changes.

export const SYSTEM_PROMPT = `You repair C code for Verifier Workbench. A bounded model checker has refuted some of the code's proof obligations: for each one it found concrete inputs that reach undefined behavior (such as a signed overflow or an out-of-bounds access) or make an assertion fail. Your task is to change the code so that every obligation is proved.

Your patch is checked mechanically, and only a patch that passes every check is accepted:
- The model checker verifies the patched file again with the same settings, and every obligation must be proved.
- Every function of the original must still be defined with exactly the same signature, and every global variable must keep its name and type. You may add helper functions.
- Every assertion must stay exactly as written.
- Behavior must be preserved. For every input on which the original function has no undefined behavior and passes its assertions, the patched function must return the same value and leave the same global state. The model checker proves this; it is not tested on samples. Change behavior only on inputs where the original was undefined or failed an assertion.
- The patch must not end the program (abort, exit and the like) to avoid a defect, and must not use verifier-specific code: __CPROVER_ or __ESBMC_ intrinsics, __VERIFIER_ functions, __builtin_assume, __builtin_unreachable, or checker pragmas.

Make the smallest change that fixes the defects. Keep everything else as it is, including formatting, comments, names and the order of declarations.

Answer with the complete patched file in "code". In "rationale", explain in two or three sentences what was wrong and how the patch fixes it.`;

const MAX_LISTED = 20;
const MAX_DIFF_LINES = 120;

const fence = (code: string, lang = 'c') => `\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\``;

/** Refuted obligations with their counterexamples, numbered. */
export function describeRefuted(findings: Finding[]): string {
  const refuted = findings.filter((f) => f.status === 'refuted');
  const items = refuted.slice(0, MAX_LISTED).map((f, i) => {
    const where = f.entry !== f.function ? ` (reached from \`${f.entry}\`)` : '';
    const lines = [`${i + 1}. \`${f.function}\`, line ${f.line}${where}: ${f.message}`];
    const inputs = f.model.filter((m) => m.role === 'input').map((m) => `${m.name} = ${m.value}`);
    const state = f.model
      .filter((m) => m.role === 'state')
      .slice(0, 6)
      .map((m) => `${m.name} = ${m.value}`);
    if (inputs.length) lines.push(`   Inputs: ${inputs.join(', ')}`);
    if (state.length) lines.push(`   Values on the failing path: ${state.join(', ')}`);
    if (f.note) lines.push(`   Note: ${f.note}`);
    return lines.join('\n');
  });
  if (refuted.length > MAX_LISTED) items.push(`… and ${refuted.length - MAX_LISTED} more.`);
  return items.join('\n');
}

export function diffText(diff: DiffLine[]): string {
  const lines = diff.map((d) => (d.type === '@' ? '@@' : `${d.type}${d.text}`));
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_DIFF_LINES), `… (${lines.length - MAX_DIFF_LINES} more lines)`].join('\n');
}

/** The part of the prompt that is the same for every attempt. */
export function stablePrompt(o: { fileName: string; code: string; result: VerifyResult }): string {
  const r = o.result;
  const engine = [r.engineLabel, r.engineVersion].filter(Boolean).join(' ');
  return [
    `File \`${o.fileName}\`:`,
    '',
    fence(o.code),
    '',
    `The checker (${engine}; loops unwound up to ${r.bounds.unwind} times; checks: ${r.checks.join(', ')}) ` +
      `refuted ${r.counts.refuted} obligation(s):`,
    '',
    describeRefuted(r.findings),
  ].join('\n');
}

/** What happened to the previous attempt, fed back into the next one. */
export type Feedback =
  | { kind: 'unusable'; error: string }
  | { kind: 'rejected'; rejection: Rejection; diff: DiffLine[] }
  | { kind: 'no-progress'; diff: DiffLine[]; result: VerifyResult };

export interface AttemptContext {
  iter: number;
  maxIters: number;
  /** The best accepted-so-far partial fix, when an earlier attempt improved on the original. */
  best?: { code: string; result: VerifyResult; before: number };
  feedback?: Feedback;
}

export function attemptPrompt(a: AttemptContext): string {
  const parts = [`Attempt ${a.iter} of ${a.maxIters}.`];
  if (a.best) {
    parts.push(
      '',
      `An earlier attempt passed every check and reduced the refuted obligations from ${a.best.before} to ` +
        `${a.best.result.counts.refuted}, so it is now the version to improve:`,
      '',
      fence(a.best.code),
      '',
      'Still refuted in it:',
      '',
      describeRefuted(a.best.result.findings),
    );
  }
  const f = a.feedback;
  if (f?.kind === 'unusable') {
    parts.push('', `Your previous answer could not be used: ${f.error}`);
  } else if (f?.kind === 'rejected') {
    parts.push(
      '',
      `Your previous attempt was rejected: ${f.rejection.message}`,
      '',
      'It made this change:',
      '',
      fence(diffText(f.diff), 'diff'),
    );
  } else if (f?.kind === 'no-progress') {
    parts.push(
      '',
      `Your previous attempt passed the checks but still left ${f.result.counts.refuted} obligation(s) refuted:`,
      '',
      describeRefuted(f.result.findings),
      '',
      'It made this change:',
      '',
      fence(diffText(f.diff), 'diff'),
    );
  }
  parts.push(
    '',
    a.best
      ? 'Return the complete patched file, building on the version above.'
      : 'Return the complete patched file.',
  );
  return parts.join('\n');
}
