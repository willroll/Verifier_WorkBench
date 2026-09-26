// C syntax colouring in the design palette (types, keywords, numbers on the
// dark code surface). A small tokenizer is enough: it only colours, and a
// construct it misreads still shows as plain text.

export type TokenKind = 'plain' | 'type' | 'keyword' | 'number' | 'string' | 'comment' | 'preproc';

export interface Token {
  kind: TokenKind;
  text: string;
}

const TYPES = new Set(
  (
    'void char short int long float double signed unsigned _Bool bool _Complex struct union enum ' +
    'static const volatile extern register inline restrict typedef auto ' +
    'size_t ssize_t ptrdiff_t intptr_t uintptr_t intmax_t uintmax_t wchar_t FILE ' +
    'int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t ' +
    'int_least8_t int_least16_t int_least32_t int_least64_t uint_least8_t uint_least16_t uint_least32_t uint_least64_t ' +
    'int_fast8_t int_fast16_t int_fast32_t int_fast64_t uint_fast8_t uint_fast16_t uint_fast32_t uint_fast64_t'
  ).split(' '),
);

const KEYWORDS = new Set(
  'if else for while do return switch case default break continue goto sizeof _Alignof alignof _Static_assert static_assert _Generic NULL true false'.split(
    ' ',
  ),
);

const WORD = /[A-Za-z_]\w*/y;
const NUMBER =
  /(?:0[xX][\da-fA-F']+|0[bB][01']+|\d[\d']*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfF]*/y;

/** Tokens per line; block comments carry across lines. */
export function highlight(code: string): Token[][] {
  const lines = code.split('\n');
  let inComment = false;
  return lines.map((line) => {
    const out: Token[] = [];
    const push = (kind: TokenKind, text: string) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.text += text;
      else out.push({ kind, text });
    };
    let i = 0;
    if (!inComment && /^\s*#/.test(line)) {
      // Preprocessor line: directive in the keyword colour, the rest plain
      // (an #include target reads like a string).
      const m = /^(\s*#\s*\w+)(.*)$/.exec(line)!;
      push('keyword', m[1]!);
      const rest = m[2]!;
      const target = /^(\s*)(<[^>]*>|"[^"]*")(.*)$/.exec(rest);
      if (target) {
        push('plain', target[1]!);
        push('string', target[2]!);
        push('plain', target[3]!);
      } else if (rest) push('plain', rest);
      return out;
    }
    while (i < line.length) {
      if (inComment) {
        const end = line.indexOf('*/', i);
        const stop = end < 0 ? line.length : end + 2;
        push('comment', line.slice(i, stop));
        i = stop;
        if (end >= 0) inComment = false;
        continue;
      }
      const c = line[i]!;
      if (c === '/' && line[i + 1] === '/') {
        push('comment', line.slice(i));
        break;
      }
      if (c === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        const stop = end < 0 ? line.length : end + 2;
        push('comment', line.slice(i, stop));
        i = stop;
        if (end < 0) inComment = true;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        push('string', line.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      WORD.lastIndex = i;
      const w = WORD.exec(line);
      if (w) {
        const word = w[0];
        push(TYPES.has(word) ? 'type' : KEYWORDS.has(word) ? 'keyword' : 'plain', word);
        i += word.length;
        continue;
      }
      NUMBER.lastIndex = i;
      const n = /\d|\./.test(c) ? NUMBER.exec(line) : null;
      if (n && n[0] !== '.') {
        push('number', n[0]);
        i += n[0].length;
        continue;
      }
      push('plain', c);
      i++;
    }
    return out;
  });
}
