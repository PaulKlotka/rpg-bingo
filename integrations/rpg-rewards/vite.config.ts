import { defineConfig } from 'vite';
export default defineConfig({ cacheDir: '.vite-cache', server: { port: 5179, strictPort: true, proxy: {
  '/embeddedApi': { target: 'http://127.0.0.1:5101', rewrite: () => '/demo-rpg-rewards/us-central1/embeddedApi' },
} } });
