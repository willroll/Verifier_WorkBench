import { useSyncExternalStore } from 'react';
import type { EngineId, EnginesResponse, ProvidersResponse } from '@verifier/shared';
import { getEngines, getProviders } from './api';

// What the server can do, asked once at startup. Without a reachable API the
// app runs in demo mode on a recorded run.

export type Backend =
  | { state: 'loading' }
  | { state: 'live'; engines: EnginesResponse; providers: ProvidersResponse | null }
  | { state: 'offline' };

let backend: Backend = { state: 'loading' };
const listeners = new Set<() => void>();

function set(next: Backend) {
  backend = next;
  listeners.forEach((l) => l());
}

export async function detectBackend(): Promise<void> {
  try {
    const engines = await getEngines();
    const providers = await getProviders().catch(() => null);
    set({ state: 'live', engines, providers });
  } catch {
    set({ state: 'offline' });
  }
}

export function useBackend(): Backend {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => backend,
  );
}

export const engineAvailable = (b: Backend, engine: EngineId) =>
  b.state === 'live' && b.engines.engines[engine].available;
