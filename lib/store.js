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
};

let state = null;

function defaults() {
  return { settings: { ...DEFAULT_SETTINGS }, sessions: {}, presets: [], launches: [] };
}

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { ...defaults(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
  } catch {
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
  hidePatterns: 'array', editor: 'string',
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

module.exports = { load, updateSettings, updateSessionMeta, savePreset, deletePreset, logLaunch, DEFAULT_SETTINGS };
