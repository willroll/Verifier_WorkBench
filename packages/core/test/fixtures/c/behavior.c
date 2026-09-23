#include <assert.h>
#include <stdint.h>

static int grid[2][3];

/* Writes one cell; the column check is off by one, so c == 3 is out of bounds. */
void put(int r, int c, int v) {
    if (r >= 0 && r < 2 && c >= 0 && c <= 3) grid[r][c] = v;
}

/* The assertion fails for a >= 50. */
int doubled(int a) {
    if (a < 0 || a > 1000) return 0;
    int r = a * 2;
    assert(r < 100);
    return r;
}

/* Exact in IEEE arithmetic, including infinities and NaN. */
float twice(float x) { return x * 2.0f; }

int first(const int *p) { return p[0]; }
