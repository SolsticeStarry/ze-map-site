# 启动后端：启动 SYSTEM 计划任务（需要提升权限，由 start-bake.cmd 调用）。
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $Root 'start.log'
function Log([string]$m) { ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Add-Content $log }

# watchdog 看到 run-to-end.log 末尾是 FINISHED 就不会重启。显式点击启动 = 想再跑一轮，
# 因此先把上一轮已结束的日志轮转掉；若当前正在跑（末尾不是 FINISHED）则不动它。
$rl = Join-Path $Root 'run-to-end.log'
if ((Test-Path $rl) -and @(Get-Content $rl -ErrorAction SilentlyContinue | Select-Object -Last 5) -match 'FINISHED') {
  $bak = Join-Path $Root ('run-to-end.{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item $rl $bak -Force -ErrorAction SilentlyContinue
  Log "rotated finished log -> $(Split-Path -Leaf $bak)"
}

try { Start-ScheduledTask -TaskName 'ze-terr-bake-svc' -ErrorAction Stop; Log 'task start issued' }
catch { Log "start failed: $($_.Exception.Message)" }
