import type { DiffLine } from '@verifier/shared';

// Line diff for showing a patch. Common leading and trailing lines are
// trimmed first, so the LCS table only covers the changed middle, which is
// small for a minimal patch. A middle too large for the table is shown as a
// plain replacement, which is still a correct diff.

const MAX_CELLS = 4_000_000;

/**
 * The candidate with the original's line endings and final newline. Both are
 * lost on the way through a model (the prompt fences the code), and a patch
 * should show only the changes that matter.
 */
export function sameLayout(original: string, candidate: string): string {
  const ending = /(?:\r?\n)*$/.exec(original)![0].replace(/\r\n/g, '\n');
  const code = candidate.replace(/\r\n/g, '\n').replace(/\n+$/, '') + ending;
  return original.includes('\r\n') ? code.replace(/\n/g, '\r\n') : code;
}

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

  // Indices are 0-based positions in a and b; lines are reported 1-based.
  const same = (i: number, j: number): DiffLine => ({
    type: ' ',
    text: a[i]!,
    oldLine: i + 1,
    newLine: j + 1,
  });
  const del = (i: number): DiffLine => ({ type: '-', text: a[i]!, oldLine: i + 1 });
  const ins = (j: number): DiffLine => ({ type: '+', text: b[j]!, newLine: j + 1 });

  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push(same(k, k));
  const n = a.length - tail - head;
  const m = b.length - tail - head;

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    for (let i = 0; i < n; i++) out.push(del(head + i));
    for (let j = 0; j < m; j++) out.push(ins(head + j));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] =
          a[head + i] === b[head + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) {
        out.push(same(head + i, head + j));
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        out.push(del(head + i++));
      } else {
        out.push(ins(head + j++));
      }
    }
    while (i < n) out.push(del(head + i++));
    while (j < m) out.push(ins(head + j++));
  }

  for (let k = 0; k < tail; k++) out.push(same(a.length - tail + k, b.length - tail + k));
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
