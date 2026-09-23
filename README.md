# Verifier Workbench

Proves whether C code is safe, and shows exactly where it isn't. Each function
is checked by a bounded model checker (**CBMC** or **ESBMC**) over a real SAT or
SMT solver (**MiniSAT, Z3, cvc5, Bitwuzla, Boolector**). Every refuted
obligation comes with a concrete counterexample (the argument values that
break it). Every obligation can be exported as SMT-LIB and re-checked with any
solver.

**Status:** Phases 0–1 of [`docs/PLAN.md`](docs/PLAN.md) are done: truthful
verification, real solver back ends and SMT-LIB export. The verified LLM repair
loop is being rebuilt with enforced guards (Phase 2). The prototype UI from the
Claude Design handoff ([`docs/design-handoff.md`](docs/design-handoff.md)) is
served as-is until the React rebuild (Phase 3).

## Quick start

**Docker** (engines and solvers included):

```bash
docker build -t verifier-workbench .
docker run --rm -p 3000:3000 verifier-workbench
# open http://localhost:3000
```

**Local development** needs Node 22.12+ and at least one engine on `PATH`:

- **CBMC:** `apt install cbmc` or `brew install cbmc`.
- **ESBMC:** unzip `esbmc-linux.zip` from its [releases](https://github.com/esbmc/esbmc/releases).
- **Optional:** `apt install z3 cvc5` adds SMT back ends for CBMC; ESBMC has its solvers built in.

```bash
npm install
npm run dev        # API + prototype UI on http://127.0.0.1:3000
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

## API

Types: [`packages/shared/src/index.ts`](packages/shared/src/index.ts).

| Method | Path | Body → response |
|---|---|---|
| GET | `/api/health` | → `{ ok, version }` |
| GET | `/api/engines` | → engines, the solvers each can use on this host (with versions), and limits |
| POST | `/api/verify` | `{ code, fileName?, engine?, solver?, unwind?, checks?, functions? }` → `VerifyResult` |
| POST | `/api/smtlib` | `{ code, …, function, ref }` → SMT-LIB text for one obligation |
| POST | `/api/repair` | 501 until Phase 2 |

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
| `UI_HTML` | the design bundle | Prototype UI to serve at `/`; empty = API only |
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

**Binaries and flags**

| Variable | Default | |
|---|---|---|
| `CBMC_BIN`, `ESBMC_BIN`, `Z3_BIN`, `CVC5_BIN`, `BITWUZLA_BIN` | on `PATH` | Explicit binary paths |
| `CBMC_EXTRA_FLAGS`, `ESBMC_EXTRA_FLAGS` | | Appended to every run |

## Layout

```
packages/shared   API contract (types only; also used by the web app later)
packages/core     verification core: engine adapters, harnesses, runner, SMT-LIB export
packages/server   Fastify API; serves the prototype UI
design/           Claude Design prototype (reference; replaced in Phase 3)
hosted-example/   the handoff's original backend (reference; superseded by packages/)
docs/             plan and the design handoff spec
```

## Tests

```bash
npm run check             # format, lint, typecheck, all tests
npm test                  # unit + replay tests; integration tests skip if engines are missing
npm run record-fixtures   # re-record engine output after changing any engine command line
```

- **Replay tests.** Recorded CBMC and ESBMC runs are replayed through the full
  pipeline, so CI checks the truthfulness guarantees without any engine
  installed.
- **Integration tests** in `packages/core/test/integration.test.ts` run the
  real engines with every installed solver. They also check that exported
  SMT-LIB is `sat` for refuted and `unsat` for proved obligations.

## Security

Submitted C is untrusted.

- **Isolation.** Checkers run in a private temporary directory with a memory
  cap and a timeout, and see no server environment variables (API keys).
- **Includes.** `#include` of absolute or parent paths is rejected.
- **No LLM proxy.** The handoff's open `/api/complete` endpoint is gone.

The container is still the real boundary: see the notes in the
[`Dockerfile`](Dockerfile). Put auth in front before exposing it (Phase 4).
