import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Integration tests shell out to real model checkers; give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
