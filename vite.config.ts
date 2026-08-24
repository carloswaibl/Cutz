import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Read rather than `import ... from './package.json'`, which would need
// `resolveJsonModule` turned on and would inline the whole manifest into the
// bundle. The version is displayed in two places in the UI; both read this.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
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
