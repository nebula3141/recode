'use strict';
// ReCode — desktop app entry point (Electron main process).
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Menu, Tray, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// The app was first released as "Claude Launcher"; keep using that folder if it exists
// so pins, notes, settings and window position survive the rename.
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'Claude Launcher');
if (process.env.RECODE_USER_DATA) app.setPath('userData', process.env.RECODE_USER_DATA); // isolated profile for tests
else if (fs.existsSync(LEGACY_USER_DATA)) app.setPath('userData', LEGACY_USER_DATA);

// Keep the launcher's own state in the per-user app data folder (writable when packaged).
process.env.LAUNCHER_DATA_DIR = (!process.env.RECODE_USER_DATA && process.env.LAUNCHER_DATA_DIR) || path.join(app.getPath('userData'), 'data');
const service = require('../lib/service');
const store = require('../lib/store');
const bubble = require('./bubble');

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
let tray = null;
let quitting = false;
let trayHintShown = false;
const START_HIDDEN = argv.includes('--hidden'); // started with Windows: tray + bubble only
const settings = () => store.load().settings;

function readBounds() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch { /* ignore */ }
}

function createWindow(opts = {}) {
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
  if (!SHOT && !opts.hidden) win.once('ready-to-show', () => win.show());

  // Links open in the default browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) { win.webContents.reload(); e.preventDefault(); }
  });
  win.on('close', (e) => {
    saveBounds();
    // With "run in background" on, closing hides the window; ReCode stays in the tray.
    if (!quitting && !SHOT && settings().runInBackground) {
      e.preventDefault();
      win.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({ title: 'ReCode is still running', body: 'It keeps watching your Claude Code sessions. Open or quit it from the tray icon.', silent: true }).show();
      }
    }
  });
  win.on('closed', () => { win = null; if (!quitting && !SHOT && !settings().runInBackground) app.quit(); });

  if (SHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      // --js=<code> or --js-file=<path>: run in the page before capturing (for checks).
      const js = arg('js-file') ? fs.readFileSync(arg('js-file'), 'utf8') : arg('js');
      if (js) {
        const v = await win.webContents.executeJavaScript(js).catch((e) => 'ERR ' + e.message);
        console.log('js ->', v);
        await new Promise((r) => setTimeout(r, 800));
      }
      win.webContents.invalidate(); // hidden windows may not have repainted since the script ran
      await new Promise((r) => setTimeout(r, 300));
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
  openExternal: (url) => { if (url.startsWith('https://')) shell.openExternal(url); },
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

function showMain(route) {
  if (!win || win.isDestroyed()) createWindow({ hidden: false });
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route) {
    const go = () => win.webContents.executeJavaScript('location.hash = ' + JSON.stringify('#/' + route)).catch(() => {});
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go); else go();
  }
}

app.on('second-instance', () => {
  if (!app.isReady()) return; // the first window is about to open anyway
  showMain();
});

// ---------- tray, bubble, notifications ----------

// Settings changed from the tray: apply them and refresh the open window.
function setFromTray(patch) {
  applySettings(store.updateSettings(patch));
  if (win && !win.isDestroyed()) win.webContents.send('update', { rev: 'settings-' + Date.now() });
}

function trayMenu() {
  const st = settings();
  return Menu.buildFromTemplate([
    { label: 'Open ReCode', click: () => showMain() },
    { type: 'separator' },
    { label: 'Show attention bubble', type: 'checkbox', checked: st.bubble, click: (i) => setFromTray({ bubble: i.checked }) },
    { label: 'Hide bubble when nothing needs me', type: 'checkbox', checked: st.bubbleAutoHide, click: (i) => setFromTray({ bubbleAutoHide: i.checked }) },
    { label: 'Notify me when a session needs me', type: 'checkbox', checked: st.notifyAttention, click: (i) => setFromTray({ notifyAttention: i.checked }) },
    { type: 'separator' },
    { label: 'Quit ReCode', click: () => app.quit() },
  ]);
}

function ensureTray() {
  // Also whenever ReCode starts hidden with Windows: the tray is then the only way in.
  const want = settings().runInBackground || settings().bubble || settings().startWithWindows || START_HIDDEN;
  if (want && !tray) {
    const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip('ReCode');
    tray.on('click', () => showMain());
  }
  if (!want && tray) { tray.destroy(); tray = null; }
  if (tray) tray.setContextMenu(trayMenu());
}

async function openAttention(item) {
  // Bring its terminal tab forward; if that isn't possible, show it in ReCode.
  const r = await service.focusLive(item.sessionId).catch(() => 'none');
  if (r === 'none') showMain('sessions/' + item.sessionId);
}

let lastAttention = [];
function onAttention(items) {
  const st = settings();
  const shown = st.bubbleFinished ? items : items.filter((i) => i.kind === 'waiting');
  bubble.update({ items: shown, autoHide: st.bubbleAutoHide });
  if (tray) tray.setToolTip(shown.length ? 'ReCode: ' + shown.length + (shown.length === 1 ? ' session needs you' : ' sessions need you') : 'ReCode');
  if (st.notifyAttention && Notification.isSupported()) {
    const before = new Set(lastAttention.filter((i) => i.kind === 'waiting').map((i) => i.sessionId));
    for (const i of items) {
      if (i.kind !== 'waiting' || before.has(i.sessionId)) continue;
      const n = new Notification({ title: 'Claude needs you', body: i.title + (i.waitingFor ? ' — ' + i.waitingFor : '') });
      n.on('click', () => openAttention(i));
      n.show();
    }
  }
  lastAttention = items;
}

function applySettings(st) {
  if (SHOT) return;
  if (st.bubble) {
    bubble.create({
      hooks: {
        getPos: () => settings().bubblePos,
        savePos: (p) => store.setBubblePos(p),
        onPick: openAttention,
        onOpenApp: () => showMain(),
        onMenu: (w) => trayMenu().popup({ window: w }),
      },
    });
    if (!st.bubblePos) bubble.moveTo(null);
    onAttention(lastAttention);
  } else bubble.destroy();
  ensureTray();
  if (app.isPackaged && process.platform === 'win32') {
    try { app.setLoginItemSettings({ openAtLogin: !!st.startWithWindows, args: ['--hidden'] }); } catch { /* not allowed */ }
  }
}
hooks.onSettings = applySettings;

// Checks GitHub for a newer release shortly after start and every 6 hours, if enabled.
// The ticker notices a new version and tells the window.
function scheduleUpdateChecks() {
  if (SHOT) return;
  const run = () => {
    const st = require('../lib/store').load().settings;
    if (st.autoUpdateCheck) service.updater.check(st.updateChannel).catch(() => {});
  };
  setTimeout(run, 15000);
  setInterval(run, 6 * 3600 * 1000);
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('io.github.nebula3141.recode'); // notifications + taskbar identity
  service.updater.configure({ version: app.getVersion(), exePath: process.execPath, packaged: app.isPackaged });
  await service.init();
  createWindow({ hidden: START_HIDDEN });
  service.startTicker((d) => {
    if (win && !win.isDestroyed()) win.webContents.send('update', d);
    if (d.attention) onAttention(d.attention);
  });
  applySettings(settings());
  if (!SHOT) setTimeout(() => service.warmUpFocus(), 3000); // so the first bubble click is instant
  scheduleUpdateChecks();
});

app.on('before-quit', () => { quitting = true; if (!SHOT) service.shutdown(); });
app.on('window-all-closed', () => { if (quitting || SHOT || !settings().runInBackground) app.quit(); });
