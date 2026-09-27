# cFS verification examples

Self-contained verification harnesses over real flight code from NASA's
[Core Flight System](https://github.com/nasa/cFE) (cFS, Apache-2.0) — the Core
Flight Executive (cFE) and the Limit Checker app (LC). Each file pairs code
taken from cFS with a small harness that states a property; CBMC (or ESBMC)
then proves it or returns a concrete counterexample. See [`NOTICE`](NOTICE) for
attribution; copied code is delimited by `verbatim from …` / `end …` markers.

The harness parameters become the checker's free variables, so a counterexample
prints them as the failing inputs — the same way the built-in `arith.c` sample
reports `a` and `b`.

| File | Property | Verdict | Notes |
|---|---|---|---|
| [`cfe_time_add.c`](cfe_time_add.c) | `CFE_TIME_Add`'s hand-written carry equals a single 64-bit addition | **Proved** for all inputs | Overflow checks **off**: cFS time is modular and wraps by contract, so unsigned "overflow" is intended. Checks: bounds, pointers, div-by-zero. |
| [`cfe_time_subtract.c`](cfe_time_subtract.c) | `CFE_TIME_Subtract`'s hand-written borrow equals a single 64-bit subtraction | **Proved** for all inputs | Overflow checks **off**, same reason as add. |
| [`cfe_time_compare.c`](cfe_time_compare.c) | The intuitive spec "`A_GT_B` ⇒ `TimeA.Seconds >= TimeB.Seconds`" | **Refuted** with a witness; the two guarded subtractions are proved safe | Default checks. The witness has the two times more than the ~68-year rollover apart. |
| [`cfe_time_compare_order.c`](cfe_time_compare_order.c) | `CFE_TIME_Compare` is antisymmetric: A after B iff B before A | **Proved** for all inputs, rollover included | Default checks; the guarded subtractions are proved too. |
| [`lc_watch_result_bounds.c`](lc_watch_result_bounds.c) | An indexed write to LC's watchpoint results table stays in bounds | **Proved** under LC's guard; the off-by-one variant is **refuted** at index `LC_MAX_WATCHPOINTS` | Default checks; uses LC's real results-table entry type and table size (176). The array-bounds check does the work. |
| [`lc_watch_result_contract.c`](lc_watch_result_contract.c) | The same table write, but in a leaf with **no** internal guard — proved in bounds under the precondition `VW_REQUIRE(WatchIndex < LC_MAX_WATCHPOINTS)` | **Proved** under the contract; **refuted** without it, at an index past the end | Default checks. The precondition is the contract LC's callers enforce; it is surfaced with the result so the proof reads as conditional. |
| [`lc_watch_caller.c`](lc_watch_caller.c) | Callers of that leaf must satisfy its precondition | Guarding caller **proved** to honor it; off-by-one caller (`<=`) **refuted** at the caller index `LC_MAX_WATCHPOINTS` | Default checks. The callee's `VW_REQUIRE` becomes an obligation on each caller — assume/guarantee reasoning, the other side of the contract. |

## Running them

In the web app, open **New Run**, pick a cFS example from the samples menu (it
carries the right checks), and press **Verify**. Or with the CLI checker:

```bash
# a proof: overflow checks off, because cFS time wraps by contract
cbmc examples/cfs/cfe_time_add.c --function prove_add_is_64bit_addition \
  --bounds-check --pointer-check --div-by-zero-check

# a counterexample: default checks, with a trace
cbmc examples/cfs/cfe_time_compare.c --function assume_gt_means_larger_seconds \
  --bounds-check --pointer-check --div-by-zero-check \
  --signed-overflow-check --unsigned-overflow-check --trace

# array bounds: the off-by-one guard is refuted at one past the end
cbmc examples/cfs/lc_watch_result_bounds.c --function store_watch_result_offbyone \
  --bounds-check --trace
```

`VW_REQUIRE` is Verifier Workbench's own spelling of the engine's assume
builtin; the app and checker expand it for you. To run the precondition example
straight from the CLI, expand it first (CBMC's `-D` cannot take a function-like
macro):

```bash
# proved in bounds under the caller contract
sed 's/\bVW_REQUIRE\b/__CPROVER_assume/g' examples/cfs/lc_watch_result_contract.c \
  > /tmp/contract.c
cbmc /tmp/contract.c --function record_watch_result \
  --bounds-check --pointer-check --div-by-zero-check
# drop the VW_REQUIRE line instead, and the same write is refuted out of bounds
```

## Why these functions

cFS is written in C and built from small, self-contained modules, which makes
individual functions good targets for bounded model checking: no operating
system, no I/O, just data. The `CFE_TIME` arithmetic is pure integer math with
real, documented modular semantics, so the same code yields both clean proofs
and an instructive counterexample. The LC example carries a fixed-size table
and shows what array-bounds checking proves — and how a strict bound differs
from an off-by-one — on cFS's real dimensions.

Note on shape: a looping copy such as LC's `LC_CopyBytesWithSwap` verifies
per-function only against a fixed loop bound; because these harnesses check
each function with unconstrained inputs, the bounds example uses a
fixed-size-table write (no unbounded loop), where the guard is what the checker
reasons about.

## Preconditions (caller contracts)

Real flight code often pushes a bound up to the caller: LC's own leaf writes
`LC_OperData.WRTPtr[WatchIndex].WatchResult` with **no** local check, because
`LC_ProcessWP` only reaches it for a valid watchpoint. Checked in isolation
with an unconstrained index, that leaf looks out of bounds — a false alarm from
verifying a leaf without its caller.

`VW_REQUIRE(expr)` (alias `VW_ASSUME(expr)`) states that contract in the
source. The checker then verifies the function only where `expr` holds, so the
honest result — "proved, *given* the caller keeps the index in range" — comes
out instead of the false alarm. The precondition travels with the result (the
workbench shows a **Proved assuming** panel; the report prints it), so a
conditional proof is never mistaken for an unconditional one, and the repair
loop treats each precondition as fixed: a patch may not weaken, add, or drop
one. `lc_watch_result_contract.c` is exactly this — the same table write as the
bounds example, but as the real unguarded leaf under its caller contract.

### Checking the callers (assume/guarantee)

A precondition is only sound if the callers honor it. When another function in
the same file calls a contracted one, the checker turns that callee's
`VW_REQUIRE` into an obligation on the **caller**: at the call, it must pass
arguments the contract allows. This is assume/guarantee reasoning — assume a
function's own precondition when verifying it, assert it at every call site — so
the two sides meet: the leaf is proved *given* its contract, and each caller is
proved to *provide* it (or refuted, with the caller input that breaks it).

`lc_watch_caller.c` shows both callers of the leaf: one guards the index and is
proved to honor the contract; an off-by-one caller (`<=`) is refuted at the
caller index `LC_MAX_WATCHPOINTS`. A violation is charged to the caller, not the
callee — the fix is to guard the call, and the callee's contract stays as
given. (Cross-file callers, where the callee's contract lives in a header, are
the next step; today both sides must be in the submitted file.)
