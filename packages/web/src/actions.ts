import { useSyncExternalStore } from 'react';
import { ApiError, verify } from './api';
import { navigate } from './router';
import { addRun, type Run, type RunRequest } from './runs';

// Verification started from anywhere (New Run, Re-verify) goes through here,
// so the whole UI can show that the checker is running.

let busy = false;
const listeners = new Set<() => void>();

function setBusy(v: boolean) {
  busy = v;
  listeners.forEach((l) => l());
}

export function useVerifying(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => busy,
  );
}

export type VerifyOutcome = { ok: true; run: Run } | { ok: false; error: string };

/**
 * Verifies and records a run. A result the checker could not produce (the
 * code does not compile, the engine is missing, a timeout) is an error for
 * the caller to show, not a run.
 */
export async function runVerification(request: RunRequest, parentId?: string): Promise<VerifyOutcome> {
  if (busy) return { ok: false, error: 'A verification is already running.' };
  setBusy(true);
  try {
    const result = await verify(request);
    if (!result.available || result.status === 'error' || result.status === 'timeout') {
      const lines = result.diagnostics
        .filter((d) => d.severity === 'error')
        .slice(0, 6)
        .map((d) => (d.line ? `line ${d.line}: ${d.message}` : d.message));
      const head = `${result.engineLabel}: ${result.error ?? result.status}`;
      const hint = result.hint ? `\n${result.hint}` : '';
      return { ok: false, error: [head, ...lines.filter((l) => l !== result.error)].join('\n') + hint };
    }
    const run = addRun({ request, result, ...(parentId ? { parentId } : {}) });
    navigate(`/runs/${run.id}`);
    return { ok: true, run };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof ApiError ? e.message : `Could not reach the server: ${String(e)}`,
    };
  } finally {
    setBusy(false);
  }
}
