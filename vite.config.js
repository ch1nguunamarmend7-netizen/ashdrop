import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
  // During `npm run dev`, send /api to `wrangler dev` (run `npm run dev:worker` in a second terminal).
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
