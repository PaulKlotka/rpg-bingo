import { defineConfig } from 'vite';
export default defineConfig({ cacheDir: '.vite-cache', server: { strictPort: true }, build: { target: 'es2022' } });
