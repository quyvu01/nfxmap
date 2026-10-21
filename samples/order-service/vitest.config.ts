import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

// The tests run against the sources of nfxmap, not its builds; the user service is started from its sources too
export default defineConfig({
    resolve: {
        alias: {
            'nfxmap-grpc': source('nfxmap-grpc/src/index.ts'),
            'nfxmap-typeorm': source('nfxmap-typeorm/src/index.ts'),
            'nfxmap/expressions': source('nfxmap/src/expressions/index.ts'),
            nfxmap: source('nfxmap/src/index.ts'),
        },
    },
});
