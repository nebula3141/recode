'use strict';
/* Shared helpers: escaping, formatting, markdown, API, toasts, tooltips, menus, modals. */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const attr = esc;
function icon(name, cls = '') { return `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`; }

// Calls the main process (see electron/main.js). Same request shape as a REST API.
async function api(path, opts = {}) {
  const u = new URL(path, 'app://local');
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const r = await window.launcher.api(method, u.pathname, Object.fromEntries(u.searchParams), opts.body || {});
  if (!r.ok) throw new Error(r.error || `Request failed (${r.status})`);
  return r.data;
}

// ---------- formatting ----------
const MIN = 60e3, HOUR = 36e5, DAY = 864e5;

function ago(t, now = Date.now()) {
  if (!t) return '—';
  const d = now - t;
  if (d < 45e3) return 'just now';
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  if (d < 7 * DAY) return `${Math.round(d / DAY)}d ago`;
  return fmtDate(t);
}

function fmtDate(t, withYear) {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear || !sameYear ? { year: 'numeric' } : {}) });
}
function fmtTime(t) { return t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'; }
function fmtDateTime(t) { return t ? `${fmtDate(t, true)}, ${fmtTime(t)}` : '—'; }
function fmtDur(ms) {
  if (!ms || ms < MIN) return ms ? '<1m' : '0m';
  // Round to whole minutes first, so 59.6 minutes becomes "1h 0m" instead of "60m".
  const total = Math.round(ms / MIN);
  const h = Math.floor(total / 60); const m = total % 60;
  if (h >= 100) return `${h}h`;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
function plural(n, w, p) { return `${fmtNum(n)} ${n === 1 ? w : (p || w + 's')}`; }
function dayKey(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function parseDayKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function dayLabel(t) {
  const s = dayStart(t); const today = dayStart(Date.now());
  if (s === today) return 'Today';
  if (s === today - DAY) return 'Yesterday';
  const d = new Date(t);
  if (today - s < 6 * DAY) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}
function baseName(p) { if (!p) return ''; const s = String(p).replace(/[\\/]+$/, ''); return s.split(/[\\/]/).pop() || s; }
function shortModel(m) {
  if (!m) return '—';
  const x = m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, ' 1M');
  return x.replace(/^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/, (_, a, b, c) => `${a[0].toUpperCase() + a.slice(1)} ${b}${c ? '.' + c : ''}`);
}
function totalTokens(t) { return t ? (t.in || 0) + (t.out || 0) + (t.cr || 0) + (t.cw || 0) : 0; }

// ---------- markdown (escape first; small, safe subset) ----------
function md(src) {
  const blocks = [];
  let s = String(src || '').replace(/```([\w+-]*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s);
  const inline = (t) => t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  const lines = s.split('\n');
  let list = null; let para = []; let table = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.t}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; } };
  const flushTable = () => {
    if (table) {
      const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r));
      out.push('<table>' + rows.map((r, i) => '<tr>' + r.replace(/^\||\|$/g, '').split('|').map((c) => (i === 0 ? `<th>${inline(c.trim())}</th>` : `<td>${inline(c.trim())}</td>`)).join('') + '</tr>').join('') + '</table>');
      table = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { flushPara(); flushList(); flushTable(); out.push(line.trim()); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); (table = table || []).push(line.trim()); continue; } else flushTable();
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushList();
    para.push(line);
  }
  flushPara(); flushList(); flushTable();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

// ---------- toasts ----------
function toast(msg, kind = 'ok', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'err' ? 'err' : ''}`;
  el.innerHTML = `${icon(kind === 'err' ? 'x' : 'check')}<div>${esc(msg)}</div>`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : ms);
}

async function copyText(text, label = 'Copied') {
  try { await window.launcher.copy(text); toast(label); } catch { toast('Copy failed', 'err'); }
}

// ---------- tooltips: any element with data-tip ----------
(function tooltips() {
  const tip = document.getElementById('tip');
  let cur = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el === cur) return;
    cur = el;
    if (!el) { tip.classList.remove('on'); return; }
    tip.innerHTML = el.getAttribute('data-tip-html') === '1' ? el.dataset.tip : esc(el.dataset.tip);
    tip.classList.add('on');
  });
  document.addEventListener('mousemove', (e) => {
    if (!cur) return;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14; let y = e.clientY + 16;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 12;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
  document.addEventListener('mouseleave', () => { cur = null; tip.classList.remove('on'); });
  document.addEventListener('scroll', () => { cur = null; tip.classList.remove('on'); }, true);
})();

// ---------- popup menu ----------
let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
function openMenu(anchor, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${icon(it.icon || 'right', 'sm')}<span>${esc(it.label)}</span></button>`)).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  let x = r.right - mr.width; let y = r.bottom + 4;
  if (x < 8) x = Math.min(r.left, innerWidth - mr.width - 8);
  if (y + mr.height > innerHeight - 8) y = r.top - mr.height - 4;
  m.style.left = x + 'px'; m.style.top = y + 'px';
  m.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it.run && it.run();
  });
  openMenuEl = m;
  const first = m.querySelector('button'); if (first) first.focus();
}
document.addEventListener('mousedown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); });

// ---------- modals ----------
const modalStack = [];
function openModal(html, { onClose, cls = '' } = {}) {
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  bd.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  document.getElementById('modal-root').appendChild(bd);
  const prevFocus = document.activeElement;
  const entry = { el: bd, close: () => { bd.remove(); modalStack.splice(modalStack.indexOf(entry), 1); onClose && onClose(); if (prevFocus && prevFocus.focus) prevFocus.focus(); } };
  modalStack.push(entry);
  bd.addEventListener('mousedown', (e) => { if (e.target === bd) entry.close(); });
  bd.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', entry.close));
  setTimeout(() => { const f = bd.querySelector('[autofocus]') || bd.querySelector('input, textarea, select, button.primary'); if (f) f.focus(); }, 0);
  return entry;
}
function closeTopModal() { const m = modalStack[modalStack.length - 1]; if (m) { m.close(); return true; } return false; }

function promptDialog({ title, label, hint = '', value = '', ok = 'Save' }) {
  return new Promise((resolve) => {
    let val = null;
    const m = openModal(`
      <div class="mh"><div><h3>${esc(title)}</h3></div></div>
      <form class="mb" id="pd-form"><div class="field"><label for="pd-in">${esc(label)}</label><input id="pd-in" class="input" value="${attr(value)}" autofocus>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div></form>
      <div class="mf"><span class="sp"></span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pd-ok">${esc(ok)}</button></div>`, { onClose: () => resolve(val) });
    const submit = (e) => { if (e) e.preventDefault(); val = m.el.querySelector('#pd-in').value.trim(); m.close(); };
    m.el.querySelector('#pd-form').addEventListener('submit', submit);
    m.el.querySelector('#pd-ok').addEventListener('click', submit);
    setTimeout(() => m.el.querySelector('#pd-in').select(), 0);
  });
}

function confirmDialog({ title, body, ok = 'Continue', danger = false, alt }) {
  return new Promise((resolve) => {
    let val = null;
    const m = openModal(`
      <div class="mh"><div><h3>${esc(title)}</h3></div></div>
      <div class="mb"><div class="dim">${body}</div></div>
      <div class="mf"><span class="sp"></span>
        <button class="btn ghost" data-close>Cancel</button>
        ${alt ? `<button class="btn" data-v="alt">${esc(alt)}</button>` : ''}
        <button class="btn ${danger ? 'danger' : 'primary'}" data-v="ok" autofocus>${esc(ok)}</button>
      </div>`, { onClose: () => resolve(val) });
    m.el.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { val = b.dataset.v; m.close(); }));
  });
}
