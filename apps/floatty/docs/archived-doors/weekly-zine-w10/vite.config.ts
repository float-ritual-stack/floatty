import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // When behind portless proxy, HMR WebSocket needs to connect
    // to the underlying vite server, not the proxy hostname
    hmr: {
      protocol: 'ws',
      host: 'localhost',
    },
  },
});
