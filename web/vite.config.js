import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development the API runs on port 3000. We proxy API calls there so
// the React dev server (5173) can talk to it without CORS headaches.
// In production the built assets are served by the Express app itself.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/events': 'http://localhost:3000',
      '/event': 'http://localhost:3000',
      '/control': 'http://localhost:3000',
      '/config': 'http://localhost:3000',
    },
  },
});
