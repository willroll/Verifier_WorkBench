// Minimal host for the Verifier Workbench MVP.
// Serves the standalone UI and wires window.claude.complete -> a chosen LLM,
// so the live repair stream works in a hosted environment.
//
//   LLM_PROVIDER=anthropic  ANTHROPIC_API_KEY=sk-ant-...  node server.js
//   open http://localhost:3000
//
// Supported providers (set LLM_PROVIDER): anthropic | gemini | openai | custom
// See README.md for the env vars each one needs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const engines = require('./engines');
const { repair } = require('./repair');

const DEFAULT_ENGINE = (process.env.VERIFY_ENGINE || 'cbmc').toLowerCase();

const PORT = process.env.PORT || 3000;
const PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();

// ---- Provider adapters -----------------------------------------------------
// Each adapter turns { messages, max_tokens } into an upstream request and
// returns the completion text as a string. `messages` is [{role, content}].

const providers = {
  // Anthropic Claude — Messages API
  anthropic: {
    label: 'Anthropic Claude',
    keyVar: 'ANTHROPIC_API_KEY',
    async complete({ messages, max_tokens }) {
      const key = process.env.ANTHROPIC_API_KEY;
      const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model, max_tokens: max_tokens || 300, messages })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      return (data.content || []).map((b) => b.text || '').join('');
    }
  },

  // Google Gemini — generateContent
  gemini: {
    label: 'Google Gemini',
    keyVar: 'GEMINI_API_KEY',
    async complete({ messages, max_tokens }) {
      const key = process.env.GEMINI_API_KEY;
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      // fold roles into Gemini's contents shape; system -> a leading user turn
      const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        model + ':generateContent?key=' + encodeURIComponent(key);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: { maxOutputTokens: max_tokens || 300 }
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      const parts = ((data.candidates || [])[0] || {}).content;
      return ((parts && parts.parts) || []).map((p) => p.text || '').join('');
    }
  },

  // OpenAI ChatGPT — Chat Completions
  openai: {
    label: 'OpenAI ChatGPT',
    keyVar: 'OPENAI_API_KEY',
    async complete({ messages, max_tokens }) {
      const key = process.env.OPENAI_API_KEY;
      const model = process.env.OPENAI_MODEL || 'gpt-4o';
      const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
      const r = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + key
        },
        body: JSON.stringify({ model, max_tokens: max_tokens || 300, messages })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      return (((data.choices || [])[0] || {}).message || {}).content || '';
    }
  },

  // Any self-hosted, OpenAI-compatible endpoint (vLLM, Ollama, LM Studio,
  // TGI, llama.cpp server, etc). Point LLM_BASE_URL at its /v1.
  custom: {
    label: 'Self-hosted (OpenAI-compatible)',
    keyVar: null,
    async complete({ messages, max_tokens }) {
      const base = process.env.LLM_BASE_URL;
      if (!base) throw new Error('LLM_BASE_URL not set');
      const model = process.env.LLM_MODEL || 'local-model';
      const key = process.env.LLM_API_KEY; // optional
      const headers = { 'content-type': 'application/json' };
      if (key) headers.authorization = 'Bearer ' + key;
      const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: max_tokens || 300, messages })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      return (((data.choices || [])[0] || {}).message || {}).content || '';
    }
  }
};

// ---- Page shim -------------------------------------------------------------
// The UI already calls window.claude.complete({messages, max_tokens}); this
// forwards to our provider-agnostic /api/complete. No UI change per provider.
const SHIM = `<script>
window.claude = window.claude || {};
window.claude.complete = async function (opts) {
  const res = await fetch('/api/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts || {})
  });
  if (!res.ok) throw new Error('complete failed: ' + res.status);
  const data = await res.json();
  return data.text || '';
};
// Verification backend: present only when hosted, so the UI can detect it and
// fall back to its built-in demo data when opened as a standalone file.
window.verifier = {
  async engines() {
    const res = await fetch('/api/engines');
    if (!res.ok) throw new Error('engines failed: ' + res.status);
    return res.json();
  },
  async verify(opts) {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts || {})
    });
    if (!res.ok) throw new Error('verify failed: ' + res.status);
    return res.json();
  },
  // Verified repair: the server re-runs the checker on every candidate patch.
  async repair(opts) {
    const res = await fetch('/api/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts || {})
    });
    if (!res.ok) throw new Error('repair failed: ' + res.status);
    return res.json();
  }
};
</script>`;

function serveIndex(res) {
  const file = path.join(__dirname, 'public', 'index.html');
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); res.end('index.html missing'); return; }
    const out = html.replace(/<head[^>]*>/i, (m) => m + '\n' + SHIM);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(out);
  });
}

// Resolve a provider and run one completion. Shared by /api/complete and the
// repair loop. Throws on misconfiguration so callers can surface it.
async function completeWith({ provider, messages, max_tokens }) {
  const name = (provider || PROVIDER).toLowerCase();
  const adapter = providers[name];
  if (!adapter) throw new Error('unknown provider: ' + name);
  if (adapter.keyVar && !process.env[adapter.keyVar]) {
    throw new Error(adapter.keyVar + ' not set for provider ' + name);
  }
  return adapter.complete({ messages: messages || [], max_tokens });
}

async function handleComplete(req, res) {
  const opts = await readJson(req);
  try {
    const text = await completeWith(opts);
    sendJson(res, 200, { text, provider: (opts.provider || PROVIDER).toLowerCase() });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

// The verified repair loop: verify -> patch -> re-verify, bounded.
async function handleRepair(req, res) {
  const opts = await readJson(req);
  const engine = (opts.engine || DEFAULT_ENGINE).toLowerCase();
  try {
    const result = await repair({
      engine,
      code: opts.code || '',
      fileName: opts.fileName,
      maxIters: opts.maxIters,
      complete: (args) => completeWith({ provider: opts.provider, ...args })
    });
    sendJson(res, 200, { engine, provider: (opts.provider || PROVIDER).toLowerCase(), ...result });
  } catch (e) {
    sendJson(res, 500, { engine, status: 'error', error: String(e && e.message || e) });
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Which checkers this host actually has, so the UI can label the picker.
async function handleEngines(res) {
  try {
    sendJson(res, 200, { default: DEFAULT_ENGINE, engines: await engines.detect() });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

// Real verification run. Falls back gracefully: available:false -> UI uses demo data.
async function handleVerify(req, res) {
  const opts = await readJson(req);
  const engine = (opts.engine || DEFAULT_ENGINE).toLowerCase();
  try {
    sendJson(res, 200, await engines.verify({
      engine,
      code: opts.code || '',
      fileName: opts.fileName
    }));
  } catch (e) {
    sendJson(res, 500, { engine, error: String(e && e.message || e) });
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/complete') return handleComplete(req, res);
  if (req.method === 'POST' && req.url === '/api/verify') return handleVerify(req, res);
  if (req.method === 'POST' && req.url === '/api/repair') return handleRepair(req, res);
  if (req.url === '/api/engines') return handleEngines(res);
  if (req.url === '/' || req.url === '/index.html') return serveIndex(res);
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => {
  const a = providers[PROVIDER];
  console.log('Verifier Workbench on http://localhost:' + PORT);
  console.log('LLM provider: ' + (a ? a.label : PROVIDER + ' (unknown)'));
  engines.detect().then((d) => {
    const list = Object.values(d).map((e) =>
      e.label + (e.available ? ' ✓' : ' ✗ (not installed)')).join('  ');
    console.log('Engines: ' + list + '   default: ' + DEFAULT_ENGINE);
  });
});
