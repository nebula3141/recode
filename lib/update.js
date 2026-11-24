'use strict';
// Updates from GitHub Releases.
//
// check()   asks the GitHub API for releases and finds the newest one on the chosen channel.
// install() downloads what this kind of install needs, verifies its SHA-256 against the
//           release's SHA256SUMS.txt, starts it and asks the app to quit:
//   installer  (ReCode-Setup.exe was used)  -> run the new Setup silently, it relaunches ReCode
//   script     (install.ps1 was used)       -> run the new install.ps1 -Update, it relaunches ReCode
//   portable / dev                          -> nothing to replace safely; open the release page
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'nebula3141/recode';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const HEADERS = { 'User-Agent': 'ReCode-updater', Accept: 'application/vnd.github+json' };

let app = { version: '0.0.0', exePath: process.execPath, packaged: false };
function configure(info) { app = { ...app, ...info }; }

// ---------- versions (semver, including pre-release ordering: 1.0.0-rc.2 < 1.0.0) ----------

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p > +q ? 1 : -1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

const isPrerelease = (v) => { const p = parseVersion(v); return !!(p && p.pre.length); };

// ---------- how this copy was installed ----------

function installKind() {
  if (!app.packaged) return 'dev';
  const dir = path.dirname(app.exePath);
  if (fs.existsSync(path.join(dir, 'Uninstall ReCode.exe'))) return 'installer';
  if (fs.existsSync(path.join(dir, 'uninstall.ps1'))) return 'script';
  return 'portable';
}

// ---------- state ----------

const state = {
  checking: false, checkedAt: 0, error: null,
  latest: null,            // { version, tag, name, notes, url, publishedAt, prerelease, assets }
  phase: 'idle',           // idle | downloading | verifying | starting | error
  received: 0, total: 0, phaseError: null,
};

function includePrereleases(channel) {
  if (channel === 'rc') return true;
  if (channel === 'stable') return false;
  return isPrerelease(app.version); // auto: follow the channel you're on
}

function status() {
  const available = !!(state.latest && compareVersions(state.latest.version, app.version) > 0);
  return {
    current: app.version, kind: installKind(), releasesPage: RELEASES_PAGE,
    checking: state.checking, checkedAt: state.checkedAt, error: state.error,
    latest: state.latest && { ...state.latest, assets: undefined }, available,
    phase: state.phase, received: state.received, total: state.total, phaseError: state.phaseError,
  };
}

let checkPromise = null;
function check(channel) {
  if (checkPromise) return checkPromise;
  checkPromise = (async () => {
    state.checking = true; state.error = null;
    try {
      const res = await fetch(RELEASES_API, { headers: HEADERS });
      if (!res.ok) throw new Error(res.status === 403 ? 'GitHub rate limit reached; try again later' : `GitHub returned ${res.status}`);
      const releases = (await res.json()).filter((r) => !r.draft && parseVersion(r.tag_name));
      const pre = includePrereleases(channel);
      const pool = releases.filter((r) => pre || !r.prerelease);
      const best = pool.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] || null;
      state.latest = best && {
        version: best.tag_name.replace(/^v/i, ''), tag: best.tag_name, name: best.name || best.tag_name,
        notes: String(best.body || '').slice(0, 20000), url: best.html_url, publishedAt: Date.parse(best.published_at) || null,
        prerelease: !!best.prerelease,
        assets: (best.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })),
      };
      state.checkedAt = Date.now();
    } catch (e) {
      state.error = e.message || String(e);
    } finally {
      state.checking = false; checkPromise = null;
    }
    return status();
  })();
  return checkPromise;
}

// ---------- download + verify ----------

async function download(asset, dir) {
  const file = path.join(dir, asset.name);
  const res = await fetch(asset.url, { headers: { ...HEADERS, Accept: 'application/octet-stream' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  state.total = Number(res.headers.get('content-length')) || asset.size || 0;
  state.received = 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      state.received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return { file, sha256: hash.digest('hex') };
}

async function expectedHashes(latest) {
  const sums = latest.assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!sums) throw new Error('This release has no SHA256SUMS.txt, so the download cannot be verified');
  const res = await fetch(sums.url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not fetch checksums (${res.status})`);
  const map = {};
  for (const line of (await res.text()).split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m) map[m[2].trim()] = m[1].toLowerCase();
  }
  return map;
}

function startDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

let installing = false;
// Returns { action: 'open', url } or { action: 'quit' } (the caller then quits the app).
async function install() {
  if (installing) throw new Error('An update is already in progress');
  const st = status();
  if (!st.latest) throw new Error('Check for updates first');
  if (!st.available) throw new Error('You already have the latest version');
  const kind = installKind();
  if (kind === 'portable' || kind === 'dev') return { action: 'open', url: state.latest.url };

  const want = kind === 'installer'
    ? state.latest.assets.find((a) => /^ReCode-Setup-.*\.exe$/i.test(a.name))
    : state.latest.assets.find((a) => a.name === 'install.ps1');
  if (!want) return { action: 'open', url: state.latest.url };

  installing = true;
  state.phaseError = null;
  try {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'recode-update-'));
    state.phase = 'downloading';
    const sums = await expectedHashes(state.latest);
    const { file, sha256 } = await download(want, dir);
    state.phase = 'verifying';
    if (!sums[want.name]) throw new Error(`SHA256SUMS.txt has no entry for ${want.name}`);
    if (sums[want.name] !== sha256) { await fsp.rm(dir, { recursive: true, force: true }); throw new Error('Downloaded file failed its checksum; nothing was installed'); }
    state.phase = 'starting';
    if (kind === 'installer') {
      // Silent per-user reinstall into the same folder; --force-run relaunches ReCode afterwards.
      await startDetached(file, ['/S', '--updated', '--force-run']);
    } else {
      await startDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file, '-Version', state.latest.version, '-Update']);
    }
    return { action: 'quit' };
  } catch (e) {
    state.phase = 'error'; state.phaseError = e.message || String(e);
    throw e;
  } finally {
    installing = false;
  }
}

module.exports = { configure, check, status, install, compareVersions, installKind, RELEASES_PAGE };
