import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Render-door's eslint config — modeled on apps/floatty/eslint.config.js.
// console usage is allowed because the door's components emit diagnostic
// warnings to the floatty webview console (a debugging surface, not a
// production browser console). render.tsx, kanban.test.ts get a more
// permissive scope; the test file gets *.test override.

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Door components legitimately use console for renderer diagnostics
      // (catalog mismatch warnings, missing-prop fallbacks, etc).
      'no-console': 'off',
      // SolidJS convention: prefix unused params with `_` to mark intentional.
      // Honor that convention — default ESLint config errors on _props.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
])
