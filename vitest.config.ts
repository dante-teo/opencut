import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'tests/fixtures/generated/**'],
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
