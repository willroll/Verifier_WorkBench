import { useEffect, useMemo } from 'react';
import type { Finding, ObligationStatus } from '@verifier/shared';
import { useBackend } from '../backend';
import {
  capitalize,
  engineText,
  findingId,
  hexText,
  inputs,
  seconds,
  solverText,
  stateValues,
} from '../format';
import { Link } from '../router';
import { getRun, setCurrentRun, useRun, type Run } from '../runs';
import { logLines } from './workbench/agentLog';
import { Ticked } from '../components/Ticked';
import { hunkHeader } from './workbench/model';
import './report.css';

// The printable report (design-handoff.md "5. Report"), built from the run.

const STATUS: Record<ObligationStatus, { text: string; tone: string }> = {
  proved: { text: '✓ proved', tone: 'tone-green' },
  refuted: { text: '✗ refuted', tone: 'tone-red' },
  inconclusive: { text: '? inconclusive', tone: 'tone-amber' },
};

export function Report({ runId }: { runId: string }) {
  const run = useRun(runId);
  const backend = useBackend();
  useEffect(() => {
    if (run) setCurrentRun(run.id);
  }, [run]);
  if (!run) {
    if (backend.state === 'loading') return null;
    return (
      <div className="page">
        <h1 className="page-title">Run #{runId} is not in this browser</h1>
        <p className="page-sub">
          <Link to="/new">Start a new run</Link>.
        </p>
      </div>
    );
  }
  return <ReportView run={run} />;
}

function ReportView({ run }: { run: Run }) {
  const r = run.result;
  const date = new Date(run.createdAt).toISOString().slice(0, 10);
  const refuted = r.findings.filter((f) => f.status === 'refuted');
  const order = useMemo(() => new Map(r.functions.map((f) => [f.name, f.line])), [r.functions]);
  const rows = useMemo(
    () =>
      [...r.findings].sort(
        (a, b) =>
          (order.get(a.entry) ?? 0) - (order.get(b.entry) ?? 0) ||
          a.entry.localeCompare(b.entry) ||
          a.line - b.line,
      ),
    [r.findings, order],
  );
  const duration = new Map(r.functions.map((f) => [f.name, f.durationMs]));
  const resultText = [
    `${r.counts.refuted} refuted`,
    `${r.counts.proved} proved`,
    ...(r.counts.inconclusive ? [`${r.counts.inconclusive} inconclusive`] : []),
  ].join(' · ');
  const resultTone = r.counts.refuted ? 'tone-red' : r.counts.inconclusive ? 'tone-amber' : 'tone-green';
  const parent = getRun(run.parentId);

  return (
    <div className="rp">
      <div className="rp-toolbar no-print">
        <div className="rp-toolbar-text">
          Exportable verification report — print or save to PDF.
          {run.demo ? ' This is the recorded demo run.' : ''}
        </div>
        <button type="button" className="btn-reset rp-print" onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>
      <article className="rp-doc">
        <header className="rp-head">
          <h1 className="rp-title">Verification Report</h1>
          <div className="rp-stamp">{[solverText(r), engineText(r), date].filter(Boolean).join(' · ')}</div>
        </header>
        <div className="rp-meta">
          <div>
            Target&ensp;<span className="rp-meta-v">{run.request.fileName}</span>
          </div>
          <div>
            VCs&ensp;<span className="rp-meta-v">{r.findings.length} checked</span>
          </div>
          <div>
            Result&ensp;<span className={`rp-meta-v rp-strong ${resultTone}`}>{resultText}</span>
          </div>
          <div>
            Checks&ensp;<span className="rp-meta-v">{r.checks.join(', ')}</span>
          </div>
          <div>
            Bound&ensp;<span className="rp-meta-v">loops unwound up to {r.bounds.unwind}×</span>
          </div>
        </div>

        <h2 className="rp-h2">1 Proof obligations</h2>
        <div className="rp-table" role="table" aria-label="Proof obligations">
          <div className="rp-tr rp-th" role="row">
            <div role="columnheader">FUNCTION</div>
            <div role="columnheader">OBLIGATION</div>
            <div role="columnheader">STATUS</div>
            <div role="columnheader">TIME</div>
          </div>
          {rows.length === 0 ? (
            <div className="rp-tr" role="row">
              <div role="cell">—</div>
              <div role="cell" className="rp-sans">
                The checks found no obligations in this file.
              </div>
            </div>
          ) : null}
          {rows.map((f, i) => {
            const first = i === 0 || rows[i - 1]!.entry !== f.entry;
            return (
              <div className="rp-tr" role="row" key={`${f.entry}:${f.id}:${i}`}>
                <div role="cell">{first ? f.entry : ''}</div>
                <div role="cell" className="rp-sans">
                  {f.message}
                  {f.line ? <span className="tone-muted"> · line {f.line}</span> : null}
                </div>
                <div role="cell" className={`rp-strong ${STATUS[f.status].tone}`}>
                  {STATUS[f.status].text}
                </div>
                <div role="cell" className="tone-muted">
                  {first ? seconds(duration.get(f.entry)) : ''}
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="rp-h2">2 Findings &amp; counterexamples</h2>
        {refuted.length === 0 ? (
          <p className="rp-note">
            No obligation was refuted
            {r.counts.inconclusive ? ', but some remain inconclusive (see above)' : ''}.
          </p>
        ) : (
          refuted.map((f, i) => <FindingBlock key={`${f.entry}:${f.id}`} run={run} finding={f} index={i} />)
        )}

        {run.repair?.status === 'repaired' ? <PatchSection run={run} parentNumber={parent?.number} /> : null}

        <footer className="rp-foot">
          Generated by Verifier Workbench · {engineText(r)}
          {r.solver ? ` with ${solverText(r)}` : ''} · checks: {r.checks.join(', ')} · loops unwound up to{' '}
          {r.bounds.unwind}× with unwinding assertions · counterexamples are concrete inputs the checker
          found.
        </footer>
      </article>
    </div>
  );
}

function FindingBlock({ run, finding, index }: { run: Run; finding: Finding; index: number }) {
  const values = [...inputs(finding), ...stateValues(finding).slice(0, 8)];
  const path = finding.trace.slice(-12);
  return (
    <section className="rp-finding">
      <div className="rp-pills">
        <span className="rp-pill rp-pill-red">{findingId(index)}</span>
        <span className="rp-pill rp-pill-amber">{finding.kind}</span>
        {finding.line ? <span className="rp-pill rp-pill-amber">line {finding.line}</span> : null}
      </div>
      <h3 className="rp-finding-title">
        {finding.function}(): {capitalize(finding.message)}
      </h3>
      <p className="rp-note">
        Refuted by {engineText(run.result)} in {finding.entry}()
        {finding.line ? ` at ${finding.file || run.request.fileName}:${finding.line}` : ''}. The values below
        are the counterexample: inputs that reach the failure, then values on the failing path.
        {finding.note ? ` ${finding.note}` : ''}
      </p>
      <div className="rp-evidence">
        <div className="rp-trace">
          {values.length ? (
            values.map((w) => (
              <div className="rp-trace-row" key={`${w.role}:${w.name}`}>
                <div>{w.name}</div>
                <div>{w.value}</div>
                <div className="tone-muted">{hexText(w)}</div>
              </div>
            ))
          ) : (
            <div className="rp-trace-row">
              <div>—</div>
              <div className="tone-muted">no assignments</div>
            </div>
          )}
        </div>
        <pre className="rp-code">
          {path.length
            ? path.map((s) => `${String(s.line || '').padStart(3)}  ${s.function}  ${s.text}`).join('\n')
            : 'No path steps were reported.'}
        </pre>
      </div>
    </section>
  );
}

function PatchSection({ run, parentNumber }: { run: Run; parentNumber: number | undefined }) {
  const repair = run.repair!;
  const diff = repair.diff ?? [];
  const functions = run.result.functions;
  const attempts = repair.iterations.filter((i) => i.kind === 'repair').length;
  const before = repair.iterations[0]?.counts;
  return (
    <>
      <h2 className="rp-h2">3 Patch that held</h2>
      <p className="rp-note">
        {parentNumber !== undefined && !run.demo ? `Repaired from run #${parentNumber}: ` : 'Repaired: '}
        {before ? `${before.refuted} refuted → ${run.result.counts.refuted}` : ''} after {attempts} attempt(s)
        {repair.model ? ` by ${repair.model}` : ''}. The patch was re-verified with the same settings, and
        each changed function was proved to behave as before wherever the original was well-defined.
      </p>
      {repair.rationale ? (
        <p className="rp-rationale">
          <Ticked text={repair.rationale} />
        </p>
      ) : null}
      <pre className="rp-code rp-diff">
        {diff.length ? <span className="rp-diff-ctx">{hunkHeader(diff, -1, functions)}</span> : null}
        {diff.map((d, i) => (
          <span
            key={i}
            className={d.type === '+' ? 'rp-diff-add' : d.type === '-' ? 'rp-diff-del' : 'rp-diff-ctx'}
          >
            {'\n'}
            {d.type === '@' ? hunkHeader(diff, i, functions) : `${d.type}${d.text}`}
          </span>
        ))}
      </pre>
      {repair.equivalence?.length ? (
        <ul className="rp-proofs">
          {repair.equivalence.map((e) => (
            <li key={e.function} className={e.status === 'equivalent' ? 'tone-green' : 'tone-amber'}>
              {e.function}:{' '}
              {e.status === 'equivalent' ? 'proved to behave as before' : `${e.status} — ${e.reason ?? ''}`}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rp-log">
        {logLines(repair.iterations).map((l, i) => (
          <div key={i} className={`tone-${l.tone}`}>
            {l.text}
            {l.detail ? (
              <div className="rp-log-detail">
                <Ticked text={l.detail} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
