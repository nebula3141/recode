'use strict';
// Running Claude Code processes: ~/.claude/sessions/<pid>.json, cross-checked
// against the actual process list so stale files from crashed sessions are ignored.
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const P = require('./paths');

let pidCache = { at: 0, pids: null };

function claudePids() {
  if (Date.now() - pidCache.at < 4000 && pidCache.pids) return Promise.resolve(pidCache.pids);
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      execFile('ps', ['-A', '-o', 'pid=,comm='], { timeout: 5000 }, (err, out) => {
        const set = new Set();
        if (!err) for (const l of out.split('\n')) { const m = l.trim().match(/^(\d+)\s+(.*)$/); if (m && /claude/i.test(m[2])) set.add(Number(m[1])); }
        pidCache = { at: Date.now(), pids: err ? null : set };
        resolve(pidCache.pids);
      });
      return;
    }
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) { pidCache = { at: Date.now(), pids: null }; return resolve(null); }
      const set = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (m && /^(claude|node)(\.exe)?$/i.test(m[1])) set.add(Number(m[2]));
      }
      pidCache = { at: Date.now(), pids: set };
      resolve(set);
    });
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Process start times (Windows FILETIME, as Claude Code writes in "procStart"), cached per
// pid. A pid can be reused by an unrelated node/claude process after the session that wrote
// the file exits without cleaning up; comparing start times tells the two apart.
const startCache = new Map(); // pid -> FILETIME string, or null when it can't be read

function startTimes(pids) {
  const need = pids.filter((p) => !startCache.has(p));
  if (!need.length || process.platform !== 'win32') return Promise.resolve();
  const script = `Get-Process -Id ${need.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } catch { "$($_.Id) ?" } }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true }, (err, out) => {
      // Mark every pid as looked up even on failure, so a broken lookup isn't retried each tick.
      for (const p of need) startCache.set(p, null);
      if (!err) {
        for (const line of String(out).split(/\r?\n/)) {
          const m = line.trim().match(/^(\d+) (\d+|\?)$/);
          if (m) startCache.set(Number(m[1]), m[2] === '?' ? null : m[2]);
        }
      }
      resolve();
    });
  });
}

async function liveSessions() {
  let names = [];
  try { names = await fsp.readdir(P.LIVE_DIR); } catch { return []; }
  const pids = await claudePids();
  const out = [];
  await Promise.all(names.filter((n) => /^\d+\.json$/.test(n)).map(async (n) => {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(P.LIVE_DIR, n), 'utf8'));
      if (!j || !j.pid || !j.sessionId) return;
      const alive = pids ? pids.has(j.pid) : pidAlive(j.pid);
      if (!alive) return;
      out.push({
        pid: j.pid,
        sessionId: j.sessionId,
        cwd: j.cwd || null,
        name: j.name || null,
        status: j.status || 'unknown',
        waitingFor: j.waitingFor || null,
        startedAt: j.startedAt || null,
        updatedAt: j.statusUpdatedAt || j.updatedAt || null,
        version: j.version || null,
        kind: j.kind || null,
        entrypoint: j.entrypoint || null,
        procStart: j.procStart || null,
      });
    } catch { /* partially written file */ }
  }));
  // Forget start times of pids that have exited, so a reused pid is looked up afresh.
  if (pids) for (const p of startCache.keys()) if (!pids.has(p)) startCache.delete(p);
  await startTimes(out.filter((e) => e.procStart).map((e) => e.pid));
  const verified = out.filter((e) => {
    const actual = startCache.get(e.pid);
    return !e.procStart || actual == null || actual === String(e.procStart);
  });
  // One entry per session: if stale files still slip through (e.g. older Claude Code without
  // procStart), the most recently updated one is the real process.
  const bySession = new Map();
  for (const e of verified) {
    const cur = bySession.get(e.sessionId);
    if (!cur || (e.updatedAt || 0) > (cur.updatedAt || 0)) bySession.set(e.sessionId, e);
  }
  const list = [...bySession.values()].map(({ procStart, ...e }) => e);
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list;
}

module.exports = { liveSessions };
