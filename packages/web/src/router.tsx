import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// Five routes need no framework: the path lives in history, components read
// it with usePath() and change it with navigate() or <Link>.

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'workbench'; runId: string }
  | { name: 'report'; runId: string }
  | { name: 'misra' }
  | { name: 'batch' }
  | { name: 'not-found' };

export function matchRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/new') return { name: 'new' };
  if (p === '/misra') return { name: 'misra' };
  if (p === '/batch') return { name: 'batch' };
  const report = /^\/runs\/([\w-]+)\/report$/.exec(p);
  if (report) return { name: 'report', runId: report[1]! };
  const run = /^\/runs\/([\w-]+)$/.exec(p);
  if (run) return { name: 'workbench', runId: run[1]! };
  return { name: 'not-found' };
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === window.location.pathname) return;
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.scrollTo(0, 0);
  notify();
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

/** A real link (open in new tab, copy address) that navigates in place on a plain click. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
