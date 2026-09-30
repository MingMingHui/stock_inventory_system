import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the site from /<repository>/. VITE_BASE_PATH overrides it
// (e.g. "/" for a custom domain). Local development always uses "/".
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? (process.env.VITE_BASE_PATH ?? '/stock_inventory_system/') : '/',
  build: {
    sourcemap: false,
  },
}));
