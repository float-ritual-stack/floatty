import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      // Reuse catalog/registry/components from the floatty render door
      '@render-door': path.resolve(__dirname, '../floatty/doors/render'),
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
