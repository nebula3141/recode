'use strict';
// Folder autocomplete for the New session dialog.
//   ""            -> recent projects
//   "E:\Proj\Se"  -> subfolders of E:\Proj starting with "Se" (then containing it), projects under it first
//   "E:\Proj\"    -> every subfolder of E:\Proj
//   "~\code"      -> same, from the home folder
//   "insta"       -> projects whose name or path contains every word
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const SKIP = new Set(['$recycle.bin', 'system volume information', 'node_modules', '$windows.~bt', '$windows.~ws', 'config.msi', 'recovery']);
const LIMIT = 40;

const lower = (s) => (IS_WIN ? String(s).toLowerCase() : String(s));
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function looksLikePath(q) {
  return /^[a-zA-Z]:/.test(q) || /^[\\/~.]/.test(q) || /[\\/]/.test(q);
}

function expand(q) {
  let s = q.replace(/^"|"$/g, '');
  if (s === '~' || /^~[\\/]/.test(s)) s = os.homedir() + s.slice(1);
  if (/^[a-zA-Z]:$/.test(s)) s += path.sep; // "E:" -> "E:\" (not "current dir on E:")
  return IS_WIN ? s.replace(/\//g, '\\') : s;
}

async function drives() {
  if (!IS_WIN) return [];
  const out = [];
  await Promise.all('CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (d) => {
    try { await fsp.access(`${d}:\\`); out.push(`${d}:\\`); } catch { /* not mounted */ }
  }));
  return out.sort();
}

// projects: [{ path, name, sessions, lastTs }]
async function completeDir(query, projects) {
  const q = String(query || '').trim();
  const proj = (projects || []).filter((p) => p.path);
  const byPath = new Map(proj.map((p) => [lower(p.path), p]));
  const asItem = (p, kind) => {
    const pr = byPath.get(lower(p));
    return { path: p, name: path.basename(p) || p, kind: pr ? 'project' : kind, sessions: pr ? pr.sessions : 0, lastTs: pr ? pr.lastTs : 0, git: fs.existsSync(path.join(p, '.git')) };
  };

  if (!q) {
    return { items: proj.slice(0, 12).map((p) => asItem(p.path, 'project')), exists: false };
  }

  if (!looksLikePath(q)) {
    const words = lower(q).split(/\s+/).filter(Boolean);
    const hits = proj.filter((p) => { const h = lower(p.name + ' ' + p.path); return words.every((w) => h.includes(w)); });
    hits.sort((a, b) => Number(lower(b.name).startsWith(words[0])) - Number(lower(a.name).startsWith(words[0])) || (b.lastTs || 0) - (a.lastTs || 0));
    const items = hits.slice(0, LIMIT).map((p) => asItem(p.path, 'project'));
    // A lone drive letter also offers that drive.
    if (/^[a-zA-Z]$/.test(q)) for (const d of await drives()) if (lower(d).startsWith(lower(q))) items.unshift({ path: d, name: d, kind: 'drive', sessions: 0, lastTs: 0, git: false });
    return { items, exists: false };
  }

  const full = expand(q);
  const endsWithSep = /[\\/]$/.test(full);
  const parent = endsWithSep ? full : path.dirname(full);
  const prefix = endsWithSep ? '' : path.basename(full);
  const lp = lower(prefix);

  let entries = [];
  try { entries = await fsp.readdir(parent, { withFileTypes: true }); } catch { /* missing or no access */ }
  const dirs = entries.filter((e) => {
    if (!e.isDirectory()) return false; // skips junctions like "My Documents" (Windows reports them as links)
    const n = lower(e.name);
    if (SKIP.has(n)) return false;
    if (n.startsWith('.') && !lp.startsWith('.')) return false; // hidden unless asked for
    return !lp || n.includes(lp);
  }).map((e) => e.name);
  // Prefix matches first, then "contains" matches; alphabetical within each.
  dirs.sort((a, b) => Number(lower(b).startsWith(lp)) - Number(lower(a).startsWith(lp)) || a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const items = [];
  const seen = new Set();
  const push = (p, kind) => { const k = lower(p); if (seen.has(k)) return; seen.add(k); items.push(asItem(p, kind)); };
  // Known projects inside what's typed so far rank first.
  const lfull = lower(full);
  for (const p of proj.filter((x) => lower(x.path).startsWith(lfull) && lower(x.path) !== lfull).slice(0, 6)) push(p.path, 'project');
  for (const d of dirs) { if (items.length >= LIMIT) break; push(path.join(parent, d), 'dir'); }
  return { items: items.slice(0, LIMIT), exists: isDir(full), resolved: full };
}

module.exports = { completeDir };
