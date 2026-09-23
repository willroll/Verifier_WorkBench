# Handoff: Verifier Workbench (SMT-LIB Code Verification Agent)

## Overview
An MVP that proves whether (often LLM-generated) C code is safe, and repairs it when it isn't. C source goes through a bounded model checker (CBMC or ESBMC over an SMT solver). Every refuted safety obligation is reported with a concrete counterexample on the offending line. A repair loop then asks an LLM (Claude / Gemini / ChatGPT / self-hosted) for a corrected file and **re-verifies it**. A patch is never trusted; only the checker can declare success.

## What's in this bundle
```
hosted-example/          REAL, working backend + compiled UI (Node 18+, zero deps)
  server.js              HTTP server, provider abstraction, window.verifier/claude shim, API
  engines.js             CBMC + ESBMC adapters → one normalized finding shape
  repair.js              verified repair loop + line diff
  public/index.html      compiled UI (same as design/…standalone.html)
  Dockerfile             Ubuntu + CBMC + ESBMC + Node
  package.json, README.md (ops/env-var docs, read this too)
design/
  Verifier Workbench.dc.html          UI source (HTML template + logic class in one file)
  support.js                          runtime for the .dc.html format (don't port this)
  Verifier Workbench (standalone).html  UI, openable offline in a browser
```

## About the files
- **`hosted-example/` is real code.** Keep it as the starting point for the backend, or port it into your stack. The repair-loop semantics and the finding shape are the contract (see below).
- **`design/` is a design reference built in HTML.** It's a prototype of the intended look and behavior, not production frontend code. Rebuild the UI in a real framework (React + Vite + TypeScript is the suggested default if you have no codebase yet), talking to the backend over the API below. The `.dc.html` format and `support.js` are prototype tooling; don't carry them forward.

## Fidelity
**High-fidelity.** Colors, type, spacing and layout are final. Match them exactly using the tokens below.

## Real vs. demo (important)
Real: CBMC/ESBMC verification, counterexamples in the Trace tab, raw checker output in the SMT-LIB tab, the repair loop, the diff of the patch that held, the provider switch, and engine detection.

Still demo/canned in the UI (hard-coded in `renderVals()` of the .dc.html):
- MISRA tab + MISRA Report view (rule text is licensed; can't be reproduced)
- Report view's VC table and findings (still canned even for live runs)
- Problem Sets (batch) data; file/function tree (`arith.c`, `crc.c`, `util.h`, `avg/store/clamp/crc8`)
- Run chip (`run #142 · z3 4.13.0`), solver picker (z3/cvc5, cosmetic), "Re-verify" button (fake 900 ms delay)
- With no backend (`window.verifier` absent) or no engine installed, the whole app falls back to a recorded `arith.c` demo run

## Backend API (from server.js)
| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/engines` | → `{ default, engines: { cbmc: {available, version}, esbmc: {…} } }` |
| POST | `/api/verify` | `{ engine, code, fileName }` → `VerifyResult` |
| POST | `/api/repair` | `{ engine, code, fileName, provider }` → `RepairResult` |
| POST | `/api/complete` | `{ messages, max_tokens, provider }` → text (plain LLM call) |

The server injects a browser shim exposing `window.verifier.engines()/verify()/repair()` and `window.claude.complete()`. A rebuilt frontend should just call the endpoints directly.

**VerifyResult:** `{ engine, engineLabel, engineVersion, available, status: 'proved'|'refuted'|'error'|'timeout', counts: {proved, refuted}, findings: Finding[], durationMs, raw, error?, hint? }`

**Finding** (normalized across engines): `{ status: 'proved'|'refuted', kind, message, function, file, line, model: [{name, value}] }`

**RepairResult:** `{ status: 'repaired'|'unrepaired'|'already-proved'|'error', rationale, finalCode, diff: [{type: '+'|'-'|' '|'@', text}], iterations: [{iter, kind: 'verify'|'repair', counts, findings, status, durationMs, error?}], remaining, engineLabel, engineVersion, error? }`

### Repair-loop invariants (keep these)
- Bounded: `REPAIR_MAX_ITERS` (default 3, hard cap 6).
- Every candidate is re-verified; success only when refuted = 0.
- Stop if the model returns unchanged source.
- A candidate becomes the new baseline only if it *reduced* the refuted count.
- The prompt forbids deleting code, weakening assertions or adding assumptions; re-verification is what enforces it.
- `unrepaired` is a first-class outcome shown to the user.

## Screens / Views
All views share one top bar. Views are switched by nav tabs (no routing in the prototype; add URL routes when you rebuild).

### Top bar
Flex row, `padding: 12px 20px`, `gap: 14px`, bottom border `1px var(--border)`, wraps on narrow widths.
- Title: `Verifier / {fileName}`, IBM Plex Sans 600 14px, slash in `--muted`.
- Run chip: Plex Mono 500 11px, `--muted` on `--chipbg`, `padding 3px 8px`, radius 4.
- Nav tabs: **New Run · Workbench · MISRA Report · Problem Sets · Report**. Plex Sans 600 12px, `padding 6px 12px`, radius 5. Active tab: `--text` on `--chipbg`; inactive: `--muted` on transparent.
- Right cluster (margin-left auto, gap 8): refuted chip (`--red` on `--redbg`), proved chip (`--green` on `--greenbg`), both Plex Mono 600 11px, `padding 3px 9px`, radius 4; theme toggle (☾/☀, Mono 13px, 1px border, radius 5); primary button "Re-verify" (Plex Sans 600 11.5px, `--btntext` on `--btn`, `padding 5px 14px`, radius 5).

### 1. New Run (code entry)
Centered, `max-width 1000px`, `padding 34px 32px 48px`.
- H: "New verification run", Plex Sans 600 18px. Sub-copy 12.5px/1.6 `--muted`, max-width 640:
  "Paste C source or drop a file. The agent generates verification conditions, discharges them with the selected solver, and checks the MISRA rule set — reporting counterexamples for anything it can refute."
- Grid `1.7fr 1fr`, gap 20, margin-top 20.
- **Left:** filename input (Mono 500 12px, 150px wide, `--panel` bg, 1px border, radius 5) + meta ("N lines · C", Mono 11px muted) + "Load sample" link (`--accent`, 11px). Code textarea: height 340, resize vertical, bg `#232420`, text `#c6c9ba`, Mono 12.5px/1.7, `padding 14px 16px`, radius 7, tab-size 4. Dashed drop zone below (1.5px dashed `--border`, radius 7, padding 14, centered 11.5px muted). File drop isn't wired yet.
- **Right panel** (`--panel`, 1px border, radius 8, `padding 16px 18px`). Section labels are Plex Sans 600 10.5px, `--muted`, letter-spacing .08em, uppercase:
  - RULE SET: stacked options "MISRA C:2012", "MISRA C:2012 + Amd 2" (default), "Safety VCs only".
  - ENGINE: CBMC / ESBMC side by side (flex:1, Mono 12px). Note under it: version in `--green` if available; "{Engine} not installed on host — demo results." or "No backend detected — showing recorded demo results." in `--amber`.
  - SOLVER: z3 / cvc5.
  - ENCODING: "QF_BV · bit-precise" (Mono 12px) + "Integers modelled as 32/8-bit vectors to catch overflow & wrap-around."
  - Option button: Sans 500 12px, `padding 7px 11px`, radius 6. Selected = `--btntext` on `--btn` with `--btn` border; unselected = `--text`, transparent, `--border` border.
  - Primary "Verify →" (full width, `padding 9px 0`, radius 6, 600 12.5px), "Verifying…" while busy, with a Mono 11.5px progress log under it: `▸ {Engine} parsing {file}… / ▸ generating obligations / ▸ {solver} · QF_BV running…`.
  - Error box: Mono 11.5px/1.6, `--red` on `--redbg`, 1px `--redborder`, radius 6, pre-wrap.
- On success → switch to Workbench with the real result.

### 2. Workbench
Optional breadcrumb strip when opened from Problem Sets ("◀ Problem set 3 / sub-id · student", `--chipbg` bg, 11.5px).
4-column grid: `186px | minmax(0,1.25fr) | minmax(0,1fr) | minmax(0,1.15fr)`, min-height `calc(100vh - 55px)`.

**Col 1: Project tree** (`--panel`, right border, `padding 14px 0`). Section labels "PROJECT", "FUNCTIONS · arith.c". Rows are Mono 500 12px, `padding 5px 16px`; active row `--text` on `--chipbg`. Files use ◉ (.c) / ◦ (.h). Functions get a ● `--red` (refuted) or ✓ `--green` mark; clicking selects the finding.

**Col 2: Source** (always dark: bg `#232420`, text `#c6c9ba`, Mono 12.5px/1.9). Header "SOURCE · {file} [· patched]" (`#767a6b`, 10.5px, .08em) and a Source/Diff segmented switch (active `#d9dccf` on `#3a3b36`, inactive `#767a6b`).
- Line row: 34px line-number gutter `#5d6154`, 3px left bar. Refuted line: bar `#c96f5f`, trailing marker `← {kind}` (live) or `● F-01` (demo) in `#c96f5f`. Selected finding line bg `#3a2a26`. Fixed line marker `✓ fixed` `#7fae86`. Clicking a marked line selects that finding.
- Syntax colors (demo only; live runs render plain): type `#c7a563`, keyword `#9d86c8`, number `#d3b56a`, plain `#c6c9ba`.
- Diff: hunk header `#767a6b`; removed `#c96f5f` on `#3a2a26`; added `#7fae86` on `#243026`.

**Col 3: Findings + Agent** (`--panel`, right border).
- LIVE RUN banner (live only): `--greenbg`, radius 6, label Mono 600 10px `--green`, line "{engine version}\n{r} refuted · {p} proved · {t} s".
- "FINDINGS (n) · {Engine}" label. Finding card: margin `0 12px 8px`, `padding 12px 14px`, radius 6, 1px border; selected = `--redbg` bg + `--redborder`. ID pill (Mono 600 10px, `--panel` on `--red`, radius 3) + title (Sans 600 12.5px) + meta line (Mono 11px muted: `file:line · kind · a=… b=…`).
- Empty state: `--greenbg` box "✓ No findings — all N obligations discharged".
- "PROVED (n)" + list (Mono 12px/2.1 `--green`, `✓ fn#kind` per line).
- **AGENT card** (`--chipbg`, radius 6, `padding 12px 14px`): "AGENT" label + status badge (Mono 600 9.5px; `canned` muted, `live · thinking…` accent, `live · claude` green, `offline · canned` amber) + action link "Repair & verify" (backend ready) or "Ask agent". Provider `<select>`: Claude / Gemini / ChatGPT / Self-hosted. Then the suggestion text (12px/1.55), an iteration log (Mono 11.5px/1.7, one line per iteration, e.g. `iter 1 · repair → re-verify · all 7 proved ✓ · 4.2 s`, green if 0 refuted, red otherwise, amber for errors), and a verdict line (600 12px):
  - repaired: "Verified — patch held (re-checked by {Engine})." + Revert link
  - already-proved: "Already verified — nothing to repair."
  - unrepaired: "Could not repair — N obligation(s) still refuted after K attempt(s)." (red)
  - error: message (amber)

**Col 4: Detail tabs** (`--panel`). Tabs: Trace · MISRA · SMT-LIB (Sans 600 11.5px, `padding 6px 12px`, radius `5 5 0 0`; active `--text` on `--chipbg`). Body `padding 16px 18px`, title Sans 600 13px.
- Trace: bordered table (radius 5), header row VAR / VALUE on `--chipbg` (10.5px, .06em). Rows are Mono 12px: var, decimal value (offending value in `--red`), hex below in muted 11px. Note under it (12px/1.6 muted) explains the witness and names the engine and location.
- MISRA: rule cards (1px border, radius 5, `padding 10px 14px`). Rule pill `--amber` on `--amberbg`, severity REQUIRED (`--red`) / ADVISORY (`--amber`), then the text. *Demo content.*
- SMT-LIB: dark block `#232420`, Mono 11.5px/1.8, pre-wrap. Live runs show the checker's raw output, truncated to 4000 chars.
- Clean state copy: "All proof obligations discharged. …"

### 3. MISRA Report (demo)
`padding 26px 32px`, max-width 1060. Title "MISRA C:2012 compliance — arith.c" (600 17px) + summary (Mono 11.5px muted). Table in a `--panel` card (radius 7). Columns `.9fr .8fr 2.6fr 1.1fr 1fr`: RULE / CATEGORY / REQUIREMENT / STATUS / LOCATION. Status pill colors: COMPLIANT/RESOLVED green, VIOLATION red, DEVIATION amber. Footer note about MISRA Compliance:2020 §4 deviations.

### 4. Problem Sets (demo)
Title "Problem set 3 — batch verification" + meta. Table columns `1.1fr 1fr .7fr .8fr .9fr .7fr .9fr`: SUBMISSION / STUDENT / VCs / REFUTED / MISRA / TIME / SCORE. Row hover `--chipbg`; click opens the Workbench with a breadcrumb. Score pill: ≥90 green, ≥70 amber, else red. Scoring: 60% obligations proved + 40% MISRA compliance.

### 5. Report (printable)
Toolbar (hidden in print): "Exportable verification report — print or save to PDF." + "Print / Save PDF" button (`window.print()`). Document is max-width 820, `padding 38px 46px 56px`. Title "Verification Report" (600 24px) over a 2px `--text` rule, with solver/date meta on the right. Meta row: Target / VCs / Result / Rule set. Section **1 Proof obligations** is a table (FUNCTION / OBLIGATION / STATUS / TIME) between 1.5px `--text` rules. Section **2 Findings & counterexamples** has, per finding, an ID pill + MISRA tag pills, title, note, then a trace table and a dark SMT block side by side (each flex:1, min-width 220). Footer line credits verifier-agent v0.3. Print CSS: hide toolbar, white background, no padding.

## Interactions & state
Core state (see `state = {…}` in the .dc.html logic class):
`view` (input|workbench|misra|batch|report), `theme` (light|dark), `f` (selected finding index), `tab` (trace|misra|smt), `phase` (dirty|running|clean), `srcMode` (source|diff), `ruleSet`, `engine`, `solver`, `provider`, `fileName`, `code`, `inputPhase`, `verifyErr`, `realResult: VerifyResult|null`, `repair: RepairResult|null`, `aiState` (idle|loading|done|offline), `aiText`, `activeSub`, `backend` (from `/api/engines`).

Flows:
- Mount → `GET /api/engines` → set `backend` and default `engine`.
- Verify → `POST /api/verify`. `available:false` → Workbench + demo + error note. `error/timeout` → stay on New Run and show the error. Otherwise → Workbench with `realResult`.
- Repair & verify → `POST /api/repair`. On `repaired`: replace `code` with `finalCode`, `phase=clean`, show Diff, and set `realResult` from the last iteration. Revert clears `repair` and restores the dirty state. (Note: the prototype doesn't keep the pre-patch code for revert; do that in the rebuild.)
- Selecting a finding (card, source line, or function) sets `f` and resets `tab` to trace.
- Switching provider resets the agent state.
- No animations; state changes are instant. Loading is conveyed through copy ("Verifying…", "live · thinking…").

## Design tokens
Fonts: **IBM Plex Sans** 400/500/600 (UI) and **IBM Plex Mono** 400/500/600 (code, data, chips), from Google Fonts.

| Token | Light | Dark |
|---|---|---|
| --bg | #f6f5f1 | #141513 |
| --panel | #fbfaf7 | #1d1e1a |
| --border | #e2e0d8 | #2c2e29 |
| --border2 | #efeee7 | #262823 |
| --text | #23221e | #d9dccf |
| --muted | #8a887c | #8b907f |
| --chipbg | #ecebe4 | #262823 |
| --red | #a23b2e | #c96f5f |
| --redbg | #f6e3df | #3a2a26 |
| --redborder | #dfb5ac | #5a3b34 |
| --green | #3f7a4e | #7fae86 |
| --greenbg | #e2ecdf | #243026 |
| --amber | #7a5c26 | #d3b56a |
| --amberbg | #efe7d8 | #332c1c |
| --btn | #23221e | #d9dccf |
| --btntext | #ffffff | #141513 |
| --accent | #2a5db0 | #8fa8c8 |

Code surfaces are always dark in both themes: bg `#232420`, text `#c6c9ba`, dim `#767a6b`, gutter `#5d6154`, tab-active bg `#3a3b36`.
Radii: 3 (pills), 4 (chips), 5 (buttons/tabs/tables), 6 (cards/options), 7 (panels, textarea), 8 (settings panel).
Type scale: 9.5 / 10 / 10.5 (section labels, .06–.08em tracking) / 11 / 11.5 / 12 / 12.5 / 13 / 14 / 17 / 18 / 24 px. Weights 400/500/600 only.
No shadows or gradients. Separation comes from 1px borders and tinted fills.

## Assets
No images or icons. Glyphs are Unicode (● ✓ ◉ ◦ ▸ ◀ ☾ ☀ ←).

## Suggested next steps (roadmap from the design project)
1. **Live data in the Report view:** build it from `realResult` / `repair` (VC table from findings, counterexamples from `model`, the raw checker output, and the diff that held).
2. **MISRA sourcing:** integrate the cppcheck MISRA addon (the user supplies their own licensed rule-text file) or ship a curated subset with paraphrased/ID-only text. Map `Finding.kind` to rule IDs.
3. **Eval corpus:** inject defects into clean C (off-by-one, overflow, null deref, div-by-zero), then measure catch rate per engine and repair rate / iterations per provider.
4. **CI:** a GitHub Action + pre-commit hook calling `/api/verify` (or `engines.js` directly) that fails on refuted obligations and can open a PR with a verified repair.
5. Real file drop, multi-file/include support, real run history, URL routing, and auth + sandboxing before any public deployment (see the Dockerfile notes).

## Run the existing backend
```bash
cd hosted-example
export ANTHROPIC_API_KEY=sk-ant-...     # or GEMINI_/OPENAI_/LLM_BASE_URL; see hosted-example/README.md
node server.js                           # http://localhost:3000
# or: docker build -t verifier-workbench . && docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=… verifier-workbench
```
