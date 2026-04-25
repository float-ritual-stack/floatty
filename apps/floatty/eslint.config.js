import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src-tauri/target', 'docs/archived-doors/**']),
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
      'no-console': ['error'],
      // Honour the standard `_`-prefix convention for intentionally-unused
      // params/vars (callback signatures, hook contracts, etc).
      // Without this, `_event: MouseEvent` in an xterm `activate(ev)` link
      // callback or `_paneId` matching a hook's expected signature gets
      // flagged even though the underscore IS the marker that says
      // "I know it's unused, don't warn me."
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/lib/logger.ts', 'scripts/**', 'doors/**', '.pi/**'],
    rules: {
      'no-console': 'off',
    },
  },
])
