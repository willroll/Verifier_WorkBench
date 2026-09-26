import fs from 'node:fs/promises';

// The prototype UI (design/…standalone.html) calls window.verifier.*. This
// shim connects it to the API. Unlike the hosted-example shim it defines no
// window.claude.complete: that was an unauthenticated pass-through to the
// server's LLM key. Without it the prototype's offline "Ask agent" path shows
// its canned text.
export const SHIM = `<script>
(function () {
  async function call(method, url, body) {
    var res = await fetch(url, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  }
  window.verifier = {
    engines: async function () {
      var r = await call('GET', '/api/engines');
      if (!r.ok) throw new Error('engines failed: ' + r.status);
      return r.data;
    },
    // A rejected request becomes an error result, which the UI shows on the New Run page.
    verify: async function (opts) {
      var r = await call('POST', '/api/verify', opts || {});
      if (r.ok) return r.data;
      return { available: true, status: 'error', error: (r.data && r.data.error) || ('HTTP ' + r.status) };
    },
    // The prototype reads counts off every iteration and shows the last one's as
    // the current state. Only the original and the accepted patch are code it
    // shows, so other iterations carry their outcome as text instead of counts
    // (a rejected patch's "0 refuted" must never read as "all proved").
    repair: async function (opts) {
      var r = await call('POST', '/api/repair', opts || {});
      if (!(r.data && r.data.status)) throw new Error((r.data && r.data.error) || ('repair failed: ' + r.status));
      var result = r.data;
      (result.iterations || []).forEach(function (it) {
        if (it.outcome === 'baseline' || it.outcome === 'accepted' || it.error) return;
        var text = it.rejection ? 'rejected: ' + it.rejection.message
          : it.outcome === 'improved' ? 'kept as a partial fix: ' + it.counts.refuted + ' refuted left'
          : it.outcome === 'no-progress' ? 'no progress: ' + it.counts.refuted + ' still refuted'
          : it.outcome;
        it.error = text;
        delete it.counts;
      });
      return result;
    },
    smtlib: async function (opts) {
      var res = await fetch('/api/smtlib', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(opts || {})
      });
      if (!res.ok) throw new Error('smtlib failed: ' + res.status);
      return res.text();
    }
  };
})();
</script>`;

export async function loadUi(file: string): Promise<string> {
  const html = await fs.readFile(file, 'utf8');
  if (!/<head[^>]*>/i.test(html)) throw new Error(`${file} has no <head> to inject the API shim into`);
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n${SHIM}`);
}
