import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/v1': 'http://localhost:3000', '/health': 'http://localhost:3000' } },
  build: { outDir: 'dist' },
});
