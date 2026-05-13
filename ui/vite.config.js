import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4567,
    proxy: {
      '/mockcloud': 'http://127.0.0.1:4566',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: { output: { manualChunks: undefined } }
  },
});
