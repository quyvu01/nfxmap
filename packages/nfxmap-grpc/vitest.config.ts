import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The tests run against the sources of nfxmap, not its build
export default defineConfig({
    resolve: { alias: { nfxmap: fileURLToPath(new URL('../nfxmap/src/index.ts', import.meta.url)) } },
});
