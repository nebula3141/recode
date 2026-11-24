<#
.SYNOPSIS
  Installs ReCode from GitHub Releases for the current user (no admin rights needed).

.DESCRIPTION
  Downloads the portable build, checks its SHA-256 against the release's SHA256SUMS.txt,
  installs it to %LOCALAPPDATA%\Programs\ReCode, adds Start menu and Desktop shortcuts,
  and registers an uninstaller under Settings > Apps.

  One-line install (PowerShell):
    irm https://raw.githubusercontent.com/nebula3141/recode/main/install.ps1 | iex

  Or download this file and run it:
    powershell -ExecutionPolicy Bypass -File install.ps1 [-Version 1.0.0-rc.1] [-Prerelease] [-NoDesktopShortcut] [-Update]

.PARAMETER Version
  A specific release, e.g. 1.0.0 or 1.0.0-rc.1. Defaults to the newest stable release,
  or the newest release candidate if there is no stable release yet.
.PARAMETER Prerelease
  Install the newest release even if it is a release candidate.
.PARAMETER NoDesktopShortcut
  Only add the Start menu shortcut.
.PARAMETER Update
  Used by ReCode's own updater: keep the Desktop shortcut only if it already exists,
  log to %TEMP%\recode-update.log, and start ReCode again when done.
#>
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Prerelease,
  [switch]$NoDesktopShortcut,
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
if ($Update) {
  try { Start-Transcript -Path (Join-Path ([IO.Path]::GetTempPath()) 'recode-update.log') -Force | Out-Null } catch { }
  # Don't recreate a Desktop shortcut the user deleted.
  if (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ReCode.lnk'))) { $NoDesktopShortcut = [switch]$true }
}
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo       = 'nebula3141/recode'
$AppName    = 'ReCode'
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$UninstKey  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
$Headers    = @{ 'User-Agent' = 'recode-installer'; 'Accept' = 'application/vnd.github+json' }

function Write-Step($msg) { Write-Host "  $msg" }

Write-Host ""
Write-Host "Installing $AppName" -ForegroundColor Cyan

# ---- pick the release
if ($Version) {
  $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  $release = Invoke-RestMethod -Headers $Headers -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag"
} else {
  # Windows PowerShell 5.1 passes a JSON array down the pipeline as ONE object, so unroll it
  # explicitly before filtering (otherwise any list of 2+ releases filters to nothing).
  $resp = Invoke-RestMethod -Headers $Headers -Uri "https://api.github.com/repos/$Repo/releases?per_page=30"
  $all = @($resp | ForEach-Object { $_ } | Where-Object { -not $_.draft } | Sort-Object { [DateTime]$_.published_at } -Descending)
  $stable = @($all | Where-Object { -not $_.prerelease })
  $release = if ($Prerelease -or -not $stable.Count) { $all | Select-Object -First 1 } else { $stable | Select-Object -First 1 }
}
if (-not $release) { throw "No release found for $Repo." }
$ver = $release.tag_name.TrimStart('v')
Write-Step "Release   $($release.tag_name)$(if ($release.prerelease) { ' (release candidate)' })"

$zipAsset = $release.assets | Where-Object { $_.name -like '*-win-x64.zip' } | Select-Object -First 1
$sumAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
if (-not $zipAsset) { throw "Release $($release.tag_name) has no Windows zip." }

# ---- download and verify
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("recode-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp $zipAsset.name
  Write-Step "Download  $($zipAsset.name) ($([math]::Round($zipAsset.size / 1MB)) MB)"
  Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri $zipAsset.browser_download_url -OutFile $zip

  if ($sumAsset) {
    $sums = (Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri $sumAsset.browser_download_url).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $line = ($sums -split "`n") | Where-Object { $_ -match ("\s" + [regex]::Escape($zipAsset.name) + "\s*$") } | Select-Object -First 1
    if (-not $line) { throw "SHA256SUMS.txt has no entry for $($zipAsset.name)." }
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
    if ($expected -ne $actual) { throw "Checksum mismatch for $($zipAsset.name). Expected $expected, got $actual." }
    Write-Step "Verified  SHA-256 matches"
  } else {
    Write-Warning "This release has no SHA256SUMS.txt; skipping checksum verification."
  }

  # ---- stop a running copy so its files can be replaced
  $running = Get-Process -Name $AppName -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
  if ($running) { Write-Step "Closing   the running $AppName"; $running | Stop-Process -Force; Start-Sleep -Milliseconds 800 }

  # ---- install: extract next to the target, then swap, so a failed extract leaves the old version intact
  $staging = "$InstallDir.new"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $staging
  $exeInZip = Get-ChildItem -LiteralPath $staging -Filter "$AppName.exe" -Recurse | Select-Object -First 1
  if (-not $exeInZip) { throw "$AppName.exe not found in the download." }
  $payload = $exeInZip.DirectoryName
  if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path $InstallDir) -Force | Out-Null
  Move-Item -LiteralPath $payload -Destination $InstallDir
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  Write-Step "Installed $InstallDir"
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$exe = Join-Path $InstallDir "$AppName.exe"

# ---- uninstaller (kept inside the install folder so it is always the matching version)
$uninstaller = Join-Path $InstallDir 'uninstall.ps1'
try {
  Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "https://raw.githubusercontent.com/$Repo/$($release.tag_name)/uninstall.ps1" -OutFile $uninstaller
} catch {
  $u = $release.assets | Where-Object { $_.name -eq 'uninstall.ps1' } | Select-Object -First 1
  if ($u) { Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri $u.browser_download_url -OutFile $uninstaller }
}

# ---- shortcuts
$shell = New-Object -ComObject WScript.Shell
$links = @(Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk")
if (-not $NoDesktopShortcut) { $links += Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk" }
foreach ($l in $links) {
  $lnk = $shell.CreateShortcut($l)
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = 'Browse and resume Claude Code sessions'
  $lnk.Save()
}
Write-Step "Shortcuts $(if ($NoDesktopShortcut) { 'Start menu' } else { 'Start menu and Desktop' })"

# ---- Settings > Apps entry
if (Test-Path -LiteralPath $uninstaller) {
  New-Item -Path $UninstKey -Force | Out-Null
  $size = [int]((Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB)
  $props = @{
    DisplayName     = $AppName
    DisplayVersion  = $ver
    Publisher       = 'nebula3141'
    DisplayIcon     = "$exe,0"
    InstallLocation = $InstallDir
    URLInfoAbout    = "https://github.com/$Repo"
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstaller`""
  }
  foreach ($k in $props.Keys) { Set-ItemProperty -Path $UninstKey -Name $k -Value $props[$k] }
  Set-ItemProperty -Path $UninstKey -Name EstimatedSize -Value $size -Type DWord
  Set-ItemProperty -Path $UninstKey -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty -Path $UninstKey -Name NoRepair -Value 1 -Type DWord
}

Write-Host ""
Write-Host "$AppName $ver is installed. Open it from the Start menu." -ForegroundColor Green
Write-Host "  Uninstall: Settings > Apps > $AppName, or run $uninstaller"
Write-Host ""

if ($Update) {
  Start-Process -FilePath $exe -WorkingDirectory $InstallDir
  try { Stop-Transcript | Out-Null } catch { }
}
