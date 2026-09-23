import { functionMark } from '../../format';
import type { WorkbenchModel } from './model';

// Col 1: the file and its functions, each marked with its verification status.

export function ProjectTree({
  model,
  selected,
  onSelectFunction,
}: {
  model: WorkbenchModel;
  selected: number;
  onSelectFunction: (name: string) => void;
}) {
  const { run, functions, refuted } = model;
  const selectedFn = refuted[selected]?.entry;
  return (
    <nav className="wb-tree" aria-label="Project">
      <div className="label wb-tree-label">PROJECT</div>
      <div className="wb-tree-row wb-tree-row-on">
        <span aria-hidden="true">◉ </span>
        {run.request.fileName}
      </div>
      <div className="label wb-tree-label wb-tree-label-fns">FUNCTIONS · {run.request.fileName}</div>
      <ul className="wb-tree-list">
        {functions.map((f) => {
          const m = functionMark(f);
          const on = f.name === selectedFn;
          return (
            <li key={f.name}>
              <button
                type="button"
                className={`btn-reset wb-tree-row wb-tree-fn${on ? ' wb-tree-row-on' : ''}`}
                onClick={() => onSelectFunction(f.name)}
                aria-current={on ? 'true' : undefined}
              >
                <span className={`tone-${m.tone}`} aria-hidden="true">
                  {m.mark}
                </span>
                {f.name}
                <span className="visually-hidden">, {m.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
