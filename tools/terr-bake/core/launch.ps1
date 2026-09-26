# 启动器：准备 node 与工具链/缓存路径后调用 run-to-end.ps1。
# 可在用户会话或 SYSTEM 会话下运行（SYSTEM 的 PATH 不含用户 node 目录）。
param(
  [int]$Batch = 60,
  [int]$Parallel = 4,
  [ValidateSet('hibernate','sleep','shutdown','none')][string]$Action = 'none',
  [string]$ToolsRoot = '',
  [string]$LocalCache = '',
  [bool]$Incremental = $true
)
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# node：优先 PATH；否则在常见位置与各用户目录中查找（SYSTEM 会话也适用）
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

# 工具链：默认仓库内 .tools（由 setup.ps1 下载，或手动放置）
if (-not $ToolsRoot) { $ToolsRoot = Join-Path $Root '.tools' }

# 本地 Steam 工坊缓存：显式参数 > 注册表中的 Steam 安装路径 + libraryfolders.vdf > 常见路径
function Get-SteamWorkshopCache {
  $roots = @()
  foreach ($k in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam') {
    $p = Get-ItemProperty $k -ErrorAction SilentlyContinue
    if ($p) { foreach ($v in @($p.SteamPath, $p.InstallPath)) { if ($v) { $roots += ($v -replace '/', '\') } } }
  }
  if (${env:ProgramFiles(x86)}) { $roots += (Join-Path ${env:ProgramFiles(x86)} 'Steam') }
  if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles 'Steam') }

  $libs = @()
  foreach ($r in $roots) {
    if (-not $r) { continue }
    $libs += $r
    $vdf = Join-Path $r 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
      foreach ($m in [regex]::Matches((Get-Content $vdf -Raw -ErrorAction SilentlyContinue), '"path"\s+"([^"]+)"')) {
        $libs += ($m.Groups[1].Value -replace '\\\\', '\' -replace '/', '\')
      }
    }
  }
  foreach ($l in $libs) {
    if (-not $l) { continue }
    $c = Join-Path $l 'steamapps\workshop\content\730'
    if (Test-Path $c) { return $c }
  }
  return ''
}

if (-not $LocalCache) { $LocalCache = Get-SteamWorkshopCache }

# 写入引擎 PID：watchdog/status 以“该 PID 是否存活”为准，避免命令行关键字误判与启动竞态
$pidFile = Join-Path $Root 'engine.pid'
Set-Content -Path $pidFile -Value $PID -Encoding ascii
try {
  Set-Location $Root
  & (Join-Path $Root 'run-to-end.ps1') -Batch $Batch -Parallel $Parallel -Action $Action -ToolsRoot $ToolsRoot -LocalCache $LocalCache -Incremental $Incremental
} finally {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
