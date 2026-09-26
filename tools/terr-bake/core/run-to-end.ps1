# 分批烘焙循环。路径以脚本自身位置(tools/terr-bake/core)为准。
#
# 两种模式：
#   -Incremental:$true（默认）: 只烘「缺失产物 / 工坊已更新 / 历史遗留」的图，避免全量重烘导致历史膨胀。
#   -Incremental:$false        : 旧行为 —— 按 done.txt 把 capped.txt 里未完成的图全部烘完。
param(
  [int]$Batch = 60,
  [int]$Parallel = 4,
  [ValidateSet('hibernate','sleep','shutdown','none')][string]$Action = 'none',
  [string]$ToolsRoot = '',
  [string]$LocalCache = '',
  [bool]$Incremental = $true
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# node 兜底：PATH 可能不含用户 node 目录（SYSTEM 会话尤甚）
function Resolve-NodeDir {
  $cands = @('C:\Program Files\nodejs', (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))
  $cands += (Get-ChildItem 'C:\Users\*\AppData\Local\Programs\nodejs\node.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.DirectoryName })
  foreach ($d in $cands) { if ($d -and (Test-Path (Join-Path $d 'node.exe'))) { return $d } }
  return ''
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $nd = Resolve-NodeDir
  if ($nd) { $env:Path = $nd + ';' + $env:Path }
}

# 无人值守（RDP 断开 / 无人登录）期间阻止系统自行休眠。ES_CONTINUOUS|ES_SYSTEM_REQUIRED
# 由本进程持有，进程退出时由系统自动清除；结束动作前会显式释放，避免挡住 hibernate。
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
try {
  Add-Type -Namespace Win32 -Name PowerKeep -ErrorAction SilentlyContinue -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
  [void][Win32.PowerKeep]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
} catch {}

$doneFile = Join-Path $Root 'done.txt'
$failFile = Join-Path $Root 'failed.txt'
$idsFile  = Join-Path $Root 'capped.txt'
$logFile  = Join-Path $Root 'run-to-end.log'

function Get-Ids([string]$f) {
  if (-not (Test-Path $f)) { return @() }
  @(Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
}
function Log([string]$m) {
  $l = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content $logFile $l
  Write-Output $l
}

# 关键：native 命令的 stderr 在 $ErrorActionPreference='Stop' 下会变成终止错误。
# 调用外部程序(node/powershell)时临时放宽；输出直接写日志文件，返回退出码（不污染输出流）。
function Invoke-Native([string]$Exe, [string[]]$CmdArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $Exe @CmdArgs 2>&1 | Out-String; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  foreach ($ln in ($out -split "`r?`n")) {
    if ($ln.Trim()) { Add-Content $logFile ('[{0}]   {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $ln.TrimEnd()) }
  }
  return $code
}

$all = Get-Ids $idsFile
Log "RUN-TO-END start total=$($all.Count) batch=$Batch parallel=$Parallel action=$Action incremental=$Incremental"

try {
if ($Incremental) {
  $selector = Join-Path $Root 'select-bake.mjs'

  # 1) 基线：只补登「已完成但无记录」的图（不覆盖已有记录，否则会掩盖工坊更新）
  Log 'INCREMENTAL seed baseline (missing records only)'
  $rc = Invoke-Native 'node' @($selector, '--seed')
  Log "  seed exit=$rc"

  # 2) 选出待烘焙
  $incFile = Join-Path $Root 'incremental.txt'
  $rc = Invoke-Native 'node' @($selector, '--out', $incFile)
  Log "  select exit=$rc"
  $ids = Get-Ids $incFile
  Log "INCREMENTAL todo=$($ids.Count)"

  if ($ids.Count -eq 0) {
    Log 'INCREMENTAL nothing to bake'
  } else {
    $doneBefore = Get-Ids $doneFile
    $chunkFile = Join-Path $Root 'incremental-chunk.txt'
    $bakeAll = Join-Path $Root 'bake-all.ps1'
    for ($i = 0; $i -lt $ids.Count; $i += $Batch) {
      $end = [math]::Min($i + $Batch - 1, $ids.Count - 1)
      $chunk = @($ids[$i..$end])
      Set-Content -Path $chunkFile -Value $chunk -Encoding ascii
      Log "BATCH start (incremental) $($chunk.Count) maps"
      $bakeArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$bakeAll,
                    '-IdsFile',$chunkFile,'-IgnoreDone','-Parallel',$Parallel)
      if ($ToolsRoot)  { $bakeArgs += @('-ToolsRoot', $ToolsRoot) }
      if ($LocalCache) { $bakeArgs += @('-LocalCache', $LocalCache) }
      [void](Invoke-Native 'powershell.exe' $bakeArgs)
      Log "BATCH end (incremental) done=$((Get-Ids $doneFile).Count)/$($all.Count)"
    }
    Remove-Item $chunkFile -Force -ErrorAction SilentlyContinue

    # 3) 只登记本批真正烘焙成功的图（未成功的留待下次）
    $recFile = Join-Path $Root 'baked-this-run.txt'
    $newIds = @((Get-Ids $doneFile) | Where-Object { $doneBefore -notcontains $_ })
    if ($newIds.Count -gt 0) {
      Set-Content -Path $recFile -Value $newIds -Encoding ascii
      Log "INCREMENTAL record baked versions ($($newIds.Count))"
      $rc = Invoke-Native 'node' @($selector, '--record', $recFile)
      Log "  record exit=$rc"
      Remove-Item $recFile -Force -ErrorAction SilentlyContinue
    } else {
      Log 'INCREMENTAL nothing newly baked; skip record'
    }
  }
}
else {
  $stall = 0
  while ($true) {
    $done = Get-Ids $doneFile
    $remaining = @($all | Where-Object { $done -notcontains $_ })
    if ($remaining.Count -eq 0) { Log 'ALL DONE'; break }

    Log "BATCH start remaining=$($remaining.Count) done=$($done.Count)"
    $bakeArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'bake-all.ps1'),
                  '-MaxMaps',$Batch,'-Parallel',$Parallel)
    if ($ToolsRoot)  { $bakeArgs += @('-ToolsRoot', $ToolsRoot) }
    if ($LocalCache) { $bakeArgs += @('-LocalCache', $LocalCache) }
    [void](Invoke-Native 'powershell.exe' $bakeArgs)

    $done2 = Get-Ids $doneFile
    if ($done2.Count -le $done.Count) {
      $stall++
      Log "NO PROGRESS (done=$($done2.Count) stall=$stall)"
      if ($stall -ge 2) { Log 'stalled twice, stopping to avoid loop'; break }
    } else {
      $stall = 0
      Log "BATCH end done=$($done2.Count)/$($all.Count)"
    }
  }
}
} catch {
  Log ("FATAL " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
  Log ("AT " + ($_.InvocationInfo.PositionMessage -replace "`r?`n", " | "))
  throw
}

Log "FINISHED done=$((Get-Ids $doneFile).Count)/$($all.Count) failed=$((Get-Ids $failFile).Count)"
# 释放休眠抑制，让下面的 hibernate/sleep 能生效
try { [void][Win32.PowerKeep]::SetThreadExecutionState($ES_CONTINUOUS) } catch {}
switch ($Action) {
  'hibernate' { Log 'ACTION hibernate'; shutdown.exe /h }
  'sleep'     { Log 'ACTION sleep'; rundll32.exe powrprof.dll,SetSuspendState 0,1,0 }
  'shutdown'  { Log 'ACTION shutdown'; shutdown.exe /s /t 120 }
  default     { Log 'ACTION none' }
}
