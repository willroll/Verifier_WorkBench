import type { Finding, FunctionSummary, VerifyResult, WitnessValue } from '@verifier/shared';

// How results read on screen: short, and the same everywhere.

/** "0.81 s" below a second, "4.2 s" above. */
export function seconds(ms: number | undefined): string {
  if (ms === undefined) return '';
  const s = ms / 1000;
  return `${s < 1 ? s.toFixed(2) : s.toFixed(1)} s`;
}

export const findingId = (index: number) => `F-${String(index + 1).padStart(2, '0')}`;

export const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "CBMC 5.95.1" from the engine's label and the first word of its version. */
export function engineText(r: Pick<VerifyResult, 'engineLabel' | 'engineVersion'>): string {
  const version = r.engineVersion?.split(/\s+/)[0];
  return version ? `${r.engineLabel} ${version}` : r.engineLabel;
}

export function solverText(r: Pick<VerifyResult, 'solver'>): string {
  if (!r.solver) return '';
  return [r.solver.id, r.solver.version?.split(/\s+/)[0]].filter(Boolean).join(' ');
}

/** SMT-LIB's bit-vector literal style, as the design shows witness values. */
export const hexText = (w: WitnessValue) => (w.hex ? w.hex.replace(/^0x/, '#x') : '—');

export const refuted = (r: VerifyResult) => r.findings.filter((f) => f.status === 'refuted');
export const proved = (r: VerifyResult) => r.findings.filter((f) => f.status === 'proved');
export const inconclusive = (r: VerifyResult) => r.findings.filter((f) => f.status === 'inconclusive');

export const inputs = (f: Finding) => f.model.filter((m) => m.role === 'input');
export const stateValues = (f: Finding) => f.model.filter((m) => m.role === 'state');

/** "a=2147483647 b=1" — the counterexample's inputs, for card meta lines. */
export const inputSummary = (f: Finding, max = 3) =>
  inputs(f)
    .slice(0, max)
    .map((m) => `${m.name}=${m.value}`)
    .join(' ');

/** "avg#overflow" lines, with repeats counted: "store#bounds ×2". */
export function obligationList(findings: Finding[]): string[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.entry}#${f.kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
}

export type Tone = 'red' | 'green' | 'amber' | 'muted';

export function functionMark(f: FunctionSummary): { mark: string; tone: Tone; label: string } {
  switch (f.status) {
    case 'refuted':
      return { mark: '●', tone: 'red', label: 'refuted' };
    case 'proved':
      return { mark: '✓', tone: 'green', label: 'proved' };
    case 'inconclusive':
      return { mark: '◐', tone: 'amber', label: 'inconclusive' };
    case 'error':
      return { mark: '!', tone: 'amber', label: 'error' };
    case 'no-obligations':
      return { mark: '✓', tone: 'muted', label: 'no obligations' };
  }
}

export const INCONCLUSIVE_REASON: Record<string, string> = {
  'unwind-bound': 'a loop needs more unwinding',
  timeout: 'the checker timed out',
  error: 'the checker failed',
  'not-checked': 'not checked',
  unknown: 'undecided',
};
