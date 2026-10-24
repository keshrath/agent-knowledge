import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    setupFiles: ['tests/setup-home.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', 'plugin/**'],
  },
});
