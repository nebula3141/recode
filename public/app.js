'use strict';
/* ReCode — single-page app. Views render to HTML strings; one delegated
   click handler dispatches [data-act] actions. Live updates arrive over SSE. */

const S = {
  data: null,
  rev: -1,
  byId: new Map(),
  liveById: new Map(),
  route: { view: 'home', arg: null },
  details: {},
  transcripts: {},
  history: null,
  f: { q: '', status: 'all', time: 'any', project: '', sort: 'recent', pinned: false, showHidden: false },
  searchHits: null,
  tab: 'overview',
  convo: { tools: true },
  timelineDay: dayKey(Date.now()),
  heatMetric: 'prompts',
  prompts: { q: '', project: '', cmds: false, limit: 200 },
  proj: { q: '', sort: 'recent', empty: false },
  insightsRange: 30,
  scrolledConvo: null,
};

const VIEWS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'sessions', label: 'Sessions', icon: 'list' },
  { id: 'live', label: 'Running', icon: 'pulse' },
  { id: 'timeline', label: 'Timeline', icon: 'calendar' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
  { id: 'prompts', label: 'Prompt history', icon: 'message' },
  { id: 'insights', label: 'Insights', icon: 'chart' },
];

const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
const PERMISSION_MODES = [['', 'Default (from settings)'], ['default', 'Ask for permission'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan mode'], ['auto', 'Auto'], ['bypassPermissions', 'Bypass permissions (dangerous)']];
const EFFORTS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const TERMINALS = [['wt-tab', 'Windows Terminal — new tab'], ['wt-window', 'Windows Terminal — new window'], ['console', 'PowerShell console window'], ['desktop', 'Claude desktop app']];

// ---------------------------------------------------------------- data

async function loadState() {
  const d = await api('/api/state');
  // Prompt history is fetched lazily; drop it when history.jsonl has grown so it reloads.
  if (S.data && d.meta.historyCount !== S.data.meta.historyCount) S.history = null;
  S.data = d;
  S.rev = d.meta.rev;
  // Earlier parts of continued conversations aren't listed, but stay reachable by id.
  S.byId = new Map([...(d.earlier || []), ...d.sessions].map((s) => [s.id, s]));
  indexLive();
  applyTheme();
  render();
}

function indexLive() { S.liveById = new Map(S.data.live.map((l) => [l.sessionId, l])); }
const liveOf = (id) => S.liveById.get(id);
const settings = () => S.data.settings;

function statusOf(s) {
  const l = liveOf(s.id);
  if (l) return l.status === 'busy' || l.status === 'waiting' || l.status === 'idle' ? l.status : 'idle';
  return s.archived ? 'archived' : 'resumable';
}
const STATUS_LABEL = { busy: 'Working', waiting: 'Needs you', idle: 'Idle', resumable: 'Resumable', archived: 'Archived' };
function statusPill(s) {
  const st = statusOf(s); const l = liveOf(s.id);
  if (st === 'resumable') return '';
  const extra = st === 'waiting' && l && l.waitingFor ? ` · ${l.waitingFor}` : '';
  return `<span class="pill ${st}"><span class="dot ${st}"></span>${esc(STATUS_LABEL[st] + extra)}</span>`;
}

function hiddenByPattern(s) {
  const pats = settings().hidePatterns || [];
  const c = String(s.cwd || '').toLowerCase();
  return pats.some((p) => p && c.includes(p.toLowerCase()));
}

function baseSessions({ includeHidden = false } = {}) {
  return S.data.sessions.filter((s) => {
    if (!settings().showArchived && s.archived) return false;
    if (!includeHidden && (s.hidden || hiddenByPattern(s))) return false;
    return true;
  });
}

function filteredSessions() {
  const f = S.f; const now = Date.now();
  let list = baseSessions({ includeHidden: f.showHidden });
  if (f.status === 'live') list = list.filter((s) => liveOf(s.id));
  else if (f.status === 'resumable') list = list.filter((s) => !s.archived);
  else if (f.status === 'archived') list = list.filter((s) => s.archived);
  if (f.time !== 'any') {
    const from = f.time === 'today' ? dayStart(now) : now - Number(f.time) * DAY;
    list = list.filter((s) => (s.lastTs || 0) >= from);
  }
  if (f.project) list = list.filter((s) => s.projectKey === f.project);
  if (f.pinned) list = list.filter((s) => s.pinned);
  if (f.q.trim()) {
    if (S.searchHits) list = list.filter((s) => S.searchHits.has(s.id));
    else { const q = f.q.toLowerCase(); list = list.filter((s) => (s.title + ' ' + s.cwd).toLowerCase().includes(q)); }
  }
  const by = {
    recent: (a, b) => (b.lastTs || 0) - (a.lastTs || 0),
    started: (a, b) => (b.firstTs || 0) - (a.firstTs || 0),
    active: (a, b) => b.activeMs - a.activeMs,
    tokens: (a, b) => totalTokens(b.tokens) - totalTokens(a.tokens),
    prompts: (a, b) => b.prompts - a.prompts,
  }[f.sort];
  list = list.slice().sort(by);
  // Pinned first when browsing by recency.
  if (f.sort === 'recent') list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return list;
}

async function ensureDetail(id, force) {
  if (!force && S.details[id] && S.details[id]._rev === S.rev) return S.details[id];
  try {
    const d = await api(`/api/session/${id}`);
    d._rev = S.rev;
    S.details[id] = d;
  } catch (e) { S.details[id] = { error: e.message, _rev: S.rev }; }
  return S.details[id];
}

async function ensureTranscript(id, all) {
  const s = S.byId.get(id);
  const cur = S.transcripts[id];
  if (cur && !all && cur.size === s.size && !cur.loading) return cur;
  if (cur && cur.loading) return cur;
  S.transcripts[id] = { ...(cur || {}), loading: true };
  try {
    const t = await api(`/api/session/${id}/transcript${all ? '' : '?limit=800'}`);
    S.transcripts[id] = { ...t, size: s.size, all: !!all };
  } catch (e) { S.transcripts[id] = { error: e.message, size: s.size }; }
  return S.transcripts[id];
}

// ---------------------------------------------------------------- routing / render

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const view = VIEWS.some((v) => v.id === parts[0]) || parts[0] === 'settings' ? parts[0] : 'home';
  return { view, arg: parts[1] ? decodeURIComponent(parts[1]) : null };
}
function go(view, arg) { location.hash = `#/${view}${arg ? '/' + encodeURIComponent(arg) : ''}`; }

window.addEventListener('hashchange', () => {
  const prev = S.route;
  S.route = parseRoute();
  if (S.route.view === 'sessions' && S.route.arg !== prev.arg) { S.scrolledConvo = null; S.resetDetailScroll = true; }
  render(prev.view !== S.route.view);
});

function render(resetScroll) {
  if (!S.data) return;
  renderNav();
  renderTop();
  const view = document.getElementById('view');
  // Preserve focus, caret, scroll positions and open <details> across re-renders.
  const active = document.activeElement;
  const focusId = active && view.contains(active) && active.id ? active.id : null;
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const focusVal = focusId && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.type !== 'checkbox' ? active.value : null;
  const scrolls = {};
  view.querySelectorAll('[data-scroll]').forEach((el) => { scrolls[el.dataset.scroll] = el.scrollTop; });
  const openDetails = new Set([...view.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k));
  const viewScroll = view.scrollTop;

  const fn = { home: viewHome, sessions: viewSessions, live: viewLive, timeline: viewTimeline, projects: viewProjects, prompts: viewPrompts, insights: viewInsights, settings: viewSettings }[S.route.view];
  view.innerHTML = fn();

  view.querySelectorAll('details[data-k]').forEach((d) => { if (openDetails.has(d.dataset.k)) d.open = true; });
  if (!resetScroll) {
    view.scrollTop = viewScroll;
    view.querySelectorAll('[data-scroll]').forEach((el) => {
      if (el.dataset.scroll === 'detail' && S.resetDetailScroll) return; // new session: start at the top
      if (el.dataset.scroll in scrolls) el.scrollTop = scrolls[el.dataset.scroll];
    });
  } else view.scrollTop = 0;
  S.resetDetailScroll = false;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { if (focusVal != null) el.value = focusVal; el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ } }
  }
  afterRender();
}

function afterRender() {
  // Scroll the conversation to the end the first time it is shown for a session.
  if (S.route.view === 'sessions' && S.tab === 'convo' && S.route.arg && S.scrolledConvo !== S.route.arg) {
    const t = S.transcripts[S.route.arg];
    const pane = document.querySelector('.pane.detail');
    if (t && t.entries && pane) { pane.scrollTop = pane.scrollHeight; S.scrolledConvo = S.route.arg; }
  }
}

function renderNav() {
  const d = S.data;
  const live = d.live.length;
  const waiting = d.live.filter((l) => l.status === 'waiting').length;
  const counts = {
    sessions: baseSessions().filter((s) => !s.archived).length,
    live,
    projects: d.projects.filter((p) => p.sessions && !hiddenByPattern({ cwd: p.path })).length,
  };
  document.getElementById('nav').innerHTML = VIEWS.map((v) => {
    let c = counts[v.id] != null ? `<span class="count">${counts[v.id]}</span>` : '';
    if (v.id === 'live') c = live ? `<span class="count live">${waiting ? `<span class="dot waiting" data-tip="${waiting} waiting for you"></span>` : '<span class="dot idle"></span>'}${live}</span>` : '<span class="count">0</span>';
    return `<button class="nav-item ${S.route.view === v.id ? 'on' : ''}" data-act="nav" data-view="${v.id}">${icon(v.icon)}<span>${v.label}</span>${c}</button>`;
  }).join('') + `<div class="nav-sep"></div><button class="nav-item ${S.route.view === 'settings' ? 'on' : ''}" data-act="nav" data-view="settings">${icon('settings')}<span>Settings</span></button>`;

  const transcripts = d.sessions.filter((s) => !s.archived).length;
  document.getElementById('brand-sub').textContent = d.meta.claudeVersion ? `Claude Code ${d.meta.claudeVersion}` : 'Claude Code';
  document.getElementById('side-foot').innerHTML = `
    <div>${transcripts} saved transcripts</div>
    <div>${d.sessions.length - transcripts} archived from history</div>
    <div><button data-act="refresh" data-tip="Re-read ~/.claude now">Refresh</button> · <button data-act="open-claude-dir" data-tip="${attr(d.meta.claudeDir)}">Open .claude</button></div>`;
}

function renderTop() {
  const live = S.data.live;
  const by = (st) => live.filter((l) => l.status === st).length;
  const parts = [];
  const up = S.data.meta.update;
  if (up && up.available) parts.push(`<button class="pill update" data-act="update-open" style="border:0;cursor:pointer" data-tip="A new ReCode release is available">${icon('down', 'xs')}Update to ${esc(up.latest.version)}</button>`);
  if (by('waiting')) parts.push(`<button class="pill waiting" data-act="nav" data-view="live" style="border:0;cursor:pointer"><span class="dot waiting"></span>${by('waiting')} need${by('waiting') === 1 ? 's' : ''} you</button>`);
  if (by('busy')) parts.push(`<button class="pill busy" data-act="nav" data-view="live" style="border:0;cursor:pointer"><span class="dot busy"></span>${by('busy')} working</button>`);
  if (by('idle')) parts.push(`<button class="pill idle" data-act="nav" data-view="live" style="border:0;cursor:pointer"><span class="dot idle"></span>${by('idle')} idle</button>`);
  document.getElementById('top-right').innerHTML = parts.join('');
}

// ---------------------------------------------------------------- shared pieces

function sessionRow(s, { sel = false, snippet = null, showDate = false } = {}) {
  const st = statusOf(s);
  const l = liveOf(s.id);
  const preview = snippet || s.lastPrompt || s.firstPrompt || '';
  const resumeBtn = s.archived ? '' : l
    ? `<button class="btn sm go primary" data-act="focus-term" data-sid="${s.id}" data-tip="Bring its terminal tab to the front (Enter)">${icon('terminal', 'sm')}Go to</button>`
    : `<button class="btn sm go primary" data-act="resume" data-sid="${s.id}">${icon('play', 'xs')}Resume</button>`;
  return `
  <div class="s-row ${sel ? 'sel' : ''} ${s.hidden || hiddenByPattern(s) ? 'hidden-s' : ''}" data-sid="${s.id}" tabindex="0" role="button" aria-label="${attr(s.title)}">
    <span class="dot ${st}" data-tip="${attr(STATUS_LABEL[st])}"></span>
    <div class="t"><span class="ellipsis">${esc(s.title)}</span>${s.pinned ? icon('pin') : ''}</div>
    <div class="r">${l ? statusPill(s) : ''}<span class="tnum" data-tip="${attr(fmtDateTime(s.lastTs))}">${showDate ? fmtDateTime(s.lastTs) : ago(s.lastTs)}</span>${resumeBtn}</div>
    <div class="sub">
      <span class="chip" data-tip="${attr(s.cwd || '')}">${icon('folder')}${esc(baseName(s.cwd) || '?')}</span>
      ${s.gitBranch ? `<span class="chip">${icon('branch')}${esc(s.gitBranch)}</span>` : ''}
      ${(s.tags || []).slice(0, 2).map((t) => `<span class="chip tag">${esc(t)}</span>`).join('')}
      <span class="p">${esc(preview)}</span>
      <span class="nowrap tnum">${s.archived ? 'archived · ' : ''}${plural(s.prompts, 'prompt')}</span>
    </div>
  </div>`;
}

function groupByDay(list, render) {
  let out = ''; let cur = null; let buf = [];
  const flush = () => { if (buf.length) out += `<div class="day-h">${esc(dayLabel(cur))} <span>${buf.length}</span></div>` + buf.join(''); buf = []; };
  for (const s of list) {
    const k = dayStart(s.lastTs || 0);
    if (k !== cur) { flush(); cur = k; }
    buf.push(render(s));
  }
  flush();
  return out;
}

function liveCard(l) {
  const s = S.byId.get(l.sessionId);
  const title = (s && s.title) || l.name || 'New session';
  const st = l.status === 'busy' || l.status === 'waiting' ? l.status : 'idle';
  return `
  <div class="card live-card ${st}" data-sid="${s ? s.id : ''}" data-act="${s ? 'open-session' : ''}">
    <div class="row"><span class="pill ${st}"><span class="dot ${st}"></span>${esc(STATUS_LABEL[st])}${st === 'waiting' && l.waitingFor ? ' · ' + esc(l.waitingFor) : ''}</span><span class="muted" style="margin-left:auto;font-size:12px" data-tip="Last status change">${ago(l.updatedAt)}</span></div>
    <div class="t ellipsis">${esc(title)}</div>
    <div class="sub"><span class="ellipsis" data-tip="${attr(l.cwd)}">${icon('folder', 'xs')} ${esc(baseName(l.cwd))}</span><span>started ${ago(l.startedAt)}</span><span class="mono">pid ${l.pid}</span></div>
    ${s && s.lastPrompt ? `<div class="muted ellipsis" style="font-size:12px">› ${esc(s.lastPrompt)}</div>` : ''}
    <div class="acts">
      <button class="btn sm primary" data-act="focus-term" data-sid="${attr(l.sessionId)}" data-tip="Bring its terminal tab to the front">${icon('terminal', 'sm')}Go to terminal</button>
      ${s ? `<button class="btn sm" data-act="open-session" data-sid="${s.id}">Details</button><button class="btn sm" data-act="fork" data-sid="${s.id}" data-tip="Open a copy of this conversation in a new terminal">${icon('fork', 'sm')}Fork</button>` : ''}
      <button class="btn sm ghost icon" data-act="open-folder" data-path="${attr(l.cwd)}" data-tip="Open folder">${icon('folder', 'sm')}</button>
      <button class="btn sm ghost icon danger" data-act="stop" data-pid="${l.pid}" data-tip="Stop this process" style="margin-left:auto">${icon('stop', 'sm')}</button>
    </div>
  </div>`;
}

function emptyBox(title, body = '') { return `<div class="empty"><b>${esc(title)}</b>${body}</div>`; }

function segDur(a, b) { return Math.max(b - a, MIN); }
function activeInRange(segs, from, to) {
  let t = 0;
  for (const [a, b] of segs || []) {
    if (b < from || a > to) continue;
    const lo = Math.max(a, from); const hi = Math.min(b, to);
    t += a === b ? MIN : Math.max(0, hi - lo);
  }
  return t;
}

// ---------------------------------------------------------------- Home

function viewHome() {
  const d = S.data; const now = Date.now();
  const all = baseSessions();
  const resumable = all.filter((s) => !s.archived);
  const hero = resumable.find((s) => !liveOf(s.id));
  const recent = resumable.filter((s) => s !== hero && !liveOf(s.id)).slice(0, 8);
  const today0 = dayStart(now);
  const todays = all.filter((s) => (s.lastTs || 0) >= today0);
  const todayActive = todays.reduce((t, s) => t + activeInRange(s.segments, today0, now), 0);
  const h = new Date().getHours();
  const greet = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const sub = [
    d.live.length ? `${d.live.length} running` : 'Nothing running',
    todays.length ? `${fmtDur(todayActive)} active today across ${plural(todays.length, 'session')}` : 'No activity yet today',
  ].join(' · ');

  return `<div class="page">
    <div class="page-h"><div><h1>${greet}</h1><p>${esc(sub)}</p></div></div>
    <div class="grid-home">
      <div class="stack" style="gap:24px">
        ${recoveryBanner()}
        ${hero ? heroCard(hero) : emptyBox('No sessions yet', '<div>Start one with <b style="display:inline">New session</b>.</div>')}
        ${d.live.length ? `<section><h2 class="sec">Running now <span class="muted">${d.live.length}</span><button class="link" data-act="nav" data-view="live">View all →</button></h2><div class="live-grid">${d.live.slice(0, 4).map(liveCard).join('')}</div></section>` : ''}
        <section>
          <h2 class="sec">Recent sessions<button class="link" data-act="nav" data-view="sessions">All sessions →</button></h2>
          <div class="card recent-list">${recent.length ? recent.map((s) => sessionRow(s)).join('') : '<div class="muted" style="padding:14px">Nothing else yet.</div>'}</div>
        </section>
      </div>
      <aside class="rail">${railStart()}${railPresets()}${railToday(todays, today0, now)}</aside>
    </div>
  </div>`;
}

function recoveryItems() { return (S.data.recovery || []).filter((r) => S.byId.has(r.sessionId)); }

function recoveryBanner({ list = false } = {}) {
  const items = recoveryItems();
  if (!items.length) return '';
  const when = items[0].at;
  const what = items.length === 1 ? `<b>${esc(items[0].title)}</b> was interrupted` : `${items.length} sessions were interrupted`;
  const rows = list || items.length <= 3
    ? `<div class="rec-list">${items.slice(0, list ? 20 : 3).map((r) => `<div class="rec-row"><span class="dot ${r.status === 'busy' ? 'busy' : r.status === 'waiting' ? 'waiting' : 'idle'}"></span><span class="ellipsis grow">${esc(r.title)}</span><span class="muted ellipsis" style="max-width:30%">${esc(baseName(r.cwd))}</span><span class="muted nowrap tnum">${esc(ago(r.at))}</span><button class="btn sm" data-act="recover-one" data-sid="${attr(r.sessionId)}">${icon('play', 'sm')}Resume</button></div>`).join('')}</div>`
    : '';
  return `<section class="card recovery" role="region" aria-label="Interrupted sessions">
    <div class="row" style="align-items:flex-start;gap:12px">
      <span class="rec-ic">${icon('refresh')}</span>
      <div class="grow" style="min-width:0">
        <div class="rec-t">${what}</div>
        <div class="muted" style="font-size:13px">Claude Code, the terminal or the PC stopped ${esc(ago(when))} while ${items.length === 1 ? 'it was' : 'they were'} open. Resume to pick up where you left off.</div>
      </div>
    </div>
    ${rows}
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${items.length > 1 ? `<button class="btn primary sm" data-act="recover-all">${icon('play', 'sm')}Resume all ${items.length}</button><button class="btn sm" data-act="recover-review">Choose…</button>` : `<button class="btn primary sm" data-act="recover-one" data-sid="${attr(items[0].sessionId)}">${icon('play', 'sm')}Resume</button>`}
      <button class="btn ghost sm" data-act="recover-dismiss">Dismiss</button>
    </div>
  </section>`;
}

async function dismissRecovery(items) {
  try {
    const r = await api('/api/recovery/dismiss', { body: { keys: items.flatMap((i) => i.keys) } });
    S.data.recovery = r.items; render();
  } catch (e) { toast(e.message, 'err'); }
}

async function resumeRecovered(items) {
  // Stagger launches so terminals don't fight over focus and Claude Code starts cleanly.
  let n = 0;
  for (const r of items) {
    const sess = S.byId.get(r.sessionId);
    if (!sess || sess.archived) continue;
    if (n) await new Promise((res) => setTimeout(res, 700));
    const ok = await doLaunch({ ...defaultsFromSettings(), mode: 'resume', sessionId: sess.id, cwd: sess.cwd, title: sess.title });
    if (ok !== false) n++;
  }
  await dismissRecovery(items);
  if (n > 1) toast(`Resumed ${n} sessions`);
}

function recoveryReview() {
  const items = recoveryItems();
  const m = openModal(`
    <div class="mh"><div><h3>Resume interrupted sessions</h3><p>Pick the ones to reopen. Each opens in its own terminal.</p></div><button class="btn ghost icon x" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="mb"><div class="list-plain">${items.map((r, i) => `<label class="check rec-pick"><input type="checkbox" data-i="${i}" checked><span class="grow ellipsis"><b>${esc(r.title)}</b><span class="muted"> · ${esc(baseName(r.cwd))}</span></span><span class="muted nowrap tnum">${esc(ago(r.at))}</span></label>`).join('')}</div></div>
    <div class="mf"><button class="btn ghost" id="rr-dismiss">Dismiss all</button><span class="sp"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="rr-go">${icon('play', 'sm')}Resume selected</button></div>`);
  const picked = () => [...m.el.querySelectorAll('input[data-i]')].filter((x) => x.checked).map((x) => items[Number(x.dataset.i)]);
  m.el.querySelector('#rr-go').addEventListener('click', () => { const sel = picked(); m.close(); if (sel.length) resumeRecovered(sel); });
  m.el.querySelector('#rr-dismiss').addEventListener('click', () => { m.close(); dismissRecovery(items); });
  m.el.addEventListener('change', () => { const k = picked().length; const b = m.el.querySelector('#rr-go'); b.disabled = !k; b.lastChild.textContent = k ? `Resume ${k}` : 'Resume selected'; });
}

// ---------- updates ----------
let updatePoll = null;
function updateDialog() {
  const render1 = (u) => {
    const l = u.latest;
    const busy = u.phase === 'downloading' || u.phase === 'verifying' || u.phase === 'starting';
    const pct = u.total ? Math.round((u.received / u.total) * 100) : null;
    const how = u.kind === 'installer' ? 'ReCode downloads the installer, checks its SHA-256, closes and updates itself, then reopens.'
      : u.kind === 'script' ? 'ReCode downloads the new version, checks its SHA-256, closes, updates itself and reopens.'
      : 'This copy of ReCode can\'t update itself (portable or source build). Download the new version from the release page.';
    return `
      <div class="mh"><div><h3>${l ? `ReCode ${esc(l.version)}` : 'Updates'}</h3><p>You have ${esc(u.current)}${l && l.publishedAt ? ` · released ${esc(ago(l.publishedAt))}` : ''}${l && l.prerelease ? ' · release candidate' : ''}</p></div><button class="btn ghost icon x" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="mb">
        ${l && l.notes ? `<div class="md update-notes">${md(l.notes)}</div>` : '<div class="muted">No release notes.</div>'}
        <div class="dim" style="font-size:13px">${esc(how)}</div>
        ${busy ? `<div class="progress"><div style="width:${pct == null ? 30 : pct}%"></div></div><div class="muted" style="font-size:12px">${u.phase === 'downloading' ? `Downloading${pct != null ? ` · ${pct}%` : '…'}` : u.phase === 'verifying' ? 'Checking the download…' : 'Starting the update…'}</div>` : ''}
        ${u.phaseError ? `<div class="err-box">${esc(u.phaseError)}</div>` : ''}
      </div>
      <div class="mf">
        <button class="btn ghost" data-act="open-url" data-url="${attr((l && l.url) || u.releasesPage)}">${icon('external', 'sm')}Release page</button>
        <span class="sp"></span>
        <button class="btn ghost" data-close>Later</button>
        ${u.available ? `<button class="btn primary" id="up-go" ${busy ? 'disabled' : ''}>${icon('down', 'sm')}${u.kind === 'installer' || u.kind === 'script' ? 'Update now' : 'Download'}</button>` : ''}
      </div>`;
  };
  let u = S.data.meta.update;
  const m = openModal(render1(u), { onClose: () => { clearInterval(updatePoll); updatePoll = null; } });
  const box = m.el.querySelector('.modal');
  const wire = (first) => {
    if (!first) box.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', m.close));
    const go = box.querySelector('#up-go');
    if (go) go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await api('/api/update/install', { body: {} });
        if (r.action === 'open') { m.close(); return; }
        toast('Updating ReCode, it will reopen in a moment');
      } catch (e) { toast(e.message, 'err'); go.disabled = false; }
    });
  };
  wire(true);
  clearInterval(updatePoll);
  updatePoll = setInterval(async () => {
    try {
      const n = await api('/api/update');
      if (JSON.stringify([n.phase, n.received, n.phaseError, n.available]) === JSON.stringify([u.phase, u.received, u.phaseError, u.available])) return;
      u = n; S.data.meta.update = n; box.innerHTML = render1(n); wire();
    } catch { /* app is closing for the update */ }
  }, 500);
}

async function checkForUpdates() {
  try {
    const u = await api('/api/update/check', { body: {} });
    S.data.meta.update = u; render();
    if (u.error) toast(u.error, 'err');
    else if (u.available) updateDialog();
    else toast(`You're on the latest version (${u.current})`);
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- folder autocomplete ----------
// Suggests known projects and real subfolders as you type a path. Tab completes a folder and
// shows what's inside it; Enter picks the highlighted entry; Esc closes the list only.
function attachFolderComplete(input, onPick) {
  const wrap = input.closest('.ac-wrap');
  const list = wrap.querySelector('.ac');
  const hint = input.closest('.field') && input.closest('.field').querySelector('.ac-hint');
  let items = []; let sel = -1; let seq = 0; let timer = null; let open = false;
  const SEP = String.fromCharCode(92);
  const show = (on) => { open = on && items.length > 0; list.hidden = !open; input.setAttribute('aria-expanded', open ? 'true' : 'false'); };
  const paint = () => {
    list.innerHTML = items.map((it, i) => `<div class="ac-item ${i === sel ? 'on' : ''}" role="option" id="ac-${i}" aria-selected="${i === sel}" data-i="${i}">
      <span class="ac-ic">${icon(it.kind === 'project' ? 'code' : it.kind === 'drive' ? 'desktop' : 'folder', 'sm')}</span>
      <span class="ac-name ellipsis">${esc(it.name)}</span>
      <span class="ac-path ellipsis muted">${esc(it.path)}</span>
      ${it.sessions ? `<span class="ac-meta muted nowrap">${plural(it.sessions, 'session')}</span>` : it.git ? '<span class="ac-meta muted">git</span>' : ''}
    </div>`).join('');
    if (sel >= 0) { input.setAttribute('aria-activedescendant', 'ac-' + sel); const el = list.children[sel]; if (el) el.scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const setHint = (r) => {
    if (!hint) return;
    const v = input.value.trim();
    if (!v) { hint.textContent = 'Type a path or a project name. Tab completes a folder.'; hint.className = 'hint ac-hint'; return; }
    if (r && r.exists) { const p = S.data.projects.find((x) => x.path.toLowerCase() === (r.resolved || '').toLowerCase()); hint.textContent = p && p.sessions ? `Folder found · ${plural(p.sessions, 'earlier session')} here` : 'Folder found'; hint.className = 'hint ac-hint ok'; }
    else if (r && /[\\/:]/.test(v)) { hint.textContent = "This folder doesn't exist yet. Claude Code needs an existing folder."; hint.className = 'hint ac-hint warn'; }
    else { hint.textContent = 'Pick a match, or type a full path.'; hint.className = 'hint ac-hint'; }
  };
  const fetchNow = async () => {
    const my = ++seq;
    try {
      const r = await api('/api/complete-dir?q=' + encodeURIComponent(input.value));
      if (my !== seq) return;
      items = r.items || []; sel = items.length && document.activeElement === input && input.value.trim() && !r.exists ? 0 : -1;
      paint(); show(document.activeElement === input); setHint(r);
    } catch { /* ignore */ }
  };
  const fetchSoon = () => { clearTimeout(timer); timer = setTimeout(fetchNow, 90); };
  const accept = (it, { descend = false } = {}) => {
    if (!it) return;
    input.value = descend ? it.path.replace(/[\\/]+$/, '') + SEP : it.path;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (onPick) onPick(it);
    if (descend) { input.focus(); fetchNow(); } else { show(false); fetchNow().then(() => show(false)); }
    const n = input.value.length; input.setSelectionRange(n, n);
  };
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off'; input.spellcheck = false;
  input.addEventListener('input', fetchSoon);
  input.addEventListener('focus', fetchNow);
  input.addEventListener('blur', () => setTimeout(() => show(false), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { show(true); if (!open) return; }
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      sel = (sel + d + items.length) % items.length; paint();
    } else if (e.key === 'Tab' && open && items.length && !e.shiftKey) {
      e.preventDefault(); accept(items[Math.max(sel, 0)], { descend: true });
    } else if (e.key === 'Enter' && open && sel >= 0) {
      e.preventDefault(); e.stopPropagation(); accept(items[sel]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault(); e.stopPropagation(); show(false);
    }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener('click', (e) => { const r = e.target.closest('.ac-item'); if (r) accept(items[Number(r.dataset.i)]); });
  list.addEventListener('mousemove', (e) => { const r = e.target.closest('.ac-item'); if (r && Number(r.dataset.i) !== sel) { sel = Number(r.dataset.i); paint(); } });
  setHint(null);
  return { refresh: fetchNow };
}

function heroCard(s) {
  return `<section class="hero">
    <div class="eyebrow">${icon('clock', 'xs')} Pick up where you left off · ${esc(ago(s.lastTs))}</div>
    <h3>${esc(s.title)}</h3>
    <div class="meta">
      <span data-tip="${attr(s.cwd)}">${icon('folder', 'xs')}${esc(s.cwd)}</span>
      ${s.gitBranch ? `<span>${icon('branch', 'xs')}${esc(s.gitBranch)}</span>` : ''}
      <span>${esc(shortModel(s.model))}</span>
      <span>${plural(s.prompts, 'prompt')} · ${fmtDur(s.activeMs)} active</span>
    </div>
    ${s.awaySummary ? `<div class="left-off"><b>WHERE IT LEFT OFF</b><p>${esc(s.awaySummary)}</p></div>` : ''}
    ${s.lastPrompt ? `<div class="left-off"><b>YOUR LAST MESSAGE · ${esc(ago(s.lastUserTs).toUpperCase())}</b><p>${esc(s.lastPrompt)}</p></div>` : ''}
    <div class="actions">
      <button class="btn primary" data-act="resume" data-sid="${s.id}">${icon('play', 'sm')}Resume</button>
      <button class="btn" data-act="fork" data-sid="${s.id}">${icon('fork')}Fork</button>
      <button class="btn" data-act="resume-opts" data-sid="${s.id}">${icon('sliders')}Options…</button>
      <button class="btn ghost" data-act="open-folder" data-path="${attr(s.cwd)}">${icon('folder')}Folder</button>
      <button class="btn ghost" data-act="open-session" data-sid="${s.id}">Details →</button>
    </div>
  </section>`;
}

function railStart() {
  const projs = S.data.projects.filter((p) => p.exists && p.sessions && !hiddenByPattern({ cwd: p.path })).slice(0, 6);
  return `<div class="card">
    <h2 class="sec">Start</h2>
    <button class="btn primary" style="width:100%;justify-content:center;margin-bottom:10px" data-act="new-session">${icon('plus')}New session…</button>
    ${projs.map((p) => `<div class="qf">
        <div class="grow"><div class="nm ellipsis">${esc(p.name)}${p.live ? ' <span class="dot idle" style="display:inline-block;vertical-align:middle;margin-left:4px"></span>' : ''}</div><div class="pt ellipsis" data-tip="${attr(p.path)}">${esc(p.path)}</div></div>
        <div class="acts">
          <button class="btn sm icon" data-act="new-in" data-path="${attr(p.path)}" data-tip="New session here">${icon('plus', 'sm')}</button>
          ${p.lastSessionId ? `<button class="btn sm icon" data-act="resume" data-sid="${p.lastSessionId}" data-tip="Resume latest session here">${icon('play', 'xs')}</button>` : ''}
          <button class="btn sm icon ghost" data-act="open-folder" data-path="${attr(p.path)}" data-tip="Open folder">${icon('folder', 'sm')}</button>
        </div></div>`).join('')}
    <button class="btn ghost sm" style="margin-top:6px" data-act="nav" data-view="projects">All projects →</button>
  </div>`;
}

function railPresets() {
  const ps = S.data.presets;
  if (!ps.length) return '';
  return `<div class="card"><h2 class="sec">Presets</h2>${ps.map((p) => `
    <div class="qf"><div class="grow"><div class="nm ellipsis">${esc(p.label)}</div><div class="pt ellipsis">${esc(p.opts.cwd || '')}</div></div>
      <div class="acts" style="opacity:1">
        <button class="btn sm primary icon" data-act="run-preset" data-id="${p.id}" data-tip="Launch">${icon('play', 'xs')}</button>
        <button class="btn sm icon ghost" data-act="edit-preset" data-id="${p.id}" data-tip="Edit">${icon('sliders', 'sm')}</button>
      </div></div>`).join('')}</div>`;
}

function railToday(todays, from, now) {
  if (!todays.length) return '';
  const firstH = Math.max(0, Math.min(...todays.map((s) => new Date(Math.max(s.firstTs || from, from)).getHours())));
  const a = from + firstH * HOUR; const b = Math.max(now, a + 3 * HOUR); const span = b - a;
  const rows = todays.slice(0, 7).map((s) => {
    const segs = (s.segments || []).filter(([x, y]) => y >= a).map(([x, y]) => {
      const l = ((Math.max(x, a) - a) / span) * 100; const w = Math.max(((Math.min(y, b) - Math.max(x, a)) / span) * 100, 0.6);
      return `<i style="left:${l}%;width:${w}%" data-tip="${attr(`${fmtTime(x)}–${fmtTime(y)}`)}"></i>`;
    }).join('');
    return `<div class="lbl"><span class="ellipsis">${esc(s.title)}</span><span class="muted nowrap">${fmtDur(activeInRange(s.segments, from, now))}</span></div><div class="seg-line" data-act="open-session" data-sid="${s.id}" style="cursor:pointer">${segs}</div>`;
  }).join('');
  return `<div class="card today-mini"><h2 class="sec">Today<button class="link" data-act="nav" data-view="timeline">Timeline →</button></h2>${rows}
    <div class="axis"><span>${fmtTime(a)}</span><span>${fmtTime(a + span / 2)}</span><span>${fmtTime(b)}</span></div></div>`;
}

// ---------------------------------------------------------------- Sessions

function viewSessions() {
  const list = filteredSessions();
  const f = S.f;
  const all = baseSessions({ includeHidden: f.showHidden });
  const cnt = { all: all.length, live: all.filter((s) => liveOf(s.id)).length, resumable: all.filter((s) => !s.archived).length, archived: all.filter((s) => s.archived).length };
  const projects = S.data.projects.filter((p) => p.sessions).sort((a, b) => a.name.localeCompare(b.name));
  const sel = S.route.arg;
  const hits = S.searchHits;
  const rowFn = (s) => sessionRow(s, { sel: s.id === sel, snippet: hits && hits.get(s.id) });
  const body = list.length
    ? (f.sort === 'recent' ? groupByDay(list, rowFn) : list.map(rowFn).join(''))
    : `<div style="padding:16px">${emptyBox('No sessions match', '<div>Try clearing filters.</div>')}</div>`;
  const statusSeg = ['all', 'live', 'resumable', 'archived'].map((k) => `<button class="${f.status === k ? 'on' : ''}" data-act="f-status" data-v="${k}">${{ all: 'All', live: 'Running', resumable: 'Resumable', archived: 'Archived' }[k]} <span class="muted">${cnt[k]}</span></button>`).join('');

  return `<div class="split-view ${sel ? 'has-sel' : ''}">
    <div class="pane list">
      <div class="filters">
        <div class="search-box">${icon('search')}<input id="f-q" class="input" placeholder="Search titles, prompts, files, notes…  ( / )" value="${attr(f.q)}" autocomplete="off"></div>
        <div class="toolbar"><div class="seg">${statusSeg}</div></div>
        <div class="toolbar">
          <select id="f-time" class="select" aria-label="Time range">${[['any', 'Any time'], ['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].map(([v, l]) => `<option value="${v}" ${f.time === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select id="f-project" class="select" style="max-width:180px" aria-label="Project"><option value="">All projects</option>${projects.map((p) => `<option value="${attr(p.key)}" ${f.project === p.key ? 'selected' : ''}>${esc(p.name)} (${p.sessions})</option>`).join('')}</select>
          <select id="f-sort" class="select" aria-label="Sort">${[['recent', 'Last active'], ['started', 'Started'], ['active', 'Active time'], ['tokens', 'Tokens'], ['prompts', 'Prompts']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn icon ${f.pinned ? 'on' : ''}" data-act="f-pinned" data-tip="Pinned only">${icon('pin')}</button>
          <button class="btn icon ${f.showHidden ? 'on' : ''}" data-act="f-hidden" data-tip="Show hidden sessions and folders">${icon('eye-off')}</button>
        </div>
        <div class="result-count"><span>${plural(list.length, 'session')}</span>${f.q || f.status !== 'all' || f.time !== 'any' || f.project || f.pinned ? '<button class="btn ghost sm" data-act="f-clear" style="height:18px;padding:0 4px">Clear filters</button>' : ''}<span style="margin-left:auto"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>Enter</kbd> resume, or go to a running session's terminal · <kbd>F</kbd> fork</span></div>
      </div>
      <div class="scroll" data-scroll="slist" id="slist">${body}</div>
    </div>
    <div class="pane detail" data-scroll="detail">${sel ? detailHtml(sel) : `<div class="detail-empty"><div><div class="big">Select a session</div>See where it left off, read the conversation, and resume or fork it.</div></div>`}</div>
  </div>`;
}

function detailHtml(id) {
  const s = S.byId.get(id);
  if (!s) return `<div class="detail-empty"><div><div class="big">Session not found</div>It may have been cleaned up by Claude Code.</div></div>`;
  const d = S.details[id];
  if (!d || d._rev !== S.rev) ensureDetail(id).then(() => { if (S.route.arg === id) render(); });
  const l = liveOf(id);
  const st = statusOf(s);
  const tab = s.archived && (S.tab === 'convo' || S.tab === 'files') ? 'prompts' : S.tab;
  const tabs = [
    ['overview', 'Overview', ''],
    ...(s.archived ? [] : [['convo', 'Conversation', fmtNum(s.assistantMsgs + s.prompts)]]),
    ['prompts', 'Prompts', fmtNum(s.prompts)],
    ...(s.archived ? [] : [['files', 'Files', fmtNum(s.files)]]),
  ];
  const actions = s.archived
    ? `<button class="btn primary" data-act="new-in" data-path="${attr(s.cwd)}">${icon('plus')}New session in this folder</button>
       <button class="btn" data-act="open-folder" data-path="${attr(s.cwd)}">${icon('folder')}Folder</button>
       <span class="sp"></span>
       <button class="btn icon ${s.pinned ? 'on' : ''}" data-act="pin" data-sid="${id}" data-tip="${s.pinned ? 'Unpin' : 'Pin'}">${icon('pin')}</button>
       <button class="btn icon" data-act="more" data-sid="${id}" aria-label="More actions">${icon('more')}</button>`
    : `<div class="split">
         ${l ? `<button class="btn primary" data-act="focus-term" data-sid="${id}" data-tip="It's running: bring its terminal tab to the front">${icon('terminal', 'sm')}Go to terminal</button>` : `<button class="btn primary" data-act="resume" data-sid="${id}">${icon('play', 'sm')}Resume</button>`}
         <button class="btn primary" data-act="resume-menu" data-sid="${id}" aria-label="Resume options">${icon('down', 'sm')}</button>
       </div>
       <button class="btn" data-act="fork" data-sid="${id}" data-tip="New session ID, same conversation so far">${icon('fork')}Fork</button>
       <button class="btn" data-act="open-folder" data-path="${attr(s.cwd)}" data-tip="${attr(s.cwd)}">${icon('folder')}Folder</button>
       ${S.data.meta.tools.code ? `<button class="btn" data-act="open-editor" data-path="${attr(s.cwd)}">${icon('code')}VS Code</button>` : ''}
       <button class="btn icon" data-act="copy-cmd" data-sid="${id}" data-tip="Copy resume command">${icon('terminal')}</button>
       <span class="sp"></span>
       ${s.remoteUrl ? `<a class="btn icon" href="${attr(s.remoteUrl)}" target="_blank" rel="noopener" data-tip="Open on claude.ai (remote control)">${icon('globe')}</a>` : ''}
       <button class="btn icon ${s.pinned ? 'on' : ''}" data-act="pin" data-sid="${id}" data-tip="${s.pinned ? 'Unpin' : 'Pin'} (P)">${icon('pin')}</button>
       <button class="btn icon" data-act="more" data-sid="${id}" aria-label="More actions">${icon('more')}</button>`;

  let body = '';
  if (tab === 'overview') body = detailOverview(s, d, l);
  else if (tab === 'convo') body = detailConvo(s);
  else if (tab === 'prompts') body = detailPrompts(s, d);
  else if (tab === 'files') body = detailFiles(s, d);

  return `
    <div class="d-head">
      <div class="top-line">${st === 'resumable' ? '<span class="pill">Resumable</span>' : statusPill(s)}<button class="chip mono" data-act="copy" data-text="${id}" data-tip="Copy session ID">${id.slice(0, 8)}</button>${s.tags && s.tags.length ? s.tags.map((t) => `<span class="chip tag">${esc(t)}</span>`).join('') : ''}<button class="btn ghost sm icon" data-act="close-detail" style="margin-left:auto" aria-label="Close">${icon('x', 'sm')}</button></div>
      <h2 class="d-title"><span>${esc(s.title)}</span><button class="btn ghost sm icon edit" data-act="rename" data-sid="${id}" data-tip="Rename (only in this launcher)">${icon('sliders', 'sm')}</button></h2>
      <div class="d-path">
        <span data-tip="Working directory">${icon('folder', 'xs')}<span class="mono">${esc(s.cwd || '?')}</span></span>
        ${s.gitBranch ? `<span>${icon('branch', 'xs')}${esc(s.gitBranch)}</span>` : ''}
        <span>${icon('clock', 'xs')}${esc(fmtDateTime(s.firstTs))} → ${esc(ago(s.lastTs))}</span>
      </div>
    </div>
    <div class="d-actions" style="margin-top:14px">${actions}</div>
    <div class="tabs" role="tablist">${tabs.map(([k, l2, n]) => `<button role="tab" class="${tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${l2}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
    <div class="d-body">${body}</div>`;
}

function detailOverview(s, d, l) {
  const t = s.tokens || {};
  const span = (s.lastTs || 0) - (s.firstTs || 0);
  const segs = s.segments || [];
  const strip = segs.length && span > 0 ? `<div class="today-mini"><div class="seg-line" style="height:22px">${segs.map(([a, b]) => `<i style="left:${((a - s.firstTs) / span) * 100}%;width:${Math.max(((b - a) / span) * 100, 0.5)}%;top:5px;height:12px" data-tip="${attr(`${fmtDateTime(a)} – ${fmtTime(b)} (${fmtDur(segDur(a, b))})`)}"></i>`).join('')}</div>
      <div class="axis"><span>${esc(fmtDateTime(s.firstTs))}</span><span>${esc(fmtDateTime(s.lastTs))}</span></div></div>` : '';
  const stat = (k, v, tip) => `<div class="stat" ${tip ? `data-tip="${attr(tip)}"` : ''}><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
  const stats = s.archived ? [
    stat('First prompt', esc(fmtDateTime(s.firstTs))),
    stat('Last prompt', esc(fmtDateTime(s.lastTs))),
    stat('Prompts', fmtNum(s.prompts)),
    stat('Active time', fmtDur(s.activeMs), 'Estimated from prompt timestamps'),
  ] : [
    stat('Started', esc(fmtDateTime(s.firstTs))),
    stat('Last active', esc(ago(s.lastTs)), fmtDateTime(s.lastTs)),
    stat('Active time', fmtDur(s.activeMs), `Sum of bursts of activity (gaps over ${settings().gapMinutes} min split them) across ${segs.length} sitting(s)`),
    stat('Your prompts', fmtNum(s.prompts)),
    stat('Claude replies', fmtNum(s.assistantMsgs)),
    stat('Tool calls', fmtNum(s.toolUses)),
    stat('Output tokens', fmtNum(t.out)),
    stat('Input tokens', `${fmtNum((t.in || 0) + (t.cr || 0) + (t.cw || 0))}`, `Fresh ${fmtNum(t.in)} · cache read ${fmtNum(t.cr)} · cache write ${fmtNum(t.cw)}`),
    stat('Context now', fmtNum(s.contextTokens), 'Tokens sent with the most recent request'),
    stat('Model', esc(shortModel(s.model)), s.model || ''),
    stat('Lines changed', s.linesAdded || s.linesRemoved ? `<span style="color:var(--live)">+${fmtNum(s.linesAdded)}</span> <span style="color:var(--danger)">−${fmtNum(s.linesRemoved)}</span>` : '—'),
    stat('Compactions', fmtNum(s.compactions)),
    stat('Subagents', fmtNum(s.subagents)),
    stat('Permission mode', esc(s.permissionMode || '—')),
    stat('Claude Code', esc(s.version || '—'), s.entrypoint ? `Entry point: ${s.entrypoint}` : ''),
    stat('Transcript', `${(s.size / 1048576).toFixed(1)} MB`),
  ];
  const tools = d && d.tools ? Object.entries(d.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ label: k, value: v })) : [];
  const cmds = d && d.commands ? Object.entries(d.commands).sort((a, b) => b[1] - a[1]) : [];
  const meta = (d && d.meta) || {};
  const links = [];
  // Parts of one conversation share a title, so label them by when they ran.
  const partSpan = (p) => (p ? `${fmtDateTime(p.firstTs)} – ${fmtDateTime(p.lastTs)}` : '');
  if (s.continuedFrom) { const p = S.byId.get(s.continuedFrom); links.push(`<button class="btn sm" data-act="open-session" data-sid="${s.continuedFrom}" data-tip="${attr(partSpan(p))}">${icon('left', 'sm')}Earlier part${p ? ' · ' + esc(fmtDate(p.firstTs)) : ''}</button>`); }
  if (s.continuedIn) { const p = S.byId.get(s.continuedIn); links.push(`<button class="btn sm" data-act="open-session" data-sid="${s.continuedIn}" data-tip="${attr(partSpan(p))}">${p && !p.supersededBy ? 'Latest part' : 'Next part'}${p ? ' · ' + esc(fmtDate(p.firstTs)) : ''}${icon('right', 'sm')}</button>`); }

  const head = s.supersededBy && S.byId.get(s.supersededBy);
  return `
    ${head ? `<div class="banner" style="margin:0">${icon('clock')}<span class="grow">An earlier part of a conversation that Claude Code continued in a newer session${s.copied ? ' (which includes everything here)' : ''}.</span><button class="btn sm" data-act="open-session" data-sid="${head.id}">Open latest${icon('right', 'sm')}</button></div>` : ''}
    ${l ? `<div class="banner" style="margin:0;background:var(--${l.status === 'waiting' ? 'wait' : l.status === 'busy' ? 'busy' : 'live'}-soft)">${icon('pulse')}<span class="grow">Running now in another terminal · <b>${esc(STATUS_LABEL[statusOf(s)])}</b>${l.waitingFor ? ' — ' + esc(l.waitingFor) : ''} · pid ${l.pid} · updated ${ago(l.updatedAt)}</span><button class="btn sm danger" data-act="stop" data-pid="${l.pid}">${icon('stop', 'sm')}Stop</button></div>` : ''}
    ${s.awaySummary || s.lastPrompt ? `<div>
      ${s.awaySummary ? `<div class="left-off" style="margin:0 0 8px;max-width:none"><b>WHERE IT LEFT OFF · ${esc(ago(s.awayTs).toUpperCase())}</b><p>${esc(s.awaySummary)}</p></div>` : ''}
      ${s.lastPrompt ? `<div class="left-off" style="margin:0;max-width:none"><b>YOUR LAST MESSAGE${s.lastUserTs ? ' · ' + esc(ago(s.lastUserTs).toUpperCase()) : ''}</b><p>${esc(s.lastPrompt)}</p></div>` : ''}
    </div>` : ''}
    ${s.firstPrompt && s.firstPrompt !== s.lastPrompt ? `<div class="left-off" style="margin:0;max-width:none"><b>HOW IT STARTED</b><p>${esc(s.firstPrompt)}</p></div>` : ''}
    ${strip ? `<section><h2 class="sec">Activity <span class="muted">${segs.length} sitting${segs.length === 1 ? '' : 's'} over ${fmtDur(span)}</span></h2>${strip}</section>` : ''}
    <div class="stats">${stats.join('')}</div>
    ${links.length ? `<div class="row" style="flex-wrap:wrap">${links.join('')}</div>` : ''}
    <section class="notes"><h2 class="sec">Notes &amp; tags <span class="muted">saved in the launcher only</span></h2>
      <textarea id="note-${s.id}" class="input" data-note="${s.id}" placeholder="What was this about? What's next?">${esc(meta.note || s.note || '')}</textarea>
      <div class="tag-edit" style="margin-top:8px">${(s.tags || []).map((t) => `<button class="chip tag" data-act="untag" data-sid="${s.id}" data-tag="${attr(t)}" data-tip="Remove tag">${esc(t)} ×</button>`).join('')}<input id="tag-${s.id}" class="input" data-tag-input="${s.id}" placeholder="Add tag + Enter"></div>
    </section>
    ${tools.length ? `<section><h2 class="sec">Tools Claude used</h2>${hbarList(tools)}</section>` : ''}
    ${cmds.length ? `<section><h2 class="sec">Commands you ran</h2><div class="row" style="flex-wrap:wrap;gap:6px">${cmds.map(([k, v]) => `<span class="chip mono">${esc(k)} ×${v}</span>`).join('')}</div></section>` : ''}
    ${d && d.artifacts && d.artifacts.length ? `<section><h2 class="sec">Artifacts</h2><div class="list-plain">${d.artifacts.map((a) => `<div class="li">${icon('external', 'sm')}<a href="${attr(a.url)}" target="_blank" rel="noopener" class="ellipsis">${esc(a.title)}</a><span class="muted" style="margin-left:auto">${ago(a.ts)}</span></div>`).join('')}</div></section>` : ''}`;
}

function detailConvo(s) {
  const t = S.transcripts[s.id];
  if (!t || (t.size !== s.size && !t.loading)) {
    ensureTranscript(s.id, t && t.all).then(() => { if (S.route.arg === s.id && S.tab === 'convo') render(); });
  }
  if (!t || (!t.entries && !t.error)) return '<div class="muted">Loading conversation…</div>';
  if (t.error) return `<div class="muted">Couldn't read transcript: ${esc(t.error)}</div>`;
  const showTools = S.convo.tools;
  let html = ''; let group = [];
  const flushGroup = () => {
    if (!group.length) return;
    html += showTools ? `<div class="tool-group">${group.join('')}</div>` : '';
    group = [];
  };
  t.entries.forEach((e, i) => {
    const k = `${s.id}:${t.total - t.entries.length + i}`;
    if (e.k === 'tool') {
      group.push(`<details class="tool ${e.err ? 'err' : ''}" data-k="${k}"><summary>${icon('terminal', 'xs')}<span class="name">${esc(e.name)}</span><span class="sum">${esc((e.summary || '').split('\n').pop())}</span>${e.err ? '<span class="pill" style="height:18px;color:var(--danger)">error</span>' : ''}</summary><pre>${esc(e.summary || '')}${e.result != null ? '\n\n── result ──\n' + esc(e.result) : ''}</pre></details>`);
      return;
    }
    flushGroup();
    if (e.k === 'user') html += `<div class="msg user ${e.cmd ? 'cmd' : ''}"><div class="mh"><span>You</span><span>${esc(fmtDateTime(e.ts))}</span></div>${esc(e.text)}</div>`;
    else if (e.k === 'assistant') html += `<div class="msg assistant"><div class="mh"><span>Claude</span><span>${esc(fmtTime(e.ts))}</span></div><div class="md">${md(e.text)}</div></div>`;
    else if (e.k === 'recap') html += `<div class="msg recap"><div class="mh"><span>Recap</span><span>${esc(fmtTime(e.ts))}</span></div>${esc(e.text)}</div>`;
    else html += `<div class="msg ${e.k}">— ${esc(e.text)} · ${esc(fmtDateTime(e.ts))} —</div>`;
  });
  flushGroup();
  const truncated = t.total > t.entries.length;
  return `<div class="convo-tools">
      <label class="check"><input type="checkbox" data-act="convo-tools" ${showTools ? 'checked' : ''}>Show tool calls</label>
      <span class="muted">${fmtNum(t.total)} entries</span>
      ${truncated ? `<button class="btn sm" data-act="convo-all" data-sid="${s.id}">Load earlier (${fmtNum(t.total - t.entries.length)})</button>` : ''}
      <button class="btn sm ghost" data-act="convo-end" style="margin-left:auto">Jump to end ↓</button>
    </div>
    ${truncated ? `<div class="msg compact">— ${fmtNum(t.total - t.entries.length)} earlier entries not shown —</div>` : ''}
    <div class="convo">${html || '<div class="muted">No messages.</div>'}</div>`;
}

function detailPrompts(s, d) {
  if (!d) return '<div class="muted">Loading…</div>';
  const ps = (d.prompts || []).slice().reverse();
  if (!ps.length) return '<div class="muted">No prompts recorded.</div>';
  return `<div class="stack">${ps.map((p, i) => `
    <div class="prompt-item ${p.c ? 'cmd' : ''}">
      <div class="h"><span class="tnum">#${ps.length - i}</span><span>${esc(fmtDateTime(p.ts))}</span>
        <span class="acts">
          <button class="btn ghost sm icon" data-act="copy" data-text="${attr(p.t)}" data-tip="Copy">${icon('copy', 'sm')}</button>
          ${p.c ? '' : `<button class="btn ghost sm" data-act="reuse-prompt" data-path="${attr(s.cwd)}" data-text="${attr(p.t)}" data-tip="Start a new session with this prompt">${icon('plus', 'sm')}Reuse</button>`}
        </span></div>
      <div class="b">${esc(p.t)}</div>
    </div>`).join('')}</div>`;
}

function detailFiles(s, d) {
  if (!d) return '<div class="muted">Loading…</div>';
  const files = d.files || [];
  if (!files.length) return '<div class="muted">Claude didn\'t edit or write any files in this session.</div>';
  const root = (s.cwd || '').replace(/[\\/]+$/, '').toLowerCase();
  return `<div class="muted" style="font-size:12px">Files Claude created or edited in this session.</div><div class="list-plain">${files.map((f) => {
    const rel = f.toLowerCase().startsWith(root + '\\') || f.toLowerCase().startsWith(root + '/') ? f.slice(root.length + 1) : f;
    return `<div class="li">${icon('file', 'sm')}<span class="mono ellipsis" data-tip="${attr(f)}">${esc(rel)}</span>
      <span class="acts">${S.data.meta.tools.code ? `<button class="btn ghost sm icon" data-act="open-editor" data-path="${attr(f)}" data-tip="Open in editor">${icon('code', 'sm')}</button>` : ''}<button class="btn ghost sm icon" data-act="reveal" data-path="${attr(f)}" data-tip="Show in Explorer">${icon('folder', 'sm')}</button><button class="btn ghost sm icon" data-act="copy" data-text="${attr(f)}" data-tip="Copy path">${icon('copy', 'sm')}</button></span></div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- Live

function viewLive() {
  const live = S.data.live;
  const now = Date.now();
  const ended = baseSessions().filter((s) => !s.archived && !liveOf(s.id) && now - (s.lastTs || 0) < DAY).slice(0, 12);
  return `<div class="page">
    <div class="page-h"><div><h1>Running now</h1><p>Claude Code processes running on this PC, refreshed every few seconds. <b>Go to terminal</b> jumps to its tab; Fork starts a copy with a new session ID.</p></div></div>
    ${recoveryBanner({ list: true })}
    ${live.length ? `<div class="live-grid">${live.map(liveCard).join('')}</div>` : emptyBox('Nothing is running', '<div>Sessions you start from here or from a terminal show up automatically.</div>')}
    <section style="margin-top:28px"><h2 class="sec">Ended in the last 24 hours <span class="muted">${ended.length}</span></h2>
      <div class="card recent-list">${ended.length ? ended.map((s) => sessionRow(s)).join('') : '<div class="muted" style="padding:14px">None.</div>'}</div></section>
  </div>`;
}

// ---------------------------------------------------------------- Timeline

function viewTimeline() {
  const d = S.data;
  const day = S.timelineDay;
  const from = parseDayKey(day); const to = from + DAY - 1;
  const counts = S.heatMetric === 'prompts' ? d.activity.histDays : d.activity.days;
  const sessions = baseSessions().filter((s) => (s.segments || []).some(([a, b]) => b >= from && a <= to));
  sessions.sort((a, b) => firstIn(a, from) - firstIn(b, from));
  const active = sessions.reduce((t, s) => t + activeInRange(s.segments, from, to), 0);
  const dayPrompts = S.history ? S.history.filter((e) => e.ts >= from && e.ts <= to).sort((a, b) => a.ts - b.ts) : null;
  if (!S.history) loadHistory();

  // Hour range: tight around activity, at least 6h.
  let h0 = 0; let h1 = 24;
  if (sessions.length) {
    const starts = sessions.flatMap((s) => s.segments.filter(([a, b]) => b >= from && a <= to).map(([a]) => Math.max(a, from)));
    const ends = sessions.flatMap((s) => s.segments.filter(([a, b]) => b >= from && a <= to).map(([, b]) => Math.min(b, to)));
    h0 = Math.max(0, Math.floor((Math.min(...starts) - from) / HOUR) - 1);
    h1 = Math.min(24, Math.ceil((Math.max(...ends) - from) / HOUR) + 1);
    if (h1 - h0 < 6) { h1 = Math.min(24, h0 + 6); h0 = Math.max(0, h1 - 6); }
  }
  const a = from + h0 * HOUR; const span = (h1 - h0) * HOUR;
  const pct = (t) => ((t - a) / span) * 100;
  const step = h1 - h0 > 12 ? 2 : 1;
  const ticks = []; for (let h = h0; h <= h1; h += step) ticks.push(h);
  const nowLine = dayStart(Date.now()) === from ? `<span class="now" style="left:${pct(Date.now())}%" data-tip="Now"></span>` : '';
  const grid = ticks.map((h) => `<span class="gl" style="left:${pct(from + h * HOUR)}%"></span>`).join('');
  const rows = sessions.map((s) => {
    const lv = liveOf(s.id);
    const segs = s.segments.filter(([x, y]) => y >= from && x <= to).map(([x, y]) => {
      const lo = Math.max(x, a); const hi = Math.min(y, a + span);
      return `<span class="seg ${lv && y > Date.now() - 10 * MIN ? 'live' : ''}" style="left:${pct(lo)}%;width:${Math.max(pct(hi) - pct(lo), 0.35)}%" data-tip="${attr(`${s.title}\n${fmtTime(x)} – ${fmtTime(y)} · ${fmtDur(segDur(x, y))}`)}"></span>`;
    }).join('');
    return `<div class="g-row" data-act="open-session" data-sid="${s.id}"><div class="lab"><div class="t ellipsis">${esc(s.title)}</div><div class="p ellipsis">${esc(baseName(s.cwd))} · ${fmtDur(activeInRange(s.segments, from, to))}</div></div><div class="g-track">${grid}${segs}${nowLine}</div></div>`;
  }).join('');
  const isToday = day === dayKey(Date.now());

  return `<div class="page">
    <div class="page-h"><div><h1>Timeline</h1><p>What was active, and when.</p></div>
      <div class="actions"><div class="seg"><button class="${S.heatMetric === 'prompts' ? 'on' : ''}" data-act="heat-metric" data-v="prompts" data-tip="Your prompts, from history.jsonl (covers deleted transcripts too)">Prompts</button><button class="${S.heatMetric === 'messages' ? 'on' : ''}" data-act="heat-metric" data-v="messages" data-tip="All messages in saved transcripts">Messages</button></div></div></div>
    <div class="card pad"><div class="heat-wrap">${heatmap(counts, { selected: day, fmtTip: (k, v) => `${dayLabel(parseDayKey(k))}, ${k}\n${v} ${S.heatMetric === 'prompts' ? 'prompts' : 'messages'}` })}</div>
      <div class="row" style="margin-top:8px"><span class="muted" style="font-size:12px">Click a day to see it below.</span><span class="legend" style="margin-left:auto">Less ${[0, 1, 2, 3, 4].map((i) => `<i style="background:var(--seq-${i})"></i>`).join('')} More</span></div></div>

    <div class="row" style="margin:24px 0 12px">
      <button class="btn icon" data-act="day-shift" data-v="-1" aria-label="Previous day">${icon('left')}</button>
      <button class="btn icon" data-act="day-shift" data-v="1" aria-label="Next day" ${isToday ? 'disabled' : ''}>${icon('right')}</button>
      <h2 class="sec" style="margin:0 6px">${esc(dayLabel(from))} <span class="muted">${esc(new Date(from).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}</span></h2>
      <span class="muted">${plural(sessions.length, 'session')} · ${fmtDur(active)} active${dayPrompts ? ` · ${plural(dayPrompts.length, 'prompt')}` : ''}</span>
      ${isToday ? '' : '<button class="btn sm ghost" data-act="day-today" style="margin-left:auto">Jump to today</button>'}
    </div>
    ${sessions.length ? `<div class="card gantt"><div class="g-axis"><div style="padding:6px 12px">Session</div><div class="ticks">${ticks.map((h) => `<span style="left:${pct(from + h * HOUR)}%">${String(h % 24).padStart(2, '0')}:00</span>`).join('')}</div></div>${rows}</div>` : emptyBox('No sessions on this day')}

    ${dayPrompts && dayPrompts.length ? `<section style="margin-top:24px"><h2 class="sec">Prompts on this day <span class="muted">${dayPrompts.length}</span></h2><div class="stack">${dayPrompts.map((e) => promptHistoryItem(e)).join('')}</div></section>` : ''}
  </div>`;
}
function firstIn(s, from) { const seg = s.segments.find(([, b]) => b >= from); return seg ? Math.max(seg[0], from) : Infinity; }

// ---------------------------------------------------------------- Projects

function viewProjects() {
  const P = S.proj;
  let list = S.data.projects.filter((p) => (P.empty || p.sessions) && (S.f.showHidden || !hiddenByPattern({ cwd: p.path })));
  if (P.q) { const q = P.q.toLowerCase(); list = list.filter((p) => p.path.toLowerCase().includes(q)); }
  const by = { recent: (a, b) => b.lastTs - a.lastTs, sessions: (a, b) => b.sessions - a.sessions, active: (a, b) => b.activeMs - a.activeMs, name: (a, b) => a.name.localeCompare(b.name) }[P.sort];
  list = list.slice().sort(by);
  return `<div class="page">
    <div class="page-h"><div><h1>Projects</h1><p>Every folder you've used Claude Code in on this PC.</p></div>
      <div class="actions"><button class="btn primary" data-act="new-session">${icon('plus')}New session…</button></div></div>
    <div class="toolbar" style="margin-bottom:16px">
      <div class="search-box" style="width:320px">${icon('search')}<input id="p-q" class="input" placeholder="Filter folders…" value="${attr(P.q)}"></div>
      <div class="seg">${[['recent', 'Recent'], ['sessions', 'Most sessions'], ['active', 'Most time'], ['name', 'Name']].map(([v, l]) => `<button class="${P.sort === v ? 'on' : ''}" data-act="p-sort" data-v="${v}">${l}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-act="p-empty" ${P.empty ? 'checked' : ''}>Include folders without saved sessions</label>
      <span class="muted" style="margin-left:auto">${plural(list.length, 'folder')}</span>
    </div>
    ${list.length ? `<div class="proj-grid">${list.map(projCard).join('')}</div>` : emptyBox('No folders match')}
  </div>`;
}

function projCard(p) {
  return `<div class="card proj ${p.exists ? '' : 'missing'}">
    <div class="n"><span class="ellipsis">${esc(p.name)}</span>${p.live ? `<span class="pill idle" style="height:18px"><span class="dot idle"></span>${p.live} running</span>` : ''}
      <span style="margin-left:auto;display:flex;gap:4px">${p.git ? '<span class="chip" data-tip="Git repository">git</span>' : ''}${p.claudeMd ? '<span class="chip" data-tip="Has CLAUDE.md">CLAUDE.md</span>' : ''}${p.exists ? '' : '<span class="chip" style="color:var(--danger)">missing</span>'}</span></div>
    <div class="path" data-tip="${attr(p.path)}"><bdi>${esc(p.path)}</bdi></div>
    <div class="m"><span>${plural(p.resumable, 'session')}${p.sessions > p.resumable ? ` <span data-tip="Archived: only prompts remain in history">+${p.sessions - p.resumable}</span>` : ''}</span><span>${fmtDur(p.activeMs)} active</span><span>${p.lastTs ? ago(p.lastTs) : 'never'}</span></div>
    <div class="acts">
      <button class="btn sm primary" data-act="new-in" data-path="${attr(p.path)}" ${p.exists ? '' : 'disabled'}>${icon('plus', 'sm')}New</button>
      ${p.lastSessionId ? `<button class="btn sm" data-act="resume" data-sid="${p.lastSessionId}" ${p.exists ? '' : 'disabled'} data-tip="${attr('Resume: ' + ((S.byId.get(p.lastSessionId) || {}).title || ''))}">${icon('play', 'xs')}Resume latest</button>` : ''}
      ${p.sessions ? `<button class="btn sm ghost" data-act="proj-sessions" data-key="${attr(p.key)}">Sessions</button>` : ''}
      <span style="margin-left:auto;display:flex;gap:4px">
        <button class="btn sm ghost icon" data-act="open-folder" data-path="${attr(p.path)}" data-tip="Open folder" ${p.exists ? '' : 'disabled'}>${icon('folder', 'sm')}</button>
        ${S.data.meta.tools.code ? `<button class="btn sm ghost icon" data-act="open-editor" data-path="${attr(p.path)}" data-tip="Open in VS Code" ${p.exists ? '' : 'disabled'}>${icon('code', 'sm')}</button>` : ''}
      </span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- Prompt history

async function loadHistory() {
  if (S.history || S._histLoading) return;
  S._histLoading = true;
  try {
    const r = await api('/api/history');
    S.history = r.entries.filter((e) => e.ts).sort((a, b) => b.ts - a.ts);
  } catch (e) { toast(e.message, 'err'); }
  S._histLoading = false;
  render();
}

function promptHistoryItem(e) {
  const s = e.s && S.byId.get(e.s);
  const isCmd = e.t.startsWith('/');
  return `<div class="prompt-item ${isCmd ? 'cmd' : ''}">
    <div class="h"><span class="tnum">${esc(fmtTime(e.ts))}</span><span class="chip" data-tip="${attr(e.p || '')}">${icon('folder')}${esc(baseName(e.p) || '?')}</span>
      ${s ? `<button class="chip" data-act="open-session" data-sid="${s.id}" data-tip="Open session">${icon('message')}<span class="ellipsis" style="max-width:240px">${esc(s.title)}</span></button>` : ''}
      <span class="acts">
        <button class="btn ghost sm icon" data-act="copy" data-text="${attr(e.t)}" data-tip="Copy">${icon('copy', 'sm')}</button>
        ${isCmd ? '' : `<button class="btn ghost sm" data-act="reuse-prompt" data-path="${attr(e.p || '')}" data-text="${attr(e.t)}">${icon('plus', 'sm')}Reuse</button>`}
        ${s && !s.archived ? `<button class="btn ghost sm icon" data-act="resume" data-sid="${s.id}" data-tip="Resume this session">${icon('play', 'xs')}</button>` : ''}
      </span></div>
    <div class="b">${esc(e.t)}</div></div>`;
}

function viewPrompts() {
  if (!S.history) { loadHistory(); return '<div class="page"><div class="muted">Loading prompt history…</div></div>'; }
  const P = S.prompts;
  let list = S.history;
  if (!P.cmds) list = list.filter((e) => !e.t.startsWith('/'));
  if (P.project) list = list.filter((e) => e.p && e.p.toLowerCase() === P.project);
  if (P.q) { const terms = P.q.toLowerCase().split(/\s+/).filter(Boolean); list = list.filter((e) => { const l = e.t.toLowerCase(); return terms.every((t) => l.includes(t)); }); }
  const projects = [...new Set(S.history.map((e) => e.p && e.p.toLowerCase()).filter(Boolean))].sort((a, b) => baseName(a).localeCompare(baseName(b)));
  const shown = list.slice(0, P.limit);
  let out = ''; let cur = null;
  for (const e of shown) {
    const k = dayStart(e.ts);
    if (k !== cur) { out += `<div class="day-h" style="padding-left:2px">${esc(dayLabel(e.ts))}</div>`; cur = k; }
    out += promptHistoryItem(e);
  }
  return `<div class="page" style="max-width:1000px">
    <div class="page-h"><div><h1>Prompt history</h1><p>Every prompt you've typed into Claude Code on this PC, including sessions whose transcripts were cleaned up.</p></div></div>
    <div class="toolbar" style="margin-bottom:12px">
      <div class="search-box grow">${icon('search')}<input id="h-q" class="input" placeholder="Search prompts…  ( / )" value="${attr(P.q)}"></div>
      <select id="h-project" class="select" style="max-width:220px"><option value="">All folders</option>${projects.map((p) => `<option value="${attr(p)}" ${P.project === p ? 'selected' : ''}>${esc(baseName(p))}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-act="h-cmds" ${P.cmds ? 'checked' : ''}>Include slash commands</label>
    </div>
    <div class="muted" style="margin-bottom:6px">${plural(list.length, 'prompt')}</div>
    <div class="stack" style="gap:6px">${out || emptyBox('No prompts match')}</div>
    ${list.length > shown.length ? `<div style="text-align:center;margin-top:16px"><button class="btn" data-act="h-more">Show more (${fmtNum(list.length - shown.length)} left)</button></div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- Insights

function viewInsights() {
  const d = S.data; const now = Date.now();
  const R = S.insightsRange;
  const from = R ? dayStart(now) - (R - 1) * DAY : Math.min(...d.sessions.map((s) => s.firstTs || now));
  const prevFrom = R ? from - R * DAY : null;
  const all = baseSessions();
  const inRange = all.filter((s) => (s.segments || []).some(([a, b]) => b >= from));
  const active = inRange.reduce((t, s) => t + activeInRange(s.segments, from, now), 0);
  const prevActive = R ? all.reduce((t, s) => t + activeInRange(s.segments, prevFrom, from - 1), 0) : null;
  const prompts = Object.entries(d.activity.histDays).filter(([k]) => parseDayKey(k) >= from).reduce((t, [, v]) => t + v, 0);
  const prevPrompts = R ? Object.entries(d.activity.histDays).filter(([k]) => { const t = parseDayKey(k); return t >= prevFrom && t < from; }).reduce((t, [, v]) => t + v, 0) : null;
  const outTok = inRange.filter((s) => !s.archived).reduce((t, s) => t + (s.tokens.out || 0), 0);
  const delta = (cur, prev, fmt) => (prev == null ? '' : prev === 0 ? (cur ? 'new this period' : '') : `${cur >= prev ? '▲' : '▼'} ${Math.abs(Math.round(((cur - prev) / prev) * 100))}% vs previous ${R} days${fmt ? ` (${fmt(prev)})` : ''}`);

  // Active time per day
  const nDays = R || Math.min(365, Math.ceil((now - from) / DAY) + 1);
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const a = dayStart(now - i * DAY); const b = a + DAY - 1;
    const v = all.reduce((t, s) => t + activeInRange(s.segments, a, b), 0);
    days.push({ label: new Date(a).toLocaleDateString(undefined, nDays > 60 ? { month: 'short' } : { day: 'numeric', month: 'short' }), value: v / HOUR, tip: `${dayLabel(a)}, ${fmtDate(a, true)}\n${fmtDur(v)} active`, key: dayKey(a) });
  }
  const hours = d.activity.hours.map((v, h) => ({ label: String(h).padStart(2, '0'), value: v, tip: `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59\n${v} prompts (all time)` }));
  const projMap = new Map();
  for (const s of inRange) { const k = s.projectKey; const cur = projMap.get(k) || { label: baseName(s.cwd), value: 0, n: 0, path: s.cwd }; cur.value += activeInRange(s.segments, from, now); cur.n++; projMap.set(k, cur); }
  const topProj = [...projMap.values()].sort((a, b) => b.value - a.value).slice(0, 10).map((p) => ({ ...p, display: fmtDur(p.value), tip: `${p.path}\n${fmtDur(p.value)} across ${plural(p.n, 'session')}` }));
  const tools = Object.entries(d.activity.tools).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ label: k, value: v }));
  const models = Object.entries(d.activity.models).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ label: shortModel(k), value: v, tip: `${k}: ${fmtNum(v)} replies` }));
  const cw = Math.max(320, (document.getElementById('view').clientWidth - 56 - 34) / 2 - 34);
  const wide = Math.max(320, document.getElementById('view').clientWidth - 56 - 34);

  return `<div class="page">
    <div class="page-h"><div><h1>Insights</h1><p>How you've been using Claude Code on this PC.</p></div>
      <div class="actions"><div class="seg">${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']].map(([v, l]) => `<button class="${R === v ? 'on' : ''}" data-act="ins-range" data-v="${v}">${l}</button>`).join('')}</div></div></div>
    <div class="kpis">
      <div class="card kpi"><div class="k">Active time</div><div class="v">${fmtDur(active)}</div><div class="d">${esc(delta(active, prevActive, fmtDur))}</div></div>
      <div class="card kpi"><div class="k">Sessions with activity</div><div class="v">${fmtNum(inRange.length)}</div><div class="d">${plural(new Set(inRange.map((s) => s.projectKey)).size, 'project')}</div></div>
      <div class="card kpi"><div class="k">Prompts typed</div><div class="v">${fmtNum(prompts)}</div><div class="d">${esc(delta(prompts, prevPrompts, fmtNum))}</div></div>
      <div class="card kpi"><div class="k">Output tokens</div><div class="v">${fmtNum(outTok)}</div><div class="d">from sessions active in this period</div></div>
    </div>
    <div class="card pad chart" style="margin-top:16px"><h2 class="sec">Active hours per day</h2>${barChart(days, { width: wide, height: 190, fmt: (v) => (v >= 1 || v === 0 ? `${Math.round(v * 10) / 10}h` : `${Math.round(v * 60)}m`), label: 'Active hours per day', labelEvery: Math.ceil(days.length / 10), onClick: true })}</div>
    <div class="charts-2" style="margin-top:16px">
      <div class="card pad chart"><h2 class="sec">When you work <span class="muted">prompts by hour, all time</span></h2>${barChart(hours, { width: cw, height: 170, label: 'Prompts by hour of day', labelEvery: 3 })}</div>
      <div class="card pad"><h2 class="sec">Where your time went</h2>${hbarList(topProj)}</div>
      <div class="card pad"><h2 class="sec">Tools Claude used most <span class="muted">all time</span></h2>${hbarList(tools)}</div>
      <div class="card pad"><h2 class="sec">Models <span class="muted">replies, all time</span></h2>${hbarList(models)}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- Settings

function viewSettings() {
  const st = settings(); const m = S.data.meta;
  const sel = (id, opts, v) => `<select id="${id}" class="select" data-setting="${id.replace(/^s-/, '')}">${opts.map(([val, l]) => `<option value="${attr(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return `<div class="page">
    <div class="page-h"><div><h1>Settings</h1><p>Stored in the launcher's own app data. Nothing in your Claude Code config is changed.</p></div></div>
    <div class="settings-grid">
      <div class="card"><h3>Launching</h3>
        <div class="fields-2">
          <div class="field"><label for="s-terminal">Open sessions in</label>${sel('s-terminal', TERMINALS.filter(([v]) => v !== 'desktop').map(([v, l]) => [v, l + (v.startsWith('wt') && !m.tools.wt ? ' (not installed)' : '')]), st.terminal)}</div>
          <div class="field"><label for="s-shell">Shell</label>${sel('s-shell', [['powershell', 'Windows PowerShell'], ['pwsh', 'PowerShell 7' + (m.tools.pwsh ? '' : ' (not installed)')]], st.shell)}</div>
          <div class="field"><label for="s-claudePath">Claude command</label><input id="s-claudePath" class="input" data-setting="claudePath" value="${attr(st.claudePath)}"><span class="hint">Command or full path to the claude executable.</span></div>
          <div class="field"><label for="s-editor">Editor command</label><input id="s-editor" class="input" data-setting="editor" value="${attr(st.editor)}"><span class="hint">Used by "Open in VS Code" (e.g. code, cursor).</span></div>
        </div>
        <label class="check"><input type="checkbox" data-setting="keepShellOpen" ${st.keepShellOpen ? 'checked' : ''}>Keep the terminal open after Claude exits</label>
      </div>
      <div class="card"><h3>Defaults for new and resumed sessions</h3>
        <div class="fields-3">
          <div class="field"><label for="s-defaultModel">Model</label><input id="s-defaultModel" class="input" data-setting="defaultModel" list="models-dl" placeholder="Claude Code default" value="${attr(st.defaultModel)}"></div>
          <div class="field"><label for="s-defaultPermissionMode">Permission mode</label>${sel('s-defaultPermissionMode', PERMISSION_MODES.map(([v, l]) => [v, v ? l : 'Claude Code default']), st.defaultPermissionMode)}</div>
          <div class="field"><label for="s-defaultEffort">Effort</label>${sel('s-defaultEffort', EFFORTS, st.defaultEffort)}</div>
        </div>
        <label class="check"><input type="checkbox" data-setting="defaultRemoteControl" ${st.defaultRemoteControl ? 'checked' : ''}>Turn on Remote Control (continue from phone/web)</label>
        <datalist id="models-dl">${MODELS.filter(Boolean).map((x) => `<option value="${x}">`).join('')}</datalist>
      </div>
      <div class="card"><h3>Sessions</h3>
        <div class="fields-2">
          <div class="field"><label for="s-gapMinutes">Idle gap that splits sittings (minutes)</label><input id="s-gapMinutes" type="number" min="1" max="240" class="input" data-setting="gapMinutes" value="${st.gapMinutes}"><span class="hint">Applies to newly indexed activity. Rebuild the index to apply it to everything.</span></div>
          <div class="field"><span class="lab">Theme</span><div class="seg">${['system', 'dark', 'light'].map((t) => `<button class="${st.theme === t ? 'on' : ''}" data-act="theme" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
        </div>
        <label class="check"><input type="checkbox" data-setting="showArchived" ${st.showArchived ? 'checked' : ''}>Show archived sessions (transcript deleted, prompts kept in history)</label>
        <div class="field"><label for="s-hidePatterns">Hide sessions from folders containing</label><textarea id="s-hidePatterns" class="input" rows="3" data-setting="hidePatterns">${esc((st.hidePatterns || []).join('\n'))}</textarea><span class="hint">One per line. Use the eye button in Sessions to show them anyway.</span></div>
      </div>
      <div class="card"><h3>Data</h3>
        <div class="dim">Reading from <span class="mono">${esc(m.claudeDir)}</span> · Claude Code ${esc(m.claudeVersion || 'not found')}</div>
        <div class="row" style="flex-wrap:wrap">
          <button class="btn" data-act="open-claude-dir">${icon('folder')}Open .claude folder</button>
          <button class="btn" data-act="rebuild">${icon('refresh')}Rebuild index</button>
          <button class="btn" data-act="quit">${icon('x')}Quit launcher</button>
        </div>
        ${S.data.launches.length ? `<div><div class="lab" style="font-size:12px;color:var(--text-2);margin-bottom:6px">Recent launches</div><div class="list-plain">${S.data.launches.slice(0, 10).map((l) => `<div class="li" style="font-size:12px"><span class="tnum muted nowrap">${esc(fmtDateTime(l.at))}</span><span class="chip">${esc(l.mode)}</span><span class="ellipsis">${esc(l.title || (l.sessionId && (S.byId.get(l.sessionId) || {}).title) || baseName(l.cwd))}</span><span class="muted" style="margin-left:auto">${esc(l.how)}</span></div>`).join('')}</div></div>` : ''}
      </div>
      <div class="card"><h3>Attention bubble &amp; background</h3>
        <div class="dim" style="font-size:13px">A small floating bubble shows when a Claude Code session is waiting on you. Click it to jump to that terminal tab. Drag it anywhere; it snaps to the screen edge.</div>
        <label class="check"><input type="checkbox" data-setting="bubble" ${st.bubble ? 'checked' : ''}>Show the floating bubble</label>
        <label class="check"><input type="checkbox" data-setting="bubbleFinished" ${st.bubbleFinished ? 'checked' : ''}>Also flag sessions that finished their work (green)</label>
        <label class="check"><input type="checkbox" data-setting="bubbleAutoHide" ${st.bubbleAutoHide ? 'checked' : ''}>Hide the bubble when nothing needs me</label>
        <label class="check"><input type="checkbox" data-setting="notifyAttention" ${st.notifyAttention ? 'checked' : ''}>Windows notification when a session needs me</label>
        <label class="check"><input type="checkbox" data-setting="runInBackground" ${st.runInBackground ? 'checked' : ''}>Keep running in the tray when the window is closed</label>
        <label class="check"><input type="checkbox" data-setting="startWithWindows" ${st.startWithWindows ? 'checked' : ''} ${m.update && m.update.kind === 'dev' ? 'disabled' : ''}>Start with Windows (tray and bubble only)</label>
        ${st.bubblePos ? '<div><button class="btn sm ghost" data-act="bubble-reset">Move bubble back to its default spot</button></div>' : ''}
      </div>
      <div class="card"><h3>Updates</h3>
        ${(() => { const u = m.update || {}; const kinds = { installer: 'installed with the setup program', script: 'installed with install.ps1', portable: 'portable copy', dev: 'running from source' };
          return `<div class="dim">ReCode ${esc(u.current || '')} · ${esc(kinds[u.kind] || '')}${u.checkedAt ? ` · checked ${esc(ago(u.checkedAt))}` : ''}</div>
          ${u.available ? `<div class="row" style="gap:8px"><span class="pill update">${icon('down', 'xs')}${esc(u.latest.version)} is available</span><button class="btn sm primary" data-act="update-open">See what's new</button></div>` : u.error ? `<div class="err-box">${esc(u.error)}</div>` : u.checkedAt ? '<div class="muted" style="font-size:13px">You have the latest version.</div>' : ''}`; })()}
        <div class="fields-2">
          <div class="field"><label for="s-updateChannel">Release channel</label>${sel('s-updateChannel', [['auto', 'Automatic (match this version)'], ['stable', 'Stable releases only'], ['rc', 'Include release candidates']], st.updateChannel)}</div>
        </div>
        <label class="check"><input type="checkbox" data-setting="autoUpdateCheck" ${st.autoUpdateCheck ? 'checked' : ''}>Check GitHub for new versions automatically</label>
        <div class="row" style="gap:8px"><button class="btn" data-act="update-check">${icon('refresh')}Check now</button><button class="btn ghost" data-act="open-url" data-url="${attr((m.update && m.update.releasesPage) || 'https://github.com/nebula3141/recode/releases')}">${icon('external', 'sm')}All releases</button></div>
      </div>
      <div class="card"><h3>Keyboard</h3>
        <div class="dim" style="line-height:2"><kbd>Ctrl K</kbd> search everything · <kbd>N</kbd> new session · <kbd>/</kbd> focus search · <kbd>J</kbd>/<kbd>K</kbd> move in lists · <kbd>Enter</kbd> resume · <kbd>F</kbd> fork · <kbd>P</kbd> pin · <kbd>O</kbd> open folder · <kbd>Esc</kbd> close</div>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- launching

function defaultsFromSettings() {
  const st = settings();
  return { model: st.defaultModel || '', permissionMode: st.defaultPermissionMode || '', effort: st.defaultEffort || '', remoteControl: !!st.defaultRemoteControl, terminal: st.terminal };
}

let lastLaunch = { key: '', at: 0 };
async function doLaunch(opts) {
  const o = { ...opts };
  if (o.terminal === 'desktop') { o.target = 'desktop'; delete o.terminal; }
  // Safety net: the same launch twice within 1.5 s is a double-click, not intent.
  const key = JSON.stringify(o);
  if (key === lastLaunch.key && Date.now() - lastLaunch.at < 1500) return false;
  lastLaunch = { key, at: Date.now() };
  try {
    const r = await api('/api/launch', { body: o });
    const where = { 'wt-tab': 'a Windows Terminal tab', 'wt-window': 'a new Windows Terminal window', console: 'a PowerShell window', desktop: 'the Claude desktop app', terminal: 'a terminal' }[r.how] || r.how;
    toast(`${o.mode === 'fork' ? 'Forked' : o.mode === 'resume' ? 'Resumed' : o.mode === 'continue' ? 'Continued' : 'Started'} in ${where}`);
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

// Brings a running session's terminal tab to the front.
let goBusy = null;
async function goToSession(id) {
  if (goBusy === id) return; // a double-click shouldn't send two requests
  goBusy = id;
  try {
    const r = await api('/api/focus', { body: { sessionId: id } });
    if (r.result === 'none') toast(liveOf(id) ? "Couldn't find its terminal window. It may be running somewhere ReCode can't switch to." : 'This session is no longer running', 'err');
  } catch (e) { toast(e.message, 'err'); }
  finally { goBusy = null; }
}

async function resumeSession(id, { fork = false, force = false } = {}) {
  const s = S.byId.get(id);
  if (!s || s.archived) return toast('This session has no transcript to resume', 'err');
  const l = liveOf(id);
  if (l && !fork && !force) {
    const v = await confirmDialog({
      title: 'This session is already running',
      body: `It's open in another terminal (pid ${l.pid}, ${esc(STATUS_LABEL[statusOf(s)].toLowerCase())}). Resuming it again gives you two windows writing to the same conversation. Go to that terminal instead, or fork to get a copy with a new session ID.`,
      ok: 'Go to its terminal', alt: 'Fork instead',
    });
    if (v === 'ok') return goToSession(id);
    if (v === 'alt') fork = true; else return;
  }
  return doLaunch({ ...defaultsFromSettings(), mode: fork ? 'fork' : 'resume', sessionId: id, cwd: s.cwd, title: s.title });
}

function launchDialog(init = {}) {
  const st = settings();
  const s = init.sessionId ? S.byId.get(init.sessionId) : null;
  const o = { ...defaultsFromSettings(), mode: s ? 'resume' : 'new', cwd: s ? s.cwd : '', name: '', prompt: '', addDirs: [], extraArgs: '', chrome: false, ide: false, ...init };
  const modes = s ? [['resume', 'Resume'], ['fork', 'Fork (new ID)']] : [['new', 'New session'], ['continue', 'Continue latest in folder']];
  const presetId = init.presetId || null;

  const m = openModal(`
    <div class="mh"><div><h3>${s ? 'Resume with options' : presetId ? 'Edit preset' : 'New session'}</h3><p>${s ? esc(s.title) : 'Start Claude Code in any folder.'}</p></div><button class="btn ghost icon x" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="mb">
      <div class="seg" id="l-mode">${modes.map(([v, l]) => `<button type="button" data-v="${v}" class="${o.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${s ? '' : `<div class="field"><label for="l-cwd">Folder</label><div class="row"><div class="ac-wrap grow"><input id="l-cwd" class="input" placeholder="E:\\Proj\\my-app or a project name" value="${attr(o.cwd)}" autofocus><div class="ac" id="l-ac" role="listbox" hidden></div></div><button class="btn" type="button" id="l-browse">${icon('folder')}Browse…</button></div>
        <span class="hint ac-hint"></span></div>`}
      <div class="fields-2">
        <div class="field"><label for="l-name">Session name</label><input id="l-name" class="input" placeholder="${s ? 'Keep current name' : 'Optional'}" value="${attr(o.name)}"></div>
        <div class="field"><label for="l-model">Model</label><input id="l-model" class="input" list="l-models" placeholder="Claude Code default" value="${attr(o.model)}"><datalist id="l-models">${MODELS.filter(Boolean).map((x) => `<option value="${x}">`).join('')}</datalist></div>
        <div class="field"><label for="l-perm">Permission mode</label><select id="l-perm" class="select">${PERMISSION_MODES.map(([v, l]) => `<option value="${v}" ${o.permissionMode === v ? 'selected' : ''}>${v ? l : 'Claude Code default'}</option>`).join('')}</select></div>
        <div class="field"><label for="l-effort">Effort</label><select id="l-effort" class="select">${EFFORTS.map(([v, l]) => `<option value="${v}" ${o.effort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="l-prompt">${s ? 'Message to send on resume' : 'First prompt'}</label><textarea id="l-prompt" class="input" rows="3" placeholder="Optional">${esc(o.prompt)}</textarea></div>
      <div class="row" style="flex-wrap:wrap;gap:16px">
        <label class="check"><input type="checkbox" id="l-rc" ${o.remoteControl ? 'checked' : ''}>Remote Control</label>
        <label class="check"><input type="checkbox" id="l-chrome" ${o.chrome ? 'checked' : ''}>Claude in Chrome</label>
        <label class="check"><input type="checkbox" id="l-ide" ${o.ide ? 'checked' : ''}>Connect to IDE</label>
      </div>
      <details ${o.addDirs.length || o.extraArgs ? 'open' : ''}><summary class="muted" style="cursor:pointer">More options</summary>
        <div class="stack" style="margin-top:10px">
          <div class="field"><label for="l-dirs">Extra directories Claude can access</label><textarea id="l-dirs" class="input" rows="2" placeholder="One path per line">${esc(o.addDirs.join('\n'))}</textarea></div>
          <div class="field"><label for="l-extra">Extra CLI arguments</label><input id="l-extra" class="input mono" placeholder="--verbose --mcp-config .\\mcp.json" value="${attr(o.extraArgs)}"><span class="hint">Passed to claude as typed.</span></div>
        </div></details>
      <div class="field"><label for="l-term">Open in</label><select id="l-term" class="select">${TERMINALS.map(([v, l]) => `<option value="${v}" ${o.terminal === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="cmd-preview"><code id="l-cmd">…</code><button class="btn ghost sm icon" type="button" id="l-copy" data-tip="Copy command">${icon('copy', 'sm')}</button></div>
    </div>
    <div class="mf">
      ${s ? '' : `<button class="btn ghost" type="button" id="l-preset">${presetId ? 'Update preset' : 'Save as preset'}</button>${presetId ? `<button class="btn ghost danger" type="button" id="l-preset-del">${icon('trash', 'sm')}</button>` : ''}`}
      <span class="sp"></span>
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" id="l-go">${icon('play', 'sm')}Launch</button>
    </div>`);
  const el = m.el;
  const $ = (id) => el.querySelector('#' + id);
  const read = () => {
    const r = {
      mode: o.mode, sessionId: s ? s.id : undefined,
      cwd: s ? s.cwd : ($('l-cwd').value || '').trim().replace(/^"|"$/g, ''),
      name: $('l-name').value.trim(), model: $('l-model').value.trim(), permissionMode: $('l-perm').value, effort: $('l-effort').value,
      prompt: $('l-prompt').value, remoteControl: $('l-rc').checked, chrome: $('l-chrome').checked, ide: $('l-ide').checked,
      addDirs: $('l-dirs').value.split('\n').map((x) => x.trim()).filter(Boolean), extraArgs: $('l-extra').value.trim(),
      terminal: $('l-term').value, title: s ? s.title : undefined,
    };
    return r;
  };
  let t = null;
  const preview = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const r = read();
      if (!r.cwd) { $('l-cmd').textContent = 'Choose a folder'; return; }
      try { const c = await api('/api/command', { body: r }); $('l-cmd').textContent = c.command; } catch (e) { $('l-cmd').textContent = e.message; }
    }, 150);
  };
  el.addEventListener('input', preview);
  el.addEventListener('change', preview);
  $('l-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    o.mode = b.dataset.v;
    $('l-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    preview();
  });
  $('l-copy').addEventListener('click', () => copyText($('l-cmd').textContent, 'Command copied'));
  const ac = $('l-cwd') ? attachFolderComplete($('l-cwd'), () => preview()) : null;
  if ($('l-browse')) $('l-browse').addEventListener('click', async () => {
    $('l-browse').disabled = true;
    try { const r = await api('/api/pick-folder', { body: { initial: $('l-cwd').value } }); if (r.path) { $('l-cwd').value = r.path; preview(); if (ac) ac.refresh(); } }
    catch (e) { toast(e.message, 'err'); }
    $('l-browse').disabled = false;
  });
  if ($('l-preset')) $('l-preset').addEventListener('click', async () => {
    const r = read();
    if (!r.cwd) return toast('Choose a folder first', 'err');
    const label = await promptDialog({ title: presetId ? 'Update preset' : 'Save as preset', label: 'Preset name', hint: 'Presets appear on Home for one-click launching.', value: init.presetLabel || r.name || baseName(r.cwd), ok: 'Save' });
    if (!label) return;
    delete r.sessionId; delete r.title;
    await api('/api/presets', { body: { id: presetId || undefined, label, opts: r } });
    toast('Preset saved'); m.close(); loadState();
  });
  if ($('l-preset-del')) $('l-preset-del').addEventListener('click', async () => {
    await api(`/api/presets/${presetId}`, { method: 'DELETE' }); toast('Preset deleted'); m.close(); loadState();
  });
  const go2 = async () => {
    const r = read();
    if (!r.cwd) return toast('Choose a folder', 'err');
    $('l-go').disabled = true;
    if (await doLaunch(r)) m.close(); else $('l-go').disabled = false;
  };
  $('l-go').addEventListener('click', go2);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go2(); } });
  preview();
}

// ---------------------------------------------------------------- command palette

function openPalette() {
  const m = openModal(`<div class="pin">${icon('search')}<input id="pal-q" placeholder="Search sessions, projects, actions…" autocomplete="off" autofocus><kbd>Esc</kbd></div><div class="res" id="pal-res"></div>
    <div class="foot"><span><kbd>↵</kbd> resume / run</span><span><kbd>Shift ↵</kbd> open details</span><span><kbd>↑</kbd><kbd>↓</kbd> move</span></div>`, { cls: 'palette' });
  const input = m.el.querySelector('#pal-q'); const res = m.el.querySelector('#pal-res');
  let items = []; let idx = 0;
  const actions = [
    { t: 'New session…', s: 'Start Claude Code in a folder', icon: 'plus', run: () => launchDialog() },
    ...VIEWS.map((v) => ({ t: `Go to ${v.label}`, s: '', icon: v.icon, run: () => go(v.id) })),
    { t: 'Go to Settings', s: '', icon: 'settings', run: () => go('settings') },
    { t: 'Refresh sessions', s: 'Re-read ~/.claude', icon: 'refresh', run: () => refresh() },
    { t: 'Rebuild index', s: 'Re-parse every transcript', icon: 'refresh', run: () => rebuild() },
  ];
  const build = () => {
    const q = input.value.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const match = (txt) => terms.every((t) => txt.toLowerCase().includes(t));
    const sess = baseSessions({ includeHidden: true }).filter((s) => !q || match(`${s.title} ${s.cwd} ${s.lastPrompt} ${s.id} ${(s.tags || []).join(' ')}`)).slice(0, q ? 10 : 6)
      .map((s) => ({ kind: 'Sessions', t: s.title, s: `${baseName(s.cwd)} · ${ago(s.lastTs)}${liveOf(s.id) ? ' · running' : ''}${s.archived ? ' · archived' : ''}`, icon: s.archived ? 'message' : 'play', k: s.archived ? 'details' : liveOf(s.id) ? 'go to terminal' : 'resume',
        run: () => (s.archived ? go('sessions', s.id) : liveOf(s.id) ? goToSession(s.id) : resumeSession(s.id)), alt: () => go('sessions', s.id) }));
    const projs = S.data.projects.filter((p) => p.exists && (!q || match(p.path))).slice(0, q ? 6 : 3)
      .map((p) => ({ kind: 'Projects', t: p.name, s: p.path, icon: 'folder', k: 'new session', run: () => launchDialog({ cwd: p.path }), alt: () => { S.f.project = p.key; go('sessions'); } }));
    const acts = actions.filter((a) => !q || match(a.t + ' ' + a.s)).map((a) => ({ ...a, kind: 'Actions', k: '' }));
    items = [...sess, ...projs, ...acts];
    idx = Math.min(idx, Math.max(0, items.length - 1));
    let html = ''; let last = null;
    items.forEach((it, i) => {
      if (it.kind !== last) { html += `<div class="grp">${it.kind}</div>`; last = it.kind; }
      html += `<div class="it ${i === idx ? 'on' : ''}" data-i="${i}">${icon(it.icon)}<div class="grow"><div class="t ellipsis">${esc(it.t)}</div>${it.s ? `<div class="s ellipsis">${esc(it.s)}</div>` : ''}</div><span class="k">${esc(it.k || '')}</span></div>`;
    });
    res.innerHTML = html || '<div class="muted" style="padding:16px">No matches.</div>';
  };
  const choose = (alt) => { const it = items[idx]; if (!it) return; m.close(); (alt && it.alt ? it.alt : it.run)(); };
  input.addEventListener('input', () => { idx = 0; build(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); build(); res.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); build(); res.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(e.shiftKey); }
  });
  res.addEventListener('mousemove', (e) => { const it = e.target.closest('.it'); if (it && Number(it.dataset.i) !== idx) { idx = Number(it.dataset.i); res.querySelectorAll('.it').forEach((x) => x.classList.toggle('on', Number(x.dataset.i) === idx)); } });
  res.addEventListener('click', (e) => { const it = e.target.closest('.it'); if (it) { idx = Number(it.dataset.i); choose(e.shiftKey); } });
  build();
}

// ---------------------------------------------------------------- actions

async function setMeta(id, patch) {
  try {
    const r = await api(`/api/meta/${id}`, { body: patch });
    const s = S.byId.get(id);
    if (s) Object.assign(s, { pinned: !!r.meta.pinned, hidden: !!r.meta.hidden, note: r.meta.note || '', tags: r.meta.tags || [], alias: r.meta.alias || '' });
    if (s && 'alias' in patch) s.title = r.meta.alias || s.customTitle || s.agentName || s.aiTitle || s.firstPrompt.slice(0, 90) || 'Untitled session';
    if (S.details[id]) S.details[id].meta = r.meta;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

async function refresh() { await loadState(); toast('Sessions refreshed'); }
async function rebuild() { toast('Rebuilding index…'); try { await api('/api/rebuild', { body: {} }); S.details = {}; S.transcripts = {}; await loadState(); toast('Index rebuilt'); } catch (e) { toast(e.message, 'err'); } }
async function osOpen(kind, p) { try { await api('/api/open', { body: { kind, path: p } }); } catch (e) { toast(e.message, 'err'); } }

const ACTIONS = {
  nav: (el) => go(el.dataset.view),
  'new-session': () => launchDialog(),
  'new-in': (el) => launchDialog({ cwd: el.dataset.path }),
  'reuse-prompt': (el) => launchDialog({ cwd: el.dataset.path, prompt: el.dataset.text }),
  resume: (el) => resumeSession(el.dataset.sid),
  'resume-live': (el) => resumeSession(el.dataset.sid),
  fork: (el) => resumeSession(el.dataset.sid, { fork: true }),
  'resume-opts': (el) => launchDialog({ sessionId: el.dataset.sid }),
  'resume-menu': (el) => {
    const id = el.dataset.sid; const s = S.byId.get(id);
    openMenu(el, [
      ...(liveOf(id) ? [{ label: 'Go to its terminal', icon: 'terminal', run: () => goToSession(id) }, { label: 'Resume a second copy', icon: 'play', run: () => resumeSession(id, { force: true }) }, '-'] : []),
      { label: 'Resume with options…', icon: 'sliders', run: () => launchDialog({ sessionId: id }) },
      { label: 'Fork with options…', icon: 'fork', run: () => launchDialog({ sessionId: id, mode: 'fork' }) },
      { label: 'Resume in a new window', icon: 'terminal', run: () => doLaunch({ ...defaultsFromSettings(), mode: 'resume', sessionId: id, cwd: s.cwd, title: s.title, terminal: 'wt-window' }) },
      { label: 'Open in Claude desktop app', icon: 'desktop', run: () => doLaunch({ mode: 'resume', sessionId: id, cwd: s.cwd, terminal: 'desktop' }) },
      '-',
      { label: 'Copy resume command', icon: 'copy', run: () => ACTIONS['copy-cmd'](el) },
    ]);
  },
  'copy-cmd': async (el) => {
    const s = S.byId.get(el.dataset.sid);
    try { const r = await api('/api/command', { body: { mode: 'resume', sessionId: s.id, cwd: s.cwd } }); copyText(r.command, 'Resume command copied'); } catch (e) { toast(e.message, 'err'); }
  },
  'open-session': (el) => { if (el.dataset.sid) go('sessions', el.dataset.sid); },
  'close-detail': () => go('sessions'),
  'open-folder': (el) => osOpen('folder', el.dataset.path),
  'open-editor': (el) => osOpen('editor', el.dataset.path),
  reveal: (el) => osOpen('reveal', el.dataset.path),
  'open-claude-dir': () => osOpen('claude-dir'),
  copy: (el) => copyText(el.dataset.text),
  pin: (el) => { const s = S.byId.get(el.dataset.sid); setMeta(s.id, { pinned: !s.pinned }); },
  untag: (el) => { const s = S.byId.get(el.dataset.sid); setMeta(s.id, { tags: s.tags.filter((t) => t !== el.dataset.tag) }); },
  rename: async (el) => {
    const s = S.byId.get(el.dataset.sid);
    const v = await promptDialog({ title: 'Rename session', label: 'Name', hint: 'Shown only in the launcher. Leave empty to go back to the original title.', value: s.alias || s.title });
    if (v !== null) setMeta(s.id, { alias: v });
  },
  more: (el) => {
    const id = el.dataset.sid; const s = S.byId.get(id); const d = S.details[id]; const l = liveOf(id);
    openMenu(el, [
      { label: 'Rename…', icon: 'sliders', run: () => ACTIONS.rename(el) },
      { label: s.hidden ? 'Unhide session' : 'Hide session', icon: 'eye-off', run: () => setMeta(id, { hidden: !s.hidden }) },
      '-',
      { label: 'Copy session ID', icon: 'copy', run: () => copyText(id) },
      { label: 'Copy folder path', icon: 'copy', run: () => copyText(s.cwd || '') },
      ...(d && d.file ? [
        { label: 'Show transcript file', icon: 'file', run: () => osOpen('reveal', d.file) },
        { label: 'Open transcript in editor', icon: 'code', run: () => osOpen('editor', d.file) },
      ] : []),
      ...(s.remoteUrl ? [{ label: 'Open on claude.ai', icon: 'globe', run: () => window.open(s.remoteUrl, '_blank', 'noopener') }] : []),
      ...(l ? ['-', { label: `Stop running process (pid ${l.pid})`, icon: 'stop', danger: true, run: () => stopPid(l.pid) }] : []),
    ]);
  },
  stop: (el) => stopPid(Number(el.dataset.pid)),
  tab: (el) => { S.tab = el.dataset.v; S.scrolledConvo = null; render(); },
  'convo-tools': (el) => { S.convo.tools = el.checked; render(); },
  'convo-all': async (el) => { await ensureTranscript(el.dataset.sid, true); render(); },
  'convo-end': () => { const p = document.querySelector('.pane.detail'); if (p) p.scrollTop = p.scrollHeight; },
  'f-status': (el) => { S.f.status = el.dataset.v; render(); },
  'f-pinned': () => { S.f.pinned = !S.f.pinned; render(); },
  'f-hidden': () => { S.f.showHidden = !S.f.showHidden; render(); },
  'f-clear': () => { Object.assign(S.f, { q: '', status: 'all', time: 'any', project: '', pinned: false }); S.searchHits = null; render(); },
  'proj-sessions': (el) => { Object.assign(S.f, { project: el.dataset.key, status: 'all', time: 'any', q: '' }); S.searchHits = null; go('sessions'); },
  'p-sort': (el) => { S.proj.sort = el.dataset.v; render(); },
  'p-empty': (el) => { S.proj.empty = el.checked; render(); },
  'h-cmds': (el) => { S.prompts.cmds = el.checked; S.prompts.limit = 200; render(); },
  'h-more': () => { S.prompts.limit += 300; render(); },
  'heat-metric': (el) => { S.heatMetric = el.dataset.v; render(); },
  'day-shift': (el) => { S.timelineDay = dayKey(parseDayKey(S.timelineDay) + Number(el.dataset.v) * DAY + 2 * HOUR); render(); },
  'day-today': () => { S.timelineDay = dayKey(Date.now()); render(); },
  'ins-range': (el) => { S.insightsRange = Number(el.dataset.v); render(); },
  'run-preset': (el) => { const p = S.data.presets.find((x) => x.id === el.dataset.id); if (p) doLaunch({ ...p.opts, title: p.label }); },
  'edit-preset': (el) => { const p = S.data.presets.find((x) => x.id === el.dataset.id); if (p) launchDialog({ ...p.opts, presetId: p.id, presetLabel: p.label }); },
  theme: async (el) => { await saveSetting('theme', el.dataset.v); },
  refresh: () => refresh(),
  rebuild: () => rebuild(),
  quit: async () => {
    const v = await confirmDialog({ title: 'Quit ReCode?', body: 'Running Claude Code sessions keep running in their terminals.', ok: 'Quit' });
    if (v === 'ok') { try { await api('/api/quit', { body: {} }); } catch { /* exiting */ } }
  },
  palette: () => openPalette(),
  'update-open': () => updateDialog(),
  'update-check': async (el) => { el.disabled = true; await checkForUpdates(); el.disabled = false; },
  'open-url': (el) => { const u = el.dataset.url || ''; if (u.startsWith('https://')) api('/api/open-url', { body: { url: u } }).catch((e) => toast(e.message, 'err')); },
  'recover-one': (el) => { const r = recoveryItems().find((x) => x.sessionId === el.dataset.sid); if (r) resumeRecovered([r]); },
  'recover-all': () => resumeRecovered(recoveryItems()),
  'recover-review': () => recoveryReview(),
  'recover-dismiss': () => dismissRecovery(recoveryItems()),
  'bubble-reset': () => saveSetting('bubblePos', null),
  'focus-term': (el) => goToSession(el.dataset.sid),
};

async function stopPid(pid) {
  const l = S.data.live.find((x) => x.pid === pid);
  const s = l && S.byId.get(l.sessionId);
  const v = await confirmDialog({ title: 'Stop this Claude Code process?', body: `<b>${esc((s && s.title) || (l && l.name) || 'Session')}</b> (pid ${pid}) will be terminated immediately. Any turn in progress is cut off. The conversation stays saved and can be resumed later.`, ok: 'Stop process', danger: true });
  if (v !== 'ok') return;
  try { await api('/api/stop', { body: { pid } }); toast('Process stopped'); setTimeout(loadState, 800); } catch (e) { toast(e.message, 'err'); }
}

async function saveSetting(k, v) {
  try {
    const r = await api('/api/settings', { body: { [k]: v } });
    S.data.settings = r.settings;
    applyTheme();
    render();
  } catch (e) { toast(e.message, 'err'); }
}

function applyTheme() {
  const t = settings().theme;
  const dark = t === 'dark' || (t === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // Match the native window-control strip to the theme.
  const cs = getComputedStyle(document.documentElement);
  window.launcher.setTitleBar({ bg: cs.getPropertyValue('--bg').trim(), fg: cs.getPropertyValue('--text-2').trim() });
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => S.data && applyTheme());

// ---------------------------------------------------------------- events

// A click on a session row navigates, which re-renders the page under the pointer.
// Remember which session was clicked so the second click of a double-click can't land on
// whatever is now at that spot (e.g. another session's Resume button).
let rowClick = { id: null, at: 0 };
const LAUNCH_ACTS = new Set(['resume', 'resume-live', 'fork', 'run-preset']);

document.addEventListener('click', (e) => {
  if (e.detail >= 2 && Date.now() - rowClick.at < 700) { e.stopPropagation(); e.preventDefault(); return; }
  const a = e.target.closest('[data-act]');
  // The second click of a double-click on a launch button must not start a second terminal.
  if (e.detail >= 2 && a && LAUNCH_ACTS.has(a.dataset.act)) { e.stopPropagation(); return; }
  if (a && a.dataset.act && ACTIONS[a.dataset.act]) {
    if (a.tagName === 'INPUT' && a.type === 'checkbox') return; // handled on change
    e.stopPropagation();
    if (a.tagName === 'A') return;
    if (a.dataset.sid && a.matches('.g-row, .live-card')) rowClick = { id: a.dataset.sid, at: Date.now() };
    ACTIONS[a.dataset.act](a, e);
    return;
  }
  const row = e.target.closest('.s-row[data-sid]');
  if (row) { rowClick = { id: row.dataset.sid, at: Date.now() }; go('sessions', row.dataset.sid); }
  const cell = e.target.closest('.heat rect[data-day]');
  if (cell) { S.timelineDay = cell.dataset.day; render(); }
  const bar = e.target.closest('.chart [data-key]');
  if (bar) { S.timelineDay = bar.dataset.key; go('timeline'); }
});

// Double-click a session anywhere to resume it straight away.
document.addEventListener('dblclick', (e) => {
  // Use the session from the first click; the DOM under the pointer may have changed since.
  const id = Date.now() - rowClick.at < 700 ? rowClick.id : null;
  rowClick = { id: null, at: 0 };
  if (!id) return;
  const s = S.byId.get(id);
  if (s && !s.archived) { window.getSelection().removeAllRanges(); if (liveOf(s.id)) goToSession(s.id); else resumeSession(s.id); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-act]')) return ACTIONS[el.dataset.act](el);
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'gapMinutes') v = Number(v);
    if (k === 'hidePatterns') v = v.split('\n').map((x) => x.trim()).filter(Boolean);
    saveSetting(k, v).then(() => toast('Saved'));
    return;
  }
  if (el.id === 'f-time') { S.f.time = el.value; render(); }
  if (el.id === 'f-project') { S.f.project = el.value; render(); }
  if (el.id === 'f-sort') { S.f.sort = el.value; render(); }
  if (el.id === 'h-project') { S.prompts.project = el.value; S.prompts.limit = 200; render(); }
  if (el.dataset.note) setMeta(el.dataset.note, { note: el.value });
});

let searchTimer = null;
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'f-q') {
    S.f.q = el.value;
    clearTimeout(searchTimer);
    if (!el.value.trim()) { S.searchHits = null; render(); return; }
    searchTimer = setTimeout(async () => {
      const q = el.value;
      try {
        const r = await api('/api/search?q=' + encodeURIComponent(q));
        if (S.f.q !== q) return;
        S.searchHits = new Map(r.results.map((x) => [x.id, x.snippet]));
        render();
      } catch (err) { toast(err.message, 'err'); }
    }, 180);
  } else if (el.id === 'h-q') {
    S.prompts.q = el.value; S.prompts.limit = 200;
    clearTimeout(searchTimer); searchTimer = setTimeout(render, 150);
  } else if (el.id === 'p-q') {
    S.proj.q = el.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 100);
  }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if (e.target.dataset && e.target.dataset.tagInput && e.key === 'Enter') {
    e.preventDefault();
    const id = e.target.dataset.tagInput; const s = S.byId.get(id); const v = e.target.value.trim();
    e.target.value = ''; // cleared before the re-render restores the focused input's value
    if (v) setMeta(id, { tags: [...(s.tags || []), v] });
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p')) { e.preventDefault(); if (!modalStack.length) openPalette(); return; }
  if (e.key === 'Escape') { if (openMenuEl) { closeMenu(); return; } if (closeTopModal()) return; if (typing) { e.target.blur(); return; } if (S.route.view === 'sessions' && S.route.arg) go('sessions'); return; }
  if (typing || modalStack.length || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n') { e.preventDefault(); launchDialog(); return; }
  if (e.key === '/') {
    const s = document.getElementById('f-q') || document.getElementById('h-q') || document.getElementById('p-q');
    if (s) { e.preventDefault(); s.focus(); s.select(); }
    return;
  }
  if (S.route.view === 'sessions') {
    const list = filteredSessions();
    const i = list.findIndex((s) => s.id === S.route.arg);
    const cur = list[i];
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); const n = list[Math.min(list.length - 1, i + 1)]; if (n) selectAndReveal(n.id); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); const n = list[Math.max(0, i - 1)]; if (n) selectAndReveal(n.id); }
    else if (cur && e.key === 'Enter') { e.preventDefault(); if (liveOf(cur.id) && !e.shiftKey) goToSession(cur.id); else if (!cur.archived) resumeSession(cur.id, { fork: e.shiftKey }); }
    else if (cur && e.key === 'f') { if (!cur.archived) resumeSession(cur.id, { fork: true }); }
    else if (cur && e.key === 'p') setMeta(cur.id, { pinned: !cur.pinned });
    else if (cur && e.key === 'o') osOpen('folder', cur.cwd);
  }
});

function selectAndReveal(id) {
  go('sessions', id);
  requestAnimationFrame(() => { const r = document.querySelector(`.s-row[data-sid="${id}"]`); if (r) r.scrollIntoView({ block: 'nearest' }); });
}

// ---------------------------------------------------------------- live updates

let reloadTimer = null;
function connectEvents() {
  // The main process pushes an update whenever transcripts change or a live session's status changes.
  window.launcher.onUpdate((d) => {
    if (S.data && (d.upd || '') !== ((S.data.meta.update && S.data.meta.update.available && S.data.meta.update.latest.version) || '')) {
      api('/api/update').then((u) => { S.data.meta.update = u; render(); }).catch(() => {});
    }
    if (S.data && d.attention) S.data.attention = d.attention;
    if (d.rev !== S.rev) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => loadState().catch(() => {}), 300);
    } else if (S.data) {
      S.data.live = d.live; indexLive(); render();
    }
  });
}

window.addEventListener('resize', () => { if (S.route.view === 'insights') { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => render(), 150); } });

// ---------------------------------------------------------------- boot

S.route = parseRoute();
// Screenshot mode renders in a hidden window where CSS animations never advance.
if (/[?&]shot=1/.test(location.search)) document.documentElement.classList.add('no-motion');
loadState().then(connectEvents).catch((e) => {
  document.getElementById('view').innerHTML = `<div class="page">${emptyBox("Couldn't load sessions", `<div>${esc(e.message)}</div>`)}</div>`;
});
