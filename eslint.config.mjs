import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const baseline = JSON.parse(
  readFileSync(new URL('./eslint-baseline.json', import.meta.url), 'utf8'),
);

export default tseslint.config(
  {
    ignores: ['.context/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/.terraform/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
  // Existing debt remains visible and may not grow. New files keep recommended errors.
  ...Object.entries(baseline).map(([file, rules]) => ({
    files: [file],
    rules: Object.fromEntries(Object.keys(rules).map((rule) => [rule, 'warn'])),
  })),
);
