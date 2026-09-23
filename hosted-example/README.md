# Verifier Workbench — hosted example

## What this is

An MVP for **proving whether generated C code is actually safe**, and repairing
it when it isn't.

LLMs now write a lot of embedded and safety-critical C. Review and linting catch
style; neither can tell you whether a function can overflow, run off the end of
an array, or divide by zero on some input nobody thought to test. This tool
answers that question with a proof rather than an opinion — and when the answer
is "no", it drives an LLM to fix the code and then *proves the fix*.

The wedge: **most AI coding tools cannot tell you whether their own fix worked.**
This one can, because the checker is the judge, not the model.

## What it does

1. **Takes C source** — pasted, dropped, or from a batch of submissions.
2. **Generates safety obligations** and discharges them with a bounded model
   checker (CBMC or ESBMC) over an SMT solver. Checks array bounds, pointer and
   null dereference, division by zero, signed/unsigned overflow, conversion, and
   any assertions you wrote.
3. **Reports counterexamples, not warnings.** Every refuted obligation comes with
   the concrete witness assignment that breaks it (`a = 2147483647, b = 1 →
   a + b = −2147483648`), located on the offending source line.
4. **Repairs, then re-verifies.** The agent asks an LLM for a corrected file and
   runs the checker again on the candidate. A patch is never trusted — success is
   only reported when every obligation is discharged. "Could not repair" is a
   first-class outcome.
5. **Maps findings to MISRA C:2012** rules and produces a printable run report —
   the artifact safety-critical reviewers actually want.

Everything is auditable: the iteration history, the counterexamples, the diff of
the patch that held, and the checker's raw output are all shown in the UI and
returned by the API.

## Who it's for

- Teams shipping LLM-generated C into embedded or safety-critical products.
- Anyone under MISRA / ISO 26262 / DO-178C / IEC 61508 pressure who needs
  evidence rather than a linter score.
- Educators grading C submissions against safety obligations (see Problem Sets).

## Status: prototype

Real and working: verification, counterexamples, the verified repair loop,
multi-provider LLM support, the engine picker.

Still demo content: the MISRA rule table and the Report tab's findings (real
MISRA checking needs a licensed rule engine), the Problem Sets batch data, and
the file/function tree. Single translation unit only. See "Known limits" below.

## How it runs

**Real verification** (CBMC or ESBMC, interchangeable) plus a **live repair
loop** (Claude, Gemini, ChatGPT, or any self-hosted OpenAI-compatible model).
Both degrade gracefully: with nothing installed and no API key you get the
recorded demo run, so it always presents.

## Run it

Requires Node 18+ (built-in `fetch`, no dependencies to install).

```bash
# Claude (default)
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
node server.js
# open http://localhost:3000
```

Or with both checkers preinstalled:

```bash
docker build -t verifier-workbench .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... verifier-workbench
```

## Verification engines (CBMC / ESBMC)

Verification is real when a checker is installed. Both are bounded model
checkers that discharge safety obligations via an SMT solver; they are
**interchangeable** — pick one per run from the ENGINE picker in the New Run
tab, or set the default with `VERIFY_ENGINE=cbmc|esbmc`.

The server detects which are present on startup and reports it (`GET
/api/engines`). The picker labels each engine with its version, or says "not
installed". **If neither is installed the UI falls back to its recorded demo
results**, so the prototype still demos cleanly with nothing installed.

Checks enabled: array bounds, pointer/null, division by zero, signed and
unsigned overflow, conversion (CBMC), plus any user assertions.

| Var                  | Default | Notes                                  |
| -------------------- | ------- | -------------------------------------- |
| `VERIFY_ENGINE`      | `cbmc`  | default engine                         |
| `VERIFY_UNWIND`      | `16`    | loop unwind bound                      |
| `VERIFY_TIMEOUT_MS`  | `60000` | per-run kill timeout                   |
| `CBMC_BIN`/`ESBMC_BIN` | on PATH | explicit binary paths                |
| `CBMC_EXTRA_FLAGS` / `ESBMC_EXTRA_FLAGS` | — | appended verbatim   |

Install locally:

```bash
# macOS
brew install cbmc            # ESBMC: download a release from github.com/esbmc/esbmc
# Ubuntu/Debian
sudo apt-get install cbmc
```

Or use the included Dockerfile, which installs both:

```bash
docker build -t verifier-workbench .
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... verifier-workbench
```

> ⚠️ **Sandbox this.** `/api/verify` runs a C frontend over untrusted input.
> The checkers don't execute the program, but they do parse attacker-controlled
> code. Run it containerised with resource limits — see the notes at the bottom
> of the Dockerfile — and don't expose it publicly without auth.

### Known limits (this is a first cut)

- Single translation unit; no multi-file projects, includes, or build systems.
- ESBMC reports the first violated property per run unless you pass
  `ESBMC_EXTRA_FLAGS=--multi-property` (build-dependent).
- The MISRA tab and Report still show demo content.
- The SMT-LIB tab shows the checker's raw output for live runs (the checkers
  don't hand back their SMT encoding by default).

## The verified repair loop

`repair.js` closes the loop that makes this more than a linter:

```
verify → refuted? → ask the model for a full corrected file
       → RE-VERIFY the candidate → still refuted? → try again (bounded)
```

The rule the module enforces: **a patch is never trusted.** Every candidate goes
back through the model checker, and success is only reported when the checker
discharges every obligation. Terminal states are `repaired`, `unrepaired`,
`already-proved`, and `error` — "unrepaired" is a first-class outcome, not a
failure to hide.

Guards, because an LLM in a loop will happily cheat:

- Bounded iterations (`REPAIR_MAX_ITERS`, default 3, hard cap 6).
- Bails when the model returns unchanged source (no progress).
- A candidate is only carried forward if it *reduced* the refuted count, so a
  regression can't become the new baseline.
- The prompt forbids deleting code, weakening assertions, or adding assumptions
  to silence the checker — but the re-verification is what actually enforces it.

The UI's AGENT card shows the full iteration history (`iter 0 · verify · 2
refuted`, `iter 1 · repair → re-verify · all 7 proved ✓`) and a real line diff of
the patch that held. `POST /api/repair` returns the same history for CI use.

| Var | Default | Notes |
| --- | ------- | ----- |
| `REPAIR_MAX_ITERS` | `3` | repair attempts before giving up |

## Providers

Set `LLM_PROVIDER` to the **default** provider — `anthropic` | `gemini` |
`openai` | `custom` — then the vars for that provider. Users can also switch
provider at runtime from the dropdown in the UI's AGENT card; set the keys for
every provider you want selectable and the dropdown will use whichever is
chosen (falling back to the canned repair if that provider isn't configured).

| Provider   | `LLM_PROVIDER` | Required            | Optional (model / base)                  |
| ---------- | -------------- | ------------------- | ---------------------------------------- |
| Claude     | `anthropic`    | `ANTHROPIC_API_KEY` | `CLAUDE_MODEL` (def. claude-sonnet-4-5)  |
| Gemini     | `gemini`       | `GEMINI_API_KEY`    | `GEMINI_MODEL` (def. gemini-2.5-flash)   |
| ChatGPT    | `openai`       | `OPENAI_API_KEY`    | `OPENAI_MODEL` (def. gpt-4o), `OPENAI_BASE_URL` |
| Self-hosted| `custom`       | `LLM_BASE_URL`      | `LLM_MODEL`, `LLM_API_KEY`               |

Common: `PORT` (default `3000`).

### Self-hosted / OpenAI-compatible

`custom` targets any server that speaks the OpenAI `/v1/chat/completions`
shape — vLLM, Ollama, LM Studio, TGI, llama.cpp server, etc.

```bash
export LLM_PROVIDER=custom
export LLM_BASE_URL=http://localhost:11434/v1   # e.g. Ollama
export LLM_MODEL=llama3.1
# export LLM_API_KEY=...  # only if your endpoint requires one
node server.js
```

## What's inside

- `public/index.html` — the self-contained Workbench UI (unchanged per provider).
- `engines.js` — CBMC/ESBMC adapters. Shells out, then normalizes each
  checker's very different output into one finding shape.
- `repair.js` — the verified repair loop + line diff.
- `server.js` — zero dependencies. Serves the UI, injects a shim defining
  `window.claude.complete(...)` and `window.verifier.*`, and exposes
  `POST /api/complete`, `POST /api/verify`, `POST /api/repair`, `GET /api/engines`.
- `Dockerfile` — Ubuntu + CBMC + ESBMC + Node, ready to run.

## Deploy anywhere

Any Node host (Render, Railway, Fly, a VM, etc.):

1. Push this folder.
2. Set `LLM_PROVIDER` + that provider's env vars.
3. Start command: `node server.js` (it binds `PORT`).

> API keys stay server-side — they are never sent to the browser.

## Updating the UI

`public/index.html` is a compiled artifact. To change the UI, edit the source
`Verifier Workbench.dc.html` in the design project, re-export the standalone
file, and drop it in as `public/index.html`.
