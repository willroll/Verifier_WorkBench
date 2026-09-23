// Verified repair loop: verify -> ask an LLM to patch -> RE-VERIFY -> repeat.
//
// The core rule: a patch is never trusted. Every candidate goes back through the
// model checker, and the loop only reports success when the checker discharges
// every obligation. Bounded iterations; bails early if the model stops making
// progress. Terminal states:
//
//   'already-proved' — nothing to fix
//   'repaired'       — checker proved all obligations on a patched source
//   'unrepaired'     — ran out of iterations (or stalled) with findings left
//   'error'          — engine or model failure
//
// Returns the full iteration history so the UI can show the audit trail.

const engines = require('./engines');

const MAX_ITERS = Number(process.env.REPAIR_MAX_ITERS || 3);

// Pull the corrected source out of the model's reply.
function extractCode(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:c|cpp|C)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // No fence: accept the whole thing only if it looks like C.
  if (/#include|\bint\b|\bvoid\b|\breturn\b/.test(text) && text.includes(';')) return text.trim();
  return null;
}

function extractRationale(text) {
  if (!text) return '';
  const m = text.match(/RATIONALE:\s*(.+)/i);
  if (m) return m[1].trim();
  // else: first non-empty line outside the code fence
  const withoutCode = text.replace(/```[\s\S]*?```/g, '').trim();
  return (withoutCode.split('\n').find((l) => l.trim()) || '').trim();
}

function describeFindings(findings) {
  return findings.filter((f) => f.status === 'refuted').map((f, i) => {
    const where = [f.file && f.line ? f.file + ':' + f.line : '', f.function ? 'in ' + f.function + '()' : '']
      .filter(Boolean).join(' ');
    const model = f.model && f.model.length
      ? '\n   counterexample: ' + f.model.map((m) => m.name + ' = ' + m.value).join(', ')
      : '';
    return (i + 1) + '. [' + f.kind + '] ' + f.message + (where ? ' (' + where + ')' : '') + model;
  }).join('\n');
}

function buildPrompt(code, findings, attempt, previousAttemptFailed) {
  return [
    'You are a C verification-repair agent. A bounded model checker refuted the',
    'safety obligations listed below. Rewrite the source so every obligation is',
    'discharged.',
    '',
    'Rules:',
    '- Preserve every function signature and the observable contract.',
    '- Fix the root cause; do not delete code, weaken assertions, or add',
    '  assumptions to silence the checker.',
    '- Keep the change minimal.',
    '',
    'Respond with the COMPLETE corrected file in one ```c fenced block, then a',
    'single line starting with RATIONALE: explaining the fix in one sentence.',
    previousAttemptFailed
      ? '\nYour previous patch did NOT verify. The remaining failures are below; try a different approach.'
      : '',
    '',
    'Attempt ' + attempt + '.',
    '',
    'FAILED OBLIGATIONS:',
    describeFindings(findings),
    '',
    'SOURCE:',
    '```c',
    code,
    '```'
  ].filter((l) => l !== null).join('\n');
}

// LCS line diff -> [{ type: ' '|'-'|'+', text }]
function lineDiff(before, after) {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: '-', text: a[i] }); i++; }
    else { out.push({ type: '+', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: '-', text: a[i++] });
  while (j < m) out.push({ type: '+', text: b[j++] });
  return out;
}

// Collapse to changed hunks with context, so the UI shows the patch not the file.
function hunks(diff, context = 2) {
  const keep = new Set();
  diff.forEach((d, i) => {
    if (d.type === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k++) keep.add(k);
  });
  const out = [];
  let lastKept = -1;
  [...keep].sort((x, y) => x - y).forEach((i) => {
    if (lastKept >= 0 && i > lastKept + 1) out.push({ type: '@', text: '@@' });
    out.push(diff[i]);
    lastKept = i;
  });
  return out;
}

// `complete` is injected by the server: ({messages, max_tokens}) => Promise<string>
async function repair({ engine, code, fileName, maxIters, complete }) {
  const limit = Math.max(1, Math.min(Number(maxIters || MAX_ITERS), 6));
  const iterations = [];
  const originalCode = code;
  let currentCode = code;

  // Iteration 0: baseline verification of what the user gave us.
  const base = await engines.verify({ engine, code: currentCode, fileName });
  if (!base.available) return { status: 'error', error: base.error, hint: base.hint, iterations };
  if (base.status === 'error' || base.status === 'timeout') {
    return { status: 'error', error: base.error, iterations };
  }

  iterations.push({
    iter: 0, kind: 'verify', engine: base.engine, engineLabel: base.engineLabel,
    counts: base.counts, status: base.status, durationMs: base.durationMs,
    findings: base.findings
  });

  if (base.counts.refuted === 0) {
    return { status: 'already-proved', iterations, finalCode: currentCode,
      engineLabel: base.engineLabel, engineVersion: base.engineVersion };
  }

  let last = base;
  let stalled = false;

  for (let attempt = 1; attempt <= limit; attempt++) {
    let reply;
    try {
      reply = await complete({
        messages: [{ role: 'user', content: buildPrompt(currentCode, last.findings, attempt, attempt > 1) }],
        max_tokens: 2000
      });
    } catch (e) {
      iterations.push({ iter: attempt, kind: 'repair', error: 'model call failed: ' + (e.message || e) });
      break;
    }

    const candidate = extractCode(reply);
    const rationale = extractRationale(reply);
    if (!candidate) {
      iterations.push({ iter: attempt, kind: 'repair', error: 'model returned no usable source', rationale });
      break;
    }
    if (candidate.trim() === currentCode.trim()) {
      iterations.push({ iter: attempt, kind: 'repair', rationale, stalled: true,
        error: 'model returned unchanged source' });
      stalled = true;
      break;
    }

    // Re-verify. This is the whole point — the patch is a hypothesis until now.
    const check = await engines.verify({ engine, code: candidate, fileName });
    if (check.status === 'error' || check.status === 'timeout') {
      iterations.push({ iter: attempt, kind: 'repair', rationale,
        error: 'patch failed to verify: ' + check.error,
        diff: hunks(lineDiff(currentCode, candidate)) });
      break;
    }

    iterations.push({
      iter: attempt, kind: 'repair', rationale,
      counts: check.counts, status: check.status, durationMs: check.durationMs,
      findings: check.findings,
      diff: hunks(lineDiff(currentCode, candidate))
    });

    if (check.counts.refuted === 0) {
      return {
        status: 'repaired', iterations,
        finalCode: candidate,
        rationale,
        engineLabel: check.engineLabel, engineVersion: check.engineVersion,
        diff: hunks(lineDiff(originalCode, candidate))
      };
    }

    // Regression check: keep the patch only if it strictly reduced failures.
    if (check.counts.refuted <= last.counts.refuted) {
      currentCode = candidate;
      last = check;
    }
  }

  return {
    status: 'unrepaired', stalled, iterations,
    finalCode: currentCode,
    remaining: last.counts.refuted,
    engineLabel: last.engineLabel, engineVersion: last.engineVersion,
    diff: currentCode === originalCode ? [] : hunks(lineDiff(originalCode, currentCode))
  };
}

module.exports = { repair, lineDiff, hunks, extractCode };
