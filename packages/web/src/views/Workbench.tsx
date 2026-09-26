import { useEffect, useMemo, useState } from 'react';
import { useBackend } from '../backend';
import { Link } from '../router';
import { setCurrentRun, useRun, type Run } from '../runs';
import { AgentCard } from './workbench/AgentCard';
import { DetailTabs, type DetailTab } from './workbench/DetailTabs';
import { FindingsPanel } from './workbench/FindingsPanel';
import { ProjectTree } from './workbench/ProjectTree';
import { SourceView, type SourceMode } from './workbench/SourceView';
import { buildModel } from './workbench/model';
import './workbench/workbench.css';

export function Workbench({ runId }: { runId: string }) {
  const run = useRun(runId);
  const backend = useBackend();
  useEffect(() => {
    if (run) setCurrentRun(run.id);
  }, [run]);
  if (!run) return <MissingRun runId={runId} loading={backend.state === 'loading'} />;
  return <WorkbenchView key={run.id} run={run} />;
}

function WorkbenchView({ run }: { run: Run }) {
  const model = useMemo(() => buildModel(run), [run]);
  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState<DetailTab>('trace');
  const [mode, setMode] = useState<SourceMode>(run.repair?.status === 'repaired' ? 'diff' : 'source');

  const select = (i: number) => {
    setSelected(i);
    setTab('trace');
  };
  const selectFunction = (name: string) => {
    const i = model.refuted.findIndex((f) => f.entry === name);
    if (i >= 0) return select(i);
    const line = model.functions.find((f) => f.name === name)?.line;
    setMode('source');
    window.setTimeout(() => {
      document.querySelector(`.src-lines [data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
    });
  };

  return (
    <div className="wb">
      <h1 className="visually-hidden">
        {run.demo ? 'Recorded run' : `Run #${run.number}`} of {run.request.fileName}
      </h1>
      <ProjectTree model={model} selected={selected} onSelectFunction={selectFunction} />
      <SourceView model={model} mode={mode} onMode={setMode} selected={selected} onSelect={select} />
      <aside className="wb-col3" aria-label="Findings and agent">
        <FindingsPanel model={model} selected={selected} onSelect={select} />
        <AgentCard run={run} />
      </aside>
      <DetailTabs model={model} selected={selected} tab={tab} onTab={setTab} />
    </div>
  );
}

function MissingRun({ runId, loading }: { runId: string; loading: boolean }) {
  if (loading) return null;
  return (
    <div className="page">
      <h1 className="page-title">Run #{runId} is not in this browser</h1>
      <p className="page-sub">
        Runs are kept in the browser that made them (at most the last 20).{' '}
        <Link to="/new">Start a new run</Link>.
      </p>
    </div>
  );
}
