import { useSyncExternalStore } from 'react';
import type { CheckId, EngineId, SolverId } from '@verifier/shared';
import { DEFAULT_SAMPLE } from './samples';

// What is typed on the New Run page survives navigation and reloads.

export interface Draft {
  code: string;
  fileName: string;
  engine: EngineId | null;
  solver: SolverId | null;
  unwind: number | null;
  /** Checks a loaded sample asked for; null uses the engine's default set. */
  checks: CheckId[] | null;
  /** The example this draft was loaded from, for its explanatory note. */
  sampleId: string | null;
}

const KEY = 'vw.draft.v1';
const initial: Draft = {
  code: DEFAULT_SAMPLE.code,
  fileName: DEFAULT_SAMPLE.fileName,
  engine: null,
  solver: null,
  unwind: null,
  checks: null,
  sampleId: DEFAULT_SAMPLE.id,
};

function load(): Draft {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...initial, ...(JSON.parse(raw) as Partial<Draft>) } : initial;
  } catch {
    return initial;
  }
}

let draft: Draft = typeof window === 'undefined' ? initial : load();
const listeners = new Set<() => void>();

export function updateDraft(patch: Partial<Draft>) {
  draft = { ...draft, ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // kept for this page view only
  }
  listeners.forEach((l) => l());
}

export function useDraft(): Draft {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => draft,
  );
}
