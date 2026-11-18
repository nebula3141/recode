'use strict';
/* Small SVG chart builders. Single-series, one hue; every mark has a hover tooltip. */

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Vertical bars. data: [{label, value, tip, key}], opts: {height, fmt, labelEvery, onClick}
function barChart(data, opts = {}) {
  const W = Math.max(300, Math.round(opts.width || 800)); const H = opts.height || 180; const padL = 34; const padB = 22; const padT = 8;
  const max = niceMax(Math.max(1, ...data.map((d) => d.value)));
  const n = data.length || 1;
  const slot = (W - padL) / n;
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const fmt = opts.fmt || fmtNum;
  const ticks = [0, max / 2, max];
  let g = '<g class="axis">';
  for (const t of ticks) g += `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 3.5}" text-anchor="end">${esc(fmt(t))}</text>`;
  const every = opts.labelEvery || Math.ceil(n / 12);
  data.forEach((d, i) => { if (i % every === 0) g += `<text x="${padL + slot * i + slot / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`; });
  g += '</g>';
  let bars = '';
  data.forEach((d, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const top = y(d.value); const h = H - padB - top;
    const r = Math.min(4, bw / 2, h);
    // 4px rounded data end, square at the baseline
    const path = d.value > 0 ? `M${x},${H - padB}V${top + r}a${r},${r} 0 0 1 ${r},${-r}h${bw - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${H - padB}Z` : '';
    bars += `<g data-tip="${attr(d.tip || `${d.label}: ${fmt(d.value)}`)}" ${d.key ? `data-key="${attr(d.key)}"` : ''} style="${opts.onClick ? 'cursor:pointer' : ''}">
      <rect class="hit" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}"/>
      ${path ? `<path class="bar" d="${path}"/>` : ''}</g>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${attr(opts.label || 'Bar chart')}">${g}${bars}</svg>`;
}

// Horizontal bar list (HTML). items: [{label, value, display, tip}]
function hbarList(items, opts = {}) {
  if (!items.length) return `<div class="muted">${esc(opts.empty || 'No data yet')}</div>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="bars">${items.map((i) => `
    <div class="hbar" data-tip="${attr(i.tip || `${i.label}: ${i.display ?? fmtNum(i.value)}`)}">
      <span class="l">${esc(i.label)}</span>
      <span class="track"><span class="fill" style="width:${(i.value / max) * 100}%"></span></span>
      <span class="n">${esc(i.display ?? fmtNum(i.value))}</span>
    </div>`).join('')}</div>`;
}

// GitHub-style calendar heatmap for the last `weeks` weeks. counts: {YYYY-MM-DD: n}
function heatmap(counts, { weeks = 53, selected, fmtTip } = {}) {
  const cell = 12; const gap = 3; const top = 18; const left = 28;
  const today = dayStart(Date.now());
  const endDow = new Date(today).getDay();
  const start = today - (weeks * 7 - 1 - (6 - endDow)) * DAY;
  const startAligned = start - new Date(start).getDay() * DAY;
  const vals = Object.values(counts).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 1;
  const th = [q(0.25), q(0.5), q(0.75)];
  const level = (v) => (!v ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4);
  let out = '';
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const t = startAligned + (w * 7 + d) * DAY;
      // DST-safe: recompute local midnight
      const tt = dayStart(t + 2 * HOUR);
      if (tt > today) continue;
      const k = dayKey(tt);
      const v = counts[k] || 0;
      const x = left + w * (cell + gap); const y = top + d * (cell + gap);
      if (d === 0) {
        const m = new Date(tt).getMonth();
        if (m !== lastMonth && w < weeks - 1) { out += `<text x="${x}" y="11">${new Date(tt).toLocaleDateString(undefined, { month: 'short' })}</text>`; lastMonth = m; }
      }
      out += `<rect class="c${k === selected ? ' sel' : ''}" data-day="${k}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="var(--seq-${level(v)})" data-tip="${attr(fmtTip ? fmtTip(k, v) : `${k}: ${v}`)}"/>`;
    }
  }
  ['Mon', 'Wed', 'Fri'].forEach((l, i) => { out += `<text x="0" y="${top + (1 + i * 2) * (cell + gap) + 9}">${l}</text>`; });
  const W = left + weeks * (cell + gap); const H = top + 7 * (cell + gap);
  return `<svg class="heat" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity heatmap">${out}</svg>`;
}
