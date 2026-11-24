'use strict';
// The floating "needs you" bubble: a small always-on-top window that never takes focus
// unless its list is open. It shows how many Claude Code sessions are blocked on you
// (permission prompts, dialogs) or have finished and await your next message.
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const SIZE = 64;          // collapsed window (bubble plus room for its shadow and badge)
const LIST_W = 320;       // expanded list
const ROW_H = 54;
const LIST_PAD = 58;      // header + padding
const MARGIN = 12;

let win = null;
let expanded = false;
let state = { items: [], autoHide: false };
let hooks = {};           // { onPick(item), onOpenApp(), onMenu(), savePos({x,y}), getPos() }
let anchor = { x: 0, y: 0 }; // top-left of the collapsed bubble in screen coordinates

function workAreaFor(pt) { return screen.getDisplayNearestPoint(pt).workArea; }

function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - SIZE - MARGIN, y: wa.y + Math.round(wa.height * 0.62) };
}

function clampPos(p) {
  const wa = workAreaFor({ x: p.x + SIZE / 2, y: p.y + SIZE / 2 });
  return { x: Math.min(Math.max(p.x, wa.x), wa.x + wa.width - SIZE), y: Math.min(Math.max(p.y, wa.y), wa.y + wa.height - SIZE) };
}

// Where the expanded list goes: it grows away from the nearest screen edges, so the bubble
// itself never moves.
function expandedBounds() {
  const wa = workAreaFor({ x: anchor.x + SIZE / 2, y: anchor.y + SIZE / 2 });
  const h = Math.min(LIST_PAD + Math.max(1, state.items.length) * ROW_H + 8, wa.height - 2 * MARGIN);
  const right = anchor.x + SIZE / 2 > wa.x + wa.width / 2;
  const bottom = anchor.y + SIZE / 2 > wa.y + wa.height / 2;
  let x = right ? anchor.x + SIZE - LIST_W : anchor.x;
  let y = bottom ? anchor.y + SIZE - h : anchor.y;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - LIST_W);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
  return { bounds: { x, y, width: LIST_W, height: h }, right, bottom };
}

function send() {
  if (!win || win.isDestroyed()) return;
  const layout = expanded ? expandedBounds() : null;
  win.webContents.send('bubble:state', { ...state, expanded, right: layout ? layout.right : false, bottom: layout ? layout.bottom : false });
}

function applyVisibility() {
  if (!win || win.isDestroyed()) return;
  const show = expanded || !state.autoHide || state.items.length > 0;
  if (show && !win.isVisible()) win.showInactive();
  if (!show && win.isVisible()) win.hide();
}

function setExpanded(on) {
  if (!win || win.isDestroyed()) return;
  expanded = !!on;
  if (expanded) {
    const { bounds } = expandedBounds();
    win.setBounds(bounds);
    win.setFocusable(true);
    win.focus(); // so a click elsewhere (blur) closes the list
  } else {
    win.setBounds({ x: anchor.x, y: anchor.y, width: SIZE, height: SIZE });
    win.setFocusable(false);
  }
  send();
  applyVisibility();
}

function create(opts) {
  hooks = opts.hooks || {};
  if (win && !win.isDestroyed()) return win;
  const saved = hooks.getPos && hooks.getPos();
  anchor = clampPos(saved || defaultPos());
  win = new BrowserWindow({
    x: anchor.x, y: anchor.y, width: SIZE, height: SIZE,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: false,
    backgroundColor: '#00000000', title: 'ReCode bubble',
    webPreferences: { preload: path.join(__dirname, 'bubble-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'public', 'bubble.html'));
  win.webContents.once('did-finish-load', () => { send(); applyVisibility(); });
  win.on('blur', () => { if (expanded) setExpanded(false); });
  win.on('closed', () => { win = null; expanded = false; });
  // Keep it on screen if displays change.
  const refit = () => { anchor = clampPos(anchor); if (!expanded && win) win.setBounds({ ...anchor, width: SIZE, height: SIZE }); };
  screen.on('display-metrics-changed', refit);
  screen.on('display-removed', refit);
  return win;
}

// Moves the bubble (null = back to the default spot).
function moveTo(pos) {
  anchor = clampPos(pos || defaultPos());
  if (win && !win.isDestroyed()) { if (expanded) setExpanded(false); win.setBounds({ ...anchor, width: SIZE, height: SIZE }); }
}

function destroy() { if (win && !win.isDestroyed()) win.destroy(); win = null; expanded = false; }

function update(next) {
  state = { ...state, ...next };
  if (expanded && !state.items.length) { setExpanded(false); return; }
  if (expanded) { const { bounds } = expandedBounds(); win.setBounds(bounds); }
  send();
  applyVisibility();
}

// ---------- IPC from the bubble page ----------
let drag = null;
ipcMain.on('bubble:drag-start', (e, p) => { if (win && e.sender === win.webContents) drag = { sx: p.x, sy: p.y, ax: anchor.x, ay: anchor.y }; });
ipcMain.on('bubble:drag-move', (e, p) => {
  if (!drag || !win || e.sender !== win.webContents || expanded) return;
  anchor = clampPos({ x: drag.ax + (p.x - drag.sx), y: drag.ay + (p.y - drag.sy) });
  win.setBounds({ ...anchor, width: SIZE, height: SIZE });
});
ipcMain.on('bubble:drag-end', (e) => {
  if (!drag || !win || e.sender !== win.webContents) return;
  drag = null;
  // Snap to the nearest side edge, like a chat head.
  const wa = workAreaFor({ x: anchor.x + SIZE / 2, y: anchor.y + SIZE / 2 });
  anchor = clampPos({ x: anchor.x + SIZE / 2 < wa.x + wa.width / 2 ? wa.x + MARGIN : wa.x + wa.width - SIZE - MARGIN, y: anchor.y });
  win.setBounds({ ...anchor, width: SIZE, height: SIZE });
  if (hooks.savePos) hooks.savePos(anchor);
});
ipcMain.on('bubble:click', (e) => {
  if (!win || e.sender !== win.webContents) return;
  const items = state.items;
  if (!items.length) { if (hooks.onOpenApp) hooks.onOpenApp(); return; }
  if (items.length === 1) { if (hooks.onPick) hooks.onPick(items[0]); return; }
  setExpanded(!expanded);
});
ipcMain.on('bubble:pick', (e, sessionId) => {
  if (!win || e.sender !== win.webContents) return;
  const item = state.items.find((i) => i.sessionId === sessionId);
  setExpanded(false);
  if (item && hooks.onPick) hooks.onPick(item);
});
ipcMain.on('bubble:open-app', (e) => { if (win && e.sender === win.webContents) { setExpanded(false); if (hooks.onOpenApp) hooks.onOpenApp(); } });
ipcMain.on('bubble:collapse', (e) => { if (win && e.sender === win.webContents) setExpanded(false); });
ipcMain.on('bubble:menu', (e) => { if (win && e.sender === win.webContents && hooks.onMenu) hooks.onMenu(win); });

module.exports = { create, destroy, update, moveTo, get window() { return win; } };
