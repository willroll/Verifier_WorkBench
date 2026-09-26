/*
 * Example: array-bounds safety on NASA cFS's watchpoint results table.
 *
 * The Limit Checker app (LC, part of cFS, Apache-2.0 — see examples/cfs/NOTICE)
 * keeps a Watchpoint Results Table of LC_MAX_WATCHPOINTS entries and, all
 * through lc_watch.c, writes it as `LC_OperData.WRTPtr[WatchIndex].WatchResult`
 * and friends. LC bounds WatchIndex against LC_MAX_WATCHPOINTS before those
 * writes (e.g. the WatchPtTblIndex < LC_MAX_WATCHPOINTS loop guard).
 *
 * The results-table entry type (LC_WRTEntry_t) and the table size
 * (LC_MAX_WATCHPOINTS, default 176 in the mission config) are LC's. The two
 * accessor functions below are harnesses that write the table by index the way
 * lc_watch.c does, so CBMC's array-bounds check can reason about the guard:
 *
 *   - store_watch_result   uses LC's guard  (WatchIndex <  LC_MAX_WATCHPOINTS)
 *                          -> proved in bounds for every index.
 *   - store_watch_result_offbyone uses a <= guard, the classic off-by-one,
 *                          -> refuted: CBMC returns WatchIndex = LC_MAX_WATCHPOINTS.
 *
 * Runs at the default check set; the array-bounds check does the work.
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
    uint8  WatchResult;      /* result of the last evaluation (enumerated)     */
    uint8  Padding[3];       /* structure padding                              */
    uint32 CountdownToStale; /* samples left before WatchResult becomes stale  */
    uint32 EvaluationCount;  /* how many times this watchpoint was evaluated   */
} LC_WRTEntry_t;
/* ---- end LC ---- */

/* The fixed-size results table LC allocates, one entry per watchpoint. */
static LC_WRTEntry_t WatchResults[LC_MAX_WATCHPOINTS];

/*
 * Records a watchpoint result the way lc_watch.c does, with LC's own bound.
 * CBMC proves the indexed write stays inside WatchResults for every index.
 */
void store_watch_result(uint16 WatchIndex, uint8 Result)
{
    if (WatchIndex < LC_MAX_WATCHPOINTS)
    {
        WatchResults[WatchIndex].WatchResult = Result;
    }
}

/*
 * The same write with an off-by-one bound (<= instead of <). CBMC refutes it
 * and returns WatchIndex = LC_MAX_WATCHPOINTS, one past the end of the table —
 * why the bound must be strict.
 */
void store_watch_result_offbyone(uint16 WatchIndex, uint8 Result)
{
    if (WatchIndex <= LC_MAX_WATCHPOINTS)
    {
        WatchResults[WatchIndex].WatchResult = Result;
    }
}
