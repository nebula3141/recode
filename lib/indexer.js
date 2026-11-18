'use strict';
// Builds and incrementally maintains an index of every Claude Code session on
// this machine, from ~/.claude/projects/*/<sessionId>.jsonl and ~/.claude/history.jsonl.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readLines } = require('./jsonl');
const P = require('./paths');

const INDEX_VERSION = 6;
const INDEX_FILE = path.join(P.DATA_DIR, 'index.json');
const MAX_PROMPTS = 1500;
const MAX_FILES = 400;
const PROMPT_CHARS = 2000;
const NON_PROMPT_ORIGINS = new Set(['task-notification', 'coordinator', 'peer', 'auto-continuation', 'system']);
const NON_PROMPT_TAGS = /^<(local-command-stdout|local-command-stderr|local-command-caveat|task-notification|system-reminder|bash-stdout|bash-stderr|user-memory-input|teammate-message)/;

let gapMs = 15 * 60 * 1000;

const index = {
  v: INDEX_VERSION,
  sessions: {}, // id -> state
  history: { offset: 0, size: 0, entries: [] }, // all prompts from history.jsonl
  rev: 0,
};

let loaded = false;
let scanning = null;
let dirty = false;

function setGapMinutes(m) {
  const n = Number(m);
  if (n >= 1 && n <= 240) gapMs = n * 60 * 1000;
}

function newState(id, file, projectDir) {
  return {
    id, file, projectDir,
    offset: 0, size: 0, mtimeMs: 0,
    cwd: null, lastCwd: null, gitBranch: null, version: null, entrypoint: null,
    models: {}, permissionMode: null,
    customTitle: null, agentName: null, aiTitle: null, lastPrompt: null,
    awaySummary: null, awayTs: null,
    firstTs: null, lastTs: null, lastUserTs: null,
    segments: [], days: {}, hours: {},
    prompts: [], promptTotal: 0, commands: {},
    userMsgs: 0, assistantMsgs: 0, toolUses: 0, tools: {}, errors: 0,
    usage: { in: 0, out: 0, cr: 0, cw: 0 }, pending: null, contextTokens: 0,
    compactions: 0, turnMs: 0, turns: 0,
    files: [], artifacts: [], remoteUrl: null, continuedIn: null,
    linesAdded: 0, linesRemoved: 0, costUSD: 0,
    subagents: 0,
  };
}

function ts(o) {
  if (!o.timestamp) return null;
  const t = typeof o.timestamp === 'number' ? o.timestamp : Date.parse(o.timestamp);
  return Number.isFinite(t) ? t : null;
}

function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addActivity(s, t) {
  if (!t) return;
  if (!s.firstTs || t < s.firstTs) s.firstTs = t;
  if (!s.lastTs || t > s.lastTs) s.lastTs = t;
  const seg = s.segments[s.segments.length - 1];
  if (seg && t >= seg[0] - gapMs && t <= seg[1] + gapMs) {
    if (t > seg[1]) seg[1] = t;
    if (t < seg[0]) seg[0] = t;
  } else {
    s.segments.push([t, t]);
  }
  const k = dayKey(t);
  s.days[k] = (s.days[k] || 0) + 1;
}

function extractPrompt(o) {
  if (o.isMeta || o.isSidechain || o.isCompactSummary || o.isVisibleInTranscriptOnly) return null;
  if (o.origin && o.origin.kind && NON_PROMPT_ORIGINS.has(o.origin.kind)) return null;
  if (o.promptSource === 'system') return null;
  const c = o.message && o.message.content;
  let t = '';
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;
    t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    if (!t && c.some((b) => b && b.type === 'image')) t = '[image]';
  }
  t = (t || '').trim();
  if (!t || NON_PROMPT_TAGS.test(t)) return null;
  if (t.startsWith('[Request interrupted') || t.startsWith('This session is being continued from a previous conversation')) return null;
  const cm = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cm) {
    const name = cm[1].trim();
    const args = ((t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '').trim();
    return { text: (name + (args ? ' ' + args : '')).slice(0, PROMPT_CHARS), cmd: name };
  }
  const bi = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bi) return { text: ('! ' + bi[1].trim()).slice(0, PROMPT_CHARS), cmd: '!' };
  return { text: t.slice(0, PROMPT_CHARS) };
}

function commitPending(s) {
  const p = s.pending;
  if (!p) return;
  s.usage.in += p.in; s.usage.out += p.out; s.usage.cr += p.cr; s.usage.cw += p.cw;
  s.pending = null;
}

function addFile(s, f) {
  if (!f || typeof f !== 'string') return;
  if (s.files.includes(f)) return;
  if (s.files.length >= MAX_FILES) return;
  s.files.push(f);
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function onLine(s, o) {
  const type = o.type;
  if (type === 'user' || type === 'assistant' || type === 'system') {
    if (o.cwd) { if (!s.cwd) s.cwd = o.cwd; s.lastCwd = o.cwd; }
    if (o.gitBranch) s.gitBranch = o.gitBranch;
    if (o.version) s.version = o.version;
    if (o.entrypoint) s.entrypoint = o.entrypoint;
    if (o.permissionMode) s.permissionMode = o.permissionMode;
  }
  switch (type) {
    case 'user': {
      if (o.isSidechain) return;
      const t = ts(o);
      addActivity(s, t);
      s.userMsgs++;
      const p = extractPrompt(o);
      if (p) {
        s.promptTotal++;
        s.lastUserTs = t;
        if (p.cmd) s.commands[p.cmd] = (s.commands[p.cmd] || 0) + 1;
        if (s.prompts.length < MAX_PROMPTS) s.prompts.push({ t: p.text, ts: t, c: p.cmd ? 1 : 0 });
        else s.prompts[s.prompts.length - 1] = { t: p.text, ts: t, c: p.cmd ? 1 : 0 };
        if (t) { const h = new Date(t).getHours(); s.hours[h] = (s.hours[h] || 0) + 1; }
      }
      return;
    }
    case 'assistant': {
      if (o.isSidechain) return;
      addActivity(s, ts(o));
      const m = o.message || {};
      if (o.isApiErrorMessage) s.errors++;
      if (m.model && m.model !== '<synthetic>') s.models[m.model] = (s.models[m.model] || 0) + (s.pending && s.pending.id === m.id ? 0 : 1);
      const u = m.usage;
      if (m.id) {
        if (!s.pending || s.pending.id !== m.id) {
          commitPending(s);
          s.assistantMsgs++;
          s.pending = { id: m.id, in: 0, out: 0, cr: 0, cw: 0 };
        }
        if (u) {
          const p = s.pending;
          p.in = Math.max(p.in, u.input_tokens || 0);
          p.out = Math.max(p.out, u.output_tokens || 0);
          p.cr = Math.max(p.cr, u.cache_read_input_tokens || 0);
          p.cw = Math.max(p.cw, u.cache_creation_input_tokens || 0);
          s.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_use') {
            s.toolUses++;
            s.tools[b.name] = (s.tools[b.name] || 0) + 1;
            if (FILE_TOOLS.has(b.name) && b.input) addFile(s, b.input.file_path || b.input.notebook_path);
          }
        }
      }
      return;
    }
    case 'system': {
      const t = ts(o);
      if (o.subtype === 'away_summary' && o.content) { s.awaySummary = String(o.content).replace(/\s*\((?:disable|turn off) recaps[^)]*\)\s*$/, ''); s.awayTs = t; }
      else if (o.subtype === 'compact_boundary') s.compactions++;
      else if (o.subtype === 'turn_duration') { s.turnMs += o.durationMs || 0; s.turns++; }
      else if (o.subtype === 'bridge_status' && o.url) s.remoteUrl = o.url;
      return;
    }
    case 'custom-title': if (o.customTitle) s.customTitle = o.customTitle; return;
    case 'agent-name': if (o.agentName) s.agentName = o.agentName; return;
    case 'ai-title': if (o.aiTitle) s.aiTitle = o.aiTitle; return;
    case 'last-prompt': if (o.lastPrompt) s.lastPrompt = String(o.lastPrompt).slice(0, PROMPT_CHARS); return;
    case 'permission-mode': if (o.permissionMode) s.permissionMode = o.permissionMode; return;
    case 'bridge-session':
      if (o.bridgeSessionId && !s.remoteUrl) s.remoteUrl = 'https://claude.ai/code/' + String(o.bridgeSessionId).replace(/^cse_/, 'session_');
      return;
    case 'frame-link':
      if (o.frameUrl && !s.artifacts.some((a) => a.url === o.frameUrl)) s.artifacts.push({ url: o.frameUrl, title: o.title || 'Artifact', ts: ts(o) });
      return;
    case 'continued-in': if (o.continuedInSessionId) s.continuedIn = o.continuedInSessionId; return;
    case 'cost-state':
      s.linesAdded = Math.max(s.linesAdded, o.totalLinesAdded || 0);
      s.linesRemoved = Math.max(s.linesRemoved, o.totalLinesRemoved || 0);
      s.costUSD = Math.max(s.costUSD, o.totalCostUSD || 0);
      return;
    case 'file-history-delta':
      if (o.backup && o.backup.realParentDir && o.trackingPath) addFile(s, path.join(o.backup.realParentDir, path.basename(o.trackingPath)));
      return;
    default:
  }
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await fsp.readFile(INDEX_FILE, 'utf8'));
    if (raw && raw.v === INDEX_VERSION) {
      index.sessions = raw.sessions || {};
      index.history = raw.history || index.history;
    }
  } catch { /* first run */ }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fsp.mkdir(P.DATA_DIR, { recursive: true });
      const tmp = INDEX_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify({ v: INDEX_VERSION, sessions: index.sessions, history: index.history }));
      await fsp.rename(tmp, INDEX_FILE);
    } catch (e) { console.error('index save failed:', e.message); }
  }, 1500);
}

async function listTranscripts() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(P.PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
    const dir = path.join(P.PROJECTS_DIR, d.name);
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const subdirs = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name));
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const id = e.name.slice(0, -6);
      const file = path.join(dir, e.name);
      out.push({ id, file, projectDir: d.name, hasSub: subdirs.has(id) });
    }
  }));
  return out;
}

async function countSubagents(file, id) {
  try {
    const ents = await fsp.readdir(path.join(path.dirname(file), id, 'subagents'));
    return ents.filter((n) => n.endsWith('.jsonl')).length;
  } catch { return 0; }
}

async function scanSession(t) {
  let st;
  try { st = await fsp.stat(t.file); } catch { return false; }
  let s = index.sessions[t.id];
  if (s && s.file === t.file && s.size === st.size && s.mtimeMs === st.mtimeMs) return false;
  // Truncated or replaced file -> rebuild from scratch.
  if (!s || s.file !== t.file || st.size < s.offset) s = newState(t.id, t.file, t.projectDir);
  if (st.size > s.offset) {
    s.offset = await readLines(t.file, s.offset, st.size, (o) => onLine(s, o));
  }
  s.size = st.size;
  s.mtimeMs = st.mtimeMs;
  if (t.hasSub) s.subagents = await countSubagents(t.file, t.id);
  index.sessions[t.id] = s;
  return true;
}

async function scanHistory() {
  let st;
  try { st = await fsp.stat(P.HISTORY_FILE); } catch { return false; }
  const h = index.history;
  if (st.size === h.size) return false;
  if (st.size < h.offset) { h.offset = 0; h.entries = []; }
  h.offset = await readLines(P.HISTORY_FILE, h.offset, st.size, (o) => {
    if (!o || typeof o.display !== 'string') return;
    h.entries.push({ t: o.display.slice(0, PROMPT_CHARS), ts: o.timestamp || null, p: o.project || null, s: o.sessionId || null });
  });
  h.size = st.size;
  return true;
}

async function doScan() {
  await load();
  const ts0 = Date.now();
  // The same session id can exist under two project folders (e.g. "E--Proj" and "e--Proj").
  // Keep one deterministically, or the index would rebuild it from scratch on every scan.
  const byId = new Map();
  for (const t of (await listTranscripts()).sort((a, b) => a.file.localeCompare(b.file))) if (!byId.has(t.id)) byId.set(t.id, t);
  const list = [...byId.values()];
  const seen = new Set();
  let changed = false;
  // Small concurrency so huge transcripts don't starve others.
  const queue = list.slice();
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      seen.add(t.id);
      try { if (await scanSession(t)) changed = true; } catch (e) { console.error('scan', t.file, e.message); }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  for (const id of Object.keys(index.sessions)) {
    if (!seen.has(id)) { delete index.sessions[id]; changed = true; }
  }
  if (await scanHistory()) changed = true;
  if (changed) { index.rev++; dirty = true; scheduleSave(); }
  return { changed, ms: Date.now() - ts0 };
}

function scan() {
  if (!scanning) scanning = doScan().finally(() => { scanning = null; });
  return scanning;
}

async function rebuild() {
  await load();
  // Let an in-flight scan finish first, or scan() would hand back that stale run.
  if (scanning) await scanning.catch(() => {});
  index.sessions = {};
  index.history = { offset: 0, size: 0, entries: [] };
  return scan();
}

module.exports = { index, scan, rebuild, setGapMinutes, extractPrompt, dayKey, get dirty() { return dirty; } };
