import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The app ships as static files with no server of any kind, so every asset
  // path must be relative - this lets the same build work on GitHub Pages
  // under a subpath, on Cloudflare Pages at a root, or opened from disk.
  base: './',
  test: {
    globals: true,
    // domain/ and solver/ must stay headless and testable in plain Node.
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    benchmark: {
      include: ['test/**/*.bench.ts'],
    },
  },
});
