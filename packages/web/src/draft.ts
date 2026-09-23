import { useSyncExternalStore } from 'react';
import type { EngineId, SolverId } from '@verifier/shared';
import { SAMPLE_CODE, SAMPLE_FILE } from './sample';

// What is typed on the New Run page survives navigation and reloads.

export interface Draft {
  code: string;
  fileName: string;
  engine: EngineId | null;
  solver: SolverId | null;
  unwind: number | null;
}

const KEY = 'vw.draft.v1';
const initial: Draft = { code: SAMPLE_CODE, fileName: SAMPLE_FILE, engine: null, solver: null, unwind: null };

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
