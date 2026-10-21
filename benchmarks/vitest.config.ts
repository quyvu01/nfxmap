import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(`../packages/nfxmap/src/${path}`, import.meta.url));

// The test runs the code of each benchmark once, against the sources of nfxmap; the benchmarks run its build
export default defineConfig({
    resolve: {
        alias: {
            'nfxmap/expressions': source('expressions/index.ts'),
            nfxmap: source('index.ts'),
        },
    },
});
