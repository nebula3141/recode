'use strict';
// Turns a session transcript into a compact, readable conversation:
// prompts, assistant text, tool calls (with their results attached), recaps, compactions.
const fsp = require('fs').promises;
const { readLines } = require('./jsonl');
const { extractPrompt } = require('./indexer');

const RESULT_CHARS = 1600;
const TEXT_CHARS = 20000;
const cache = new Map(); // file -> { size, mtimeMs, data }

function summarizeTool(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => { for (const k of keys) if (input[k]) return String(input[k]); return ''; };
  switch (name) {
    case 'Bash': case 'PowerShell': return pick('description') ? `${pick('description')}\n$ ${pick('command')}` : pick('command');
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return pick('file_path', 'notebook_path');
    case 'Grep': return `${pick('pattern')}${input.path ? '  in ' + input.path : ''}`;
    case 'Glob': return pick('pattern');
    case 'WebFetch': return pick('url');
    case 'WebSearch': return pick('query');
    case 'Agent': case 'Task': return `${pick('subagent_type')}${input.subagent_type ? ': ' : ''}${pick('description')}`;
    case 'Skill': return pick('skill');
    case 'TodoWrite': return Array.isArray(input.todos) ? input.todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.content}`).join('\n') : '';
    default: {
      const s = JSON.stringify(input);
      return s.length > 300 ? s.slice(0, 300) + '…' : s;
    }
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  return '';
}

// Parse state per file, kept between calls so a live session only costs the new lines.
function newState() { return { offset: 0, size: -1, mtimeMs: -1, entries: [], tools: new Map(), last: null }; }

function onLine(c, o) {
  if (o.isSidechain) return;
  const t = o.timestamp ? Date.parse(o.timestamp) : null;
  if (o.type === 'user') {
    const content = o.message && o.message.content;
    if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
      for (const b of content) {
        if (!b || b.type !== 'tool_result') continue;
        const tool = c.tools.get(b.tool_use_id);
        if (!tool) continue;
        const txt = resultText(b.content);
        tool.result = txt.length > RESULT_CHARS ? txt.slice(0, RESULT_CHARS) + `\n… (${txt.length - RESULT_CHARS} more chars)` : txt;
        tool.err = !!b.is_error;
        c.tools.delete(b.tool_use_id);
      }
      return;
    }
    const p = extractPrompt(o);
    if (p) { c.entries.push({ k: 'user', ts: t, text: p.text, cmd: p.cmd || null }); c.last = null; }
    return;
  }
  if (o.type === 'assistant') {
    const m = o.message || {};
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        if (c.last && c.last.mid === m.id) c.last.e.text += '\n\n' + b.text;
        else { const e = { k: 'assistant', ts: t, text: b.text, model: m.model }; c.last = { mid: m.id, e }; c.entries.push(e); }
        if (c.last.e.text.length > TEXT_CHARS) c.last.e.text = c.last.e.text.slice(0, TEXT_CHARS) + '\n…';
      } else if (b.type === 'tool_use') {
        const e = { k: 'tool', ts: t, name: b.name, summary: summarizeTool(b.name, b.input), result: null, err: false };
        c.tools.set(b.id, e);
        c.entries.push(e);
        c.last = null;
      }
    }
    return;
  }
  if (o.type === 'system') {
    if (o.subtype === 'away_summary' && o.content) c.entries.push({ k: 'recap', ts: t, text: String(o.content).replace(/\s*\((?:disable|turn off) recaps[^)]*\)\s*$/, '') });
    else if (o.subtype === 'compact_boundary') c.entries.push({ k: 'compact', ts: t, text: o.compactMetadata && o.compactMetadata.preTokens ? `Conversation compacted (${Math.round(o.compactMetadata.preTokens / 1000)}k tokens)` : 'Conversation compacted' });
    else if (o.subtype === 'api_error' || o.level === 'error') c.entries.push({ k: 'error', ts: t, text: String(o.content || 'API error').slice(0, 500) });
  }
}

const locks = new Map(); // file -> in-flight read, so two calls never parse the same range twice

async function readTranscript(file) {
  if (locks.has(file)) return locks.get(file);
  const job = (async () => {
    const st = await fsp.stat(file);
    let c = cache.get(file);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return { entries: c.entries, size: c.size };
    if (!c || st.size < c.offset) c = newState(); // truncated or replaced: start over
    if (st.size > c.offset) c.offset = await readLines(file, c.offset, st.size, (o) => onLine(c, o));
    c.size = st.size; c.mtimeMs = st.mtimeMs;
    cache.delete(file); cache.set(file, c); // most recently used last
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    return { entries: c.entries, size: c.size };
  })();
  locks.set(file, job);
  try { return await job; } finally { locks.delete(file); }
}

module.exports = { readTranscript };
