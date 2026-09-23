import type { DiffLine, Finding, FunctionSummary } from '@verifier/shared';
import type { Run } from '../../runs';

// What the Workbench panels share about a run: its refuted findings in a
// stable order (their F-nn ids), and where each sits in the source.

export interface WorkbenchModel {
  run: Run;
  /** Refuted findings; the index is the F-nn id and the selection. */
  refuted: Finding[];
  /** Source line → index of the first refuted finding on it (in the user's file). */
  lineToFinding: Map<number, number>;
  /** Source lines with an inconclusive obligation and no refuted one. */
  inconclusiveLines: Map<number, Finding>;
  /** Lines of the patched source that the patch added or changed. */
  fixedLines: Set<number>;
  functions: FunctionSummary[];
}

export function buildModel(run: Run): WorkbenchModel {
  const { result } = run;
  const ownFunctions = new Set(result.functions.map((f) => f.name));
  const inSource = (f: Finding) => f.line > 0 && ownFunctions.has(f.function);
  const refuted = result.findings.filter((f) => f.status === 'refuted');

  const lineToFinding = new Map<number, number>();
  refuted.forEach((f, i) => {
    if (inSource(f) && !lineToFinding.has(f.line)) lineToFinding.set(f.line, i);
  });
  const inconclusiveLines = new Map<number, Finding>();
  for (const f of result.findings) {
    if (
      f.status === 'inconclusive' &&
      inSource(f) &&
      !lineToFinding.has(f.line) &&
      !inconclusiveLines.has(f.line)
    ) {
      inconclusiveLines.set(f.line, f);
    }
  }
  const fixedLines = new Set<number>(
    (run.repair?.status === 'repaired' ? (run.repair.diff ?? []) : [])
      .filter((d) => d.type === '+' && d.newLine !== undefined)
      .map((d) => d.newLine!),
  );
  const functions = [...result.functions].sort((a, b) => a.line - b.line);
  return { run, refuted, lineToFinding, inconclusiveLines, fixedLines, functions };
}

/** The function a line belongs to: the last one starting at or before it. */
export function functionAt(functions: FunctionSummary[], line: number): string | undefined {
  let name: string | undefined;
  for (const f of functions) if (f.line <= line) name = f.name;
  return name;
}

/**
 * "@@ avg() — line 5" for the hunk after index `at` (-1 for the first): the
 * first line it changes, numbered in the patched file where it has one.
 */
export function hunkHeader(diff: DiffLine[], at: number, functions: FunctionSummary[]): string {
  const end = diff.findIndex((d, i) => i > at && d.type === '@');
  const hunk = diff.slice(at + 1, end < 0 ? undefined : end);
  const first = hunk.findIndex((d) => d.type === '+' || d.type === '-');
  const numbered = hunk.slice(Math.max(first, 0)).find((d) => d.newLine !== undefined);
  const line = numbered?.newLine ?? hunk[Math.max(first, 0)]?.oldLine;
  if (!line) return '@@';
  const fn = functionAt(functions, line);
  return fn ? `@@ ${fn}() — line ${line}` : `@@ line ${line}`;
}
