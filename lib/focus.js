'use strict';
// Bring a running Claude Code session's terminal to the front, on the exact tab.
//
// Matching Windows Terminal tabs by title is unreliable (two sessions can share a title, new
// sessions are all "Claude Code"), so instead we briefly give the session's console a unique
// title: attach to the claude process's console, set the title to a nonce, find the tab that
// shows it via UI Automation, restore the original title, then select that tab and raise its
// window. Fallbacks: the session's own console window (classic conhost), the nearest ancestor
// process that owns a window (VS Code, other terminals), then a tab whose title matches the
// session's title only if exactly one does.
//
// A single PowerShell helper stays running so a click costs ~0.2 s instead of a cold start.
const { spawn } = require('child_process');

const HELPER = String.raw`
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class RcNative {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetConsoleTitle(StringBuilder sb, uint n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool SetConsoleTitle(string t);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr x);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint pid);
  [DllImport("kernel32.dll")] static extern bool Process32FirstW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool Process32NextW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct PE { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile; }

  // Sets the console title of the process's console; returns the previous title (null if it has no console).
  public static string SwapTitle(uint pid, string title) {
    FreeConsole();
    if (!AttachConsole(pid)) return null;
    try { var sb = new StringBuilder(4096); GetConsoleTitle(sb, 4096); SetConsoleTitle(title); return sb.ToString(); }
    finally { FreeConsole(); }
  }
  public static long ConsoleWindowOf(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return 0;
    try { return GetConsoleWindow().ToInt64(); } finally { FreeConsole(); }
  }
  // Foreground changes are normally blocked for background processes; a synthetic Alt tap lifts that.
  public static void Activate(long hwnd) {
    var h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h); BringWindowToTop(h);
  }
  public static uint[] Ancestors(uint pid) {
    var parent = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    var e = new PE(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE));
    if (Process32FirstW(snap, ref e)) do { parent[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32NextW(snap, ref e));
    CloseHandle(snap);
    var list = new List<uint>(); uint cur = pid;
    while (parent.ContainsKey(cur) && list.Count < 12) { cur = parent[cur]; if (cur == 0 || list.Contains(cur)) break; list.Add(cur); }
    return list.ToArray();
  }
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$isTab = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$isWt = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')

function Get-Tabs {
  foreach ($w in $AE::RootElement.FindAll($Scope::Children, $isWt)) {
    foreach ($t in $w.FindAll($Scope::Descendants, $isTab)) { [pscustomobject]@{ Win = $w; Tab = $t; Name = $t.Current.Name } }
  }
}
function Norm($s) { ([string]$s -replace '^[^\p{L}\p{N}]+', '').Trim().ToLowerInvariant() }
function Show-Tab($hit, $dry) {
  if ($dry) { return }
  try { $hit.Tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { }
  [RcNative]::Activate([long]$hit.Win.Current.NativeWindowHandle)
}

function Focus-Session([uint32]$target, [string[]]$titles, [bool]$dry) {
  # 1. Exact tab via a temporary unique console title. A busy session redraws its title often,
  #    so retry a couple of times if Claude Code overwrote ours before the tab showed it.
  $nonce = 'recode-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
  $old = [RcNative]::SwapTitle($target, $nonce)
  if ($null -ne $old) {
    $hit = $null
    for ($round = 0; $round -lt 3 -and -not $hit; $round++) {
      if ($round) { [void][RcNative]::SwapTitle($target, $nonce) }
      for ($i = 0; $i -lt 8 -and -not $hit; $i++) {
        $hit = Get-Tabs | Where-Object { $_.Name -like "*$nonce*" } | Select-Object -First 1
        if (-not $hit) { Start-Sleep -Milliseconds 40 }
      }
    }
    [void][RcNative]::SwapTitle($target, $old)
    if ($hit) { Show-Tab $hit $dry; return 'tab' }
    # 2. A classic console window of its own.
    $cw = [RcNative]::ConsoleWindowOf($target)
    if ($cw -ne 0 -and [RcNative]::IsWindowVisible([IntPtr]$cw)) { if (-not $dry) { [RcNative]::Activate($cw) }; return 'window:console' }
  }
  # 3. Title match, only when it's unambiguous (e.g. the terminal ignores title changes).
  $want = @($titles | Where-Object { $_ } | ForEach-Object { Norm $_ } | Select-Object -Unique)
  if ($want.Count) {
    $hits = @(Get-Tabs | Where-Object { $want -contains (Norm $_.Name) })
    if ($hits.Count -eq 1) { Show-Tab $hits[0] $dry; return 'tab:title' }
  }
  # 4. Nearest ancestor with a window (VS Code's terminal, other terminal apps).
  foreach ($a in [RcNative]::Ancestors($target)) {
    $p = Get-Process -Id $a -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { if (-not $dry) { [RcNative]::Activate([long]$p.MainWindowHandle) }; return 'window:' + $p.ProcessName }
  }
  'none'
}

$in = [Console]::In; $out = [Console]::Out
$out.WriteLine('ready'); $out.Flush()
while ($null -ne ($line = $in.ReadLine())) {
  $parts = $line -split "\t"
  try {
    $titles = if ($parts.Count -gt 3 -and $parts[3]) { $parts[3] -split [char]0x1f } else { @() }
    $r = Focus-Session ([uint32]$parts[1]) $titles ($parts[2] -eq 'dry')
  } catch { $r = 'error:' + ($_.Exception.Message -replace '\s+', ' ') }
  $out.WriteLine($parts[0] + [char]9 + $r); $out.Flush()
}
`;

let proc = null;
let buf = '';
let seq = 0;
const pending = new Map(); // id -> { resolve, timer }

function finish(id, result) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(result);
}

function helper() {
  if (proc && proc.exitCode === null && !proc.killed) return proc;
  const encoded = Buffer.from(HELPER, 'utf16le').toString('base64');
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  buf = '';
  const me = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      const tab = line.indexOf('\t');
      if (tab > 0) finish(line.slice(0, tab), line.slice(tab + 1).trim());
    }
  });
  const fail = () => { if (proc === me) proc = null; for (const id of [...pending.keys()]) finish(id, 'none'); };
  proc.on('exit', fail);
  proc.on('error', fail);
  proc.stdin.on('error', () => {});
  return proc;
}

// Resolves to 'tab' | 'tab:title' | 'window:<name>' | 'none'. dryRun finds the target without
// switching anything (used by checks).
function focusSession(pid, { titles = [], dryRun = false } = {}) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve('none');
  return new Promise((resolve) => {
    const id = String(++seq);
    // The first call also waits for the helper to compile its native bits (~1-2 s).
    // A helper stuck on a hung window would block every later request; replace it.
    const timer = setTimeout(() => { finish(id, 'none'); stop(); }, 15000);
    pending.set(id, { resolve, timer });
    const clean = titles.map((t) => String(t || '').replace(/[\t\r\n\x1f]/g, ' ').trim()).filter(Boolean).join('\x1f');
    try { helper().stdin.write(`${id}\t${pid}\t${dryRun ? 'dry' : 'go'}\t${clean}\n`); } catch { finish(id, 'none'); }
  });
}

// Starts the helper ahead of the first click.
function warmUp() { if (process.platform === 'win32') helper(); }
function stop() { if (proc) { try { proc.kill(); } catch { /* gone */ } proc = null; } }

module.exports = { focusSession, warmUp, stop };
