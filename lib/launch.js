'use strict';
// Opens Claude Code in a terminal (Windows Terminal tab/window or a plain console)
// and performs small OS actions (open folder, editor, folder picker, stop process).
// The PowerShell command is passed with -EncodedCommand, so paths, names and
// prompts containing quotes, semicolons or unicode can't break out of quoting.
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
// ReCode's own settings (data folder, test profile) must not leak into terminals it opens:
// a ReCode started later from such a terminal would otherwise share or misplace its state.
function childEnv() {
  const env = { ...process.env };
  delete env.LAUNCHER_DATA_DIR; delete env.RECODE_USER_DATA;
  return env;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TOKEN = /^[\w.\-\[\]:]{1,80}$/;
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function which(cmd) {
  try {
    const out = execFileSync(IS_WIN ? 'where.exe' : 'which', [cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}

const tools = {
  wt: IS_WIN ? which('wt.exe') : null,
  pwsh: IS_WIN ? which('pwsh.exe') : which('pwsh'),
  code: which(IS_WIN ? 'code.cmd' : 'code'),
};

// One `claude --version` per configured command, success or failure, so a missing
// claude doesn't spawn a process on every refresh.
const versions = new Map();
function getClaudeVersion(claudePath) {
  const cmd = claudePath || 'claude';
  if (!versions.has(cmd)) {
    versions.set(cmd, new Promise((resolve) => {
      execFile(cmd, ['--version'], { timeout: 15000, windowsHide: true }, (err, out) => {
        resolve(err ? null : String(out).trim().split(/\s+/)[0] || null);
      });
    }));
  }
  return versions.get(cmd);
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// Validates launch options and returns the claude argument vector.
function buildClaudeArgs(o) {
  const args = [];
  const mode = o.mode || 'new';
  if (mode === 'resume' || mode === 'fork') {
    if (!UUID.test(o.sessionId || '')) throw new Error('Invalid session id');
    args.push('--resume', o.sessionId);
    if (mode === 'fork') args.push('--fork-session');
  } else if (mode === 'continue') {
    args.push('--continue');
  } else if (mode !== 'new') {
    throw new Error('Unknown mode');
  }
  if (o.model) { if (!SAFE_TOKEN.test(o.model)) throw new Error('Invalid model'); args.push('--model', o.model); }
  if (o.permissionMode) { if (!PERMISSION_MODES.has(o.permissionMode)) throw new Error('Invalid permission mode'); args.push('--permission-mode', o.permissionMode); }
  if (o.effort) { if (!EFFORTS.has(o.effort)) throw new Error('Invalid effort'); args.push('--effort', o.effort); }
  if (o.name && String(o.name).trim()) args.push('--name', String(o.name).trim().slice(0, 120));
  if (o.remoteControl) args.push('--remote-control');
  if (o.chrome) args.push('--chrome');
  if (o.ide) args.push('--ide');
  for (const d of o.addDirs || []) if (String(d).trim()) args.push('--add-dir', String(d).trim());
  if (o.prompt && String(o.prompt).trim()) args.push(String(o.prompt));
  return args;
}

// Windows PowerShell 5.1 (and pwsh in Legacy mode) wraps an argument that contains
// whitespace in quotes when calling a program, but does not escape quotes or trailing
// backslashes inside it. Pre-escape them (MSVC rules) so claude receives the exact text.
function nativeArg(a) {
  let s = String(a).replace(/(\\*)"/g, (_, bs) => bs + bs + '\\"');
  if (/\s/.test(s)) s = s.replace(/(\\+)$/, '$1$1');
  return psQuote(s);
}

function buildPsCommand(claudePath, args, o, title) {
  const extra = typeof o.extraArgs === 'string' && o.extraArgs.trim() ? ' ' + o.extraArgs.trim().replace(/[\r\n]+/g, ' ') : '';
  // Insert extra args before the positional prompt, if any.
  let head = args;
  let tail = [];
  if (o.prompt && String(o.prompt).trim()) { head = args.slice(0, -1); tail = args.slice(-1); }
  return [
    "$PSNativeCommandArgumentPassing = 'Legacy'", // same behavior on pwsh 7 as on 5.1
    `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
    `Set-Location -LiteralPath ${psQuote(o.cwd)}`,
    `& ${psQuote(claudePath || 'claude')} ${head.map(nativeArg).join(' ')}${extra} ${tail.map(nativeArg).join(' ')}`.trimEnd(),
  ].join('; ');
}

function encode(cmd) { return Buffer.from(cmd, 'utf16le').toString('base64'); }

function detach(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
    } catch (e) { return reject(e); }
    let done = false;
    child.once('error', (e) => { if (!done) { done = true; reject(e); } });
    child.once('spawn', () => { if (!done) { done = true; child.unref(); resolve(child.pid); } });
  });
}

function cleanTitle(s) { return String(s || 'Claude').replace(/[;"\r\n\t]/g, ' ').slice(0, 60).trim() || 'Claude'; }

async function launch(o, settings) {
  if (!o.cwd || !isDir(o.cwd)) throw new Error(`Folder not found: ${o.cwd || '(none)'}`);
  const claudePath = settings.claudePath || 'claude';
  const args = buildClaudeArgs(o);
  const title = cleanTitle(o.title || o.name || path.basename(o.cwd));

  if (o.target === 'desktop') {
    args.unshift('--desktop');
    await detach(claudePath, args, { cwd: o.cwd, windowsHide: true });
    return { how: 'desktop', args };
  }

  if (!IS_WIN) {
    // Best effort on macOS/Linux: open a terminal running the command.
    const line = `cd ${JSON.stringify(o.cwd)} && ${claudePath} ${args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')}`;
    if (process.platform === 'darwin') {
      await detach('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate']);
    } else {
      await detach('x-terminal-emulator', ['-e', 'bash', '-lc', line + '; exec bash']);
    }
    return { how: 'terminal', args };
  }

  const shellExe = (o.shell || settings.shell) === 'pwsh' && tools.pwsh ? tools.pwsh : 'powershell.exe';
  const keepOpen = o.keepShellOpen ?? settings.keepShellOpen;
  const psArgs = ['-NoLogo', ...(keepOpen ? ['-NoExit'] : []), '-EncodedCommand', encode(buildPsCommand(claudePath, args, o, title))];
  const terminal = o.terminal || settings.terminal;

  if ((terminal === 'wt-tab' || terminal === 'wt-window') && tools.wt) {
    const wtArgs = ['-w', terminal === 'wt-tab' ? '0' : 'new', 'new-tab', '--title', title, '-d', o.cwd.replace(/;/g, '\\;'), shellExe, ...psArgs];
    await detach(tools.wt, wtArgs, { cwd: o.cwd });
    return { how: terminal, args };
  }
  // A detached process gets no console of its own; `start` opens a new console window.
  // Title and folder go through environment variables: cmd expands %VAR% once and does not
  // re-expand the value, so a % in a path or title stays literal. Neither can contain a ",
  // and the PowerShell command itself is base64.
  const line = `start "%CL_TITLE%" /D "%CL_CWD%" "%CL_SHELL%" ${psArgs.join(' ')}`;
  await detach('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true, windowsHide: true,
    env: { ...childEnv(), CL_TITLE: title, CL_CWD: o.cwd, CL_SHELL: shellExe },
  });
  return { how: 'console', args };
}

// Human-readable command for copy/paste.
function commandLine(o, settings) {
  const args = buildClaudeArgs(o);
  // PowerShell quoting: bare when safe, otherwise single quotes with '' escaping.
  const q = (a) => (/^[\w.\-\/:=\\]+$/.test(a) ? a : psQuote(a));
  const extra = o.extraArgs && o.extraArgs.trim() ? ' ' + o.extraArgs.trim() : '';
  return `cd ${q(o.cwd || '.')}; ${settings.claudePath && settings.claudePath !== 'claude' ? q(settings.claudePath) : 'claude'} ${args.map(q).join(' ')}${extra}`.trim();
}

async function openFolder(p) {
  if (!isDir(p)) throw new Error('Folder not found');
  if (IS_WIN) return detach('explorer.exe', [p]);
  return detach(process.platform === 'darwin' ? 'open' : 'xdg-open', [p]);
}

async function revealFile(p) {
  if (!fs.existsSync(p)) throw new Error('File not found');
  if (IS_WIN) return detach('explorer.exe', ['/select,', p]);
  return openFolder(path.dirname(p));
}

async function openInEditor(p, editor) {
  if (!fs.existsSync(p)) throw new Error('Path not found');
  const ed = editor || 'code';
  if (!/^[\w.\-]+$/.test(ed)) throw new Error('Invalid editor command');
  if (IS_WIN) {
    // .cmd shims need cmd.exe. The path goes through an env var so % in it isn't expanded;
    // Windows paths cannot contain double quotes.
    return detach('cmd.exe', ['/d', '/s', '/c', `"${ed} "%CL_PATH%""`], { windowsVerbatimArguments: true, windowsHide: true, env: { ...childEnv(), CL_PATH: p } });
  }
  return detach(ed, [p]);
}

function pickFolder(initial) {
  if (!IS_WIN) return Promise.reject(new Error('Folder picker is only available on Windows'));
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; WindowState="Minimized"}',
    '$owner.Show(); $owner.Hide()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "Choose a folder for Claude Code"',
    '$d.ShowNewFolderButton = $true',
    initial && isDir(initial) ? `$d.SelectedPath = ${psQuote(initial)}` : '',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }',
  ].filter(Boolean).join('; ');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encode(script)], { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, out) => {
      if (err) return reject(err);
      resolve(String(out).trim() || null);
    });
  });
}

function stopProcess(pid) {
  return new Promise((resolve, reject) => {
    const cmd = IS_WIN ? 'taskkill.exe' : 'kill';
    const args = IS_WIN ? ['/PID', String(pid), '/T', '/F'] : ['-TERM', String(pid)];
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve()));
  });
}

module.exports = { launch, commandLine, openFolder, revealFile, openInEditor, pickFolder, stopProcess, getClaudeVersion, tools, UUID };
