import { useSyncExternalStore } from 'react';
import type { ProviderId, RepairEvent, RepairIteration, RepairResult } from '@verifier/shared';
import { ApiError, streamRepair } from './api';
import { navigate } from './router';
import { addRun, getRun, type Run } from './runs';

// One repair per run at a time. The session outlives the page that started
// it, so leaving and coming back shows the live log; a patch that holds
// becomes a new run whose parent is the original (Revert returns to it).

export interface RepairSession {
  runId: string;
  provider: ProviderId;
  status: 'running' | 'done';
  iterations: RepairIteration[];
  /** What the loop is doing right now, while running. */
  step?: { iter: number; text: string };
  result?: RepairResult;
  /** The run holding the accepted patch, once there is one. */
  patchedRunId?: string;
  error?: string;
  controller: AbortController;
}

const sessions = new Map<string, RepairSession>();
const listeners = new Set<() => void>();

function update(runId: string, patch: Partial<RepairSession>) {
  const s = sessions.get(runId);
  if (!s) return;
  sessions.set(runId, { ...s, ...patch });
  listeners.forEach((l) => l());
}

const stepText = (e: RepairEvent, modelName: string): string | null => {
  if (e.type === 'proposing') return `asking ${modelName}…`;
  if (e.type !== 'checking') return null;
  if (e.step === 'guards') return 'checking the patch…';
  if (e.step === 'verify') return e.iter === 0 ? 'verifying the original…' : 're-verifying…';
  return 'proving behavior unchanged…';
};

function finish(run: Run, result: RepairResult) {
  update(run.id, { status: 'done', result, step: undefined, iterations: result.iterations });
  if (result.status !== 'repaired' || !result.finalCode || !result.finalResult) return;
  const patched = addRun({
    request: { ...run.request, code: result.finalCode },
    result: result.finalResult,
    repair: result,
    parentId: run.id,
  });
  update(run.id, { patchedRunId: patched.id });
  // Follow the patch only if the person is still looking at the original.
  if (window.location.pathname === `/runs/${run.id}`) navigate(`/runs/${patched.id}`);
}

export function startRepair(run: Run, provider: ProviderId, modelName: string) {
  const existing = sessions.get(run.id);
  if (existing?.status === 'running') return;
  const controller = new AbortController();
  sessions.set(run.id, { runId: run.id, provider, status: 'running', iterations: [], controller });
  listeners.forEach((l) => l());

  const onEvent = (e: RepairEvent) => {
    const s = sessions.get(run.id);
    if (!s) return;
    if (e.type === 'iteration') update(run.id, { iterations: [...s.iterations, e.iteration] });
    const text = stepText(e, modelName);
    if (text && (e.type === 'proposing' || e.type === 'checking'))
      update(run.id, { step: { iter: e.iter, text } });
  };

  const { request } = run;
  streamRepair(
    {
      code: request.code,
      fileName: request.fileName,
      engine: request.engine,
      ...(request.solver ? { solver: request.solver } : {}),
      ...(request.unwind ? { unwind: request.unwind } : {}),
      ...(request.checks ? { checks: request.checks } : {}),
      provider,
    },
    onEvent,
    controller.signal,
  ).then(
    (result) => finish(run, result),
    (e: unknown) => {
      const aborted = controller.signal.aborted;
      update(run.id, {
        status: 'done',
        step: undefined,
        error: aborted ? 'Stopped.' : e instanceof ApiError ? e.message : `The repair failed: ${String(e)}`,
      });
    },
  );
}

export function stopRepair(runId: string) {
  sessions.get(runId)?.controller.abort();
}

/** Demo mode: replays a recorded repair at a readable pace. */
export function replayRepair(run: Run, recorded: RepairResult, patchedRunId: string) {
  if (sessions.get(run.id)?.status === 'running') return;
  const controller = new AbortController();
  sessions.set(run.id, {
    runId: run.id,
    provider: recorded.provider ?? 'anthropic',
    status: 'running',
    iterations: [],
    controller,
  });
  listeners.forEach((l) => l());
  const its = recorded.iterations;
  let i = 0;
  const tick = () => {
    if (controller.signal.aborted)
      return update(run.id, { status: 'done', step: undefined, error: 'Stopped.' });
    const s = sessions.get(run.id)!;
    if (i < its.length) {
      const it = its[i++]!;
      update(run.id, {
        iterations: [...s.iterations, it],
        step: i < its.length ? { iter: its[i]!.iter, text: 'replaying the recorded run…' } : undefined,
      });
      window.setTimeout(tick, 700);
      return;
    }
    update(run.id, { status: 'done', result: recorded, step: undefined, patchedRunId });
    if (window.location.pathname === `/runs/${run.id}` && getRun(patchedRunId))
      navigate(`/runs/${patchedRunId}`);
  };
  window.setTimeout(tick, 400);
}

export function useRepairSession(runId: string): RepairSession | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sessions.get(runId),
  );
}
