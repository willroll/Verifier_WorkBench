import type { RepairIteration, RepairResult } from '@verifier/shared';
import { seconds } from '../../format';

// The repair loop's attempts as log lines, and its verdict, for the agent
// card and the report. Only the checker can declare success.

const GUARD_LABEL: Record<string, string> = {
  unchanged: 'unchanged',
  empty: 'empty answer',
  includes: 'include',
  'verifier-intrinsics': 'verifier trick',
  macros: 'macro',
  assertions: 'assertion',
  termination: 'ends the program',
  'does-not-compile': 'does not compile',
  signature: 'signature',
  globals: 'global removed',
  inconclusive: 'undecided',
  obligations: 'checks vanished',
  behavior: 'behavior changed',
};

export type Tone = 'green' | 'red' | 'amber' | 'muted' | 'accent';

interface LogLine {
  text: string;
  tone: Tone;
  detail?: string;
}

export function logLines(iterations: RepairIteration[]): LogLine[] {
  return iterations.map((it): LogLine => {
    const head = `iter ${it.iter} · ${it.kind === 'verify' ? 'verify' : 'repair → re-verify'}`;
    const time = it.durationMs !== undefined ? ` · ${seconds(it.durationMs)}` : '';
    if (it.outcome === 'error' || (it.error && !it.rejection)) {
      return { text: `iter ${it.iter} · ${it.error ?? 'no usable answer'}`, tone: 'amber' };
    }
    if (it.rejection) {
      return {
        text: `iter ${it.iter} · repair → rejected (${GUARD_LABEL[it.rejection.guard] ?? it.rejection.guard})${time}`,
        tone: 'amber',
        detail: it.rejection.message,
      };
    }
    const c = it.counts;
    if (!c) return { text: head + time, tone: 'muted' };
    if (c.refuted === 0 && c.inconclusive === 0)
      return { text: `${head} · all ${c.proved} proved ✓${time}`, tone: 'green' };
    const suffix =
      it.outcome === 'improved'
        ? ' · kept as the new baseline'
        : it.outcome === 'no-progress'
          ? ' · no progress'
          : '';
    return {
      text: `${head} · ${c.refuted} refuted${c.inconclusive ? ` · ${c.inconclusive} inconclusive` : ''}${suffix}${time}`,
      tone: c.refuted === 0 ? 'green' : 'red',
    };
  });
}

export function verdictOf(result: RepairResult, engineLabel: string): { text: string; tone: Tone } {
  const attempts = result.iterations.filter((i) => i.kind === 'repair').length;
  switch (result.status) {
    case 'repaired':
      return {
        text: `Verified — patch held (re-checked by ${result.engineLabel ?? engineLabel}).`,
        tone: 'green',
      };
    case 'already-proved':
      return { text: 'Already verified — nothing to repair.', tone: 'green' };
    case 'unrepaired':
      return {
        text: `Could not repair — ${result.remaining ?? 0} obligation(s) still refuted after ${attempts} attempt(s).`,
        tone: 'red',
      };
    case 'error':
      return { text: result.error ?? 'Repair failed.', tone: 'amber' };
  }
}
