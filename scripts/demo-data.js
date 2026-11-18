'use strict';
// Generates a fictional Claude Code data folder for screenshots and demos, so nothing
// real (your projects, prompts, paths) ends up in an image.
//
//   node scripts/demo-data.js <root>          writes <root>/.claude and <root>/code/*
//   node scripts/demo-data.js <root> --live   also starts two placeholder processes and
//                                             registers them as running sessions
//
// Then point the app at it:  CLAUDE_CONFIG_DIR=<root>/.claude LAUNCHER_DATA_DIR=<tmp> npm start
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.resolve(process.argv[2] || 'demo');
const withLive = process.argv.includes('--live');
const CLAUDE = path.join(root, '.claude');
const CODE = path.join(root, 'code');

// Deterministic randomness so screenshots are reproducible.
let seed = 20261119;
function rnd() { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const uuid = () => { const b = Buffer.alloc(16); for (let i = 0; i < 16; i++) b[i] = Math.floor(rnd() * 256); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

const PROJECTS = [
  {
    name: 'aurora-api', weight: 5, branch: ['main', 'feat/rate-limits', 'fix/token-refresh'], claudeMd: true,
    titles: ['Add per-tenant rate limiting', 'Fix refresh token race', 'Migrate jobs to the new queue', 'Speed up the /search endpoint', 'Webhook retries with backoff', 'Audit log for admin actions', 'Postgres connection pool tuning'],
    prompts: ['add per-tenant rate limiting to the public API, 100 req/min default, configurable per plan', 'the refresh token sometimes gets used twice when two tabs refresh at once, can you find the race?', 'write tests for the limiter, including the burst case', 'move the email jobs from cron to the new queue worker', '/search is slow for big tenants, profile it and tell me what you find', 'add an index for that and show me the before/after query plan', 'webhooks should retry with exponential backoff, max 6 attempts', 'log every admin action to the audit table with the actor and diff', 'run the full test suite', 'looks good, commit it with a clear message', 'why is the pool exhausting under load test?', 'make the limits visible in the response headers'],
    files: ['src/middleware/rateLimit.ts', 'src/auth/refresh.ts', 'src/jobs/email.ts', 'src/queue/worker.ts', 'src/routes/search.ts', 'src/db/migrations/0042_search_index.sql', 'src/webhooks/deliver.ts', 'src/audit/log.ts', 'test/rateLimit.test.ts', 'src/db/pool.ts'],
    recaps: ['Rate limiting is in and tested; per-plan limits come from the plans table. Next: expose the remaining quota in response headers.', 'Found the refresh race: both tabs passed the validity check before either rotated the token. Fixed with a conditional update; tests pass.', 'Search is 6x faster after the composite index. The query plan now uses an index scan instead of a sequential scan.', 'Webhook retries ship with jittered backoff. Failed deliveries after 6 attempts land in the dead-letter table.'],
  },
  {
    name: 'tidepool-web', weight: 4, branch: ['main', 'redesign/settings', 'feat/onboarding'], claudeMd: true,
    titles: ['Redesign the settings page', 'Onboarding checklist', 'Dark mode for charts', 'Fix layout shift on dashboard', 'Keyboard shortcuts for the editor', 'Empty states for every list'],
    prompts: ['the settings page is a wall of toggles, group it into sections with clear headings', 'add an onboarding checklist that disappears once all five steps are done', 'charts look washed out in dark mode, fix the palette', 'there is a layout shift when the dashboard cards load, reserve the space', 'add keyboard shortcuts to the editor and a ? overlay that lists them', 'every list needs a useful empty state, not just "No data"', 'take a screenshot at mobile width and check nothing overflows', 'the toggle animation feels sluggish, make it snappier', 'run the storybook tests'],
    files: ['src/pages/Settings.tsx', 'src/components/Checklist.tsx', 'src/charts/palette.ts', 'src/pages/Dashboard.tsx', 'src/editor/shortcuts.ts', 'src/components/EmptyState.tsx', 'src/styles/tokens.css'],
    recaps: ['Settings is now four sections with sticky headings; all toggles kept their keys so saved preferences still load.', 'The onboarding checklist tracks progress server-side and hides itself after the last step.', 'Dark-mode chart colors now come from the same tokens as the rest of the UI and pass contrast checks.'],
  },
  {
    name: 'ledgerline', weight: 3, branch: ['main', 'feat/csv-import'], claudeMd: false,
    titles: ['CSV import for bank statements', 'Monthly budget report', 'Currency conversion', 'Categorization rules engine', 'Fix rounding in totals'],
    prompts: ['add a CSV import that handles the three bank formats in samples/', 'generate a monthly report: spending by category, compared with the budget', 'support multiple currencies, convert with the rate on the transaction date', 'let me write rules like "description contains UBER -> Transport"', 'totals are off by a cent sometimes, I think it is float rounding', 'use integer cents everywhere instead', 'cargo test and fix whatever breaks', 'add a --dry-run flag to import'],
    files: ['src/import/csv.rs', 'src/report/monthly.rs', 'src/fx.rs', 'src/rules.rs', 'src/money.rs', 'src/main.rs'],
    recaps: ['CSV import handles all three bank formats; unknown columns are reported instead of silently dropped.', 'Money is integer cents end to end now, so the off-by-one-cent totals are gone.'],
  },
  {
    name: 'quill-docs', weight: 2, branch: ['main'], claudeMd: true,
    titles: ['Rewrite the getting started guide', 'API reference from OpenAPI', 'Fix broken links', 'Search for the docs site'],
    prompts: ['the getting started guide assumes too much, rewrite it for someone who has never used the CLI', 'generate the API reference pages from openapi.yaml', 'find and fix every broken link in the docs', 'add client-side search to the docs site', 'tighten the wording on the auth page, it is too long'],
    files: ['docs/getting-started.md', 'docs/api/index.md', 'scripts/gen-api.js', 'site/search.js', 'docs/auth.md'],
    recaps: ['Getting started is rewritten around one complete example; the old page is kept as "Advanced setup".'],
  },
  {
    name: 'pixel-forge', weight: 2, branch: ['main', 'feat/tilemap'], claudeMd: false,
    titles: ['Tilemap editor', 'Collision detection pass', 'Save and load levels', 'Sprite animation timing'],
    prompts: ['build a simple tilemap editor: paint, erase, fill', 'collisions are tunneling at high speed, switch to swept AABB', 'save levels to JSON and load them back', 'the walk animation runs at the frame rate instead of a fixed rate, fix it', 'add undo to the editor'],
    files: ['src/editor/tilemap.ts', 'src/physics/collide.ts', 'src/level/io.ts', 'src/render/sprite.ts', 'src/editor/history.ts'],
    recaps: ['Swept AABB stops the tunneling; fast projectiles now hit thin walls reliably.'],
  },
  {
    name: 'homelab-infra', weight: 1, branch: ['main'], claudeMd: true,
    titles: ['Backups to object storage', 'Upgrade the cluster', 'Alerting for disk usage'],
    prompts: ['set up nightly backups of the postgres volume to object storage, keep 14 days', 'plan the cluster upgrade, list everything that could break', 'alert me when any disk is over 85%'],
    files: ['terraform/backups.tf', 'ansible/upgrade.yml', 'monitoring/alerts.yml'],
    recaps: ['Nightly backups run at 03:00 with 14-day retention; a restore was tested on a scratch volume.'],
  },
];

const REPLIES = [
  'I\'ll start by reading the relevant code to understand the current behavior.',
  'Found it. The issue is in how the value is read before it is updated — two callers can both pass the check.',
  'Here\'s the plan:\n\n1. Add the change behind a small helper\n2. Update the call sites\n3. Add tests for the edge cases\n\nStarting with the helper.',
  'Done. All tests pass. Summary of the change:\n\n- The new logic lives in one place\n- Existing behavior is unchanged for current users\n- Added tests for the edge cases you mentioned',
  'The before/after numbers:\n\n| | Before | After |\n|---|---|---|\n| p50 | 420 ms | 64 ms |\n| p95 | 1.9 s | 180 ms |',
  'That works. One thing to watch: the old code path is still used by the nightly job, so I left it in place for now.',
];
const MODELS = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'];

function encodeDir(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

function writeSession({ project, start, endAt, turns, id, title, model, recap, keepOpen }) {
  const cwd = path.join(CODE, project.name);
  const dir = path.join(CLAUDE, 'projects', encodeDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const branch = pick(project.branch);
  const lines = [];
  const base = { sessionId: id, cwd, gitBranch: branch, version: '2.1.327', entrypoint: 'cli', userType: 'external', isSidechain: false };
  let t = start;
  let parent = null;
  const rec = (o) => { const uuidv = uuid(); lines.push({ ...base, parentUuid: parent, uuid: uuidv, ts: t, ...o }); parent = uuidv; };
  const history = [];
  let ctx = int(18000, 30000);
  const prompts = project.prompts.slice();
  let pi = int(0, Math.max(0, prompts.length - turns));
  for (let i = 0; i < turns; i++) {
    const text = prompts[(pi + i) % prompts.length];
    rec({ type: 'user', message: { role: 'user', content: text }, promptSource: 'user' });
    history.push({ display: text, pastedContents: {}, timestamp: t, project: cwd, sessionId: id });
    const steps = int(1, 4);
    for (let k = 0; k < steps; k++) {
      t += int(4, 40) * 1000;
      const mid = 'msg_' + crypto.randomBytes(8).toString('hex');
      ctx += int(1500, 9000);
      const usage = { input_tokens: int(3, 40), output_tokens: int(150, 2400), cache_read_input_tokens: ctx, cache_creation_input_tokens: int(400, 6000) };
      const tool = pick(['Read', 'Edit', 'Edit', 'Bash', 'Grep', 'Write']);
      const file = path.join(cwd, pick(project.files));
      const input = tool === 'Bash' ? { command: pick(['npm test', 'git status', 'cargo test', 'npm run lint', 'git diff --stat']), description: 'Run checks' }
        : tool === 'Grep' ? { pattern: pick(['refresh', 'limit', 'TODO', 'export function']), path: cwd }
          : tool === 'Write' ? { file_path: file, content: '// …' }
            : tool === 'Edit' ? { file_path: file, old_string: 'before', new_string: 'after' } : { file_path: file };
      const toolId = 'toolu_' + crypto.randomBytes(8).toString('hex');
      const content = [];
      if (k === 0) content.push({ type: 'text', text: pick(REPLIES.slice(0, 3)) });
      content.push({ type: 'tool_use', id: toolId, name: tool, input });
      rec({ type: 'assistant', message: { id: mid, role: 'assistant', model, content, usage } });
      t += int(1, 6) * 1000;
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: tool === 'Bash' ? 'All tests passed (48 tests)' : 'ok' }] }, toolUseResult: {} });
    }
    t += int(5, 30) * 1000;
    rec({ type: 'assistant', message: { id: 'msg_' + crypto.randomBytes(8).toString('hex'), role: 'assistant', model, content: [{ type: 'text', text: pick(REPLIES.slice(3)) }], usage: { input_tokens: 4, output_tokens: int(200, 900), cache_read_input_tokens: ctx, cache_creation_input_tokens: int(200, 1500) } } });
    rec({ type: 'system', subtype: 'turn_duration', durationMs: int(20, 240) * 1000 });
    // Thinking/reading time before the next prompt; occasionally a long break.
    if (i < turns - 1) t += (rnd() < 0.12 ? int(25, 70) : int(1, 9)) * 60000;
  }
  lines.push({ type: 'ai-title', aiTitle: title, sessionId: id });
  if (recap && !keepOpen) { t += 60000; rec({ type: 'system', subtype: 'away_summary', content: recap }); }
  lines.push({ type: 'cost-state', sessionId: id, totalLinesAdded: int(20, 900), totalLinesRemoved: int(5, 300) });
  // Optionally slide the whole session so it ends at a chosen moment.
  const shift = endAt ? endAt - t : 0;
  t += shift;
  for (const h of history) h.timestamp += shift;
  const out = lines.map(({ ts, ...o }) => JSON.stringify(ts == null ? o : { ...o, timestamp: new Date(ts + shift).toISOString() }));
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, out.join('\n') + '\n');
  const mtime = new Date(t);
  fs.utimesSync(file, mtime, mtime);
  return { history, end: t, cwd };
}

function main() {
  if (fs.existsSync(CLAUDE)) fs.rmSync(CLAUDE, { recursive: true, force: true });
  fs.mkdirSync(path.join(CLAUDE, 'sessions'), { recursive: true });
  for (const p of PROJECTS) {
    const d = path.join(CODE, p.name);
    fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    if (p.claudeMd) fs.writeFileSync(path.join(d, 'CLAUDE.md'), `# ${p.name}\n`);
  }

  const now = Date.now();
  const day = 86400000;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const totalW = PROJECTS.reduce((a, p) => a + p.weight, 0);
  const weighted = () => { let r = rnd() * totalW; for (const p of PROJECTS) { r -= p.weight; if (r < 0) return p; } return PROJECTS[0]; };

  const history = [];
  const sessions = [];
  // ~4 months of history, busier on weekdays and in recent weeks.
  for (let d = 120; d >= 1; d--) {
    const date = new Date(today0.getTime() - d * day);
    const weekday = date.getDay() % 6 !== 0;
    const p = (weekday ? 0.78 : 0.3) * (d > 60 ? 0.7 : 1);
    if (rnd() > p) continue;
    const n = int(1, weekday ? 3 : 1);
    let hour = int(9, 11);
    for (let i = 0; i < n; i++) {
      const pr = weighted();
      const start = date.getTime() + hour * 3600000 + int(0, 50) * 60000;
      const s = writeSession({ project: pr, start, turns: int(3, 14), id: uuid(), title: pick(pr.titles), model: pick(MODELS), recap: rnd() < 0.75 ? pick(pr.recaps) : null });
      history.push(...s.history); sessions.push(s);
      hour = Math.min(22, new Date(s.end).getHours() + int(1, 3));
    }
  }

  // Today: a finished morning session, one still working, and one waiting for approval.
  // These are anchored to end shortly before now, whatever time of day it is.
  const hero = writeSession({ project: PROJECTS[0], start: now, endAt: now - 26 * 60000, turns: 9, id: uuid(), title: 'Add per-tenant rate limiting', model: 'claude-opus-5-5', recap: PROJECTS[0].recaps[0] });
  history.push(...hero.history);
  const busyId = uuid();
  const busy = writeSession({ project: PROJECTS[1], start: now, endAt: now - 2 * 60000, turns: 6, id: busyId, title: 'Redesign the settings page', model: 'claude-opus-5-5', keepOpen: true });
  history.push(...busy.history);
  const waitId = uuid();
  const wait = writeSession({ project: PROJECTS[2], start: now, endAt: now - 4 * 60000, turns: 4, id: waitId, title: 'CSV import for bank statements', model: 'claude-sonnet-5-5', keepOpen: true });
  history.push(...wait.history);

  // A few sessions whose transcripts were cleaned up: only prompt history remains.
  for (let i = 0; i < 6; i++) {
    const pr = weighted(); const sid = uuid(); let t = today0.getTime() - int(130, 200) * day + int(9, 18) * 3600000;
    for (let k = 0; k < int(2, 5); k++) { history.push({ display: pick(pr.prompts), pastedContents: {}, timestamp: t, project: path.join(CODE, pr.name), sessionId: sid }); t += int(2, 15) * 60000; }
  }

  history.sort((a, b) => a.timestamp - b.timestamp);
  fs.writeFileSync(path.join(CLAUDE, 'history.jsonl'), history.map((h) => JSON.stringify(h)).join('\n') + '\n');
  fs.writeFileSync(path.join(CLAUDE, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(PROJECTS.map((p) => [path.join(CODE, p.name), {}])) }, null, 2));

  if (withLive) {
    // Placeholder processes stand in for running `claude` sessions (they exit after 10 minutes).
    const live = [[busyId, busy.cwd, 'busy', null], [waitId, wait.cwd, 'waiting', 'approve Bash: cargo test']];
    for (const [sid, cwd, status, waitingFor] of live) {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      const ts = Date.now() - int(1, 4) * 60000;
      fs.writeFileSync(path.join(CLAUDE, 'sessions', child.pid + '.json'), JSON.stringify({ pid: child.pid, sessionId: sid, cwd, status, waitingFor, startedAt: ts - 3600000, updatedAt: ts, statusUpdatedAt: ts, version: '2.1.327', kind: 'interactive', entrypoint: 'cli' }));
      console.log('live pid', child.pid);
    }
  }
  console.log(`Wrote ${sessions.length + 3} sessions, ${history.length} prompts to ${CLAUDE}`);
}

main();
