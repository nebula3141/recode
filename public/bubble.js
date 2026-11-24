'use strict';
// Floating bubble page. State comes from the main process; clicks and drags go back to it.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};
const folder = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

let state = { items: [], expanded: false };

function render() {
  const items = state.items || [];
  const waiting = items.filter((i) => i.kind === 'waiting').length;
  const b = $('bubble');
  b.className = 'bubble ' + (waiting ? 'waiting' : items.length ? 'finished' : 'idle');
  $('badge').textContent = items.length > 9 ? '9+' : String(items.length);
  b.title = items.length
    ? items.map((i) => `${i.kind === 'waiting' ? 'Needs you' : 'Finished'}: ${i.title}`).join('\n') + (items.length > 1 ? '\n\nClick to choose' : '\n\nClick to open it')
    : 'No Claude Code session needs you. Click to open ReCode, drag to move.';
  b.setAttribute('aria-label', items.length ? `${items.length} Claude Code session${items.length === 1 ? '' : 's'} need attention` : 'ReCode');

  $('bubble').hidden = !!state.expanded;
  $('panel').hidden = !state.expanded;
  if (state.expanded) {
    $('head-t').textContent = waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` + (items.length > waiting ? ` · ${items.length - waiting} finished` : '') : `${items.length} finished`;
    $('list').innerHTML = items.map((i) => `
      <button class="row" role="listitem" data-id="${esc(i.sessionId)}">
        <span class="dot ${i.kind}"></span>
        <div><div class="t">${esc(i.title)}</div>
        <div class="s">${i.kind === 'waiting' ? esc(i.waitingFor ? 'Waiting: ' + i.waitingFor : 'Waiting for you') : 'Finished ' + esc(ago(i.since))} · ${esc(folder(i.cwd))}</div></div>
      </button>`).join('');
  }
}

window.bubble.onState((s) => { state = s; render(); });

// Click vs drag: anything that moves more than a few pixels is a drag.
let press = null;
$('bubble').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, dragging: false };
  $('bubble').setPointerCapture(e.pointerId);
});
$('bubble').addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.dragging = true;
    window.bubble.dragStart(press.x, press.y);
  }
  if (press.dragging) window.bubble.dragMove(e.screenX, e.screenY);
});
$('bubble').addEventListener('pointerup', () => {
  if (!press) return;
  if (press.dragging) window.bubble.dragEnd(); else window.bubble.click();
  press = null;
});
$('bubble').addEventListener('contextmenu', (e) => { e.preventDefault(); window.bubble.menu(); });

$('list').addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) window.bubble.pick(r.dataset.id); });
$('open-app').addEventListener('click', () => window.bubble.openApp());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.bubble.collapse();
  if (!state.expanded) return;
  const rows = [...document.querySelectorAll('.row')];
  const i = rows.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); (rows[i + 1] || rows[0]).focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); (rows[i - 1] || rows[rows.length - 1]).focus(); }
});
// Keep "x minutes ago" fresh while the list is open.
setInterval(() => { if (state.expanded) render(); }, 30000);
render();
