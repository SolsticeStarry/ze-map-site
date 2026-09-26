param(
  [string]$ToolsRoot = '',
  [string]$S2VVersion = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ToolsRoot) { $ToolsRoot = Join-Path $root '.tools' }
New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null

function Info([string]$Message) { Write-Host "[setup] $Message" -ForegroundColor Cyan }

function Get-File([string]$Url, [string]$Out) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 -o $Out $Url
    if ($LASTEXITCODE -ne 0) { throw "curl failed ($LASTEXITCODE) for $Url" }
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  $cands = @('C:\Program Files\nodejs', (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'))
  $cands += (Get-ChildItem 'C:\Users\*\AppData\Local\Programs\nodejs\node.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.DirectoryName })
  foreach ($d in $cands) { if ($d -and (Test-Path (Join-Path $d 'node.exe'))) { $env:Path = $d + ';' + $env:Path; break } }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js not found on PATH; install Node.js 18+ first.' }

Info 'installing node packages (meshoptimizer)...'
Push-Location $root
try { & npm install --no-fund --no-audit } finally { Pop-Location }

$s2vDir = Join-Path $ToolsRoot 's2v'
$cliExe = Join-Path $s2vDir 'Source2Viewer-CLI.exe'
if ($Force -or -not (Test-Path $cliExe)) {
  if (-not $S2VVersion) {
    try {
      $release = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'ze-map-site' } `
        -Uri 'https://api.github.com/repos/ValveResourceFormat/ValveResourceFormat/releases/latest'
      $S2VVersion = $release.tag_name
    } catch {
      Info 'GitHub API unavailable, falling back to pinned version 20.0'
      $S2VVersion = '20.0'
    }
  }
  $url = "https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/$S2VVersion/cli-windows-x64.zip"
  $zip = Join-Path $ToolsRoot 's2v-cli.zip'
  Info "downloading Source2Viewer CLI $S2VVersion ..."
  Get-File -Url $url -Out $zip
  New-Item -ItemType Directory -Force -Path $s2vDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $s2vDir -Force
  Remove-Item $zip -Force
} else {
  Info "Source2Viewer CLI already present at $cliExe"
}

$steamDir = Join-Path $ToolsRoot 'steamcmd'
$steamExe = Join-Path $steamDir 'steamcmd.exe'
if ($Force -or -not (Test-Path $steamExe)) {
  $zip = Join-Path $ToolsRoot 'steamcmd.zip'
  Info 'downloading steamcmd ...'
  Get-File -Url 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip' -Out $zip
  New-Item -ItemType Directory -Force -Path $steamDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $steamDir -Force
  Remove-Item $zip -Force
} else {
  Info "steamcmd already present at $steamExe"
}

Info 'initializing steamcmd (first run self-update)...'
& $steamExe +quit 2>&1 | Out-Null

Info ''
Info "done. toolchain at $ToolsRoot"
Info 'next: powershell -NoProfile -ExecutionPolicy Bypass -File .\bake-all.ps1 -MaxMaps 2 -Random'
