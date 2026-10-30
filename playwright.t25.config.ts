import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/desktop',
  testMatch: 't25.perf.ts',
  outputDir: 'test-results/t25',
  timeout: 300000,
  workers: 1,
  reporter: 'list',
});
