#!/usr/bin/env node
// Sets the version of every published package, and the range each asks of nfxmap, to the version given:
//
//   node scripts/set-version.mjs 0.2.0
//
// The release workflow runs it with the version of the tag; the packages are always released together.
import { publishedPackages, writeManifest } from './packages.mjs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    console.error('Usage: node scripts/set-version.mjs <major>.<minor>.<patch>[-<label>]');
    process.exit(2);
}
const names = new Set(publishedPackages().map(pkg => pkg.manifest.name));
for (const pkg of publishedPackages()) {
    pkg.manifest.version = version;
    for (const field of ['dependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg.manifest[field] ?? {}))
            if (names.has(name)) pkg.manifest[field][name] = `^${version}`;
    }
    writeManifest(pkg);
    console.log(`${pkg.manifest.name} ${version}`);
}
