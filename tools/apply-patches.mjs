// Dependency-free postinstall patcher — survives `npm install`/`npm ci` on any
// platform. Applies upstream bug fixes npm can't ship us until a fixed release.
//
// Fix #1: next-metadata-route-loader embeds resourcePath inside single-quoted
// generated code via ${JSON.stringify(resourcePath)} — JSON doesn't escape `'`,
// so any project path containing an apostrophe produces a webpack parse error
// on every metadata route (favicon.ico, manifest.ts, opengraph-image…).
// Upstream: unpatched as of next@15.5.4.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let changed = 0;

function patch(rel, pairs) {
    const file = path.join(root, rel);
    if (!existsSync(file)) return; // dep not installed yet — npm will postinstall again on full install
    let src = readFileSync(file, 'utf8');
    let out = src;
    for (const [from, to] of pairs) {
        if (out.includes(from)) out = out.split(from).join(to);
    }
    if (out !== src) {
        writeFileSync(file, out);
        changed++;
        console.log(`[patch] applied → ${rel}`);
    }
}

patch('node_modules/next/dist/build/webpack/loaders/next-metadata-route-loader.js', [
    [
        "throw new Error('Default export is missing in ${JSON.stringify(resourcePath)}')",
        "throw new Error('Default export is missing in ' + ${JSON.stringify(resourcePath)})"
    ],
    [
        "throw new Error('File size for ${imgName} image ${JSON.stringify(resourcePath)} exceeds ${fileSizeLimit}MB. ' +",
        "throw new Error('File size for ${imgName} image ' + ${JSON.stringify(resourcePath)} + ' exceeds ${fileSizeLimit}MB. ' +"
    ]
]);

process.exit(0);
