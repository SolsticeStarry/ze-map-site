# Show progress (普通权限即可). Running state is based on the engine PID.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
function Ids([string]$f) {
  if (-not (Test-Path $f)) { return @() }
  @(Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
}

$all  = Ids (Join-Path $Root 'data\capped.txt')
$done = Ids (Join-Path $Root 'data\done.txt')
$fail = Ids (Join-Path $Root 'data\failed.txt')
"Progress: {0}/{1}   failed {2}   remaining {3}" -f $done.Count, $all.Count, $fail.Count, ($all.Count - $done.Count)

# Running state: engine.pid is alive.
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
"Running: {0}{1}" -f $(if ($engineAlive -or $steam -gt 0) { 'yes' } else { 'no' }),
  $(if ($engineAlive) { " (engine PID $enginePid)" } elseif ($steam -gt 0) { ' (steamcmd active)' } else { '' })

Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -in 'C','D' } |
  ForEach-Object { "{0}: 空闲 {1:N1} GB" -f $_.Name, ($_.Free / 1GB) }

"--- run-to-end.log 末尾 ---"
Get-Content (Join-Path $Root 'run-to-end.log') -Tail 5 -ErrorAction SilentlyContinue
"--- bake.log 末尾 ---"
Get-Content (Join-Path $Root 'bake.log') -Tail 5 -ErrorAction SilentlyContinue
