#include <stdint.h>

static const uint8_t table[8] = {1, 2, 3, 4, 5, 6, 7, 8};

uint8_t lookup(uint8_t i) { return table[i & 7]; }

int32_t mean(int32_t a, int32_t b) { return (int32_t)(((int64_t)a + b) / 2); }
