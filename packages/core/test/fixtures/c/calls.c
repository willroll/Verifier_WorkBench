#include <stdint.h>
#include <string.h>

static int32_t bump(int32_t x) { return x + 1; }

/* Calls bump but has no obligations of its own. */
int32_t twice(int32_t y) { return bump(bump(y)); }

static char dst[4];

/* memcpy writes 8 bytes into a 4-byte array: the failure is inside library code. */
void fill(void) {
    const char src[8] = "abcdefg";
    memcpy(dst, src, sizeof src);
}

int deref(const int *p) { return *p; }
