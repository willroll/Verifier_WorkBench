import { Link, navigate } from '../router';
import { useRuns, type Run } from '../runs';
import { seconds } from '../format';
import './pages.css';

// Batch upload is not built yet; the table lists the runs made in this
// browser, in the design's problem-set layout. MISRA is not checked, so the
// score is the share of obligations proved.

function score(run: Run): number {
  const { proved, refuted, inconclusive } = run.result.counts;
  const total = proved + refuted + inconclusive;
  return total ? Math.round((100 * proved) / total) : 100;
}

const scoreTone = (pct: number) => (pct >= 90 ? 'green' : pct >= 70 ? 'amber' : 'red');

const COLUMNS = ['SUBMISSION', 'RUN', 'VCs', 'REFUTED', 'MISRA', 'TIME', 'SCORE'];

export function ProblemSets() {
  const runs = [...useRuns()].reverse();
  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1 className="page-title">Problem sets — batch verification</h1>
        <div className="page-meta">
          {runs.length} run(s) in this browser · batch upload is not available yet
        </div>
      </div>
      <div className="page-card">
        <div role="table" aria-label="Runs in this browser">
          <div role="rowgroup">
            <div className="ps-row ps-head" role="row">
              {COLUMNS.map((c) => (
                <div key={c} role="columnheader">
                  {c}
                </div>
              ))}
            </div>
          </div>
          <div role="rowgroup">
            {runs.map((run) => {
              const r = run.result;
              const pct = score(run);
              const to = `/runs/${run.id}`;
              // The file name is the keyboard route in; the whole row is a
              // larger target for the mouse.
              return (
                <div key={run.id} role="row" className="ps-row ps-body" onClick={() => navigate(to)}>
                  <div role="cell">
                    <Link to={to} className="ps-link" onClick={(e) => e.stopPropagation()}>
                      {run.request.fileName}
                    </Link>
                  </div>
                  <div role="cell" className="ps-sans">
                    #{run.number}
                    {run.parentId ? ' · patched' : ''}
                  </div>
                  <div role="cell" className="tone-muted">
                    {r.findings.length}
                  </div>
                  <div role="cell" className={r.counts.refuted ? 'tone-red' : 'tone-green'}>
                    {r.counts.refuted ? `${r.counts.refuted} sat` : '0'}
                  </div>
                  <div role="cell" className="tone-muted">
                    —
                  </div>
                  <div role="cell" className="tone-muted">
                    {seconds(r.durationMs)}
                  </div>
                  <div role="cell">
                    <span className={`ps-score ps-score-${scoreTone(pct)}`}>{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {runs.length === 0 ? <div className="ps-empty">No runs yet. Start one from New Run.</div> : null}
      </div>
      <div className="page-foot">
        Click a row to open it in the Workbench. Score: share of obligations proved (MISRA is not checked
        yet).
      </div>
    </div>
  );
}
