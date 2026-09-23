import type { DiffLine } from '@verifier/shared';

// Line diff for showing a patch. Common leading and trailing lines are
// trimmed first, so the LCS table only covers the changed middle, which is
// small for a minimal patch. A middle too large for the table is shown as a
// plain replacement, which is still a correct diff.

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const out: DiffLine[] = a.slice(0, head).map((text) => ({ type: ' ', text }));
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const n = ma.length;
  const m = mb.length;

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    out.push(
      ...ma.map((text): DiffLine => ({ type: '-', text })),
      ...mb.map((text): DiffLine => ({ type: '+', text })),
    );
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = ma[i] === mb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        out.push({ type: ' ', text: ma[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        out.push({ type: '-', text: ma[i++]! });
      } else {
        out.push({ type: '+', text: mb[j++]! });
      }
    }
    while (i < n) out.push({ type: '-', text: ma[i++]! });
    while (j < m) out.push({ type: '+', text: mb[j++]! });
  }

  out.push(...a.slice(a.length - tail).map((text): DiffLine => ({ type: ' ', text })));
  return out;
}

/** Keeps changed lines plus `context` lines around them; '@' marks a gap. */
export function hunks(diff: DiffLine[], context = 2): DiffLine[] {
  const keep = new Set<number>();
  diff.forEach((d, i) => {
    if (d.type === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep.add(k);
  });
  const out: DiffLine[] = [];
  let last = -1;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && i > last + 1) out.push({ type: '@', text: '@@' });
    out.push(diff[i]!);
    last = i;
  }
  return out;
}

export const patchOf = (before: string, after: string): DiffLine[] => hunks(lineDiff(before, after));
