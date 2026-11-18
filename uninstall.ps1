<#
.SYNOPSIS
  Removes ReCode installed by install.ps1.

.DESCRIPTION
  Deletes %LOCALAPPDATA%\Programs\ReCode, its Start menu and Desktop shortcuts, and its
  Settings > Apps entry. Your pins, notes, tags and settings are kept unless you pass
  -RemoveData. Claude Code's own files (~/.claude) are never touched.

  powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-RemoveData]

  If you installed with ReCode-Setup.exe instead, uninstall from Settings > Apps.
#>
[CmdletBinding()]
param([switch]$RemoveData)

$ErrorActionPreference = 'Stop'
$AppName    = 'ReCode'
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$UninstKey  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"

Write-Host ""
Write-Host "Uninstalling $AppName" -ForegroundColor Cyan

Get-Process -Name $AppName -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Write-Host "  Closing the running $AppName"; $_ | Stop-Process -Force; Start-Sleep -Milliseconds 800 }

foreach ($l in @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk")
)) {
  # Only remove shortcuts that point at this install, not a Setup.exe or source build.
  if (Test-Path -LiteralPath $l) {
    $target = (New-Object -ComObject WScript.Shell).CreateShortcut($l).TargetPath
    if ($target -and $target.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $l -Force; Write-Host "  Removed $l" }
  }
}

if (Test-Path -LiteralPath $UninstKey) { Remove-Item -LiteralPath $UninstKey -Recurse -Force }

if (Test-Path -LiteralPath $InstallDir) {
  # This script may be running from inside the folder; PowerShell has already read it, so deleting is safe.
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
  Write-Host "  Removed $InstallDir"
}

if ($RemoveData) {
  foreach ($d in @((Join-Path $env:APPDATA $AppName), (Join-Path $env:APPDATA 'Claude Launcher'))) {
    if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force; Write-Host "  Removed $d" }
  }
} else {
  Write-Host "  Kept your ReCode settings and notes in $env:APPDATA (use -RemoveData to delete them)"
}

Write-Host ""
Write-Host "$AppName is uninstalled." -ForegroundColor Green
Write-Host ""
