// The packages published to npm: each folder of packages/, nfxmap first, as the others depend on it.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));

export function publishedPackages() {
    return readdirSync(join(root, 'packages'), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const dir = join(root, 'packages', entry.name);
            const file = join(dir, 'package.json');
            return { dir, file, manifest: JSON.parse(readFileSync(file, 'utf8')) };
        })
        .filter(pkg => !pkg.manifest.private)
        .sort((a, b) => (a.manifest.name === 'nfxmap' ? -1 : b.manifest.name === 'nfxmap' ? 1
            : a.manifest.name.localeCompare(b.manifest.name)));
}

export function writeManifest(pkg) {
    writeFileSync(pkg.file, JSON.stringify(pkg.manifest, null, 2) + '\n');
}
