# Verifier Workbench: goals and plan

Handoff review of the Claude Design bundle (2026-09-23). The evidence below comes from
running the bundled backend against **CBMC 5.95.1**, the version the Dockerfile installs
from Ubuntu 24.04. Commands to reproduce each finding are in the appendix.

## TL;DR

The design is strong. The handoff spec (`README.md`) covers tokens, layouts, the API
contract, and the repair-loop invariants. The backend is a good sketch, but its central
claims do not hold yet when it runs against a real checker:

- Real verification fails on the product's own sample: it has no `main`, so CBMC stops with "no entry point".
- When verification does run, the Trace tab shows static initializers instead of the counterexample inputs.
- A "proved" result can be vacuous (the code is unreachable) or unsound (the bug lies past the loop bound).
- The repair loop accepts cheating patches: gutted function bodies, `__CPROVER_assume`, or a deleted harness.
- CBMC refutes the design's own showcase fix, and the fix also changes the function's results.

The plan therefore puts **truthful verification first**, then enforced repair guards,
then the UI rebuild at design fidelity, then hosting hardening and product expansion.

## 1. What's in the repo

| Path | What it is | Disposition |
|---|---|---|
| `README.md` | Handoff spec: 5 screens, design tokens, API, state model, roadmap | Keep as the design spec |
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
  - `packages/web`: React + Vite + TypeScript.
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
  - Fix the install (correct release asset, pinned version).
  - Use a per-function entry point.
  - Parse a model per violation; today every finding gets the whole output's model.
  - Report real proved counts; today the count is always 0.
- **Solver and SMT-LIB (decision D3).**
  - Either make the solver real (`--z3` / `--cvc5`, detected by `/api/engines`) and export SMT-LIB per property (`--property p --smt2 --outfile`, as `QF_AUFBV`),
  - or relabel the solver as "SAT (MiniSAT)" and rename the tab "Checker output".
- **Exit:**
  - The sample `arith.c` gives 2 refuted obligations, with witnesses `a, b` and `idx=16`.
  - The V3 and V4 cases produce no false "proved".
  - The fixture tests and the CBMC integration tests pass in CI.

### Phase 2: Ungameable repair loop
- **Guards enforced in code.** A candidate that breaks any of these is rejected, and the reason is fed back to the model:
  - Every original function is still defined, with an identical signature.
  - No new `__CPROVER_assume`, `__ESBMC_assume`, or `assume`.
  - No `assert` removed or weakened.
  - No function's set of obligations shrinks.
  - The harness is untouched.

  Parse the source with tree-sitter-c or read the checker's symbol table.
- **Behavior preservation.** Compile the original and the candidate with clang + UBSan. Run both on boundary and random inputs for which the original has no undefined behavior, and compare outputs. A divergence rejects the candidate, which would have caught V6.
- **Claude plumbing (Anthropic adapter).**
  - Move to `@anthropic-ai/sdk`.
  - Default to `claude-opus-5`, overridable by environment variable.
  - Ask for structured output `{code, rationale}` through `output_config.format` instead of regex-parsing fences.
  - Stream the response (`finalMessage()`) with `max_tokens` sized for whole files.
  - Treat `stop_reason` `max_tokens` and `refusal` as explicit iteration errors.
- **Other providers.** Keep the Gemini, OpenAI, and self-hosted adapters, and move the Gemini key into a header.
- **Semantics.**
  - A misconfigured provider returns `error`.
  - Add `GET /api/providers` so the UI can disable unconfigured providers.
  - Choose between the strictly-fewer and no-more baseline rules, and make the code and docs agree.
  - Give multi-turn feedback that includes the rejected candidate and why it was rejected.
- **Progress.** Stream iterations over SSE so the Agent card fills in as the loop runs, instead of a long blank wait.
- **Exit:** The V5 cheating patches and the V6 fix are rejected with clear reasons, and the honest fix is accepted as `repaired`.

### Phase 3: UI rebuild at design fidelity
- Implement the tokens as CSS custom properties exactly per the `README.md` spec, in light and dark. Use IBM Plex Sans and Mono, with no shadows or gradients.
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
- **Exit:** The full flow (New Run → Workbench → Repair → Diff → Report) runs on real data and looks nearly pixel-identical to the prototype.

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
- Persist runs in SQLite, which gives run history and real run IDs (the design's `run #142` chip).
- Add auth, at minimum a shared token, before any public deployment.

### Phase 5: Expansion (to prioritize together)
- **Eval corpus.** Inject defects (off-by-one, overflow, null dereference, division by zero) into clean C. Measure catch rate per engine, and repair rate, iterations, cost, and cheat-rejection rate per provider.
- **CI.** A GitHub Action and a pre-commit hook, with an optional PR carrying a verified repair.
- **MISRA.** The cppcheck MISRA addon with user-supplied rule text, mapping `Finding.kind` to rule IDs.
- **Problem Sets.** Batch upload, a queue, and rubric scoring.
- **Scale.** Multi-file projects via `compile_commands.json`, and function contracts for the functional properties the design implies (e.g. `clamp#post`).

## 5. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Stack | TypeScript monorepo: React + Vite + TS for the web app and Node 22 + TS for the server. This matches the handoff's suggestion, and the finding and repair contract is shared. |
| D2 | Order | Backend truthfulness (Phases 1–2) before the full UI rebuild. The existing prototype UI keeps working against the new server in the meantime. |
| D3 | SMT-LIB identity | Make it real: the `--z3` / `--cvc5` back ends plus per-property SMT-LIB export, since the product name promises SMT-LIB. The alternative is to relabel it honestly. |
| D4 | LLM providers | Keep all four (Claude, Gemini, ChatGPT, self-hosted), with Claude as the default. |
| D5 | Deployment target | Local tool, internal hosted, or public? The answer sets how deep Phase 4 goes. |

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
