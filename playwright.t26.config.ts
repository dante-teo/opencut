import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/desktop',
  testMatch: 't26.perf.ts',
  outputDir: 'test-results/t26',
  timeout: 300000,
  workers: 1,
  reporter: 'list',
});
