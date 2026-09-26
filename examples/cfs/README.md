# cFS verification examples

Self-contained verification harnesses over real flight code from NASA's
[Core Flight System](https://github.com/nasa/cFE) (cFE, Apache-2.0). Each file
pairs a function copied verbatim from cFE with a small harness that states a
property; CBMC (or ESBMC) then proves it or returns a concrete counterexample.
See [`NOTICE`](NOTICE) for attribution; the copied code is delimited by
`verbatim from cFE` / `end cFE` markers.

The harness parameters become the checker's free variables, so a counterexample
prints them as the failing inputs — the same way the built-in `arith.c` sample
reports `a` and `b`.

| File | Property | Verdict | Notes |
|---|---|---|---|
| [`cfe_time_add.c`](cfe_time_add.c) | `CFE_TIME_Add`'s hand-written Subseconds→Seconds carry equals a single 64-bit addition | **Proved** for all inputs | Run with overflow checks **off**: cFS time is modular and wraps by contract, so unsigned "overflow" is intended, not a defect. Recommended checks: bounds, pointers, div-by-zero. |
| [`cfe_time_compare.c`](cfe_time_compare.c) | The intuitive spec "`A_GT_B` ⇒ `TimeA.Seconds >= TimeB.Seconds`" | **Refuted** with a witness; the two guarded subtractions are proved safe | Runs clean at the default check set. The witness has the two times more than the ~68-year rollover apart. |

## Running them

In the web app, open **New Run**, pick a cFS example from the samples menu (it
carries the right checks), and press **Verify**. Or with the CLI checker:

```bash
# proof: overflow checks off, because the code wraps by contract
cbmc examples/cfs/cfe_time_add.c --function prove_add_is_64bit_addition \
  --bounds-check --pointer-check --div-by-zero-check

# counterexample: default checks, with a trace
cbmc examples/cfs/cfe_time_compare.c --function assume_gt_means_larger_seconds \
  --bounds-check --pointer-check --div-by-zero-check \
  --signed-overflow-check --unsigned-overflow-check --trace
```

## Why these functions

cFS is written in C and built from small, self-contained modules, which makes
individual functions good targets for bounded model checking: no operating
system, no I/O, just data. The `CFE_TIME` arithmetic is a clean first case —
pure integer math with real, documented modular semantics, so the same code
yields both a clean proof and an instructive counterexample.
