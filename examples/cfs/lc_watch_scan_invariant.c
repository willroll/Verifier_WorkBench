/*
 * Example: proving an unbounded loop with VW_INVARIANT.
 *
 * A bounded model checker unwinds loops a fixed number of times, so a loop
 * whose trip count is a caller-supplied variable — as most flight-code scans
 * and copies are — comes out inconclusive: no fixed unwind bound covers every
 * count. VW_INVARIANT states a loop invariant the checker uses to reason about
 * the loop for ANY number of iterations instead of unwinding it, turning that
 * inconclusive into a real, unbounded proof.
 *
 * This is a compaction pass over NASA cFS's Limit Checker results table (LC,
 * Apache-2.0 — see examples/cfs/NOTICE): it walks the first `Count` entries and
 * packs the stale ones to the front. The read index `k` is bounded by the loop
 * guard (k < Count) and the caller precondition (Count <= LC_MAX_WATCHPOINTS),
 * but the write index `w` is not — only the invariant `w <= k` keeps it inside
 * the table. Drop the invariant and the indexed writes are inconclusive; with
 * it, the scan is proved in bounds for every Count.
 *
 * Runs at the default check set.
 */
#include <stdint.h>

typedef uint8_t  uint8;
typedef uint16_t uint16;
typedef uint32_t uint32;

#define LC_MAX_WATCHPOINTS 176 /* DEFAULT_LC_MAX_WATCHPOINTS, LC interface config */
#define LC_WATCHPOINT_STALE 2  /* stale marker for a watch result (lc_tbldefs.h) */

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
 * Compact the stale results to the front of the table. `k` reads every entry up
 * to Count; `w` is the next free slot. The invariant `w <= k` holds throughout,
 * so the write index is always inside the table — the fact the invariant
 * supplies and the loop guard alone does not. Proved for every Count, without
 * unwinding the loop.
 */
uint16 compact_stale_results(uint16 Count)
{
    VW_REQUIRE(Count <= LC_MAX_WATCHPOINTS);

    uint16 w = 0;
    for (uint16 k = 0; k < Count; k++)
    VW_INVARIANT(w <= k)
    {
        if (WatchResults[k].WatchResult == LC_WATCHPOINT_STALE)
        {
            WatchResults[w] = WatchResults[k];
            w++;
        }
    }
    return w;
}
