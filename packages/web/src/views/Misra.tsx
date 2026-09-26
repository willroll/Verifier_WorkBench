import { Link } from '../router';
import { useCurrentRun } from '../runs';
import './pages.css';

// MISRA C:2012 checking is not built yet (docs/PLAN.md, Phase 5). The rule
// texts are licensed, so nothing here pretends to have checked them.

export function Misra() {
  const run = useCurrentRun();
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">MISRA C:2012 compliance{run ? ` — ${run.request.fileName}` : ''}</h1>
        <div className="page-meta">not checked</div>
      </div>
      <div className="page-card page-card-body">
        <p>
          MISRA C:2012 rules are not checked yet. The rule texts are licensed and are not shipped with
          Verifier Workbench; the planned route is a MISRA checker (such as cppcheck&apos;s MISRA add-on) with
          a rule file you supply.
        </p>
        <p>
          What is checked today are the safety obligations — array bounds, pointers, division by zero, signed
          and unsigned overflow, conversions and shifts — with a counterexample for each one that fails.
          {run ? (
            <>
              {' '}
              <Link to={`/runs/${run.id}`}>
                Open run {run.demo ? '(demo)' : `#${run.number}`} in the Workbench
              </Link>
              .
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
