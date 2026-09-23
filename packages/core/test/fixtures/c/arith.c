#include <stdint.h>

/* Return the mean of two signed 32-bit integers. */
int32_t avg(int32_t a, int32_t b) {
    return (a + b) / 2;
}

static uint8_t buf[16];

void store(uint8_t idx, uint8_t v)
{
    if (idx <= 16) {
        buf[idx] = v;
    }
}

int32_t clamp(int32_t x, int32_t lo, int32_t hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}
