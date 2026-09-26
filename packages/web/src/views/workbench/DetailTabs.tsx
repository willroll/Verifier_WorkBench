import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Finding } from '@verifier/shared';
import { exportSmtlib, type SmtlibFile } from '../../api';
import {
  INCONCLUSIVE_REASON,
  engineText,
  findingId,
  hexText,
  inconclusive,
  inputs,
  stateValues,
} from '../../format';
import type { Run } from '../../runs';
import type { WorkbenchModel } from './model';

// Col 4: the selected finding's counterexample (Trace), MISRA status, and the
// obligation as SMT-LIB that any solver can re-check.

export type DetailTab = 'trace' | 'misra' | 'smt';
const TABS: { id: DetailTab; label: string }[] = [
  { id: 'trace', label: 'Trace' },
  { id: 'misra', label: 'MISRA' },
  { id: 'smt', label: 'SMT-LIB' },
];

export function DetailTabs({
  model,
  selected,
  tab,
  onTab,
}: {
  model: WorkbenchModel;
  selected: number;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
}) {
  const finding = model.refuted[selected];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + TABS.length) % TABS.length;
    onTab(TABS[next]!.id);
    refs.current[next]?.focus();
  };

  return (
    <section className="wb-detail" aria-label="Finding detail">
      <div className="wb-tabs" role="tablist" aria-label="Detail">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="detail-panel"
            tabIndex={tab === t.id ? 0 : -1}
            className="btn-reset wb-tab"
            onClick={() => onTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        className="wb-tabbody"
        role="tabpanel"
        id="detail-panel"
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
      >
        {finding ? (
          <>
            <h2 className="wb-detail-title">
              {findingId(selected)} · {finding.function}(): {finding.message}
            </h2>
            {tab === 'trace' ? <Trace run={model.run} finding={finding} /> : null}
            {tab === 'misra' ? <MisraNotChecked /> : null}
            {tab === 'smt' ? <Smt run={model.run} finding={finding} /> : null}
          </>
        ) : (
          <Clean run={model.run} tab={tab} />
        )}
      </div>
    </section>
  );
}

function Trace({ run, finding }: { run: Run; finding: Finding }) {
  const ins = inputs(finding);
  const state = stateValues(finding);
  const where = finding.line ? `${finding.file || run.request.fileName}:${finding.line}` : finding.file;
  const path = finding.trace.slice(-10);
  return (
    <>
      <div className="trace-table" role="table" aria-label="Counterexample">
        <div className="trace-row trace-head" role="row">
          <div role="columnheader">VAR</div>
          <div role="columnheader">VALUE</div>
        </div>
        {ins.length === 0 && state.length === 0 ? (
          <div className="trace-row" role="row">
            <div role="cell">—</div>
            <div role="cell" className="tone-muted">
              no assignments in the counterexample
            </div>
          </div>
        ) : null}
        {ins.map((w) => (
          <div className="trace-row" role="row" key={`in:${w.name}`}>
            <div role="cell">{w.name}</div>
            <div role="cell">
              <div>{w.value}</div>
              <div className="trace-hex">{hexText(w)}</div>
            </div>
          </div>
        ))}
        {state.length ? (
          <div className="trace-row trace-sub" role="row">
            <div role="cell">on the failing path</div>
          </div>
        ) : null}
        {state.slice(0, 12).map((w) => (
          <div className="trace-row" role="row" key={`st:${w.name}`}>
            <div role="cell">{w.name}</div>
            <div role="cell">
              <div>{w.value}</div>
              <div className="trace-hex">{hexText(w)}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="trace-note">
        {finding.message} — found by {engineText(run.result)} at {where}. The inputs above make{' '}
        {finding.entry}() reach it
        {state.length ? '; the values below them are what the failing path computes' : ''}.
      </p>
      {finding.note ? <p className="trace-note tone-amber">{finding.note}</p> : null}
      {path.length ? (
        <>
          <div className="label trace-path-label">PATH</div>
          <ol className="trace-path">
            {path.map((s, i) => (
              <li key={i}>
                <span className="trace-path-line">{s.line || '·'}</span>
                <span className="trace-path-fn">{s.function}</span>
                <span className="trace-path-text">{s.text}</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </>
  );
}

function MisraNotChecked() {
  return (
    <p className="wb-clean">
      MISRA C:2012 rules are not checked yet. The rule texts are licensed and are not shipped with the
      product; this finding comes from the safety checks (bounds, pointers, division by zero, overflow,
      conversions and shifts).
    </p>
  );
}

const smtCache = new Map<string, SmtlibFile>();

function Smt({ run, finding }: { run: Run; finding: Finding }) {
  const key = `${run.id}:${finding.entry}:${finding.exportRef ?? ''}`;
  const [file, setFile] = useState<SmtlibFile | null>(smtCache.get(key) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(run.demo === true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (file || run.demo || !finding.exportRef || showRaw) return;
    const controller = new AbortController();
    const { request } = run;
    exportSmtlib(
      {
        code: request.code,
        fileName: request.fileName,
        engine: request.engine,
        ...(request.solver ? { solver: request.solver } : {}),
        ...(request.unwind ? { unwind: request.unwind } : {}),
        function: finding.entry,
        ref: finding.exportRef,
      },
      controller.signal,
    ).then(
      (f) => {
        smtCache.set(key, f);
        setFile(f);
      },
      (e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => controller.abort();
  }, [key, file, run, finding, showRaw]);

  const logic = file ? /\(set-logic\s+([^)\s]+)\)/.exec(file.text)?.[1] : undefined;
  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copying needs clipboard permission; use Download instead.');
    }
  };

  const raw = run.result.raw;
  return (
    <>
      {showRaw ? (
        <pre className="smt-block">
          {raw ? raw.slice(0, 4000) : `No ${run.result.engineLabel} output was kept for this run.`}
        </pre>
      ) : file ? (
        <pre className="smt-block smt-scroll" tabIndex={0} aria-label={file.fileName}>
          {file.text}
        </pre>
      ) : (
        <div className="smt-block tone-muted">
          {error ?? (finding.exportRef ? 'Exporting the obligation…' : 'This obligation cannot be exported.')}
        </div>
      )}
      <div className="smt-foot">
        {showRaw ? (
          <span>{run.result.engineLabel} output · first 4000 characters</span>
        ) : (
          <span>{logic ? `logic ${logic} · ` : ''}sat means the obligation can be violated</span>
        )}
        {!showRaw && file ? (
          <>
            <button type="button" className="btn-reset smt-action" onClick={download}>
              Download .smt2
            </button>
            <button type="button" className="btn-reset smt-action" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </>
        ) : null}
        {!run.demo ? (
          <button type="button" className="btn-reset smt-action" onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? 'Show SMT-LIB' : 'Checker output'}
          </button>
        ) : null}
      </div>
      {run.demo ? (
        <p className="trace-note">
          Exporting SMT-LIB needs a server; the demo shows the recorded checker output.
        </p>
      ) : null}
    </>
  );
}

function Clean({ run, tab }: { run: Run; tab: DetailTab }) {
  const undecided = inconclusive(run.result);
  if (tab === 'misra') return <MisraNotChecked />;
  return (
    <>
      <p className="wb-clean">
        {undecided.length
          ? `No obligation is refuted, but ${undecided.length} could not be decided:`
          : 'All proof obligations discharged. Re-verify to reproduce the result, or open the Report for the full record.'}
      </p>
      {undecided.length ? (
        <ul className="wb-clean-list">
          {undecided.slice(0, 12).map((f, i) => (
            <li key={i}>
              {f.entry}() line {f.line}: {f.message} —{' '}
              {INCONCLUSIVE_REASON[f.reason ?? 'unknown'] ?? f.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
