#include <stdint.h>

/* The design prototype's "verified" fix: still overflows (b - a, and the add). */
int32_t avg_design(int32_t a, int32_t b) {
    return a + (b - a) / 2;
}

/* Widening keeps (a + b) / 2's exact results and cannot overflow. */
int32_t avg_widened(int32_t a, int32_t b) {
    return (int32_t)(((int64_t)a + b) / 2);
}

static uint8_t buf[16];

void store_fixed(uint8_t idx, uint8_t v)
{
    if (idx < 16) {
        buf[idx] = v;
    }
}
