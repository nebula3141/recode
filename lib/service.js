'use strict';
// Core service for the desktop app: derived views over the session index, plus a
// small request router the renderer calls over IPC. No network server.
const fs = require('fs');
const path = require('path');

const P = require('./paths');
const indexer = require('./indexer');
const live = require('./live');
const store = require('./store');
const launcher = require('./launch');
const { readTranscript } = require('./transcript');

// ---------- derived views over the index ----------

const norm = (p) => (p ? path.resolve(p).replace(/[\\/]+$/, '') : '');
const key = (p) => (process.platform === 'win32' ? norm(p).toLowerCase() : norm(p));
const existsCache = new Map();
function dirInfo(p) {
  const k = key(p);
  const hit = existsCache.get(k);
  if (hit && Date.now() - hit.at < 60000) return hit;
  let exists = false; let git = false; let claudeMd = false;
  try { exists = fs.statSync(p).isDirectory(); } catch { /* gone */ }
  if (exists) {
    git = fs.existsSync(path.join(p, '.git'));
    claudeMd = fs.existsSync(path.join(p, 'CLAUDE.md')) || fs.existsSync(path.join(p, '.claude', 'CLAUDE.md'));
  }
  const v = { at: Date.now(), exists, git, claudeMd };
  existsCache.set(k, v);
  return v;
}

function activeMs(segs) {
  let t = 0;
  for (const [a, b] of segs || []) t += Math.max(b - a, 60 * 1000); // a burst counts as at least a minute
  return t;
}

function tokens(s) {
  const u = { ...s.usage };
  if (s.pending) { u.in += s.pending.in; u.out += s.pending.out; u.cr += s.pending.cr; u.cw += s.pending.cw; }
  return u;
}

function topModel(models) {
  let best = null; let n = -1;
  for (const [m, c] of Object.entries(models || {})) if (c > n) { best = m; n = c; }
  return best;
}

function firstRealPrompt(prompts) {
  const p = (prompts || []).find((x) => !x.c);
  return p ? p.t : (prompts && prompts[0] ? prompts[0].t : null);
}

function lastRealPrompt(prompts) {
  for (let i = (prompts || []).length - 1; i >= 0; i--) if (!prompts[i].c) return prompts[i];
  return null;
}

function summarize(s, meta, continuedFrom) {
  const lp = lastRealPrompt(s.prompts);
  return {
    id: s.id,
    archived: false,
    title: meta.alias || s.customTitle || s.agentName || s.aiTitle || (firstRealPrompt(s.prompts) || '').slice(0, 90) || 'Untitled session',
    aiTitle: s.aiTitle, customTitle: s.customTitle, agentName: s.agentName,
    cwd: s.cwd || s.lastCwd, lastCwd: s.lastCwd,
    projectKey: key(s.cwd || s.lastCwd || s.projectDir),
    gitBranch: s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : null,
    version: s.version, entrypoint: s.entrypoint, permissionMode: s.permissionMode,
    firstTs: s.firstTs, lastTs: s.lastTs || s.mtimeMs, lastUserTs: s.lastUserTs,
    activeMs: activeMs(s.segments), segments: s.segments,
    prompts: s.promptTotal, userMsgs: s.userMsgs, assistantMsgs: s.assistantMsgs, toolUses: s.toolUses,
    tokens: tokens(s), contextTokens: s.contextTokens, model: topModel(s.models),
    firstPrompt: (firstRealPrompt(s.prompts) || '').slice(0, 400),
    lastPrompt: ((lp && lp.t) || s.lastPrompt || '').slice(0, 400),
    awaySummary: s.awaySummary, awayTs: s.awayTs,
    compactions: s.compactions, subagents: s.subagents, errors: s.errors,
    remoteUrl: s.remoteUrl, continuedIn: s.continuedIn, continuedFrom: continuedFrom || null,
    linesAdded: s.linesAdded, linesRemoved: s.linesRemoved,
    files: s.files.length, artifacts: s.artifacts.length,
    size: s.size,
    pinned: !!meta.pinned, hidden: !!meta.hidden, note: meta.note || '', tags: meta.tags || [], alias: meta.alias || '',
  };
}

function archivedSessions(knownIds, metaAll) {
  const groups = new Map();
  for (const e of indexer.index.history.entries) {
    if (!e.s || knownIds.has(e.s)) continue;
    let g = groups.get(e.s);
    if (!g) { g = { id: e.s, cwd: e.p, prompts: [] }; groups.set(e.s, g); }
    g.prompts.push(e);
  }
  const out = [];
  const gap = 15 * 60 * 1000;
  for (const g of groups.values()) {
    const ts = g.prompts.map((p) => p.ts).filter(Boolean).sort((a, b) => a - b);
    const segs = [];
    for (const t of ts) { const l = segs[segs.length - 1]; if (l && t - l[1] <= gap) l[1] = t; else segs.push([t, t]); }
    const real = g.prompts.filter((p) => !p.t.startsWith('/') && !/^(exit|quit|clear)$/i.test(p.t.trim()));
    if (!real.length) continue; // only slash commands (e.g. a /resume picker) — not a real session
    const meta = metaAll[g.id] || {};
    out.push({
      id: g.id, archived: true,
      title: meta.alias || ((real[0] || g.prompts[0]).t || 'Untitled').slice(0, 90),
      cwd: g.cwd, lastCwd: g.cwd, projectKey: key(g.cwd),
      firstTs: ts[0] || null, lastTs: ts[ts.length - 1] || null, lastUserTs: ts[ts.length - 1] || null,
      activeMs: activeMs(segs), segments: segs,
      prompts: g.prompts.length, userMsgs: g.prompts.length, assistantMsgs: 0, toolUses: 0,
      tokens: { in: 0, out: 0, cr: 0, cw: 0 }, contextTokens: 0, model: null,
      firstPrompt: ((real[0] || g.prompts[0]).t || '').slice(0, 400),
      lastPrompt: ((real[real.length - 1] || g.prompts[g.prompts.length - 1]).t || '').slice(0, 400),
      files: 0, artifacts: 0, compactions: 0, subagents: 0,
      pinned: !!meta.pinned, hidden: !!meta.hidden, note: meta.note || '', tags: meta.tags || [], alias: meta.alias || '',
    });
  }
  return out;
}

function buildSessions() {
  const metaAll = store.load().sessions;
  const all = Object.values(indexer.index.sessions);
  const from = {};
  for (const s of all) if (s.continuedIn) from[s.continuedIn] = s.id;
  // Skip transcripts with no conversation at all (e.g. a session opened and closed immediately).
  const list = all.filter((s) => s.userMsgs + s.assistantMsgs > 0).map((s) => summarize(s, metaAll[s.id] || {}, from[s.id]));
  const ids = new Set(all.map((s) => s.id));
  const archived = archivedSessions(ids, metaAll);
  return list.concat(archived).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

// ~/.claude.json can be hundreds of KB; re-parse it only when it changes.
let knownProjects = { mtimeMs: -1, list: [] };
function readKnownProjects() {
  try {
    const st = fs.statSync(P.CLAUDE_JSON);
    if (st.mtimeMs !== knownProjects.mtimeMs) {
      const j = JSON.parse(fs.readFileSync(P.CLAUDE_JSON, 'utf8'));
      knownProjects = { mtimeMs: st.mtimeMs, list: Object.keys(j.projects || {}).map((p) => norm(p)) };
    }
  } catch { /* missing or mid-write: keep the last good list */ }
  return knownProjects.list;
}

function buildProjects(sessions, liveList) {
  const map = new Map();
  const ensure = (p) => {
    const k = key(p);
    if (!k) return null;
    let pr = map.get(k);
    if (!pr) { pr = { key: k, path: norm(p), name: path.basename(norm(p)) || norm(p), sessions: 0, resumable: 0, lastTs: 0, firstTs: 0, activeMs: 0, tokens: 0, prompts: 0, live: 0, lastSessionId: null }; map.set(k, pr); }
    return pr;
  };
  for (const s of sessions) {
    const pr = ensure(s.cwd);
    if (!pr) continue;
    pr.sessions++;
    if (!s.archived) pr.resumable++;
    if ((s.lastTs || 0) > pr.lastTs) { pr.lastTs = s.lastTs; pr.path = norm(s.cwd); if (!s.archived) pr.lastSessionId = s.id; }
    if (!pr.lastSessionId && !s.archived) pr.lastSessionId = s.id;
    if (s.firstTs && (!pr.firstTs || s.firstTs < pr.firstTs)) pr.firstTs = s.firstTs;
    pr.activeMs += s.activeMs || 0;
    pr.tokens += (s.tokens.out || 0) + (s.tokens.in || 0) + (s.tokens.cw || 0);
    pr.prompts += s.prompts || 0;
  }
  for (const l of liveList) { const pr = ensure(l.cwd); if (pr) pr.live++; }
  for (const p of readKnownProjects()) ensure(p);
  for (const e of indexer.index.history.entries) if (e.p) { const pr = ensure(e.p); if (pr && e.ts > pr.lastTs && !pr.sessions) pr.lastTs = e.ts; }
  const out = [...map.values()];
  for (const pr of out) Object.assign(pr, (({ exists, git, claudeMd }) => ({ exists, git, claudeMd }))(dirInfo(pr.path)));
  return out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

function buildActivity(sessions) {
  const days = {};
  const hours = new Array(24).fill(0);
  const tools = {};
  const models = {};
  for (const s of Object.values(indexer.index.sessions)) {
    for (const [d, n] of Object.entries(s.days)) days[d] = (days[d] || 0) + n;
    for (const [h, n] of Object.entries(s.hours || {})) hours[h] += n;
    for (const [t, n] of Object.entries(s.tools || {})) tools[t] = (tools[t] || 0) + n;
    for (const [m, n] of Object.entries(s.models || {})) models[m] = (models[m] || 0) + n;
  }
  // Prompt history covers sessions whose transcripts were cleaned up.
  const histDays = {};
  for (const e of indexer.index.history.entries) if (e.ts) { const d = indexer.dayKey(e.ts); histDays[d] = (histDays[d] || 0) + 1; }
  return { days, histDays, hours, tools, models };
}

let liveCache = { at: 0, list: [] };
async function getLive() {
  if (Date.now() - liveCache.at < 1500) return liveCache.list;
  liveCache = { at: Date.now(), list: await live.liveSessions() };
  return liveCache.list;
}

async function fullState() {
  await indexer.scan();
  const liveList = await getLive();
  const sessions = buildSessions();
  const st = store.load();
  return {
    sessions,
    live: liveList,
    projects: buildProjects(sessions, liveList),
    activity: buildActivity(sessions),
    settings: st.settings,
    presets: st.presets,
    launches: st.launches.slice(0, 30),
    meta: {
      rev: indexer.index.rev,
      claudeDir: P.CLAUDE_DIR,
      // Cached per command; never hold up the UI for more than a moment.
      claudeVersion: await Promise.race([launcher.getClaudeVersion(st.settings.claudePath), new Promise((r) => setTimeout(() => r(null), 1500))]),
      historyCount: indexer.index.history.entries.length,
      tools: { wt: !!launcher.tools.wt, pwsh: !!launcher.tools.pwsh, code: !!launcher.tools.code },
      platform: process.platform,
      now: Date.now(),
    },
  };
}

function sessionDetail(id) {
  const s = indexer.index.sessions[id];
  const meta = store.load().sessions[id] || {};
  if (!s) {
    const prompts = indexer.index.history.entries.filter((e) => e.s === id).map((e) => ({ t: e.t, ts: e.ts, c: e.t.startsWith('/') ? 1 : 0 }));
    if (!prompts.length) return null;
    return { id, archived: true, prompts, files: [], artifacts: [], tools: {}, models: {}, commands: {}, meta };
  }
  return {
    id, archived: false, file: s.file, prompts: s.prompts, promptTotal: s.promptTotal, files: s.files, artifacts: s.artifacts,
    tools: s.tools, models: s.models, commands: s.commands, days: s.days, turnMs: s.turnMs, turns: s.turns,
    costUSD: s.costUSD, meta,
  };
}

function search(q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const metaAll = store.load().sessions;
  const results = [];
  const test = (txt) => { const l = txt.toLowerCase(); return terms.every((t) => l.includes(t)); };
  const snippet = (txt) => {
    const l = txt.toLowerCase(); const i = l.indexOf(terms[0]);
    const a = Math.max(0, i - 60);
    return (a > 0 ? '…' : '') + txt.slice(a, a + 200).replace(/\s+/g, ' ') + (a + 200 < txt.length ? '…' : '');
  };
  for (const s of Object.values(indexer.index.sessions)) {
    const m = metaAll[s.id] || {};
    const head = [m.alias, s.customTitle, s.agentName, s.aiTitle, s.cwd, s.gitBranch, m.note, (m.tags || []).join(' '), s.awaySummary, s.id].filter(Boolean).join(' \n ');
    let score = 0; let snip = null; let hits = 0;
    if (test(head)) { score += 10; snip = test(s.awaySummary || '') ? snippet(s.awaySummary) : null; }
    for (const p of s.prompts) if (test(p.t)) { hits++; if (!snip) snip = snippet(p.t); }
    for (const f of s.files) if (test(f)) { hits++; if (!snip) snip = f; }
    score += hits;
    if (score) results.push({ id: s.id, score, hits, snippet: snip });
  }
  const groups = new Map();
  for (const e of indexer.index.history.entries) {
    if (!e.s || indexer.index.sessions[e.s] || !test(e.t + ' ' + (e.p || ''))) continue;
    const g = groups.get(e.s) || { id: e.s, score: 0, hits: 0, snippet: snippet(e.t) };
    g.score++; g.hits++; groups.set(e.s, g);
  }
  return results.concat([...groups.values()]).sort((a, b) => b.score - a.score).slice(0, 200);
}

// ---------- live updates ----------

let lastSig = '';
let ticker = null;
function startTicker(emit, ms = 3000) {
  if (ticker) return;
  const tick = async () => {
    try {
      const { changed } = await indexer.scan();
      liveCache.at = 0;
      const liveList = await getLive();
      const sig = JSON.stringify(liveList.map((l) => [l.pid, l.sessionId, l.status, l.waitingFor, l.name, l.updatedAt]));
      if (changed || sig !== lastSig) {
        lastSig = sig;
        emit({ rev: indexer.index.rev, live: liveList });
      }
    } catch (e) { console.error('tick', e.message); }
  };
  ticker = setInterval(tick, ms);
}
function stopTicker() { if (ticker) clearInterval(ticker); ticker = null; }

// ---------- router ----------

function sessionCwd(id) {
  const s = indexer.index.sessions[id];
  return s ? (s.cwd || s.lastCwd) : null;
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// hooks: { pickFolder(initial) -> path|null, quit() }
async function handle(method, pathname, query = {}, body = {}, hooks = {}) {
  const p = pathname; const m = method;
  let mm;
  if (m === 'GET') {
    if (p === '/api/state') return fullState();
    if ((mm = p.match(/^\/api\/session\/([\w-]+)$/))) {
      await indexer.scan();
      const d = sessionDetail(mm[1]);
      if (!d) throw new HttpError(404, 'Session not found');
      return d;
    }
    if ((mm = p.match(/^\/api\/session\/([\w-]+)\/transcript$/))) {
      const s = indexer.index.sessions[mm[1]];
      if (!s) throw new HttpError(404, 'Transcript not available');
      const data = await readTranscript(s.file);
      const limit = Number(query.limit || 0);
      const entries = limit && data.entries.length > limit ? data.entries.slice(-limit) : data.entries;
      return { total: data.entries.length, entries };
    }
    if (p === '/api/history') return { entries: indexer.index.history.entries };
    if (p === '/api/search') return { results: search(query.q) };
    throw new HttpError(404, 'Not found');
  }

  const settings = store.load().settings;
  if (p === '/api/launch' || p === '/api/command') {
    const o = { ...body };
    if ((o.mode === 'resume' || o.mode === 'fork') && !o.cwd) o.cwd = sessionCwd(o.sessionId);
    if (p === '/api/command') return { command: launcher.commandLine(o, settings) };
    const r = await launcher.launch(o, settings);
    store.logLaunch({ mode: o.mode, sessionId: o.sessionId || null, cwd: o.cwd, how: r.how, title: o.title || null });
    return { ok: true, ...r };
  }
  if (p === '/api/open') {
    if (body.kind === 'folder') await launcher.openFolder(body.path);
    else if (body.kind === 'editor') await launcher.openInEditor(body.path, settings.editor);
    else if (body.kind === 'reveal') await launcher.revealFile(body.path);
    else if (body.kind === 'claude-dir') await launcher.openFolder(P.CLAUDE_DIR);
    else throw new HttpError(400, 'Unknown kind');
    return { ok: true };
  }
  if (p === '/api/pick-folder') return { path: hooks.pickFolder ? await hooks.pickFolder(body.initial) : await launcher.pickFolder(body.initial) };
  if (p === '/api/stop') {
    const pid = Number(body.pid);
    liveCache.at = 0;
    const l = (await getLive()).find((x) => x.pid === pid);
    if (!l) throw new HttpError(400, 'That process is not a running Claude Code session');
    await launcher.stopProcess(pid);
    liveCache.at = 0;
    return { ok: true };
  }
  if ((mm = p.match(/^\/api\/meta\/([\w-]+)$/))) return { meta: store.updateSessionMeta(mm[1], body) };
  if (p === '/api/settings') {
    const s = store.updateSettings(body);
    indexer.setGapMinutes(s.gapMinutes);
    return { settings: s };
  }
  if (p === '/api/presets' && m === 'POST') return { preset: store.savePreset(body) };
  if ((mm = p.match(/^\/api\/presets\/([\w-]+)$/)) && m === 'DELETE') { store.deletePreset(mm[1]); return { ok: true }; }
  if (p === '/api/rebuild') return { ok: true, ...(await indexer.rebuild()) };
  if (p === '/api/quit') { if (hooks.quit) setTimeout(hooks.quit, 100); return { ok: true }; }
  throw new HttpError(404, 'Not found');
}

function init() {
  indexer.setGapMinutes(store.load().settings.gapMinutes);
  return indexer.scan();
}

module.exports = { handle, init, startTicker, stopTicker, HttpError };
