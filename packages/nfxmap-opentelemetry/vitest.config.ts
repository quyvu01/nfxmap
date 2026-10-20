import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The tests run against the sources of nfxmap and nfxmap-grpc, not their builds
export default defineConfig({
    resolve: {
        alias: {
            'nfxmap-grpc': fileURLToPath(new URL('../nfxmap-grpc/src/index.ts', import.meta.url)),
            nfxmap: fileURLToPath(new URL('../nfxmap/src/index.ts', import.meta.url)),
        },
    },
});
