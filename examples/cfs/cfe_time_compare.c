/*
 * Example: a natural-looking spec that CFE_TIME_Compare refutes.
 *
 * CFE_TIME_SysTime_t and CFE_TIME_Compare below are taken verbatim from NASA's
 * Core Flight System (cFE, Apache-2.0) — see examples/cfs/NOTICE. Compare
 * treats time as circular: if two Seconds values differ by more than
 * CFE_TIME_NEGATIVE (0x80000000, ~68 years), it assumes the clock has rolled
 * over and flips the ordering. A consequence is that a time judged "greater"
 * can hold the SMALLER Seconds value.
 *
 * This file shows both outcomes at once, at the default check set:
 *   - the two guarded subtractions inside Compare are PROVED not to underflow;
 *   - the intuitive spec "A_GT_B implies TimeA.Seconds >= TimeB.Seconds" is
 *     REFUTED, and CBMC returns the concrete time pair that breaks it.
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
    CFE_TIME_A_LT_B = -1, /* the first time is before the second */
    CFE_TIME_EQUAL  = 0,
    CFE_TIME_A_GT_B = 1   /* the first time is after the second  */
} CFE_TIME_Compare_t;

#define CFE_TIME_NEGATIVE 0x80000000 /* ~68 years, the rollover threshold */

/* ---- verbatim from cFE modules/time/fsw/src/cfe_time_api.c ---- */
CFE_TIME_Compare_t CFE_TIME_Compare(CFE_TIME_SysTime_t TimeA, CFE_TIME_SysTime_t TimeB)
{
    CFE_TIME_Compare_t Result;

    if (TimeA.Seconds > TimeB.Seconds)
    {
        /*
        ** Assume rollover if difference is too large...
        */
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
        /*
        ** Assume rollover if difference is too large...
        */
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
        /*
        ** Seconds are equal, check sub-seconds
        */
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
 * Intuitive but FALSE: because Compare wraps around at ~68 years, a "greater"
 * time need not have a larger Seconds field. The parameters become the free
 * variables of the search; CBMC returns the pair that violates the assertion.
 */
void assume_gt_means_larger_seconds(uint32_t a_sec, uint32_t a_sub, uint32_t b_sec, uint32_t b_sub)
{
    CFE_TIME_SysTime_t a = {a_sec, a_sub};
    CFE_TIME_SysTime_t b = {b_sec, b_sub};

    if (CFE_TIME_Compare(a, b) == CFE_TIME_A_GT_B)
    {
        assert(a_sec >= b_sec);
    }
}
