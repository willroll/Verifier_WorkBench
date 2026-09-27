/*
 * Example: checking that a CALLER honors a callee's precondition.
 *
 * lc_watch_result_contract.c proved the Limit Checker's unguarded leaf write in
 * bounds *assuming* the caller keeps WatchIndex below LC_MAX_WATCHPOINTS. This
 * file verifies that assumption on the other side: the callers.
 *
 * `record_watch_result` is the same real cFS leaf (NASA LC, Apache-2.0 — see
 * examples/cfs/NOTICE), with its caller contract stated by VW_REQUIRE. When
 * another function in this file calls it, the checker turns that precondition
 * into an obligation on the caller: it must pass arguments the contract allows,
 * or the call is refuted with the caller input that breaks it.
 *
 * `process_watchpoint` guards the index the way LC's own control flow does, so
 * it is proved to honor the contract. `process_watchpoint_offbyone` uses `<=`,
 * the classic off-by-one, and is refuted — the counterexample is the caller
 * index LC_MAX_WATCHPOINTS, one past the end.
 *
 * Runs at the default check set.
 */
#include <stdint.h>

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
 * The real LC leaf: an indexed table write with no internal bound check, under
 * its caller contract. Verified on its own it is proved in bounds; here it is
 * the callee whose contract the functions below must satisfy.
 */
void record_watch_result(uint16 WatchIndex, uint8 Result)
{
    VW_REQUIRE(WatchIndex < LC_MAX_WATCHPOINTS);

    WatchResults[WatchIndex].WatchResult = Result;
}

/*
 * A caller that validates the index before the leaf write, as LC's own
 * watchpoint processing does. Proved to honor record_watch_result's contract.
 */
void process_watchpoint(uint16 WatchIndex, uint8 Result)
{
    if (WatchIndex < LC_MAX_WATCHPOINTS)
    {
        record_watch_result(WatchIndex, Result);
    }
}

/*
 * The same caller with an off-by-one guard (`<=` admits WatchIndex ==
 * LC_MAX_WATCHPOINTS). Refuted: it calls the leaf one past the end of the
 * table, violating the contract. The counterexample is that caller index.
 */
void process_watchpoint_offbyone(uint16 WatchIndex, uint8 Result)
{
    if (WatchIndex <= LC_MAX_WATCHPOINTS)
    {
        record_watch_result(WatchIndex, Result);
    }
}
