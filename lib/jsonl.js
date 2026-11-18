'use strict';
// Incremental, byte-accurate JSONL reader. Only complete lines (ending in \n)
// are delivered, so a file that is still being written is safe to read: the
// returned offset points just past the last complete line and the next read
// resumes from there.
const fsp = require('fs').promises;

const CHUNK = 4 * 1024 * 1024;
// Lines that are large and carry nothing the launcher needs.
const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history-snapshot"', '{"type":"atis-latch"'];

async function readLines(file, start, end, onLine) {
  const fd = await fsp.open(file, 'r');
  let pos = start;
  let carry = null;
  try {
    while (pos < end) {
      const len = Math.min(CHUNK, end - pos);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fd.read(buf, 0, len, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let ls = 0;
      let nl;
      while ((nl = data.indexOf(10, ls)) !== -1) {
        if (nl > ls) handle(data, ls, nl, onLine);
        ls = nl + 1;
      }
      carry = ls < data.length ? Buffer.from(data.subarray(ls)) : null;
    }
  } finally {
    await fd.close();
  }
  return pos - (carry ? carry.length : 0);
}

function handle(data, ls, nl, onLine) {
  const head = data.toString('latin1', ls, Math.min(ls + 48, nl));
  for (const p of SKIP_PREFIXES) if (head.startsWith(p)) return;
  let obj;
  try {
    obj = JSON.parse(data.toString('utf8', ls, nl));
  } catch {
    return;
  }
  onLine(obj);
}

module.exports = { readLines };
