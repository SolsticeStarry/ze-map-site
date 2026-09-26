# 查看进度（普通权限即可）。运行判据以 engine.pid 的 PID 是否存活为准。
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
function Ids([string]$f) {
  if (-not (Test-Path $f)) { return @() }
  @(Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
}

$all  = Ids (Join-Path $Root 'capped.txt')
$done = Ids (Join-Path $Root 'done.txt')
$fail = Ids (Join-Path $Root 'failed.txt')
"进度: {0}/{1}   失败 {2}   剩余 {3}" -f $done.Count, $all.Count, $fail.Count, ($all.Count - $done.Count)

# 运行判据：engine.pid 存活
$pidFile = Join-Path $Root 'engine.pid'
$enginePid = 0; $engineAlive = $false
if (Test-Path $pidFile) {
  $ep = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($ep -match '^\d+$') {
    $enginePid = [int]$ep
    if (Get-Process -Id $enginePid -ErrorAction SilentlyContinue) { $engineAlive = $true }
  }
}
$steam = @(Get-Process steamcmd -ErrorAction SilentlyContinue).Count
"运行中: {0}{1}" -f $(if ($engineAlive -or $steam -gt 0) { '是' } else { '否' }),
  $(if ($engineAlive) { " (engine PID $enginePid)" } elseif ($steam -gt 0) { ' (steamcmd 活跃)' } else { '' })

Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -in 'C','D' } |
  ForEach-Object { "{0}: 空闲 {1:N1} GB" -f $_.Name, ($_.Free / 1GB) }

"--- run-to-end.log 末尾 ---"
Get-Content (Join-Path $Root 'run-to-end.log') -Tail 5 -ErrorAction SilentlyContinue
"--- bake.log 末尾 ---"
Get-Content (Join-Path $Root 'bake.log') -Tail 5 -ErrorAction SilentlyContinue
