import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/desktop',
  testMatch: 't21.perf.ts',
  outputDir: 'test-results/t21',
  timeout: 240000,
  workers: 1,
  reporter: 'list',
});
