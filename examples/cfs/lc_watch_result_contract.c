/*
 * Example: verifying a real caller-contract leaf with VW_REQUIRE.
 *
 * All through NASA cFS's Limit Checker (LC, Apache-2.0 — see examples/cfs/
 * NOTICE), the watchpoint results table is written as
 * `LC_OperData.WRTPtr[WatchIndex].WatchResult = ...` with no bound check in the
 * leaf: LC relies on the caller to keep WatchIndex below LC_MAX_WATCHPOINTS
 * (LC_ProcessWP is only reached for a valid watchpoint). Checked with
 * unconstrained inputs, that write looks out of bounds — the false alarm you
 * get from verifying a leaf in isolation.
 *
 * A precondition states that caller contract. `VW_REQUIRE(expr)` tells the
 * checker to verify the function only where expr holds (it becomes the engine's
 * assume). Under the contract, the indexed write is proved in bounds — the
 * honest result for code whose bound is enforced by its callers.
 *
 * Runs at the default check set. The precondition is shown with the result, so
 * the proof is always read as "proved, given this contract".
 */
#include <stdint.h>
#include <assert.h>

typedef uint8_t  uint8;
typedef uint16_t uint16;
typedef uint32_t uint32;

#define LC_MAX_WATCHPOINTS 176 /* DEFAULT_LC_MAX_WATCHPOINTS, LC interface config */

/* ---- results-table entry, from LC config/default_lc_tblstruct.h (trimmed) ---- */
typedef struct
{
    uint8  WatchResult;
    uint8  Padding[3];
    uint32 CountdownToStale;
    uint32 EvaluationCount;
} LC_WRTEntry_t;
/* ---- end LC ---- */

static LC_WRTEntry_t WatchResults[LC_MAX_WATCHPOINTS];

/*
 * The leaf write LC does, without an internal guard, under its caller contract.
 * VW_REQUIRE is LC's precondition; the checker proves the write in bounds only
 * for indexes the caller is required to pass.
 */
void record_watch_result(uint16 WatchIndex, uint8 Result)
{
    VW_REQUIRE(WatchIndex < LC_MAX_WATCHPOINTS);

    WatchResults[WatchIndex].WatchResult = Result;
}
