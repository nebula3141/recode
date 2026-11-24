'use strict';
// Bring a running Claude Code session's terminal to the front.
// Walks up from the claude process to the first ancestor that owns a window. For Windows
// Terminal it then selects the tab whose title matches the session (Claude Code titles its
// tab "<status glyph> <session title>") using UI Automation.
const { execFile } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [int]$env:CL_PID
$title = $env:CL_TITLE
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]

$procs = @{}
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
$cur = $procs[$target]; $owner = $null; $n = 0
while ($cur -and $n -lt 12) {
  $gp = Get-Process -Id $cur.ProcessId -ErrorAction SilentlyContinue
  if ($gp -and $gp.MainWindowHandle -ne 0) { $owner = $gp; break }
  $cur = $procs[[int]$cur.ParentProcessId]; $n++
}
if (-not $owner) { 'none'; exit }

function Show-Window($el) {
  try { $wp = $el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern); if ($wp.Current.WindowVisualState -eq 'Minimized') { $wp.SetWindowVisualState('Normal') } } catch { }
  try { $el.SetFocus() } catch { }
}
function Norm($s) { ($s -replace '^[^\p{L}\p{N}]+', '').Trim().ToLowerInvariant() }

if ($owner.ProcessName -eq 'WindowsTerminal' -and $title) {
  $want = Norm $title
  $isTab = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $isWt = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
  $best = $null; $bestWin = $null; $bestScore = 0
  foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $isWt)) {
    foreach ($t in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isTab)) {
      $name = Norm $t.Current.Name
      $score = if ($name -eq $want) { 3 } elseif ($name.StartsWith($want) -or $want.StartsWith($name)) { 2 } elseif ($name.Contains($want)) { 1 } else { 0 }
      if ($score -gt $bestScore) { $best = $t; $bestWin = $w; $bestScore = $score }
    }
  }
  if ($best) {
    Show-Window $bestWin
    try { $best.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { }
    'tab'; exit
  }
}
Show-Window ($AE::FromHandle($owner.MainWindowHandle))
'window:' + $owner.ProcessName
`;

// Resolves to 'tab' (exact Windows Terminal tab), 'window:<process>' or 'none'.
function focusSession(pid, title) {
  if (process.platform !== 'win32' || !Number.isInteger(pid)) return Promise.resolve('none');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      timeout: 10000, windowsHide: true, env: { ...process.env, CL_PID: String(pid), CL_TITLE: String(title || '') },
    }, (err, out) => resolve(err ? 'none' : String(out).trim().split(/\r?\n/).pop() || 'none'));
  });
}

module.exports = { focusSession };
