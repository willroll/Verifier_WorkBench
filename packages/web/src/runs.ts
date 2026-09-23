import { useSyncExternalStore } from 'react';
import type { CheckId, EngineId, RepairResult, SolverId, VerifyResult } from '@verifier/shared';

// Runs live in this browser until accounts and server-side history arrive
// (docs/PLAN.md, Phase 4). Storage can be unavailable (private windows,
// blocked site data), so every read and write is allowed to fail.

export interface RunRequest {
  code: string;
  fileName: string;
  engine: EngineId;
  solver?: SolverId;
  unwind?: number;
  checks?: CheckId[];
}

export interface Run {
  id: string;
  /** Shown as "run #N". */
  number: number;
  createdAt: string;
  request: RunRequest;
  result: VerifyResult;
  /** The repair that produced this run's code. */
  repair?: RepairResult;
  /** The run the repair started from; Revert goes back to it. */
  parentId?: string;
  /** A recorded run replayed without a backend. */
  demo?: boolean;
}

const RUNS_KEY = 'vw.runs.v1';
const COUNTER_KEY = 'vw.runCounter';
const CURRENT_KEY = 'vw.currentRun';
const MAX_RUNS = 20;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

let runs: Run[] = read<Run[]>(RUNS_KEY, []);
let counter = read<number>(
  COUNTER_KEY,
  runs.reduce((n, r) => Math.max(n, r.number), 0),
);
let current: string | null = read<string | null>(CURRENT_KEY, null);
const demoRuns = new Map<string, Run>();
const listeners = new Set<() => void>();

function persist() {
  // Keep the newest runs; drop older ones until they fit the browser's quota.
  let kept = runs.slice(-MAX_RUNS);
  while (kept.length > 1 && !write(RUNS_KEY, kept)) kept = kept.slice(1);
  runs = kept;
}

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addRun(run: Omit<Run, 'id' | 'number' | 'createdAt'>): Run {
  counter += 1;
  write(COUNTER_KEY, counter);
  const full: Run = { ...run, id: String(counter), number: counter, createdAt: new Date().toISOString() };
  runs = [...runs, full];
  persist();
  emit();
  return full;
}

/** Recorded runs for demo mode: looked up like any other, never persisted. */
export function registerDemoRuns(list: Run[]) {
  for (const r of list) demoRuns.set(r.id, r);
  emit();
}

export function getRun(id: string | null | undefined): Run | undefined {
  if (!id) return undefined;
  return demoRuns.get(id) ?? runs.find((r) => r.id === id);
}

export function setCurrentRun(id: string) {
  if (current === id) return;
  current = id;
  write(CURRENT_KEY, id);
  emit();
}

export function useRuns(): Run[] {
  return useSyncExternalStore(subscribe, () => runs);
}

export function useRun(id: string | null | undefined): Run | undefined {
  return useSyncExternalStore(subscribe, () => getRun(id));
}

/** The run the top bar describes: the one last opened, if it still exists. */
export function useCurrentRun(): Run | undefined {
  return useSyncExternalStore(subscribe, () => getRun(current));
}
