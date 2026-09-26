/*
 * Example: CFE_TIME_Add proved equal to 64-bit addition.
 *
 * CFE_TIME_SysTime_t and CFE_TIME_Add below are taken verbatim from NASA's
 * Core Flight System (cFE, Apache-2.0) — see examples/cfs/NOTICE. A cFS time
 * is a 64-bit fixed-point count: Seconds in the high 32 bits, Subseconds
 * (units of 2^-32 s) in the low 32. CFE_TIME_Add carries from Subseconds to
 * Seconds by hand. This harness proves that hand-written carry is exactly a
 * single 64-bit addition, for every pair of times.
 *
 * Recommended checks: bounds, pointers, division by zero. Leave overflow
 * checks OFF: cFS time is modular and wraps by contract (~136-year period),
 * so unsigned "overflow" here is defined, intended behaviour, not a defect.
 */
#include <stdint.h>
#include <assert.h>

typedef struct
{
    uint32_t Seconds;
    uint32_t Subseconds;
} CFE_TIME_SysTime_t;

/* ---- verbatim from cFE modules/time/fsw/src/cfe_time_api.c ---- */
CFE_TIME_SysTime_t CFE_TIME_Add(CFE_TIME_SysTime_t Time1, CFE_TIME_SysTime_t Time2)
{
    CFE_TIME_SysTime_t Result;

    Result.Subseconds = Time1.Subseconds + Time2.Subseconds;

    /*
    ** Check for sub-seconds roll-over
    */
    if (Result.Subseconds < Time1.Subseconds)
    {
        Result.Seconds = (Time1.Seconds + Time2.Seconds) + 1;
    }
    else
    {
        Result.Seconds = Time1.Seconds + Time2.Seconds;
    }

    return Result;
}
/* ---- end cFE ---- */

/* The same time viewed as one 64-bit value, high 32 bits = Seconds. */
static uint64_t as_u64(CFE_TIME_SysTime_t t)
{
    return ((uint64_t)t.Seconds << 32) | t.Subseconds;
}

/*
 * Property: for all inputs, CFE_TIME_Add equals 64-bit addition of the two
 * fixed-point values (mod 2^64). The parameters become the proof's free
 * variables; CBMC proves the assertion holds for every assignment.
 */
void prove_add_is_64bit_addition(uint32_t a_sec, uint32_t a_sub, uint32_t b_sec, uint32_t b_sub)
{
    CFE_TIME_SysTime_t a = {a_sec, a_sub};
    CFE_TIME_SysTime_t b = {b_sec, b_sub};

    CFE_TIME_SysTime_t r = CFE_TIME_Add(a, b);

    assert(as_u64(r) == (uint64_t)(as_u64(a) + as_u64(b)));
}
