import { useRef, useState, type DragEvent } from 'react';
import type { EngineId, SolverId } from '@verifier/shared';
import { runVerification, useVerifying } from '../actions';
import { useBackend } from '../backend';
import { OptionGroup, type Option } from '../components/OptionGroup';
import { DEMO_RUN_ID } from '../demo';
import { updateDraft, useDraft } from '../draft';
import { navigate } from '../router';
import { DEFAULT_SAMPLE, SAMPLES, getSample, type Sample } from '../samples';
import './newrun.css';

type RuleSet = 'c2012' | 'amd2' | 'safety';

const RULE_SETS: Option<RuleSet>[] = [
  { value: 'c2012', label: 'MISRA C:2012', disabled: true, title: 'MISRA rules are not checked yet' },
  { value: 'amd2', label: 'MISRA C:2012 + Amd 2', disabled: true, title: 'MISRA rules are not checked yet' },
  { value: 'safety', label: 'Safety VCs only' },
];

const ENGINE_LABEL: Record<EngineId, string> = { cbmc: 'CBMC', esbmc: 'ESBMC' };

export function NewRun() {
  const backend = useBackend();
  const draft = useDraft();
  const verifying = useVerifying();
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const live = backend.state === 'live' ? backend.engines : null;
  const engine: EngineId = draft.engine ?? live?.default ?? 'cbmc';
  const info = live?.engines[engine];
  const solverInfo = info?.solvers ?? [];
  const solver: SolverId | null =
    draft.solver && solverInfo.some((s) => s.id === draft.solver && s.available)
      ? draft.solver
      : (info?.defaultSolver ?? (backend.state === 'offline' ? 'z3' : null));
  const maxUnwind = live?.limits.maxUnwind ?? 256;
  const unwind = draft.unwind ?? live?.limits.defaultUnwind ?? 16;
  const maxBytes = live?.limits.maxCodeBytes ?? 200 * 1024;
  const lines = draft.code.split('\n').length;

  let engineNote: { text: string; tone: 'green' | 'amber' | 'muted' };
  if (backend.state === 'loading') engineNote = { text: 'Checking the server…', tone: 'muted' };
  else if (backend.state === 'offline')
    engineNote = { text: 'No server detected — the demo replays a recorded run.', tone: 'amber' };
  else if (info?.available)
    engineNote = { text: `${info.label} ${info.version?.split(/\s+/)[0] ?? 'ready'}`, tone: 'green' };
  else engineNote = { text: `${ENGINE_LABEL[engine]} is not installed on this server.`, tone: 'amber' };

  const solverOptions: Option<SolverId>[] = live
    ? solverInfo.map((s) => ({
        value: s.id,
        label: s.id,
        disabled: !s.available,
        title: s.available
          ? `${s.label} ${s.version ?? ''}`.trim()
          : `${s.label} is not installed on this server`,
      }))
    : [{ value: 'z3', label: 'z3' }];

  const sat = solver === 'minisat';
  const canVerify = draft.code.trim() !== '' && (backend.state === 'offline' || !!info?.available);

  const loadSample = (sample: Sample) => {
    setError(null);
    updateDraft({
      code: sample.code,
      fileName: sample.fileName,
      sampleId: sample.id,
      checks: sample.checks ?? null,
      ...(sample.engine ? { engine: sample.engine, solver: null } : {}),
      ...(sample.solver ? { solver: sample.solver } : {}),
    });
  };
  const activeSample = getSample(draft.sampleId);

  const verify = async () => {
    setError(null);
    if (backend.state === 'offline') {
      if (draft.code.trim() === DEFAULT_SAMPLE.code.trim()) navigate(`/runs/${DEMO_RUN_ID}`);
      else
        setError(
          'No server is reachable, so nothing can be verified here. The demo replays a recorded run of the arith.c sample (load it from Samples).',
        );
      return;
    }
    const outcome = await runVerification({
      code: draft.code,
      fileName: draft.fileName.trim() || 'input.c',
      engine,
      ...(solver ? { solver } : {}),
      unwind,
      ...(draft.checks ? { checks: draft.checks } : {}),
    });
    if (!outcome.ok) setError(outcome.error);
  };

  const takeFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!/\.[ch]$/i.test(file.name)) return setError(`${file.name} is not a .c or .h file.`);
    if (file.size > maxBytes) {
      return setError(`${file.name} is larger than the ${Math.round(maxBytes / 1024)} KB limit.`);
    }
    updateDraft({ code: await file.text(), fileName: file.name });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void takeFile(e.dataTransfer.files[0]);
  };

  return (
    <div className="nr">
      <h1 className="nr-title">New verification run</h1>
      <p className="nr-sub">
        Paste C source or drop a file. The agent generates verification conditions, discharges them with the
        selected solver, and reports counterexamples for anything it can refute.
      </p>
      <div className="nr-grid">
        <div>
          <div className="nr-filebar">
            <label className="visually-hidden" htmlFor="nr-file">
              File name
            </label>
            <input
              id="nr-file"
              className="nr-filename"
              value={draft.fileName}
              spellCheck={false}
              onChange={(e) => updateDraft({ fileName: e.target.value })}
            />
            <div className="nr-meta">{lines} lines · C</div>
            <label className="visually-hidden" htmlFor="nr-sample">
              Load a sample
            </label>
            <select
              id="nr-sample"
              className="nr-sample"
              value={activeSample && draft.code === activeSample.code ? activeSample.id : ''}
              onChange={(e) => {
                const s = getSample(e.target.value);
                if (s) loadSample(s);
              }}
            >
              <option value="">Load a sample…</option>
              {SAMPLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <label className="visually-hidden" htmlFor="nr-code">
            C source
          </label>
          <textarea
            id="nr-code"
            className="nr-code"
            value={draft.code}
            spellCheck={false}
            onChange={(e) => updateDraft({ code: e.target.value })}
          />
          {activeSample?.note && draft.code === activeSample.code ? (
            <div className="nr-sample-note">{activeSample.note}</div>
          ) : null}
          {draft.checks ? (
            <div className="nr-sample-note tone-muted">
              Checking only: {draft.checks.join(' · ')}. Other checks are off for this run.
            </div>
          ) : null}
          <div
            className={`nr-drop${dragOver ? ' nr-drop-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            Drop a <span className="mono">.c</span> / <span className="mono">.h</span> file here, or{' '}
            <button
              type="button"
              className="btn-reset nr-link-inline"
              onClick={() => fileInput.current?.click()}
            >
              browse
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".c,.h"
              className="visually-hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                void takeFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        <div className="nr-panel">
          <div className="label">RULE SET</div>
          <OptionGroup
            label="Rule set"
            layout="column"
            options={RULE_SETS}
            value="safety"
            onChange={() => {}}
          />
          <div className="nr-note tone-muted">MISRA C:2012 rules are not checked yet.</div>

          <div className="label nr-section">ENGINE</div>
          <OptionGroup
            label="Engine"
            layout="row"
            mono
            options={[
              { value: 'cbmc', label: 'CBMC' },
              { value: 'esbmc', label: 'ESBMC' },
            ]}
            value={engine}
            onChange={(v) => updateDraft({ engine: v, solver: null })}
          />
          <div className={`nr-note tone-${engineNote.tone}`}>{engineNote.text}</div>

          <div className="label nr-section">SOLVER</div>
          {solver ? (
            <OptionGroup
              label="Solver"
              layout="row"
              mono
              options={solverOptions}
              value={solver}
              onChange={(v) => updateDraft({ solver: v })}
            />
          ) : (
            <div className="nr-note tone-muted">No solver is available for this engine.</div>
          )}

          <div className="label nr-section">ENCODING</div>
          <div className="nr-encoding">{sat ? 'SAT · bit-precise' : 'SMT bit-vectors · bit-precise'}</div>
          <div className="nr-note tone-muted nr-note-tight">
            {sat
              ? 'Bit-blasted to CNF for MiniSAT; integers keep their exact C widths.'
              : 'Integers modelled as bit-vectors of their C width to catch overflow & wrap-around.'}
          </div>

          <div className="label nr-section">LOOP BOUND</div>
          <label className="nr-bound">
            Unwind loops up to
            <input
              type="number"
              min={1}
              max={maxUnwind}
              value={unwind}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= maxUnwind) updateDraft({ unwind: n });
              }}
            />
            times
          </label>
          <div className="nr-note tone-muted nr-note-tight">
            A loop that may run longer leaves its obligations inconclusive, never proved.
          </div>

          <button
            type="button"
            className="btn-reset nr-verify"
            disabled={verifying || !canVerify}
            onClick={() => void verify()}
          >
            {verifying ? 'Verifying…' : 'Verify →'}
          </button>
          {verifying ? (
            <div className="nr-progress" aria-live="polite">
              ▸ {ENGINE_LABEL[engine]} parsing {draft.fileName}…<br />▸ generating obligations
              <br />▸ {solver ?? 'solver'} running…
            </div>
          ) : null}
          {error ? (
            <div className="nr-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
