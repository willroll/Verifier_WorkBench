import { useState } from 'react';
import { runVerification, useVerifying } from '../actions';
import { useBackend } from '../backend';
import { seconds, solverText } from '../format';
import { Link, type Route } from '../router';
import { useCurrentRun } from '../runs';
import { toggleTheme, useTheme } from '../theme';
import './topbar.css';

const TABS = [
  { label: 'New Run', view: 'new' },
  { label: 'Workbench', view: 'workbench' },
  { label: 'MISRA Report', view: 'misra' },
  { label: 'Problem Sets', view: 'batch' },
  { label: 'Report', view: 'report' },
] as const;

export function TopBar({ route }: { route: Route }) {
  const run = useCurrentRun();
  const backend = useBackend();
  const verifying = useVerifying();
  const theme = useTheme();
  const [reverifyError, setReverifyError] = useState<string | null>(null);

  const hrefOf = (view: (typeof TABS)[number]['view']) => {
    if (view === 'workbench') return run ? `/runs/${run.id}` : '/new';
    if (view === 'report') return run ? `/runs/${run.id}/report` : '/new';
    return `/${view}`;
  };
  const active = route.name === 'home' ? 'workbench' : route.name;

  const r = run?.result;
  const runChip = !run
    ? 'no run yet'
    : [
        run.demo ? 'demo run' : `run #${run.number}`,
        solverText(r!) || r!.engineLabel,
        verifying ? 'running…' : seconds(r!.durationMs),
      ]
        .filter(Boolean)
        .join(' · ');

  const canReverify = !!run && !run.demo && backend.state === 'live' && !verifying;
  const reverify = async () => {
    if (!run || !canReverify) return;
    setReverifyError(null);
    const outcome = await runVerification(run.request, run.parentId);
    if (!outcome.ok) setReverifyError(outcome.error);
  };

  return (
    <>
      <header className="tb no-print">
        <div className="tb-title">
          Verifier<span className="tb-slash">&thinsp;/&thinsp;</span>
          {run?.request.fileName ?? 'new run'}
        </div>
        <div className="tb-run">{runChip}</div>
        <nav className="tb-nav" aria-label="Views">
          {TABS.map((t) => (
            <Link
              key={t.view}
              to={hrefOf(t.view)}
              className="tb-tab"
              aria-current={active === t.view ? 'page' : undefined}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="tb-right">
          <span className="chip chip-red">{verifying || !r ? '…' : r.counts.refuted} refuted</span>
          <span className="chip chip-green">{verifying || !r ? '…' : r.counts.proved} proved</span>
          {r && !verifying && r.counts.inconclusive > 0 ? (
            <span className="chip chip-amber">{r.counts.inconclusive} inconclusive</span>
          ) : null}
          <button
            type="button"
            className="btn-reset tb-theme"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            type="button"
            className="btn-reset tb-primary"
            onClick={() => void reverify()}
            disabled={!canReverify}
            title={run?.demo ? 'The demo replays a recorded run; verifying needs a server.' : undefined}
          >
            {verifying ? 'Verifying…' : 'Re-verify'}
          </button>
        </div>
      </header>
      {reverifyError ? (
        <div className="tb-error no-print" role="alert">
          <span>{reverifyError}</span>
          <button type="button" className="btn-reset tb-error-close" onClick={() => setReverifyError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  );
}
