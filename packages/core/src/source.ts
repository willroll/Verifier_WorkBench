import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Diagnostic } from '@verifier/shared';

/** File name the checker sees; shown in findings. Keeps letters, digits, dot, dash, underscore. */
export function safeFileName(name: string | undefined): string {
  const base = path
    .basename((name ?? '').trim())
    .replace(/[^\w.-]/g, '_')
    .replace(/^\.+/, '');
  const stem = base.replace(/\.[ch]$/i, '').slice(0, 60) || 'input';
  return `${stem}.c`;
}

// The C preprocessor reads whatever #include names. On a shared server that
// would let a submission pull host files into diagnostics, so includes must
// name a relative header without "..": system headers like <stdint.h> are
// fine; absolute paths, parent-directory escapes and macro-computed includes
// are rejected. The container sandbox (Phase 4) is the real boundary; this is
// defense in depth.
export function checkIncludes(code: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = code.split('\n');
  lines.forEach((text, i) => {
    const m = /^\s*#\s*(include|include_next|import)\b\s*(.*)$/.exec(text);
    if (!m) return;
    const target = (m[2] ?? '').trim();
    const quoted = /^(<[^>]*>|"[^"]*")/.exec(target);
    const where = { line: i + 1 };
    if (!quoted) {
      out.push({
        severity: 'error',
        message: `#${m[1]} must name a header in quotes or angle brackets`,
        ...where,
      });
      return;
    }
    const header = quoted[1]!.slice(1, -1);
    if (header.startsWith('/') || header.startsWith('\\') || /^[A-Za-z]:/.test(header)) {
      out.push({
        severity: 'error',
        message: `#include of an absolute path is not allowed: ${header}`,
        ...where,
      });
    } else if (header.split(/[\\/]/).includes('..')) {
      out.push({
        severity: 'error',
        message: `#include may not leave the source directory: ${header}`,
        ...where,
      });
    }
  });
  return out;
}

/** Runs `fn` with a private temporary directory that is always removed afterwards. */
export async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
