import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src-tauri/target']),
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
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/lib/logger.ts', 'scripts/**', 'doors/**', '.pi/**'],
    rules: {
      'no-console': 'off',
    },
  },
])
