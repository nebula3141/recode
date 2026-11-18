'use strict';
// Renders public/icon.svg into build/icon.png and a multi-size build/icon.ico.
// Run with Electron (it provides the SVG renderer): `electron scripts/make-icon.js`
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function ico(pngs) {
  // ICO container with PNG-compressed entries (supported since Windows Vista).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'public', 'icon.svg'), 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  // Draw the SVG onto a canvas at each size; toDataURL keeps real alpha (transparent corners).
  const win = new BrowserWindow({ width: 300, height: 300, show: false });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const svgUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const urls = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(svgUrl)}; await img.decode();
    return ${JSON.stringify(SIZES)}.map((s) => { const c = document.createElement('canvas'); c.width = c.height = s;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, s, s); return c.toDataURL('image/png'); });
  })()`);
  win.destroy();
  const pngs = urls.map((u, i) => ({ size: SIZES[i], buf: Buffer.from(u.split(',')[1], 'base64') }));
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[pngs.length - 1].buf);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(pngs));
  console.log('Wrote build/icon.png and build/icon.ico');
  app.exit(0);
});
