# Called (elevated) by start-bake.cmd: prepare toolchain + SYSTEM task once, then start the bake.
# Goal: on a fresh machine the flow is just "install Node.js -> clone -> double-click start-bake.cmd".
# Idempotent: if the toolchain and task already exist it skips straight to starting.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $Root 'bootstrap.log'
function Log([string]$m) { ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Add-Content $log }
function Info([string]$m) { Log $m; Write-Host "[bake] $m" -ForegroundColor Cyan }

# node: fall back to common install dirs when PATH does not have it.
function Resolve-NodeDir {
  $cands = @('C:\Program Files\nodejs', (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))
  $cands += (Get-ChildItem 'C:\Users\*\AppData\Local\Programs\nodejs\node.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.DirectoryName })
  foreach ($d in $cands) { if ($d -and (Test-Path (Join-Path $d 'node.exe'))) { return $d } }
  return ''
}

try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nd = Resolve-NodeDir
    if ($nd) { $env:Path = $nd + ';' + $env:Path }
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 18+ not found. Install it first: https://nodejs.org/'
  }

  # 1) toolchain: steamcmd + Source2Viewer CLI + npm deps
  $s2v = Join-Path $Root '.tools\s2v\Source2Viewer-CLI.exe'
  $steam = Join-Path $Root '.tools\steamcmd\steamcmd.exe'
  $mesh = Join-Path $Root 'node_modules\meshoptimizer'
  if (-not (Test-Path $s2v) -or -not (Test-Path $steam) -or -not (Test-Path $mesh)) {
    Info 'toolchain missing, running setup.ps1 (needs internet)...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'setup.ps1')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $s2v) -or -not (Test-Path $steam)) { throw 'setup.ps1 failed' }
  } else {
    Info 'toolchain ready'
  }

  # 2) SYSTEM scheduled task (skip when it already points at this clone)
  $taskOk = $false
  try {
    $t = Get-ScheduledTask -TaskName 'ze-terr-bake-svc' -ErrorAction Stop
    $act = $t.Actions | Select-Object -First 1
    if ($act.Arguments -like "*$Root\watchdog.ps1*") { $taskOk = $true }
  } catch {}
  if (-not $taskOk) {
    Info 'scheduled task missing/stale, registering ze-terr-bake-svc ...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'install-task.ps1')
  } else {
    Info 'scheduled task ready'
  }

  # 3) start (start-bake.ps1 rotates a finished log + Start-ScheduledTask)
  Info 'starting bake task'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'start-bake.ps1')
} catch {
  Info ("bootstrap failed: " + $_.Exception.Message)
  Write-Host "[bake] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
