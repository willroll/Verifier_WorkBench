import {
  INCONCLUSIVE_REASON,
  capitalize,
  engineText,
  findingId,
  inconclusive,
  inputSummary,
  obligationList,
  proved,
  seconds,
  solverText,
} from '../../format';
import type { WorkbenchModel } from './model';

// Col 3 (top): the run banner, one card per refuted obligation, and the
// obligations that were proved or could not be decided.

export function FindingsPanel({
  model,
  selected,
  onSelect,
}: {
  model: WorkbenchModel;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const { run, refuted } = model;
  const r = run.result;
  const provedList = obligationList(proved(r));
  const undecided = inconclusive(r);
  const counts = [
    `${r.counts.refuted} refuted`,
    `${r.counts.proved} proved`,
    ...(r.counts.inconclusive ? [`${r.counts.inconclusive} inconclusive`] : []),
    seconds(r.durationMs),
  ].join(' · ');

  return (
    <div className="fp">
      <div className={`fp-banner${run.demo ? ' fp-banner-demo' : ''}`}>
        <div className="fp-banner-label">{run.demo ? 'RECORDED RUN' : 'LIVE RUN'}</div>
        <div className="fp-banner-line">
          {engineText(r)}
          {r.solver ? ` · ${solverText(r)}` : ''}
          <br />
          {counts}
        </div>
      </div>

      <h2 className="label fp-heading">
        FINDINGS ({refuted.length}) · {r.engineLabel}
      </h2>
      {refuted.length > 0 ? (
        <ul className="fp-cards" aria-label="Refuted obligations">
          {refuted.map((f, i) => (
            <li key={`${f.entry}:${f.id}`}>
              <button
                type="button"
                className={`btn-reset fp-card${i === selected ? ' fp-card-on' : ''}`}
                aria-pressed={i === selected}
                onClick={() => onSelect(i)}
              >
                <span className="fp-card-top">
                  <span className="fp-pill">{findingId(i)}</span>
                  <span className="fp-card-title">{capitalize(f.message)}</span>
                </span>
                <span className="fp-card-meta">
                  {[f.entry, f.line ? `line ${f.line}` : '', f.kind, inputSummary(f)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : undecided.length === 0 ? (
        <div className="fp-empty">✓ No findings — all {r.findings.length} obligations discharged</div>
      ) : (
        <div className="fp-empty fp-empty-amber">
          No counterexample found, but {undecided.length} obligation(s) are inconclusive.
        </div>
      )}

      <h2 className="label fp-heading">PROVED ({r.counts.proved})</h2>
      <div className="fp-list tone-green">
        {provedList.length ? provedList.map((l) => `✓ ${l}`).join('\n') : '—'}
      </div>

      {undecided.length > 0 ? (
        <>
          <h2 className="label fp-heading">INCONCLUSIVE ({undecided.length})</h2>
          <ul className="fp-list fp-list-amber">
            {undecided.slice(0, 12).map((f, i) => (
              <li key={i}>
                ◐ {f.entry}#{f.kind}
                <span className="fp-reason"> — {INCONCLUSIVE_REASON[f.reason ?? 'unknown'] ?? f.reason}</span>
              </li>
            ))}
            {undecided.length > 12 ? <li>… {undecided.length - 12} more</li> : null}
          </ul>
        </>
      ) : null}
    </div>
  );
}
