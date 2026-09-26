# Verifier Workbench: goals and plan

Handoff review of the Claude Design bundle (2026-09-23). The evidence below comes from
running the bundled backend against **CBMC 5.95.1**, the version the Dockerfile installs
from Ubuntu 24.04. Commands to reproduce each finding are in the appendix.

## TL;DR

The design is strong. The handoff spec (`docs/design-handoff.md`, originally the root `README.md`) covers tokens, layouts, the API
contract, and the repair-loop invariants. The backend is a good sketch, but its central
claims do not hold yet when it runs against a real checker:

- Real verification fails on the product's own sample: it has no `main`, so CBMC stops with "no entry point".
- When verification does run, the Trace tab shows static initializers instead of the counterexample inputs.
- A "proved" result can be vacuous (the code is unreachable) or unsound (the bug lies past the loop bound).
- The repair loop accepts cheating patches: gutted function bodies, `__CPROVER_assume`, or a deleted harness.
- CBMC refutes the design's own showcase fix, and the fix also changes the function's results.

The plan therefore puts **truthful verification first**, then enforced repair guards,
then the UI rebuild at design fidelity, then hosting hardening and product expansion.

## Progress

| Phase | Status |
|---|---|
| 0 Foundation | **Done.** npm-workspaces TypeScript monorepo, ESLint, Prettier, Vitest, GitHub Actions (check, real engines, Docker smoke test). |
| 1 Truthful verification | **Done.** V1–V4 and V6–V8 are fixed and pinned by tests. The solver choice and SMT-LIB export are real (D3). The prototype UI runs against the new server. |
| 2 Ungameable repair | **Done.** V5, V6 and V11 are fixed and pinned by replayed and live tests. `/api/repair` (plus an SSE variant) runs a guarded loop whose accepted patches are re-verified and proved behavior-preserving. `GET /api/providers` lists Claude, ChatGPT, Gemini and self-hosted. |
| 3 UI rebuild | **Done.** A React + Vite web app (`packages/web`) replaces the prototype at `/` and runs New Run → Workbench → Repair → Diff → Report → Revert on real results. The prototype stays at `/prototype`. |
| 4–5 | Not started. |

Two things from the Phase 1 build changed the design:

- **Every function gets its own run**, even one with no obligations of its own. A `memcpy` overflow lives in library code, and ESBMC generates its pointer checks only during symbolic execution, so skipping "obligation-free" functions missed both.
- **Pointer-argument findings carry a `note`.** The per-function harness passes arbitrary pointers, so `int deref(const int *p) { return *p; }` is refuted with `p = NULL`. That is true, but it may be a caller precondition rather than a bug.

The Phase 2 build changed the plan in these ways:

- **Behavior preservation is proved, not tested.** Instead of running both versions under UBSan on sample inputs, CBMC compiles the original and the candidate side by side and proves, for each changed function and everything that calls one, that it returns the same value and leaves the same globals on *every* input where the original has no undefined behavior and passes its assertions. That covers all inputs rather than samples, never executes submitted code on the server, and reuses the toolchain already in the image. A difference comes back as concrete inputs, which the model gets as feedback (`store(idx = 13, v = 128)` leaves `buf[13]` different).
- **More guards than planned.** Each closes a way to reach "proved" without fixing the code, found while building the loop: calls that end the program (CBMC treats `abort()`/`exit()` as a path that stops), `#define NDEBUG` or a redefined `assert`, macros that redefine existing names or keywords (the proof is compiled after the patch), `_Pragma` and inline assembly, a candidate that turns decided obligations into inconclusive ones (an added loop past the bound), and a behavior proof that does not finish or cannot be built.
- **Baseline rule: strictly fewer.** A candidate replaces the current best only with strictly fewer refuted obligations, and only after passing every guard including the behavior proof; the result is `repaired` only when nothing is refuted and nothing new is inconclusive.
- **Known limits of the behavior proof.** Functions with pointer or aggregate parameters or results, variadic functions and functions that reach a body-less function are listed as `skipped`; for them, a function whose checks all vanished is still rejected. Function-local `static` state is not compared, and each call starts from the globals' initial values.

The Phase 3 build changed the plan in these ways:

- **Runs live in the browser until Phase 4.** The last 20 runs are kept in `localStorage`. A repaired patch becomes a new run linked to its original, so Revert returns to the unpatched source and its findings, and Re-verify runs the checker again as a new run.
- **Demo mode is a recording, not canned data.** `npm run record-demo` verifies the sample with CBMC and Z3 and runs the real repair loop with scripted answers: a gutted `store` that the behavior proof rejects, then the fix. With no server reachable, `/` replays it, labelled as recorded.
- **Unbuilt features say so.** The MISRA view and tab say the rules are not checked, and the MISRA rule sets cannot be selected. Problem Sets lists this browser's runs; batch upload is not built. The prototype's canned chips, the demo F-01 shown for live runs, the fake "Apply patch" and the non-restoring Revert are gone.
- **The prototype's own font files.** Google Fonts serves IBM Plex Sans as a variable font, and the static cut from npm sets 600-weight text about 5% narrower, so the web app ships the prototype's files (latin and latin-ext, SIL OFL). Text now measures identically.
- **Visual QA.** On a run seeded with the prototype's header values, the top bar, project tree labels, source header and detail tabs are pixel-identical to the prototype (0.00% of pixels differ) in both themes at 1440×900. The rest differs only in content: live results instead of canned ones, the run banner, line numbers from 1.
- **Accessibility.** axe reports no violations except colour contrast. Several design tokens are below WCAG AA: light-theme muted text on the page (3.3:1) and on the run chip (3.0:1), `#767a6b` on the code surface (3.5:1), line numbers (2.5:1), the refuted chip (3.8:1). They are kept as designed; raising them is a design decision.
- **Model answers keep the file's layout.** The prompt fences the code, which loses the final newline and line endings; the loop now restores the original's, so a diff shows only real changes.

## 1. What's in the repo

| Path | What it is | Disposition |
|---|---|---|
| `README.md` (now `docs/design-handoff.md`) | Handoff spec: 5 screens, design tokens, API, state model, roadmap | Keep as the design spec |
| `hosted-example/server.js` | Zero-dependency Node HTTP server, 4 LLM provider adapters, page shim, 4 endpoints | Reference; replace |
| `hosted-example/engines.js` | CBMC (JSON) and ESBMC (text) adapters → normalized `Finding` | Port, with the fixes below |
| `hosted-example/repair.js` | Bounded verify → patch → re-verify loop, LCS line diff | Port, with the fixes below |
| `hosted-example/Dockerfile` | Ubuntu 24.04 + cbmc + nodejs + ESBMC | The ESBMC step is broken (404) |
| `design/Verifier Workbench.dc.html` | UI source: HTML template plus one logic class (~760 lines) | Design reference only |
| `design/support.js` | Runtime for the prototype's `.dc.html` format | Don't port |
| `design/… (standalone).html` | 500 KB compiled bundle, byte-identical to `hosted-example/public/index.html` | Delete once the rebuild ships |

The repo has no tests, lint, types, CI, or `.gitignore`, and one commit.

## 2. What I verified

Everything in this table was reproduced in a session unless marked *(code reading)*.

| # | Handoff claim | What actually happens | Severity |
|---|---|---|---|
| V1 | "Real: CBMC/ESBMC verification" | The sample `arith.c` has no `main`. CBMC reports `the program has no entry point`, so `/api/verify` returns `status:"error"`, `"could not parse CBMC output"`, and the UI stays on New Run with that error. Typical LLM-generated library code has no `main` either. | Blocker |
| V2 | "Counterexamples in the Trace tab" | The parser keeps the first 12 trace assignments. The static initializers `buf[0l]` … `buf[11l] = 0` fill all 12 slots, so the real witness (`a=-2147483648, b=-2147483647`; `idx=16`) is dropped. The witness *is* in the JSON, tagged `assignmentType:"actual-parameter"`, with a `binary` field that can feed the hex column. | Blocker |
| V3 | "Proved" means proved | With `--function avg`, CBMC reports `store.array_bounds.1` (a real bug) as `SUCCESS` because `store` is unreachable from `avg`. A patch that deletes the harness gets the same vacuous "proved". | High |
| V4 | Bounded but sound | Without `--unwinding-assertions`, a bug deeper than the unwind bound is reported as `SUCCESS` (tested: an overflow at `i ≥ 8` with `--unwind 4`). The CBMC adapter omits the flag, and the ESBMC adapter passes `--no-unwinding-assertions`. | High |
| V5 | "Re-verification is what actually enforces" the no-deleting-code and no-assumptions rules | The real `repair()` loop, driven by a stubbed LLM, returned `repaired` for all three cheating patches: both function bodies gutted, `__CPROVER_assume(...)` added, and the `main` harness deleted. | High |
| V6 | Demo: `a + (b - a) / 2`, "Verified — patch held · 7 proved" | CBMC refutes it twice: `b - a` overflows, and so does the addition. The fix also changes results: `avg(-3, 0)` returns −2 instead of −1. `(int32_t)(((int64_t)a + b) / 2)` verifies and keeps the original results. | High (demo story) |
| V7 | 7 obligations in the sample | With the adapter's check flags, CBMC generates 2 obligations, and both are refuted. The UI's `clamp#post`, `crc8#term`, and so on don't exist: the sample has no `crc8`, and a postcondition check would need contracts. | Medium |
| V8 | Solver z3 / cvc5, encoding "QF_BV", SMT-LIB tab | CBMC solves with **MiniSAT 2.2.1** (propositional reduction), so the solver picker is cosmetic, and the tab shows raw JSON. CBMC does support `--z3`, `--cvc5`, `--bitwuzla`, and `--smt2 --outfile`. A per-property export for `avg` is 199 lines in logic `QF_AUFBV`, not `QF_BV`. | Medium (product identity) |
| V9 | Repair error states | With no API key, `/api/repair` returns `status:"unrepaired"` ("Could not repair — 1 obligation(s) still refuted…") instead of `error`. | Medium |
| V10 | Hosting | `/api/complete` forwards arbitrary prompts and `max_tokens` to the configured key without auth. There is no body-size limit (a 5 MB body was accepted) and no concurrency cap on checker processes *(code reading)*. The Gemini key travels in the URL query string *(code reading)*. The ESBMC download URL returns 404, so the image silently ships without ESBMC. `/api/engines?x=1` returns 404. | High before any deploy |
| V11 | LLM integration *(code reading)* | The default model `claude-sonnet-4-5` is several generations old. `max_tokens: 2000` truncates whole-file rewrites; a truncated reply has no closing fence, which yields a garbage candidate. There is no `stop_reason` handling, and code is extracted from the reply with a regex. The comment and README say a candidate is kept only if it *strictly* reduces the refuted count, but the code uses `<=`. | Medium |

### Prototype UI bugs not to carry into the rebuild *(code reading, `.dc.html`)*

- Live finding cards have `click: undefined` and no selected state.
- A live run with 0 refuted still shows the demo's F-01 counterexample in the Trace tab, because `showDetail` keys off `phase`, not the real result.
- "Apply patch → re-run" is visible in live mode and fakes "Verified — patch held" after a 1.3 s timer. That violates "only the checker can declare success".
- The top-bar chips and run chip show canned values even for live runs, and the MISRA tab shows demo rules during live runs.
- Revert doesn't restore the pre-patch source (the README already notes this).

## 3. Goals

**North star.** You paste C code or submit it from CI and get an answer you can trust
and audit:

- which safety obligations hold, and within which bounds;
- a concrete counterexample for each obligation that doesn't hold;
- optionally, an LLM patch, accepted only when the checker proves it *and* it passes anti-cheat checks enforced in code.

| Goal | Outcome |
|---|---|
| **G1 Truthful verification** | Works on library code with no `main`. Each obligation is proved, refuted, or inconclusive. No vacuous or out-of-bound "proved". Bounds are shown. Witnesses are correct, with hex. |
| **G2 Ungameable repair** | Guards are enforced by code, not by the prompt. Behavior preservation is checked. `unrepaired` stays a first-class outcome. |
| **G3 Design-fidelity UI** | React + Vite + TypeScript, tokens exactly per spec. Every number traces back to a checker run; demo mode replays a recorded *real* run. |
| **G4 Safe to host** | No open LLM proxy. Request limits, a job queue, and a sandbox. Auth before public exposure. A working image with both engines. |
| **G5 Measured** | Unit and integration tests from day one. An eval corpus for catch rate per engine, and for repair rate, iterations, and cost per provider. |
| **G6 Workflow reach** | Report built from real runs, a CI action, batch problem sets, MISRA through cppcheck, multi-file projects. Starts after G1–G5. |

**Non-goals for the first milestone:** MISRA rule text (it's licensed), multi-file
projects, user accounts or multi-tenancy, and contracts or functional correctness.

## 4. Plan

| Phase | Theme | Size | Depends on |
|---|---|---|---|
| 0 | Foundation | S | — |
| 1 | Truthful verification core | M | 0 |
| 2 | Ungameable repair loop | M | 1 |
| 3 | UI rebuild at design fidelity | L | 0 (contract), 1–2 (real data) |
| 4 | Hosting hardening | M | 1–2 |
| 5 | Expansion (evals, CI, MISRA, batch, multi-file) | L | 1–4 |

The new server keeps the current API shape and adds fields without removing any, so it
can serve the existing compiled prototype UI while the rebuild is in progress. That way
every phase has a working end-to-end demo.

### Phase 0: Foundation
- npm-workspaces monorepo:
  - `packages/shared`: the contract types `VerifyResult`, `Finding`, and `RepairResult`.
  - `packages/server`: Node 22 + TypeScript, with a small framework (e.g. Fastify) for body limits, schema validation, and SSE.
  - `packages/web`: React + Vite + TypeScript, created at the start of Phase 3 when the UI rebuild begins.
  - `design/` stays as a read-only reference, and `hosted-example/` stays runnable until the new server reaches parity.
- Strict TypeScript, ESLint and Prettier, Vitest, and a `.gitignore`.
- A GitHub Actions workflow that runs lint, typecheck, and unit tests, plus an integration job that runs `apt-get install cbmc`.
- `fixtures/`: C inputs with recorded CBMC 5.95.1 JSON, so parser tests run without a checker.
- **Exit:** CI is green with the ported parser under test.

### Phase 1: Truthful verification core (the critical path)
- **Harness strategy.**
  1. Run `--show-properties`; it works without `main`.
  2. Group the properties by function.
  3. Run `--function f` once per function, with bounded parallelism.
  4. Keep only the properties located in `f`.
  5. Also run from `main` if the file has one.

  A function with no properties is labeled "no obligations", not "proved".
- **Soundness.** Turn on `--unwinding-assertions` for both engines. Report an unwinding failure as **inconclusive** (raise the bound), not as a bug. Put the unwind bound in every result and in the UI copy, e.g. "proved up to unwind 16".
- **Status model.** Each obligation is `proved | refuted | inconclusive`. CBMC's `UNKNOWN` and `ERROR` statuses are not "refuted".
- **Witness extraction.**
  - Inputs first (`actual-parameter`), then globals changed on the failing path.
  - Keep `type`, `width`, and `binary`; `binary` feeds the hex column.
  - Keep the per-finding trace steps for a trace viewer.
- **Arbitrary-input caveat.** A per-function harness gives every input an arbitrary value, so a pointer or size-parameter finding may really be a caller precondition. v1 labels such findings. Later, add `__CPROVER_requires` contracts and `goto-harness`, which ships in the cbmc package, for pointer-shaped inputs.
- **ESBMC.**
  - Fix the install: v8.5, `esbmc-linux.zip`.
  - Read the report from stderr.
  - For each function, run a generated wrapper so the witness values appear.
  - Parse the multi-property `** Results:` block (PASSED, FAILED, NOT CHECKED) per violation; today every finding gets the whole output's model.
  - Report real proved counts; today the count is always 0.
- **Solver and SMT-LIB (decision D3: make them real).**
  - `solver` is a real verify option. `/api/engines` reports, per engine, which solvers are usable on this host, with their versions.
  - The result records the solver and the encoding the checker actually used (e.g. SAT/MiniSAT, SMT-LIB `QF_AUFBV` via Z3).
  - Export SMT-LIB per obligation: `--property p --smt2 --outfile` for CBMC; `--claim n --smt-formula-only --output` for ESBMC.
- **Exit:**
  - The sample `arith.c` gives 2 refuted obligations, with witnesses `a, b` and `idx=16`.
  - The V3 and V4 cases produce no false "proved".
  - The fixture tests and the CBMC integration tests pass in CI.

### Phase 2: Ungameable repair loop *(done)*
- **Guards enforced in code** (`packages/core/src/repair/guards.ts`). A rejected candidate's reason goes back to the model:
  - Source: no new verifier intrinsics, assumptions, checker pragmas (directive or `_Pragma`), inline assembly or `__vw_` names; no removed, changed or disabled assertions; no new calls that end the program; no macros redefining existing names or keywords; no includes outside the source.
  - Result: the same engine settings re-verify it; every original function keeps its exact type (CBMC's type with names stripped); no function gets more inconclusive obligations than the original had; a function whose obligations all vanished must be proved equivalent.
- **Behavior preservation, proved** (`equivalence.ts`). See *Progress* above; every global of the original must survive with its type.
- **Claude plumbing** (`packages/llm/src/anthropic.ts`). `@anthropic-ai/sdk`, `claude-opus-5` by default (`CLAUDE_MODEL`), one streamed request per attempt with `max_tokens` 64000, adaptive thinking at effort `high`, structured output `{rationale, code}` through `output_config.format`, the original source as a cacheable block, and server-side refusal fallbacks (`fallbacks: "default"`) on by default. `stop_reason` `refusal` and `max_tokens` become explicit iteration errors; SDK errors map to typed outcomes (auth and configuration stop the loop).
- **Other providers.** OpenAI (schema enforced), any OpenAI-compatible self-hosted server (format given as an instruction) and Gemini (schema enforced, key in a header).
- **Semantics.** A misconfigured provider returns `error` after the original is verified, so code that is already proved needs no key. `GET /api/providers` lists providers and what each still needs. The prompt's stable part (source and counterexamples) is identical across attempts; each attempt adds the current best version and why the last candidate failed.
- **Progress.** `POST /api/repair/stream` sends `checking`, `proposing`, `iteration` and `result` events; a client that disconnects cancels the repair and its model request. `REPAIR_CONCURRENCY` bounds concurrent repairs (429 beyond it).
- **Exit (met):** in `packages/core/test/repair.test.ts`, the design prototype's fix makes no progress, its overflow-free variant and a gutted `store` are rejected by the behavior proof with counterexamples, `__CPROVER_assume` and a widened signature are rejected, and the honest fix is accepted as `repaired` with both functions proved equivalent. CI repeats this inside the Docker image with a scripted model.

### Phase 3: UI rebuild at design fidelity *(done)*
- Implement the tokens as CSS custom properties exactly per the `docs/design-handoff.md` spec, in light and dark. Use IBM Plex Sans and Mono, with no shadows or gradients.
- Routes: `/new`, `/runs/:id` (Workbench), `/runs/:id/report`, `/misra`, `/batch`.
- Components:

  | Component | Scope |
  |---|---|
  | TopBar | Chips come from the real run |
  | NewRun | Real file drop |
  | ProjectTree | Real functions with per-function status |
  | SourceView | Syntax highlighting in the design palette; finding markers and selection |
  | DiffView | The diff of the patch that held |
  | FindingsPanel | Clickable, selectable finding cards |
  | AgentCard | Live iteration log |
  | DetailTabs | Trace (with hex), MISRA, SMT-LIB or checker output |
  | Report | Built from real data, with print CSS |
- Revert restores the pre-patch source, and Re-verify runs the checker. Demo mode replays a recorded real run with a correct fix.
- Use semantic buttons, keyboard navigation, and visible focus states.
- For visual QA, capture Playwright screenshots of the new UI and the prototype at the same viewport, in both themes, and compare them.
- **Exit (met):** `packages/web/e2e/flow.mjs` drives Chromium through New Run → Workbench → Repair → Diff → Report → Revert against the real checker, and through demo mode with no server; CI runs it against the Docker image. See *Progress* for the pixel comparison.

### Phase 4: Hosting hardening
- Remove `/api/complete`. If an "explain this finding" feature is wanted, build its prompt on the server.
- Limits and isolation:
  - body-size limits and rate limiting;
  - a job queue with a concurrency cap;
  - per-run CPU, memory, and time limits;
  - a tmpfs working directory for each run.
- Docker:
  - fix the ESBMC install;
  - pin the checker versions;
  - run as non-root;
  - add a healthcheck;
  - give the checker no network access.
- Persist runs in SQLite, which gives run history and real run IDs (the design's `run #142` chip), and move the web app's run history from `localStorage` to the server.
- Add auth, at minimum a shared token, before any public deployment.

### Phase 5: Expansion (to prioritize together)
- **Eval corpus.** Inject defects (off-by-one, overflow, null dereference, division by zero) into clean C. Measure catch rate per engine, and repair rate, iterations, cost, and cheat-rejection rate per provider.
- **CI.** A GitHub Action and a pre-commit hook, with an optional PR carrying a verified repair.
- **MISRA.** The cppcheck MISRA addon with user-supplied rule text, mapping `Finding.kind` to rule IDs.
- **Problem Sets.** Batch upload, a queue, and rubric scoring.
- **Scale.** Multi-file projects via `compile_commands.json`, and function contracts for the functional properties the design implies (e.g. `clamp#post`).

## 5. Decisions (2026-09-23)

| # | Decision | Outcome |
|---|---|---|
| D1 | Stack | TypeScript monorepo (npm workspaces): Node 22 + TS for the server, React + Vite + TS for the web app. TypeScript is pinned to 6.0.x, because typescript-eslint does not support TypeScript 7 yet. |
| D2 | Order | Backend truthfulness (Phases 1–2) comes before the full UI rebuild. Until Phase 3 the server served the prototype UI; it now serves the web app, with the prototype at `/prototype`. |
| D3 | SMT-LIB identity | **Make it real.** The solver picker maps to real solver back ends, and each obligation can be exported as SMT-LIB that any solver can re-check. |
| D4 | LLM providers | Keep all four (Claude, Gemini, ChatGPT, self-hosted), with Claude as the default. |
| D5 | Deployment | **SaaS on a server is the target; a local install may also be offered.** The details are still open, so the design keeps both options (see below). |

### Deployment model (SaaS first, local possible)

- **Core as a library.** The verification core (`@verifier/core`) has no HTTP or storage dependencies. The same code can run in the SaaS API, a local server, a CLI, or a CI action.
- **Pluggable runner.** Checker processes run through a `Runner` interface. Phase 1 ships a local runner with timeouts, output caps, a `prlimit` memory cap, and a concurrency cap. For SaaS, Phase 4 adds an isolated runner behind the same interface: a per-job container or sandbox with no network.
- **Stateless server.** The server is configured by environment variables, and one Docker image serves both modes.
- **Pluggable services.** Auth, persistence, and quotas are swappable: none and SQLite for local; a token or OIDC, plus Postgres, for SaaS (Phase 4).
- **Auditable results.** Every result records the engine, solver, versions, and exact flags, so any run can be reproduced.

### Toolchain facts established during Phase 0–1 setup

| Engine | Solvers | Notes |
|---|---|---|
| CBMC 5.95.1 | MiniSAT (built in); z3 and cvc5 (apt) | z3 and cvc5 run as external binaries. Bitwuzla isn't packaged, and `cbmc --bitwuzla` without the binary ends in `ERROR`, so detection offers a solver only when its binary is present. |
| ESBMC 8.5.0 | Bitwuzla (default), z3, cvc5, Boolector — all built in | Current release, shipped as `esbmc-linux.zip` (a 641 MB static binary; the Dockerfile's v7.6.1 `.tar.xz` URL is stale). |

- **ESBMC reporting quirks.** ESBMC writes its report to **stderr** and needs `main` or `--function`. For `--function` runs it never prints parameter values. A generated wrapper that makes the parameters locals, set from body-less functions, makes the values appear (`a = -1`, `b = -2147483648`; `idx = 16`).
- **Checkable exports.** Per-obligation SMT-LIB exports from both engines are accepted by z3, which answers `sat` for refuted obligations, so anyone can re-check an export.

Facts the Phase 2 behavior proof depends on (CBMC 5.95.1):

- `goto-instrument <check flags> --assert-to-assume` turns the checks it adds into assumptions only in that same pass, and never the program's own `assert()` calls; the original is therefore compiled against an `assert.h` that assumes.
- `__CPROVER_array_equal` gives false differences under the SMT back ends (z3, cvc5) but not MiniSAT; arrays are compared at a symbolic index instead, which every back end decides.
- CBMC leaves unused file-local globals out of the symbol table, so the candidate is read together with a generated function that uses every global of the original.
- `abort()` and `exit()` are modeled as a path that stops (an assumption of false), which would make "abort on hard inputs" look equivalent; the proof supplies its own definitions that flag it.

## Appendix: reproducing the findings

```bash
sudo apt-get install -y cbmc          # 5.95.1 on Ubuntu 24.04, same as the Dockerfile
```

`arith.c` is `DEFAULT_SRC` from `design/Verifier Workbench.dc.html` (`avg`, `store`,
`clamp`; no `main`).

```bash
# V1: no entry point → the adapter reports "could not parse CBMC output"
cbmc arith.c --json-ui --signed-overflow-check --bounds-check --unwind 16

# V2 and V3: per-function run. store.array_bounds.1 is SUCCESS (vacuous) when the entry is avg;
# the witness a, b is present but past the parser's 12-entry cap.
cbmc arith.c --json-ui --signed-overflow-check --bounds-check --function avg

# V7: only 2 properties exist with the adapter's full check set
cbmc arith.c --show-properties --json-ui --bounds-check --pointer-check --div-by-zero-check \
  --signed-overflow-check --unsigned-overflow-check --conversion-check

# V8: back end in use, and a per-property SMT-LIB export (199 lines, QF_AUFBV)
cbmc arith.c --function avg --signed-overflow-check --json-ui | grep -i minisat
cbmc arith.c --function avg --signed-overflow-check --property avg.overflow.1 --smt2 --outfile avg.smt2
```

V4 uses `loop.c`:

```c
#include <stdint.h>
#include <stddef.h>
static uint8_t table[8];
uint8_t lookup_sum(size_t n) {
    uint8_t s = 0;
    for (size_t i = 0; i < n; i++) s += table[i];   /* out of bounds once i >= 8 */
    return s;
}
```

```bash
cbmc loop.c --json-ui --bounds-check --unwind 4 --function lookup_sum                        # SUCCESS (false)
cbmc loop.c --json-ui --bounds-check --unwind 4 --function lookup_sum --unwinding-assertions  # unwinding assertion FAILURE
```

V6 compares the design's fix with a widening fix:

```c
int32_t avg(int32_t a, int32_t b) { return a + (b - a) / 2; }               /* design: 2 FAILUREs */
int32_t avg(int32_t a, int32_t b) { return (int32_t)(((int64_t)a + b) / 2); } /* verifies */
```

V5 drives `repair()` from `hosted-example/repair.js` with
`complete: async () => '```c\n' + candidate + '\n```'`. It uses a version of `arith.c` that
has a `main` calling `avg(nondet_int32(), nondet_int32())` and
`store(nondet_u8(), nondet_u8())`. Three candidates all come back `repaired`:

- both function bodies gutted;
- `__CPROVER_assume` added;
- the harness replaced by `int main(void){return 0;}`.
