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
