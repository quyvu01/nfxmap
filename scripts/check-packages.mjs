#!/usr/bin/env node
// Packs every published package as npm would publish it, checks what each tarball holds, then installs them all in a
// new project and loads each one there, with require and with import, as an application would.
//
//   npm run build && node scripts/check-packages.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedPackages, root } from './packages.mjs';

const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
const work = mkdtempSync(join(tmpdir(), 'nfxmap-packages-'));
const problems = [];
try {
    const tarballs = [];
    for (const pkg of publishedPackages()) {
        const name = pkg.manifest.name;
        const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', work], pkg.dir));
        const files = new Set(packed.files.map(file => file.path));
        const needed = ['package.json', 'README.md', 'LICENSE', 'dist/esm/index.js', 'dist/esm/index.d.ts',
            'dist/cjs/index.js', 'dist/cjs/index.d.ts', 'dist/cjs/package.json'];
        for (const file of needed) if (!files.has(file)) problems.push(`${name} does not hold ${file}`);
        for (const file of files) if (/(^|\/)(src|test)\//.test(file)) problems.push(`${name} holds its ${file}`);
        console.log(`${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1024).toFixed(1)} kB`);
        tarballs.push({ name, path: join(work, packed.filename), exports: Object.keys(pkg.manifest.exports ?? { '.': {} }) });
    }

    // A new project that installs the tarballs, and their peers from the registry
    const app = join(work, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    npm(['install', '--no-audit', '--no-fund', ...tarballs.map(tarball => tarball.path)], app);
    for (const { name, exports } of tarballs) {
        for (const subpath of exports) {
            const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`;
            for (const [how, code] of [
                ['require', `require(${JSON.stringify(specifier)})`],
                ['import', `import(${JSON.stringify(specifier)}).then(m => { if (Object.keys(m).length === 0) process.exit(1) })`],
            ]) {
                try {
                    execFileSync(process.execPath, ['-e', code], { cwd: app, stdio: 'pipe' });
                } catch (error) {
                    problems.push(`${how} of ${specifier} fails: ${String(error.stderr ?? error).split('\n').slice(0, 5).join('\n')}`);
                }
            }
        }
    }
} finally {
    rmSync(work, { recursive: true, force: true });
}
if (problems.length > 0) {
    console.error(`\nThe packages are not ready:\n - ${problems.join('\n - ')}`);
    process.exit(1);
}
console.log('\nEach package holds its builds and loads with require and import.');
