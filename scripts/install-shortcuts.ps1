# Adds "ReCode" to the Start menu and the Desktop, pointing at the packaged app.
# Run after `npm run package`:  npm run shortcuts
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Get-ChildItem -Path (Join-Path $root 'dist') -Filter 'ReCode.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { throw "Packaged app not found. Run 'npm run package' first." }

# Remove shortcuts left over from the app's earlier name.
foreach ($old in @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Claude Launcher.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Launcher.lnk')
)) { if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force; Write-Output "Removed $old" } }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'ReCode.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ReCode.lnk')
)
foreach ($lnkPath in $targets) {
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $exe.FullName
  $lnk.WorkingDirectory = $exe.DirectoryName
  $lnk.IconLocation = "$($exe.FullName),0"
  $lnk.Description = 'Browse and resume Claude Code sessions'
  $lnk.Save()
  Write-Output "Created $lnkPath"
}
