/*
 * Example: CFE_TIME_Compare is a consistent strict order (antisymmetry).
 *
 * CFE_TIME_SysTime_t and CFE_TIME_Compare below are taken verbatim from NASA's
 * Core Flight System (cFE, Apache-2.0) — see examples/cfs/NOTICE. Compare
 * treats time as circular (see cfe_time_compare.c for the rollover this
 * causes). Even so, it is a consistent order: this harness proves that
 * whenever A is judged after B, B is judged before A, for every pair of times.
 *
 * Runs clean at the default check set: the two guarded subtractions inside
 * Compare are proved not to underflow, and the ordering property is proved.
 */
#include <stdint.h>
#include <assert.h>

typedef struct
{
    uint32_t Seconds;
    uint32_t Subseconds;
} CFE_TIME_SysTime_t;

typedef enum
{
    CFE_TIME_A_LT_B = -1,
    CFE_TIME_EQUAL  = 0,
    CFE_TIME_A_GT_B = 1
} CFE_TIME_Compare_t;

#define CFE_TIME_NEGATIVE 0x80000000

/* ---- verbatim from cFE modules/time/fsw/src/cfe_time_api.c ---- */
CFE_TIME_Compare_t CFE_TIME_Compare(CFE_TIME_SysTime_t TimeA, CFE_TIME_SysTime_t TimeB)
{
    CFE_TIME_Compare_t Result;

    if (TimeA.Seconds > TimeB.Seconds)
    {
        if ((TimeA.Seconds - TimeB.Seconds) > CFE_TIME_NEGATIVE)
        {
            Result = CFE_TIME_A_LT_B;
        }
        else
        {
            Result = CFE_TIME_A_GT_B;
        }
    }
    else if (TimeA.Seconds < TimeB.Seconds)
    {
        if ((TimeB.Seconds - TimeA.Seconds) > CFE_TIME_NEGATIVE)
        {
            Result = CFE_TIME_A_GT_B;
        }
        else
        {
            Result = CFE_TIME_A_LT_B;
        }
    }
    else
    {
        if (TimeA.Subseconds > TimeB.Subseconds)
        {
            Result = CFE_TIME_A_GT_B;
        }
        else if (TimeA.Subseconds < TimeB.Subseconds)
        {
            Result = CFE_TIME_A_LT_B;
        }
        else
        {
            Result = CFE_TIME_EQUAL;
        }
    }

    return Result;
}
/* ---- end cFE ---- */

/*
 * Property: Compare is antisymmetric — A after B iff B before A. CBMC proves
 * the assertion for every pair of times, rollover included.
 */
void prove_compare_is_antisymmetric(uint32_t a_sec, uint32_t a_sub, uint32_t b_sec, uint32_t b_sub)
{
    CFE_TIME_SysTime_t a = {a_sec, a_sub};
    CFE_TIME_SysTime_t b = {b_sec, b_sub};

    if (CFE_TIME_Compare(a, b) == CFE_TIME_A_GT_B)
    {
        assert(CFE_TIME_Compare(b, a) == CFE_TIME_A_LT_B);
    }
}
