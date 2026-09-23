import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev:web` serves the app with hot reload and forwards /api to the
// API server (`npm run dev`, port 3000 unless API_URL says otherwise).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
