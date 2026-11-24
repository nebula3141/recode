'use strict';
// Launcher-owned state: settings, per-session pins/notes/tags/aliases, presets,
// launch log. Never writes into ~/.claude.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');

const FILE = path.join(P.DATA_DIR, 'state.json');

const DEFAULT_SETTINGS = {
  claudePath: 'claude',
  terminal: 'wt-tab', // wt-tab | wt-window | console
  shell: 'powershell', // powershell | pwsh
  keepShellOpen: true,
  defaultModel: '',
  defaultPermissionMode: '',
  defaultEffort: '',
  defaultRemoteControl: false,
  gapMinutes: 15,
  theme: 'system', // system | dark | light
  showArchived: true,
  hidePatterns: ['\\AppData\\Local\\Temp\\', '.claude-mem'],
  editor: 'code',
  autoUpdateCheck: true,
  updateChannel: 'auto', // auto (follow the installed version) | stable | rc
  bubble: true,            // floating "needs you" bubble
  bubbleAutoHide: false,   // hide the bubble when nothing needs attention
  bubbleFinished: true,    // also flag sessions that finished working and await your next message
  notifyAttention: false,  // Windows notification when a session starts needing you
  runInBackground: true,   // closing the window keeps ReCode (and the bubble) running in the tray
  startWithWindows: false,
  bubblePos: null,         // { x, y } in screen coordinates
};

let state = null;

function defaults() {
  return { settings: { ...DEFAULT_SETTINGS }, sessions: {}, presets: [], launches: [], recovery: { snapshot: null, dismissed: {} } };
}

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { ...defaults(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }, recovery: { snapshot: null, dismissed: {}, ...(raw.recovery || {}) } };
  } catch (e) {
    // Unreadable (not just missing): keep a copy before the next save replaces it.
    if (e.code !== 'ENOENT') { try { fs.copyFileSync(FILE, `${FILE}.unreadable-${Date.now()}`); } catch { /* ignore */ } }
    state = defaults();
  }
  return state;
}

let saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fsp.mkdir(P.DATA_DIR, { recursive: true });
      await fsp.writeFile(FILE + '.tmp', JSON.stringify(state, null, 2));
      await fsp.rename(FILE + '.tmp', FILE);
    } catch (e) { console.error('state save failed:', e.message); }
  }, 200);
}

const SETTING_TYPES = {
  claudePath: 'string', terminal: ['wt-tab', 'wt-window', 'console'], shell: ['powershell', 'pwsh'],
  keepShellOpen: 'boolean', defaultModel: 'string', defaultPermissionMode: 'string', defaultEffort: 'string',
  defaultRemoteControl: 'boolean', gapMinutes: 'number', theme: ['system', 'dark', 'light'], showArchived: 'boolean',
  hidePatterns: 'array', editor: 'string', autoUpdateCheck: 'boolean', updateChannel: ['auto', 'stable', 'rc'],
  bubble: 'boolean', bubbleAutoHide: 'boolean', bubbleFinished: 'boolean', notifyAttention: 'boolean',
  runInBackground: 'boolean', startWithWindows: 'boolean',
};

function updateSettings(patch) {
  load();
  for (const [k, v] of Object.entries(patch || {})) {
    const t = SETTING_TYPES[k];
    if (!t) continue;
    if (Array.isArray(t)) { if (t.includes(v)) state.settings[k] = v; }
    else if (t === 'array') { if (Array.isArray(v)) state.settings[k] = v.map(String).map((x) => x.trim()).filter(Boolean); }
    else if (typeof v === t) state.settings[k] = t === 'string' ? v.trim() : v;
  }
  save();
  return state.settings;
}

function updateSessionMeta(id, patch) {
  load();
  const cur = state.sessions[id] || {};
  const next = { ...cur };
  if ('pinned' in patch) next.pinned = !!patch.pinned;
  if ('hidden' in patch) next.hidden = !!patch.hidden;
  if ('note' in patch) next.note = String(patch.note || '').slice(0, 5000);
  if ('alias' in patch) next.alias = String(patch.alias || '').slice(0, 200).trim();
  if ('tags' in patch && Array.isArray(patch.tags)) next.tags = [...new Set(patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  for (const k of Object.keys(next)) if (next[k] === '' || next[k] === false || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
  if (Object.keys(next).length) state.sessions[id] = next; else delete state.sessions[id];
  save();
  return state.sessions[id] || {};
}

function savePreset(p) {
  load();
  const preset = {
    id: p.id || crypto.randomBytes(6).toString('hex'),
    label: String(p.label || 'Preset').slice(0, 80),
    opts: p.opts || {},
  };
  const i = state.presets.findIndex((x) => x.id === preset.id);
  if (i >= 0) state.presets[i] = preset; else state.presets.push(preset);
  save();
  return preset;
}

function deletePreset(id) {
  load();
  state.presets = state.presets.filter((p) => p.id !== id);
  save();
}

function logLaunch(entry) {
  load();
  state.launches.unshift({ ...entry, at: Date.now() });
  state.launches = state.launches.slice(0, 200);
  save();
}

function setBubblePos(pos) {
  load();
  state.settings.bubblePos = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: Math.round(pos.x), y: Math.round(pos.y) } : null;
  save();
}

// ---------- crash recovery ----------
// The sessions running right now, kept up to date while ReCode runs. "clean" is set only
// when ReCode quits normally, so an unclean snapshot at startup means ReCode (or the PC)
// went down while those sessions were open.
function setLiveSnapshot(sessions) {
  load();
  state.recovery.snapshot = { at: Date.now(), clean: false, sessions };
  save();
}

function markCleanExit() {
  load();
  if (state.recovery.snapshot) state.recovery.snapshot.clean = true;
  saveNow();
}

function dismissRecovery(keys) {
  load();
  const now = Date.now();
  for (const k of keys) state.recovery.dismissed[k] = now;
  // Forget dismissals older than 30 days.
  for (const [k, t] of Object.entries(state.recovery.dismissed)) if (now - t > 30 * 86400000) delete state.recovery.dismissed[k];
  save();
}

// Synchronous write, for use while the app is quitting.
function saveNow() {
  if (!state) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(P.DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('state save failed:', e.message); }
}

module.exports = { load, updateSettings, updateSessionMeta, savePreset, deletePreset, logLaunch, setBubblePos, setLiveSnapshot, markCleanExit, dismissRecovery, saveNow, DEFAULT_SETTINGS };
