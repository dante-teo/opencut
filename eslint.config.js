import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'test-results/**',
      'conformance-results/**',
      'playwright-report/**',
      'coverage/**',
      'tests/fixtures/generated/**',
      'target/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  { files: ['**/*.js'], languageOptions: { sourceType: 'module' } },
  prettier,
);
