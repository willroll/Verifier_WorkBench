import { useSyncExternalStore } from 'react';

// Dark by default, as the design presents it; the toggle is remembered.

export type Theme = 'light' | 'dark';
const KEY = 'vw.theme';

function initial(): Theme {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // storage unavailable: use the default
  }
  return 'dark';
}

let theme: Theme = typeof window === 'undefined' ? 'dark' : initial();
const listeners = new Set<() => void>();

export function applyTheme() {
  document.documentElement.dataset.theme = theme;
}

export function toggleTheme() {
  theme = theme === 'dark' ? 'light' : 'dark';
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // not remembered, still applied
  }
  applyTheme();
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => theme,
  );
}
