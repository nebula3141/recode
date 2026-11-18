'use strict';
// Builds a standalone Windows app: dist/ReCode-win32-x64/ReCode.exe
const path = require('path');
const { spawnSync } = require('child_process');
const electronBin = require('electron'); // path to the Electron binary

const ROOT = path.join(__dirname, '..');

const r = spawnSync(electronBin, [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit', cwd: ROOT });
if (r.status !== 0) { console.error('Icon generation failed'); process.exit(1); }

(async () => {
  const mod = require('@electron/packager');
  const packager = mod.packager || mod.default || mod;
  const out = await packager({
    dir: ROOT,
    out: path.join(ROOT, 'dist'),
    name: 'ReCode',
    executableName: 'ReCode',
    platform: process.platform,
    arch: process.arch,
    icon: path.join(ROOT, 'build', 'icon.ico'),
    asar: true,
    overwrite: true,
    prune: true,
    ignore: [/^\/dist($|\/)/, /^\/data($|\/)/, /^\/scripts($|\/)/, /^\/\.claude($|\/)/, /^\/\.impeccable($|\/)/, /^\/docs($|\/)/, /^\/README\.md$/, /^\/LICENSE$/],
    win32metadata: { CompanyName: 'ReCode', FileDescription: 'ReCode', ProductName: 'ReCode', InternalName: 'ReCode' },
  });
  console.log('Built:', out.join(', '));
})().catch((e) => { console.error(e); process.exit(1); });
