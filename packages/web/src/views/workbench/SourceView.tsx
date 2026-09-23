import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { findingId } from '../../format';
import { highlight } from '../../highlight';
import { hunkHeader, type WorkbenchModel } from './model';

// Col 2: the source (always on the dark code surface) with finding markers,
// or the diff of the patch that held.

export type SourceMode = 'source' | 'diff';

interface Props {
  model: WorkbenchModel;
  mode: SourceMode;
  onMode: (m: SourceMode) => void;
  selected: number;
  onSelect: (index: number) => void;
}

export function SourceView({ model, mode, onMode, selected, onSelect }: Props) {
  const { run } = model;
  const patched = run.repair?.status === 'repaired';
  return (
    <section className="wb-source on-code" aria-label="Source">
      <div className="src-head">
        <span className="src-title">
          SOURCE · {run.request.fileName}
          {patched ? ' · patched' : ''}
        </span>
        <span className="src-switch" role="group" aria-label="Show">
          <button
            type="button"
            className="btn-reset src-switch-btn"
            aria-pressed={mode === 'source'}
            onClick={() => onMode('source')}
          >
            Source
          </button>
          <button
            type="button"
            className="btn-reset src-switch-btn"
            aria-pressed={mode === 'diff'}
            onClick={() => onMode('diff')}
          >
            Diff
          </button>
        </span>
      </div>
      {mode === 'source' ? (
        <SourceLines model={model} selected={selected} onSelect={onSelect} />
      ) : (
        <DiffLines model={model} />
      )}
    </section>
  );
}

function SourceLines({ model, selected, onSelect }: Omit<Props, 'mode' | 'onMode'>) {
  const { run, refuted, lineToFinding, inconclusiveLines, fixedLines } = model;
  const lines = useMemo(() => highlight(run.request.code), [run.request.code]);
  const selectedLine = refuted[selected]?.line;
  const container = useRef<HTMLDivElement>(null);

  // Bring the selected finding's line into view when the selection changes
  // (not on first render: the page opens at the top, keyboard focus too).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (selectedLine === undefined) return;
    container.current?.querySelector(`[data-line="${selectedLine}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedLine]);

  return (
    <div
      className="src-lines"
      ref={container}
      role="region"
      aria-label={`Source of ${run.request.fileName}`}
      tabIndex={0}
    >
      {lines.map((tokens, i) => {
        const n = i + 1;
        const idx = lineToFinding.get(n);
        const marked = idx !== undefined;
        const finding = marked ? refuted[idx] : undefined;
        const undecided = !marked ? inconclusiveLines.get(n) : undefined;
        const fixed = !marked && fixedLines.has(n);
        const cls = [
          'src-line',
          marked ? 'src-line-refuted' : '',
          marked && idx === selected ? 'src-line-selected' : '',
          undecided ? 'src-line-inconclusive' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const activate = () => marked && onSelect(idx);
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        };
        return (
          <div
            key={n}
            data-line={n}
            className={cls}
            {...(marked
              ? {
                  role: 'button',
                  tabIndex: 0,
                  onClick: activate,
                  onKeyDown: onKey,
                  'aria-label': `Line ${n}: ${findingId(idx)}, ${finding!.message}`,
                }
              : {})}
          >
            <span className="src-no">{n}</span>
            <span className="src-code">
              {tokens.map((t, k) =>
                t.kind === 'plain' ? (
                  t.text
                ) : (
                  <span key={k} className={`syn-${t.kind}`}>
                    {t.text}
                  </span>
                ),
              )}
            </span>
            {finding ? (
              <span className="src-mark src-mark-red">
                {run.demo ? `  ● ${findingId(idx!)}` : `   ← ${finding.kind}`}
              </span>
            ) : null}
            {undecided ? (
              <span className="src-mark src-mark-amber">{`   ← ${undecided.kind} · inconclusive`}</span>
            ) : null}
            {fixed ? <span className="src-mark src-mark-green">{'  ✓ fixed'}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function DiffLines({ model }: { model: WorkbenchModel }) {
  const diff = model.run.repair?.status === 'repaired' ? (model.run.repair.diff ?? []) : [];
  if (diff.length === 0) {
    return (
      <div className="diff">
        <div className="diff-line diff-ctx">
          No patch yet. “Repair & verify” produces one, re-checked by the checker.
        </div>
      </div>
    );
  }
  const fns = model.functions;
  return (
    <div className="diff" role="region" aria-label="Patch" tabIndex={0}>
      <div className="diff-line diff-ctx">{hunkHeader(diff, -1, fns)}</div>
      {diff.map((d, i) => {
        if (d.type === '@') {
          return (
            <div key={i} className="diff-line diff-ctx diff-hunk">
              {hunkHeader(diff, i, fns)}
            </div>
          );
        }
        const cls = d.type === '+' ? 'diff-add' : d.type === '-' ? 'diff-del' : 'diff-ctx';
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {d.type}
            {d.text}
          </div>
        );
      })}
    </div>
  );
}
