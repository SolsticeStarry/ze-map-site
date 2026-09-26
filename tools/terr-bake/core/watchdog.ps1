# 看门狗：若流水线未运行且尚未结束，则以独立进程重新拉起。
# 供计划任务调用（SYSTEM），或手动运行。路径以脚本自身位置为准。
param([string]$ToolsRoot = '', [string]$LocalCache = '')
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $Root 'watchdog.log'

function Log([string]$m) { ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Add-Content $log }
function Ids([string]$f) {
  if (-not (Test-Path $f)) { return @() }
  @(Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
}

# 已正常结束（FINISHED）→ 不再拉起
$rl = Join-Path $Root 'run-to-end.log'
if ((Test-Path $rl) -and @(Get-Content $rl -ErrorAction SilentlyContinue | Select-Object -Last 5) -match 'FINISHED') { exit 0 }

$all = Ids (Join-Path $Root 'capped.txt')
$done = Ids (Join-Path $Root 'done.txt')
if (($all.Count - $done.Count) -le 0) { exit 0 }

# 是否已在运行：优先看 engine.pid（launch.ps1 写入），该 PID 存活即认为在跑
$pidFile = Join-Path $Root 'engine.pid'
$alive = $false
if (Test-Path $pidFile) {
  $ep = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($ep -match '^\d+$' -and (Get-Process -Id ([int]$ep) -ErrorAction SilentlyContinue)) { $alive = $true }
}
if ($alive) { exit 0 }

Log "pipeline not running (remaining=$($all.Count - $done.Count)) -> restart"
$argLine = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'launch.ps1') + '"'
if ($ToolsRoot)  { $argLine += ' -ToolsRoot "' + $ToolsRoot + '"' }
if ($LocalCache) { $argLine += ' -LocalCache "' + $LocalCache + '"' }
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('powershell.exe ' + $argLine); CurrentDirectory = $Root } | Out-Null
