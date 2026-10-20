import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The tests run against the sources of nfxmap, not its build
export default defineConfig({
    resolve: {
        alias: [
            { find: /^nfxmap\/expressions$/, replacement: fileURLToPath(new URL('../nfxmap/src/expressions/index.ts', import.meta.url)) },
            { find: /^nfxmap$/, replacement: fileURLToPath(new URL('../nfxmap/src/index.ts', import.meta.url)) },
        ],
    },
});
