import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['@constellation/core', '@constellation/core/browser-runtime', '@constellation/web-component'] },
});
