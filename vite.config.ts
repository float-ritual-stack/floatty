import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// https://vite.dev/config/
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5188,
    strictPort: true, // fail if port is in use instead of trying another
  },
})
