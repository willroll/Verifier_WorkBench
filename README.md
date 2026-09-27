# Verifier Workbench

Proves whether C code is safe, and shows exactly where it isn't. Each function
is checked by a bounded model checker (**CBMC** or **ESBMC**) over a real SAT or
SMT solver (**MiniSAT, Z3, cvc5, Bitwuzla, Boolector**). Every refuted
obligation comes with a concrete counterexample (the argument values that
break it). Every obligation can be exported as SMT-LIB and re-checked with any
solver.

A model can propose fixes, and a fix counts only when the checker proves both
that it removes the defects and that it changes nothing else (see
[Verified repair](#verified-repair)).

**Status:** Phases 0–3 of [`docs/PLAN.md`](docs/PLAN.md) are done: truthful
verification, real solver back ends, SMT-LIB export, the verified repair loop,
and the [web app](#web-app) rebuilt from the Claude Design handoff
([`docs/design-handoff.md`](docs/design-handoff.md)). The original prototype
stays at `/prototype` for comparison.

## Quick start

**Docker** (engines and solvers included):

```bash
docker build -t verifier-workbench .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY verifier-workbench
# open http://localhost:3000
```

The API key is only needed for repair; verification works without one.

The image is `linux/amd64`, because ESBMC ships x86-64 binaries only. On
Apple silicon, add `--platform linux/amd64` to both commands.

**Local development** needs Node 22.12+ and at least one engine on `PATH`:

- **CBMC:** `apt install cbmc` or `brew install cbmc`.
- **ESBMC:** unzip `esbmc-linux.zip` from its [releases](https://github.com/esbmc/esbmc/releases).
- **Optional:** `apt install z3 cvc5` adds SMT back ends for CBMC; ESBMC has its solvers built in.

```bash
npm install
npm run build && npm start   # web app + API on http://127.0.0.1:3000
```

For UI work, run the API and the Vite dev server side by side:

```bash
npm run dev        # API on :3000, restarting on change
npm run dev:web    # web app on http://127.0.0.1:5173, with /api proxied to :3000
```

## What "proved" means here

A bounded model checker proves a property *within bounds*. The results say
exactly which bounds applied:

- **Per-function harness.** Each function is verified on its own with
  arbitrary argument values, so library code without `main` works. Only
  obligations located in that function count, which rules out vacuous proofs
  of code the entry never reaches. Failures inside library code it calls, such
  as `memcpy`, are reported against it.
- **Three outcomes: proved, refuted, inconclusive.** Loops are unwound up to
  `unwind` (default 16) with unwinding assertions on. If a loop can run longer,
  that function's results are **inconclusive**, never proved; raise `unwind`
  to settle them.
- **Arbitrary pointers.** Pointer arguments are arbitrary, possibly NULL or
  dangling. Findings that depend on this carry a `note`, since the caller may
  guarantee a valid pointer.
- **Initial globals.** Global variables start at their initial values.

## Verified repair

`POST /api/repair` asks a model for a patch, then checks it mechanically. A
patch counts only if it passes every check. A rejected patch goes back to the
model with the reason, for up to `REPAIR_MAX_ITERS` attempts.

1. **No tricks.** The patch may not add:
   - verifier intrinsics or assumptions (`__CPROVER_*`, `__ESBMC_*`,
     `__VERIFIER_*`, `__builtin_assume`);
   - checker pragmas or inline assembly;
   - calls that end the program (`abort`, `exit`, …);
   - includes outside the source;
   - macros that redefine existing names or keywords.

   Every assertion must stay as written and in force, so `#define NDEBUG` is
   rejected too.
2. **Re-verified.** The same engine, solver, bound and checks re-verify the
   patch. Every function of the original keeps its exact type. No obligation
   the original decided may become inconclusive.
3. **Same behavior, proved.** CBMC proves that each changed function, and every
   function that calls one:
   - returns the same value as the original;
   - leaves the same global state;
   - does not end the program where the original returns.

   This must hold on every input where the original has no undefined behavior
   and passes its assertions. So a patch may change behavior only where the
   original was wrong.
   - **Differences.** A difference is reported with concrete inputs, for
     example `store(idx = 13, v = 128)` leaves `buf[13]` different.
   - **Unfinished proofs.** A proof that does not finish rejects the patch.
   - **No execution.** Nothing submitted is ever executed.
4. **No vanishing checks.** If every obligation of a function disappeared, the
   function must be proved equivalent.

A patch that passes every check with strictly fewer refuted obligations becomes
the version the next attempt builds on. The result is `repaired` only when
nothing is refuted. Every attempt is in `iterations`, with its outcome, its
diff and the reason for any rejection.

Limits of the behavior proof:
- **Skipped functions.** These are not compared, and the result marks them
  `skipped`; check 4 still applies to them:
  - functions with pointer or struct parameters or results;
  - variadic functions;
  - functions that reach a function without a body.
- **Static locals.** Function-local `static` variables are not compared.
- **Initial state.** Each call starts from the globals' initial values.

**Models.** The Claude adapter:
- uses the official SDK with `claude-opus-5` by default;
- streams its requests;
- gets structured output through a JSON schema;
- marks the original source for prompt caching.

**Refusal fallbacks are on:** if Claude's safety classifiers decline a request,
the API retries it on the model Anthropic recommends for that category. Set
`CLAUDE_REPAIR_FALLBACKS=off` to disable them. ChatGPT, Gemini and any OpenAI-compatible
self-hosted server (vLLM, Ollama, LM Studio, llama.cpp) work too.

## Web app

React and Vite, in [`packages/web`](packages/web). The server serves the built
files at `/`: hashed assets are cached for good, and pages get a strict
Content-Security-Policy (scripts, styles and fonts from the same origin only).

| Route | View |
|---|---|
| `/new` | New Run: paste or drop a `.c` / `.h` file; choose engine, solver and loop bound |
| `/runs/:id` | Workbench: functions, source with finding markers or the patch diff, findings, the repair agent, and the selected finding's counterexample and SMT-LIB |
| `/runs/:id/report` | Printable verification report (print or save as PDF) |
| `/misra` | MISRA status: the rules are not checked yet, and the page says so |
| `/batch` | Problem sets: the runs in this browser (batch upload is not built yet) |

- **Runs live in the browser that made them** (the last 20, in `localStorage`)
  until accounts arrive (Phase 4). A repaired patch becomes a new run linked to
  its original, so Revert returns to the unpatched source and its findings.
- **Demo mode.** With no server reachable, `/` opens a recorded run of the
  sample, labelled as recorded. It holds real CBMC results and a real repair
  loop with scripted model answers: one patch the behavior proof rejects, then
  the fix. `npm run record-demo` re-records it with the installed CBMC and Z3.
- **Design fidelity.** Tokens, type and layout follow the handoff, in light and
  dark. IBM Plex ships with the app: the same files the prototype embeds (SIL
  Open Font License).
- **Accessibility.** Controls are real buttons and links, tabs and option groups
  follow the ARIA patterns with arrow keys, and focus is always visible. axe
  reports nothing but colour contrast, where a few of the design's tokens are
  below WCAG AA (see `docs/PLAN.md`, Phase 3).

## Examples

New Run's **Samples** menu offers the built-in `arith.c` and self-contained
harnesses over real flight code from NASA's
[Core Flight System](https://github.com/nasa/cFE) (cFS, Apache-2.0), in
[`examples/cfs`](examples/cfs):

- **`cfe_time_add.c`** / **`cfe_time_subtract.c`** prove that `CFE_TIME_Add` and
  `CFE_TIME_Subtract`'s hand-written carry/borrow equal a single 64-bit
  addition/subtraction, for every pair of times.
- **`cfe_time_compare.c`** refutes a natural-looking spec about `CFE_TIME_Compare`
  with a concrete witness that exposes its deliberate ~68-year clock rollover,
  while proving the function's two internal subtractions safe.
- **`cfe_time_compare_order.c`** proves `CFE_TIME_Compare` is a consistent order
  (A after B iff B before A), rollover included.
- **`lc_watch_result_bounds.c`** proves an indexed write to the Limit Checker's
  watchpoint results table (real entry type, real table size) stays in bounds
  under LC's guard, and refutes the off-by-one variant at one past the end.

Each sample carries the engine settings and check set that make its point. The
`CFE_TIME` proofs run with overflow checks **off**, because cFS time wraps
unsigned by contract — the menu says so when it loads, so a proof or
counterexample is never misread. See [`examples/cfs/README.md`](examples/cfs/README.md)
for how to run them from the CLI checker, and [`examples/cfs/NOTICE`](examples/cfs/NOTICE)
for attribution.

## API

Types: [`packages/shared/src/index.ts`](packages/shared/src/index.ts).

| Method | Path | Body → response |
|---|---|---|
| GET | `/api/health` | → `{ ok, version }` |
| GET | `/api/engines` | → engines, the solvers each can use on this host (with versions), and limits |
| POST | `/api/verify` | `{ code, fileName?, engine?, solver?, unwind?, checks?, functions? }` → `VerifyResult` |
| POST | `/api/smtlib` | `{ code, …, function, ref }` → SMT-LIB text for one obligation |
| GET | `/api/providers` | → model providers, which are configured, and what each still needs |
| POST | `/api/repair` | `{ code, fileName?, engine?, solver?, unwind?, checks?, provider?, maxIters? }` → `RepairResult` |
| POST | `/api/repair/stream` | same body → server-sent events `checking`, `proposing`, `iteration`, then `result` |

For `/api/smtlib`, pass a finding's `entry` as `function` and its `exportRef`
as `ref`. The formula asserts the obligation's negation: `sat` means it can be
violated (the model is a counterexample), and `unsat` means it holds within the
bound.

```bash
jq -n --rawfile code packages/core/test/fixtures/c/arith.c '{code: $code, fileName: "arith.c", solver: "z3"}' \
  | curl -s localhost:3000/api/verify -H 'content-type: application/json' -d @- \
  | jq '.findings[] | {id, status, line, inputs: [.model[] | select(.role == "input") | "\(.name)=\(.value)"]}'
```

## Configuration

**Server**

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | The Docker image listens on `0.0.0.0` |
| `BODY_LIMIT_BYTES` | 512 KiB | Request body limit |
| `WEB_DIST` | `packages/web/dist`, if built | Web app to serve at `/`; empty = none |
| `UI_HTML` | the design bundle | Prototype to serve at `/prototype` (and at `/` without a web app); empty = none |
| `LOG_LEVEL` | `info` | |

**Verification**

| Variable | Default | |
|---|---|---|
| `VERIFY_ENGINE` | `cbmc` | `cbmc` or `esbmc` |
| `VERIFY_SOLVER` | Z3 if installed, else the engine's own | `minisat`, `z3`, `cvc5`, `bitwuzla` or `boolector` |
| `VERIFY_UNWIND` / `VERIFY_MAX_UNWIND` | `16` / `256` | Loop bound: default and the most a request may ask for |
| `VERIFY_TIMEOUT_MS` | `60000` | Per checker process |
| `VERIFY_CONCURRENCY` | CPUs − 1, at most 4 | Checker processes at once, across requests |
| `VERIFY_MEMORY_LIMIT_MB` | `4096` | Per checker process, via `prlimit`; `0` = off |
| `VERIFY_MAX_FUNCTIONS` / `VERIFY_MAX_CODE_BYTES` | `64` / 200 KiB | Per request |
| `VERIFY_MAX_OUTPUT_BYTES` / `VERIFY_MAX_SMT_BYTES` | 32 MiB / 8 MiB | |

**Repair and models**

| Variable | Default | |
|---|---|---|
| `REPAIR_MAX_ITERS` | `3` | Attempts per repair: the default and the most a request may ask for |
| `REPAIR_CONCURRENCY` | `2` | Repairs at once; more get HTTP 429 |
| `LLM_PROVIDER` | `anthropic` | Default provider: `anthropic`, `openai`, `gemini` or `custom` |
| `LLM_TIMEOUT_MS` | `300000` | Per model request |
| `ANTHROPIC_API_KEY` | | Claude (or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, workload identity) |
| `CLAUDE_MODEL` / `CLAUDE_REPAIR_EFFORT` / `CLAUDE_REPAIR_MAX_TOKENS` | `claude-opus-5` / `high` / `64000` | |
| `CLAUDE_REPAIR_FALLBACKS` | `default` | `off` disables server-side refusal fallbacks |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_MAX_TOKENS` | model `gpt-4o` | ChatGPT |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_MAX_TOKENS` | model `gemini-2.5-flash` | Gemini (the key is sent in a header) |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_MAX_TOKENS` | | Self-hosted OpenAI-compatible server (`custom`) |

The Claude settings added for repair are named `CLAUDE_REPAIR_*`, because a
server started from a Claude Code terminal inherits Claude Code's own settings,
such as `CLAUDE_EFFORT`.

**Binaries and flags**

| Variable | Default | |
|---|---|---|
| `CBMC_BIN`, `ESBMC_BIN`, `Z3_BIN`, `CVC5_BIN`, `BITWUZLA_BIN` | on `PATH` | Explicit binary paths |
| `CBMC_EXTRA_FLAGS`, `ESBMC_EXTRA_FLAGS` | | Appended to every run |

## Layout

```
packages/shared   API contract (types only; shared by the server and the web app)
packages/core     verification core: engine adapters, harnesses, runner, SMT-LIB export,
                  and the repair loop (repair/: guards, behavior proof, prompts)
packages/llm      model providers: Claude (official SDK), OpenAI-compatible, Gemini
packages/server   Fastify API; serves the web app, and the prototype at /prototype
packages/web      React web app: New Run, Workbench, Report, MISRA, Problem Sets
examples/cfs      verification harnesses over real NASA cFS code (Apache-2.0)
design/           Claude Design prototype (reference)
hosted-example/   the handoff's original backend (reference; superseded by packages/)
docs/             plan and the design handoff spec
```

## Tests

```bash
npm run check             # format, lint, typecheck, all tests
npm test                  # unit + replay tests; integration tests skip if engines are missing
npm run record-fixtures   # re-record engine output after changing any engine command line
npm run e2e               # the web app in a real browser, against a running server (below)
```

- **Replay tests.** Recorded CBMC and ESBMC runs are replayed through the full
  pipeline, so CI checks the truthfulness guarantees without any engine
  installed. Repair scenarios run the loop with a scripted model: each cheat
  is rejected with its reason, and the honest fix is accepted.
- **Integration tests** in `packages/core/test/integration.test.ts` run the
  real engines with every installed solver. They also:
  - check that exported SMT-LIB is `sat` for refuted and `unsat` for proved
    obligations;
  - rerun every recorded behavior proof and repair live, and require the same
    verdicts.
- **cFS examples** in `packages/core/test/cfs-examples.test.ts` run real CBMC on
  the shipped [`examples/cfs`](examples/cfs) harnesses and pin their verdicts:
  the `CFE_TIME_Add` proof holds, and the `CFE_TIME_Compare` spec is refuted with
  the rollover witness. Skipped when CBMC is absent, required in CI.
- **Model providers** are tested against a fake SDK client and a fake `fetch`.
  `packages/server/test/fake-model.mjs` stands in for a self-hosted model. CI
  uses it to run a repair inside the Docker image.
- **Web app.** Unit tests cover the Workbench's view of a run, formatting, the
  highlighter, the router and the repair stream client, on the recorded demo
  run. [`packages/web/e2e/flow.mjs`](packages/web/e2e/flow.mjs) drives Chromium
  through New Run → Workbench → Repair → Diff → Report → Revert and through
  demo mode. CI runs it against the Docker image; locally:

  ```bash
  node packages/server/test/fake-model.mjs packages/core/test/fixtures/c/arith.c 4011 &
  npm run build && LLM_PROVIDER=custom LLM_BASE_URL=http://127.0.0.1:4011/v1 npm start &
  npx playwright install chromium   # once
  BASE_URL=http://127.0.0.1:3000 npm run e2e
  ```

## Security

Submitted C is untrusted.

- **Isolation.** Checkers run in a private temporary directory with a memory
  cap and a timeout, and see no server environment variables (API keys).
- **Includes.** `#include` of absolute or parent paths is rejected.
- **No LLM proxy.** The handoff's open `/api/complete` endpoint is gone. The
  model only proposes code, and nothing it writes is executed. Checkers read
  it, and the behavior proof analyzes it symbolically.
- **Keys stay on the server.** `/api/providers` reports whether a provider is
  configured, never the key.
- **Web app.** Pages allow no inline script or style and no other origin, and
  cannot be framed. Runs, source included, stay in the browser; the server
  stores none.
- **Repairs spend model tokens.** `REPAIR_CONCURRENCY` bounds how many run at
  once, but there is no authentication or quota yet (Phase 4). Do not expose a
  server that has a model key to the internet.

The container is still the real boundary: see the notes in the
[`Dockerfile`](Dockerfile). Put auth in front before exposing it (Phase 4).
