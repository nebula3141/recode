'use strict';
// ReCode — desktop app entry point (Electron main process).
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// The app was first released as "Claude Launcher"; keep using that folder if it exists
// so pins, notes, settings and window position survive the rename.
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'Claude Launcher');
if (fs.existsSync(LEGACY_USER_DATA)) app.setPath('userData', LEGACY_USER_DATA);

// Keep the launcher's own state in the per-user app data folder (writable when packaged).
process.env.LAUNCHER_DATA_DIR = process.env.LAUNCHER_DATA_DIR || path.join(app.getPath('userData'), 'data');
const service = require('../lib/service');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const STATE_FILE = path.join(app.getPath('userData'), 'window.json');
const TITLEBAR_H = 52;
const argv = process.argv.slice(1);
const arg = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const SHOT = arg('shot'); // --shot=out.png [--route=#/sessions] : render, save a screenshot, exit (used for checks)

if (!SHOT && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
Menu.setApplicationMenu(null);

let win = null;

function readBounds() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* ignore */ }
}

function createWindow() {
  const b = SHOT ? {} : readBounds();
  const [w, h] = (arg('size') || '').split('x').map(Number);
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: w || b.width || 1360,
    height: h || b.height || 880,
    x: b.x, y: b.y,
    minWidth: 880, minHeight: 560,
    title: 'ReCode',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: dark ? '#131210' : '#f5f3ef',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#131210' : '#f5f3ef', symbolColor: dark ? '#b8b1a7' : '#4c4741', height: TITLEBAR_H },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: !SHOT, // hidden screenshot windows must still run animations
    },
  });
  if (b.maximized && !SHOT) win.maximize();

  const route = arg('route');
  win.loadFile(path.join(ROOT, 'public', 'index.html'), {
    ...(route ? { hash: '/' + route.replace(/^#?\/?/, '') } : {}),
    ...(SHOT ? { query: { shot: '1' } } : {}),
  });
  if (!SHOT) win.once('ready-to-show', () => win.show());

  // Links open in the default browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
  });
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });

  if (SHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      // --js=<code> or --js-file=<path>: run in the page before capturing (for checks).
      const js = arg('js-file') ? fs.readFileSync(arg('js-file'), 'utf8') : arg('js');
      if (js) {
        const v = await win.webContents.executeJavaScript(js).catch((e) => 'ERR ' + e.message);
        console.log('js ->', v);
        await new Promise((r) => setTimeout(r, 800));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(SHOT, img.toPNG());
      app.exit(0);
    }, Number(arg('wait') || 2500)));
  }
}

// ---------- IPC ----------

const hooks = {
  pickFolder: async (initial) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for Claude Code',
      defaultPath: initial && fs.existsSync(initial) ? initial : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  quit: () => app.quit(),
};

ipcMain.handle('api', async (_e, req) => {
  try {
    const data = await service.handle(req.method || 'GET', req.path, req.query || {}, req.body || {}, hooks);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: err.status || 500, error: err.message || String(err) };
  }
});
ipcMain.handle('clipboard', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });
ipcMain.on('titlebar', (_e, c) => {
  if (!win || !c || process.platform === 'darwin') return;
  try { win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: TITLEBAR_H }); } catch { /* not supported */ }
  win.setBackgroundColor(c.bg);
});

// ---------- lifecycle ----------

app.on('second-instance', () => {
  if (!app.isReady()) return; // the first window is about to open anyway
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  await service.init();
  createWindow();
  service.startTicker((d) => { if (win && !win.isDestroyed()) win.webContents.send('update', d); });
});

app.on('window-all-closed', () => { service.stopTicker(); app.quit(); });
