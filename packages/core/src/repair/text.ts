// Source-level facts about C code that need no compiler: what a patch added
// or removed that could silence the checker instead of fixing the code.

/**
 * Replaces comments and string/character literals with spaces, keeping
 * newlines and every other character position, so later scans only see code.
 */
export function blankCommentsAndStrings(code: string): string {
  const out = code.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? code.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? code.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

const count = (items: string[]) => {
  const m = new Map<string, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/**
 * Verifier-specific constructs, counted: intrinsics such as __CPROVER_assume
 * or __ESBMC_assume, compiler assumptions, pragmas that switch checks off, and
 * the names the behavior check reserves for itself (__vw_*).
 */
export function verifierConstructs(code: string): Map<string, number> {
  const text = blankCommentsAndStrings(code);
  const found = [
    ...text.matchAll(
      /\b(__CPROVER_\w+|__ESBMC_\w+|__VERIFIER_\w+|__vw_\w+|__builtin_(?:assume|unreachable))\b/g,
    ),
  ].map((m) => m[1]!);
  // Found in the blanked text (so commented-out pragmas do not count), quoted
  // from the original (blanking keeps positions, and string arguments matter).
  for (const m of text.matchAll(/^[ \t]*#[ \t]*pragma[ \t]+(?:CPROVER|ESBMC)\b.*$/gm)) {
    const line = code.slice(m.index, m.index + m[0].trimEnd().length);
    found.push(
      line
        .trim()
        .replace(/^#\s*pragma\s+/, '#pragma ')
        .replace(/\s+/g, ' '),
    );
  }
  return count(found);
}

const ASSERT_CALLS = /\b(assert|__CPROVER_assert|__VERIFIER_assert|_Static_assert|static_assert)\s*\(/g;

/** Arguments of assert-like calls with whitespace removed, counted. */
export function assertionConditions(code: string): Map<string, number> {
  const text = blankCommentsAndStrings(code);
  const conditions: string[] = [];
  for (const m of text.matchAll(ASSERT_CALLS)) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
      j++;
    }
    if (depth === 0) conditions.push(`${m[1]!}(${text.slice(start, j - 1).replace(/\s+/g, '')})`);
  }
  return count(conditions);
}

const ASSERT_MACROS =
  /^[ \t]*#[ \t]*(define|undef)[ \t]+(assert|NDEBUG|static_assert|__CPROVER_assert|__VERIFIER_assert)\b/gm;

/** #define/#undef lines that would switch assertions off or redefine them, counted. */
export function assertionMacros(code: string): Map<string, number> {
  const text = blankCommentsAndStrings(code);
  return count([...text.matchAll(ASSERT_MACROS)].map((m) => `#${m[1]!} ${m[2]!}`));
}

const TERMINATING_CALLS =
  /\b(abort|exit|_Exit|quick_exit|longjmp|siglongjmp|__builtin_trap|pthread_exit|thrd_exit)\s*\(/g;

/** Calls that end the program (or jump out of the function), counted by name. */
export function terminatingCalls(code: string): Map<string, number> {
  const text = blankCommentsAndStrings(code);
  return count([...text.matchAll(TERMINATING_CALLS)].map((m) => m[1]!));
}

/** Keys whose count in `after` is higher than in `before`. */
export function added(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k);
}

/** Keys whose count in `after` is lower than in `before`. */
export function removed(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...before].filter(([k, n]) => n > (after.get(k) ?? 0)).map(([k]) => k);
}
