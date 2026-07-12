import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
    // Transform SolidJS files
    deps: {
      optimizer: {
        web: {
          include: ['solid-js'],
        },
      },
    },
  },
  resolve: {
    conditions: ['development', 'browser'],
    alias: {
      // Doors import '@floatty/stdlib' as a bare specifier — at runtime the
      // door loader shims it, and compile-door-bundle.mjs keeps it external.
      // Tests import door sources directly, so point it at the real module.
      '@floatty/stdlib': fileURLToPath(new URL('./src/lib/doorStdlib.ts', import.meta.url)),
    },
  },
});
