import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The tests run against the sources of nfxmap, not its build. graphql-tools goes through Vite too, so that it imports
// the same graphql module as the tests (graphql refuses the types of another copy)
export default defineConfig({
    resolve: { alias: { nfxmap: fileURLToPath(new URL('../nfxmap/src/index.ts', import.meta.url)) } },
    test: { server: { deps: { inline: [/@graphql-tools\//] } } },
});
