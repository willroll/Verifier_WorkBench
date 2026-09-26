import { useEffect } from 'react';
import { useBackend } from './backend';
import { TopBar } from './components/TopBar';
import { DEMO_RUN_ID } from './demo';
import { matchRoute, navigate, usePath } from './router';
import { useCurrentRun } from './runs';
import { Misra } from './views/Misra';
import { NewRun } from './views/NewRun';
import { NotFound } from './views/NotFound';
import { ProblemSets } from './views/ProblemSets';
import { Report } from './views/Report';
import { Workbench } from './views/Workbench';

export function App() {
  const route = matchRoute(usePath());
  const backend = useBackend();
  const current = useCurrentRun();

  // "/" opens the last run, the demo when there is no server, or a new run.
  useEffect(() => {
    if (route.name !== 'home' || backend.state === 'loading') return;
    const to = current
      ? `/runs/${current.id}`
      : backend.state === 'offline'
        ? `/runs/${DEMO_RUN_ID}`
        : '/new';
    navigate(to, { replace: true });
  }, [route.name, backend.state, current]);

  return (
    <div className="vw-root">
      <TopBar route={route} />
      <main>
        {route.name === 'new' ? <NewRun /> : null}
        {route.name === 'workbench' ? <Workbench runId={route.runId} /> : null}
        {route.name === 'report' ? <Report runId={route.runId} /> : null}
        {route.name === 'misra' ? <Misra /> : null}
        {route.name === 'batch' ? <ProblemSets /> : null}
        {route.name === 'not-found' ? <NotFound /> : null}
      </main>
    </div>
  );
}
