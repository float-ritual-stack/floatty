import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [solid()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        shelf: resolve(__dirname, 'shelf.html'),
      },
    },
  },
})
