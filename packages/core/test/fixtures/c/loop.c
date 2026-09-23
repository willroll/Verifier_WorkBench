#include <stdint.h>
#include <stddef.h>

static uint8_t table[8];

/* Out of bounds once i >= 8, but only on iterations past a small unwind bound. */
uint8_t lookup_sum(size_t n) {
    uint8_t s = 0;
    for (size_t i = 0; i < n; i++) s += table[i];
    return s;
}
