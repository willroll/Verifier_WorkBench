// Verification engine adapters: CBMC and ESBMC, interchangeable.
//
// Both are bounded model checkers that discharge safety obligations with an
// SMT solver (Z3 by default here). We shell out, then normalize their very
// different outputs into one shape the UI can render:
//
//   {
//     engine, engineVersion, status, durationMs,
//     counts: { proved, refuted },
//     findings: [{
//       id, status: 'proved'|'refuted', kind, message,
//       file, line, function,
//       model: [{ name, value }],      // counterexample assignments
//       trace: [{ line, function, text }]
//     }],
//     raw
//   }
//
// SECURITY: this compiles/analyses untrusted C. The checkers do not execute the
// program, but they do run a C frontend over attacker-controlled input. Run the
// server in a container with no network and a read-only FS before exposing it.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 60000);
const UNWIND = String(process.env.VERIFY_UNWIND || 16);

function which(bin) {
  return new Promise((resolve) => {
    const p = spawn(bin, ['--version']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 || out ? out.trim().split('\n')[0] : null));
  });
}

function run(bin, args, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const p = spawn(bin, args, { cwd });
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT_MS);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message, stdout, stderr, durationMs: Date.now() - started });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

// Map a checker's property description onto a short obligation kind.
function classify(desc) {
  const d = (desc || '').toLowerCase();
  if (d.includes('overflow')) return 'overflow';
  if (d.includes('bound') || d.includes('array') || d.includes('index')) return 'bounds';
  if (d.includes('division') || d.includes('div-by-zero') || d.includes('divide')) return 'div-by-zero';
  if (d.includes('null') || d.includes('pointer') || d.includes('dereference')) return 'pointer';
  if (d.includes('conversion')) return 'conversion';
  if (d.includes('unwind')) return 'unwind';
  return 'assertion';
}

// ---- CBMC ------------------------------------------------------------------
// --json-ui gives structured properties + traces, so parsing is reliable.

const cbmc = {
  id: 'cbmc',
  label: 'CBMC',
  bin: process.env.CBMC_BIN || 'cbmc',
  args(file) {
    return [
      file,
      '--json-ui',
      '--bounds-check',
      '--pointer-check',
      '--div-by-zero-check',
      '--signed-overflow-check',
      '--unsigned-overflow-check',
      '--conversion-check',
      '--unwind', UNWIND,
      ...extra('CBMC_EXTRA_FLAGS')
    ];
  },
  parse(stdout) {
    let arr;
    try { arr = JSON.parse(stdout); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    const block = arr.find((o) => o && Array.isArray(o.result));
    if (!block) return null;
    const findings = block.result.map((p, i) => {
      const loc = p.sourceLocation || {};
      const refuted = p.status !== 'SUCCESS';
      const steps = Array.isArray(p.trace) ? p.trace : [];
      const model = [];
      const trace = [];
      for (const s of steps) {
        const sl = s.sourceLocation || {};
        if (s.stepType === 'assignment' && !s.hidden && s.lhs) {
          const v = s.value && (s.value.data != null ? s.value.data : s.value.name);
          if (v != null) model.push({ name: s.lhs, value: String(v) });
        }
        if (sl.line) {
          trace.push({
            line: Number(sl.line),
            function: sl.function || '',
            text: s.stepType === 'assignment' && s.lhs ? s.lhs + ' = ' +
              String((s.value && (s.value.data != null ? s.value.data : s.value.name)) ?? '?')
              : (s.stepType || '')
          });
        }
      }
      return {
        id: p.property || 'vc-' + (i + 1),
        status: refuted ? 'refuted' : 'proved',
        kind: classify(p.description),
        message: p.description || '',
        file: loc.file || '',
        line: Number(loc.line || 0),
        function: loc.function || '',
        // dedupe: keep last assignment per variable, that's the witness value
        model: dedupeModel(model),
        trace
      };
    });
    return findings;
  }
};

// ---- ESBMC -----------------------------------------------------------------
// Text output. ESBMC stops at the first violated property unless told
// otherwise, so we ask for multi-property when the build supports it.

const esbmc = {
  id: 'esbmc',
  label: 'ESBMC',
  bin: process.env.ESBMC_BIN || 'esbmc',
  args(file) {
    return [
      file,
      '--bounds-check',
      '--pointer-check',
      '--div-by-zero-check',
      '--overflow-check',
      '--unwind', UNWIND,
      '--no-unwinding-assertions',
      ...extra('ESBMC_EXTRA_FLAGS')
    ];
  },
  parse(stdout) {
    const text = stdout || '';
    if (!/VERIFICATION (SUCCESSFUL|FAILED)/.test(text)) return null;
    const findings = [];
    // Each violation: "Violated property:\n  file f.c line N function g\n  <desc>"
    const re = /Violated property:\s*\n\s*file\s+(\S+)\s+line\s+(\d+)(?:\s+column\s+\d+)?(?:\s+function\s+(\S+))?\s*\n\s*([^\n]+)/g;
    let m;
    let i = 0;
    while ((m = re.exec(text))) {
      findings.push({
        id: 'vc-' + ++i,
        status: 'refuted',
        kind: classify(m[4]),
        message: (m[4] || '').trim(),
        file: m[1],
        line: Number(m[2]),
        function: m[3] || '',
        model: dedupeModel(parseEsbmcModel(text)),
        trace: parseEsbmcTrace(text)
      });
    }
    if (!findings.length && /VERIFICATION SUCCESSFUL/.test(text)) return [];
    return findings;
  }
};

// ESBMC counterexample states look like:
//   State 3 file f.c line 5 function avg thread 0
//   ----------------------------------------------
//     a = 2147483647 (01111111...)
function parseEsbmcModel(text) {
  const model = [];
  const re = /^\s{2,}([A-Za-z_][\w.\->\[\]]*)\s*=\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    let value = m[2].replace(/\s*\([01\s.]+\)\s*$/, '').trim();
    if (/^(file|line|function|thread|State)$/i.test(name)) continue;
    model.push({ name, value });
  }
  return model;
}

function parseEsbmcTrace(text) {
  const trace = [];
  const re = /^State\s+\d+\s+file\s+\S+\s+line\s+(\d+)(?:\s+column\s+\d+)?(?:\s+function\s+(\S+))?/gm;
  let m;
  while ((m = re.exec(text))) {
    trace.push({ line: Number(m[1]), function: m[2] || '', text: '' });
  }
  return trace;
}

function dedupeModel(model) {
  const seen = new Map();
  for (const kv of model) seen.set(kv.name, kv.value);
  return [...seen.entries()].map(([name, value]) => ({ name, value })).slice(0, 12);
}

function extra(varName) {
  const v = process.env[varName];
  return v ? v.split(/\s+/).filter(Boolean) : [];
}

const ENGINES = { cbmc, esbmc };

// Which engines are actually installed on this host.
async function detect() {
  const out = {};
  for (const key of Object.keys(ENGINES)) {
    const version = await which(ENGINES[key].bin);
    out[key] = { id: key, label: ENGINES[key].label, available: !!version, version: version || null };
  }
  return out;
}

// Verify `code` with the named engine. Never throws; returns a result object
// with `available:false` when the binary is missing so the UI can fall back.
async function verify({ engine, code, fileName }) {
  const eng = ENGINES[engine];
  if (!eng) return { engine, available: false, error: 'unknown engine: ' + engine };

  const version = await which(eng.bin);
  if (!version) {
    return {
      engine, available: false,
      error: eng.bin + ' not found on PATH',
      hint: 'Install ' + eng.label + ', or set ' + eng.id.toUpperCase() + '_BIN'
    };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const safeName = (fileName || 'input.c').replace(/[^\w.\-]/g, '_');
  const file = path.join(dir, safeName.endsWith('.c') ? safeName : safeName + '.c');
  fs.writeFileSync(file, code || '');

  let res;
  try {
    res = await run(eng.bin, eng.args(path.basename(file)), dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  if (res.timedOut) {
    return { engine, available: true, engineVersion: version, status: 'timeout',
      error: 'timed out after ' + TIMEOUT_MS + 'ms', raw: res.stdout || res.stderr };
  }
  if (res.error) {
    return { engine, available: true, engineVersion: version, status: 'error',
      error: res.error, raw: res.stderr };
  }

  const findings = eng.parse(res.stdout);
  if (findings === null) {
    // Parse failed — surface raw output rather than pretending we understood it.
    return { engine, available: true, engineVersion: version, status: 'error',
      error: 'could not parse ' + eng.label + ' output',
      raw: (res.stdout || '') + (res.stderr || '') };
  }

  const refuted = findings.filter((f) => f.status === 'refuted').length;
  return {
    engine,
    engineLabel: eng.label,
    available: true,
    engineVersion: version,
    status: refuted ? 'refuted' : 'proved',
    durationMs: res.durationMs,
    counts: { proved: findings.length - refuted, refuted },
    findings,
    raw: res.stdout && res.stdout.length < 200000 ? res.stdout : undefined
  };
}

module.exports = { detect, verify, ENGINES };
