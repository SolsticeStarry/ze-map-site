# 停止流水线（保留 done.txt 断点，可随时续跑）。排除自身及祖先进程。
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $Root 'stop.log'
function Log([string]$m) { ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Add-Content $log }
Log '--- stop start ---'

$patterns = @('run-to-end.ps1','bake-all.ps1','bake-one.ps1','bake-terrain.mjs','extract-entities.mjs','build-entity-bin.mjs','launch.ps1')

$exclude = @{}
$curr = $PID
while ($curr -and $curr -ne 0) {
  $exclude[[int]$curr] = $true
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$curr" -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  $curr = [int]$proc.ParentProcessId
}

$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $cl = $_.CommandLine
  if (-not $cl) { return $false }
  if ($exclude.ContainsKey([int]$_.ProcessId)) { return $false }
  if ($cl -like '*stop-bake*') { return $false }
  foreach ($p in $patterns) { if ($cl -like "*$p*") { return $true } }
  return $false
}
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Log "stopped $($p.Name) $($p.ProcessId)" }
foreach ($s in @(Get-Process steamcmd -ErrorAction SilentlyContinue)) { Stop-Process -Id $s.Id -Force -ErrorAction SilentlyContinue; Log "stopped steamcmd $($s.Id)" }

# 清掉引擎 PID 标记
Remove-Item (Join-Path $Root 'engine.pid') -Force -ErrorAction SilentlyContinue

# 写明确的停止标记，供 status-bake.ps1 / 人 判断
$toLog = Join-Path $Root 'run-to-end.log'
('[{0}] STOPPED by stop-bake' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) | Add-Content $toLog -ErrorAction SilentlyContinue
Log 'done'
