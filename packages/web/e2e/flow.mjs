// End to end in a real browser, against a running server whose model is
// packages/server/test/fake-model.mjs (freshly started, so it answers with
// the gutted patch first and the honest fix second):
//
//   New Run → Verify → Workbench → Repair & verify → Diff → Report → Revert,
//   then demo mode with the API unreachable.
//
//   BASE_URL=http://127.0.0.1:3000 node packages/web/e2e/flow.mjs
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch();
const problems = [];

async function open(offline = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (offline) await context.route('**/api/**', (r) => r.abort('connectionrefused'));
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Demo mode expects the API to be unreachable.
    if (offline && /ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) return;
    problems.push(`console: ${m.text()}`);
  });
  return { context, page };
}

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

const text = (locator) => locator.innerText();

try {
  const { context, page } = await open();

  await step('New Run verifies the sample with the real checker', async () => {
    await page.goto(`${BASE}/new`);
    await page.getByRole('button', { name: 'Load sample' }).click();
    await page.locator('.nr-note.tone-green').waitFor();
    await page.getByRole('button', { name: /^Verify/ }).click();
    await page.waitForURL(/\/runs\/1$/, { timeout: 120_000 });
    const cards = await page.locator('.fp-card').allInnerTexts();
    assert.equal(cards.length, 2, 'two refuted obligations');
    assert.match(cards[0], /F-01[\s\S]*avg · line 5 · overflow/);
    assert.match(cards[1], /F-02[\s\S]*store · line 13 · bounds · idx=16/);
    assert.match(await text(page.locator('.fp-banner')), /LIVE RUN[\s\S]*CBMC[\s\S]*2 refuted/);
  });

  await step('Workbench selects findings from cards, source lines and tabs', async () => {
    await page.locator('.src-line-refuted').nth(1).click();
    assert.match(await text(page.locator('.wb-detail-title')), /^F-02 · store\(\)/);
    assert.match(await text(page.locator('.trace-table')), /idx\s+16\s+#x10/);
    await page.getByRole('tab', { name: 'SMT-LIB' }).click();
    await page.locator('pre.smt-scroll').waitFor({ timeout: 60_000 });
    assert.match(await text(page.locator('pre.smt-scroll')), /\(set-logic /);
    await page.locator('.fp-card').first().click();
    assert.equal(await page.getByRole('tab', { name: 'Trace' }).getAttribute('aria-selected'), 'true');
  });

  await step('Repair & verify: the loop rejects the gutted patch and keeps the fix', async () => {
    await page.getByRole('button', { name: 'Repair & verify' }).click();
    await page.waitForURL(/\/runs\/2$/, { timeout: 300_000 });
    const agent = await text(page.locator('.agent'));
    assert.match(agent, /repair → rejected \(behavior changed\)/);
    assert.match(agent, /all 3 proved ✓/);
    assert.match(agent, /Verified — patch held \(re-checked by CBMC\)/);
    assert.match(agent, /≡ avg behaves as before \(proved\)/);
    assert.match(await text(page.locator('.chip-red')), /^0 refuted$/);
    const hunks = await page.locator('.diff-hunk, .diff > .diff-line:first-child').allInnerTexts();
    assert.deepEqual(hunks, ['@@ avg() — line 5', '@@ store() — line 12']);
    assert.match(await text(page.locator('.diff')), /\+\s+if \(idx < 16\) \{/);
  });

  await step('Report shows the proof and the patch that held', async () => {
    await page.getByRole('link', { name: 'Report', exact: true }).click();
    await page.getByRole('heading', { name: 'Verification Report' }).waitFor();
    const doc = await text(page.locator('.rp-doc'));
    assert.match(doc, /0 refuted · 3 proved/);
    assert.match(doc, /Patch that held/);
    assert.match(doc, /Repaired from run #1/);
  });

  await step('Revert returns to the original source and its findings', async () => {
    await page.goBack();
    await page.getByRole('link', { name: 'Revert' }).click();
    await page.waitForURL(/\/runs\/1$/);
    assert.match(await text(page.locator('.src-lines')), /if \(idx <= 16\)/);
    assert.equal(await page.locator('.fp-card').count(), 2);
  });
  await context.close();

  await step('Without a server, the recorded demo replays', async () => {
    const { context: offline, page: demo } = await open(true);
    await demo.goto(`${BASE}/`);
    await demo.waitForURL(/\/runs\/demo$/);
    assert.match(await text(demo.locator('.fp-banner')), /RECORDED RUN/);
    assert.equal(await demo.getByRole('button', { name: 'Re-verify' }).isDisabled(), true);
    await demo.getByRole('button', { name: 'Replay repair' }).click();
    await demo.waitForURL(/\/runs\/demo-patched$/, { timeout: 30_000 });
    assert.match(await text(demo.locator('.agent')), /Verified — patch held/);
    await offline.close();
  });

  assert.deepEqual(problems, [], 'no page errors or console errors');
  console.log('e2e: all steps passed');
} catch (e) {
  if (problems.length) console.error(problems.join('\n'));
  throw e;
} finally {
  await browser.close();
}
