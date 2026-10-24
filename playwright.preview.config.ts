import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop',
  testMatch: 'preview.perf.ts',
  outputDir: 'test-results/preview-performance',
  timeout: 180000,
  workers: 1,
  reporter: 'list',
});
