'use strict';
// Builds the release artifacts into release/<version>/:
//   ReCode-Setup-<version>.exe     per-user installer (Start menu + Desktop shortcuts, uninstaller)
//   ReCode-<version>-win-x64.zip   portable build, used by install.ps1
//   install.ps1 / uninstall.ps1    one-command install from GitHub Releases
//   SHA256SUMS.txt                 checksums for everything above
// Usage: npm run release
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { version } = require(path.join(ROOT, 'package.json'));
const OUT = path.join(ROOT, 'release', version);
const run = (cmd, args, shell = false) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell });

console.log(`Building ReCode ${version}`);
run(require('electron'), [path.join('scripts', 'make-icon.js')]);
fs.rmSync(OUT, { recursive: true, force: true });
run('npx', ['electron-builder', '--win', '--x64', '--publish', 'never'], process.platform === 'win32'); // npx is a .cmd shim

for (const f of ['install.ps1', 'uninstall.ps1']) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));

const assets = fs.readdirSync(OUT).filter((f) => /\.(exe|zip|ps1)$/.test(f)).sort();
const sums = assets.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, f))).digest('hex')}  ${f}`);
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

console.log(`\nRelease files in ${OUT}:`);
for (const f of [...assets, 'SHA256SUMS.txt']) console.log(`  ${f}  (${(fs.statSync(path.join(OUT, f)).size / 1048576).toFixed(1)} MB)`);
