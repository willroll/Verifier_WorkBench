import { useState } from 'react';
import type { ProviderId, RepairResult } from '@verifier/shared';
import { useBackend } from '../../backend';
import { DEMO_PATCHED_ID, demoRepair } from '../../demo';
import { replayRepair, startRepair, stopRepair, useRepairSession } from '../../repairSession';
import { Link } from '../../router';
import type { Run } from '../../runs';
import { Ticked } from '../../components/Ticked';
import { logLines, verdictOf, type Tone } from './agentLog';

// Col 3 (bottom): asks a model for a patch and shows every attempt as the
// loop checks it. Only the checker can declare success (design-handoff.md).

export function AgentCard({ run }: { run: Run }) {
  const backend = useBackend();
  const session = useRepairSession(run.id);
  const providers = backend.state === 'live' ? (backend.providers?.providers ?? []) : [];
  const defaultProvider =
    backend.state === 'live' ? (backend.providers?.default ?? 'anthropic') : 'anthropic';
  const [choice, setChoice] = useState<ProviderId | null>(null);
  const provider: ProviderId = choice ?? session?.provider ?? defaultProvider;
  const info = providers.find((p) => p.id === provider);
  const label = info?.label ?? 'Claude';

  const running = session?.status === 'running';
  // A patched run carries the repair that produced it; otherwise the session's.
  const result: RepairResult | undefined = run.repair ?? session?.result;
  const iterations = run.repair?.iterations ?? session?.iterations ?? [];
  const lines = logLines(iterations);
  const hasRefuted = run.result.counts.refuted > 0;
  const configured = run.demo || info?.configured === true;
  const canRepair =
    hasRefuted && !run.repair && !running && (run.demo || backend.state === 'live') && configured;

  const start = () => {
    if (run.demo) {
      const recorded = demoRepair();
      if (recorded) replayRepair(run, recorded, DEMO_PATCHED_ID);
      return;
    }
    startRepair(run, provider, info?.model ?? label);
  };

  let badge: { text: string; tone: Tone };
  if (run.demo) badge = { text: 'demo · recorded', tone: 'amber' };
  else if (running) badge = { text: 'live · thinking…', tone: 'accent' };
  else if (result)
    badge = { text: `live · ${label.toLowerCase()}`, tone: result.status === 'error' ? 'amber' : 'green' };
  else if (backend.state === 'live' && !configured) badge = { text: 'not configured', tone: 'amber' };
  else badge = { text: 'ready', tone: 'muted' };

  let text: string | null = null;
  if (result?.rationale && (result.status === 'repaired' || result.status === 'unrepaired'))
    text = result.rationale;
  else if (!result && !running && hasRefuted && run.demo) {
    text =
      'Replays a recorded repair: real CBMC results with scripted model answers — one patch the behavior proof rejects, then the fix.';
  } else if (!result && !running && hasRefuted) {
    text =
      backend.state === 'live' && !configured
        ? `${label} is not configured on this server${info?.missing ? `: set ${info.missing}` : ''}.`
        : `Asks ${label} for a patch, re-verifies it, and proves it changes nothing else. Only a patch that passes counts.`;
  } else if (!result && !running && !hasRefuted) {
    text = run.result.counts.inconclusive
      ? 'Nothing is refuted. Raise the loop bound to decide the inconclusive obligations before repairing.'
      : 'Nothing to repair — every obligation is proved.';
  }

  const verdict = result ? verdictOf(result, run.result.engineLabel) : null;
  const proofs = result?.status === 'repaired' ? (result.equivalence ?? []) : [];

  return (
    <section className="agent" aria-label="Agent">
      <div className="agent-head">
        <span className="agent-title">AGENT</span>
        <span className={`agent-badge badge-${badge.tone}`}>{badge.text}</span>
        {canRepair ? (
          <button type="button" className="btn-reset agent-action" onClick={start}>
            {run.demo ? 'Replay repair' : result ? 'Repair again' : 'Repair & verify'}
          </button>
        ) : running ? (
          <button type="button" className="btn-reset agent-action" onClick={() => stopRepair(run.id)}>
            Stop
          </button>
        ) : null}
      </div>
      <label className="visually-hidden" htmlFor={`agent-model-${run.id}`}>
        Model
      </label>
      <select
        id={`agent-model-${run.id}`}
        className="agent-select"
        value={provider}
        disabled={running || !!run.repair || run.demo}
        onChange={(e) => setChoice(e.target.value as ProviderId)}
      >
        {(run.demo
          ? [{ id: provider, label: 'Scripted answers (recorded)', configured: true }]
          : providers.length
            ? providers
            : [{ id: 'anthropic' as const, label: 'Claude', configured: true }]
        ).map((p) => (
          <option key={p.id} value={p.id} disabled={!p.configured}>
            {p.label}
            {p.configured ? '' : ' (not configured)'}
          </option>
        ))}
      </select>
      {text ? (
        <p className="agent-text">
          <Ticked text={text} />
        </p>
      ) : null}
      {lines.length || running ? (
        <div className="agent-log" aria-live="polite">
          {lines.map((l, i) => (
            <div key={i}>
              <div className={`agent-log-line tone-${l.tone}`}>{l.text}</div>
              {l.detail ? (
                <div className="agent-log-detail">
                  <Ticked text={l.detail} />
                </div>
              ) : null}
            </div>
          ))}
          {running && session?.step ? (
            <div className="agent-log-line tone-muted">
              iter {session.step.iter} · {session.step.text}
            </div>
          ) : null}
        </div>
      ) : null}
      {session?.error && !result ? <div className="agent-verdict tone-amber">{session.error}</div> : null}
      {verdict ? (
        <div className={`agent-verdict tone-${verdict.tone}`}>
          {verdict.text}{' '}
          {result?.status === 'repaired' && run.parentId ? (
            <Link to={`/runs/${run.parentId}`} className="agent-revert">
              Revert
            </Link>
          ) : result?.status === 'repaired' && session?.patchedRunId ? (
            <Link to={`/runs/${session.patchedRunId}`} className="agent-revert">
              Open the patched run
            </Link>
          ) : null}
        </div>
      ) : null}
      {proofs.length ? (
        <div className="agent-proofs">
          {proofs.map((p) => (
            <div key={p.function} className={p.status === 'equivalent' ? 'tone-green' : 'tone-amber'}>
              {p.status === 'equivalent' ? '≡' : '·'} {p.function}{' '}
              {p.status === 'equivalent' ? 'behaves as before (proved)' : `— ${p.reason ?? p.status}`}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
