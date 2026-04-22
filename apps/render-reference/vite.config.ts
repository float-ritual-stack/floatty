import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      // Render-door source now lives as its own workspace package
      // (@floatty/render-door). Alias kept for import-path stability —
      // existing specs use '@render-door/catalog' etc., and swapping to
      // '@floatty/render-door/catalog' everywhere is pure churn. The
      // workspace dependency is declared in package.json so pnpm knows
      // about the relationship; this alias just gives vite the on-disk
      // path for its module resolver.
      '@render-door': path.resolve(__dirname, '../../packages/render-door/src'),
    },
    // Force single instance — @json-render/solid's StateContext must be one
    // identity or useStateStore() throws across component boundaries
    // (e.g. Renderer vs JsonRenderDevtools).
    dedupe: ['solid-js', '@json-render/solid', '@json-render/core'],
  },
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
