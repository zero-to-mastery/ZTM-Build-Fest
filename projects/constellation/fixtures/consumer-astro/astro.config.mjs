import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  vite: {
    optimizeDeps: { exclude: ['@constellation/core', '@constellation/core/browser-runtime', '@constellation/web-component'] },
    build: { target: 'esnext' },
  },
});
