/// <reference types="vite/client" />

/**
 * The version from `package.json`, substituted at build time by the `define`
 * in `vite.config.ts`. Single source for every version string the UI shows -
 * see `Header` and `Footer`.
 */
declare const __APP_VERSION__: string;
