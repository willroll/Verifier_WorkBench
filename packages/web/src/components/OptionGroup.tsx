import { useRef, type KeyboardEvent } from 'react';

// A single-choice group styled as the design's option buttons, with radio
// semantics: one tab stop, arrow keys move the choice.

export interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

interface Props<T extends string> {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  layout: 'row' | 'column';
  mono?: boolean;
}

export function OptionGroup<T extends string>({ label, options, value, onChange, layout, mono }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step || enabled.length === 0) return;
    e.preventDefault();
    const at = enabled.findIndex((o) => o.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length]!;
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className={`opt-group opt-${layout}`}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={o.disabled}
            title={o.title}
            tabIndex={checked ? 0 : -1}
            className={`btn-reset opt${checked ? ' opt-on' : ''}${mono ? ' opt-mono' : ''}`}
            onClick={() => onChange(o.value)}
            onKeyDown={onKey}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
