# Download GFL public ZE server configs (entwatch / bosshud / musicname) from jsDelivr.
#
# These configs are the best public source for per-map 神器/道具, BOSS names+HP and BGM lists.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/content/fetch-gfl-configs.ps1
#   ... -Dirs entwatch,bosshud
#
# Output: data/gfl/<dir>/<map>.jsonc   (resume-safe; existing files are skipped)
# NOTE: keep ASCII-only - Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.
param(
  [string]$Dirs = 'entwatch,bosshud,musicname',
  [int]$DelayMs = 70,
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$api = 'https://data.jsdelivr.com/v1/packages/gh/gflze/CS2-ZE-Configs@main?structure=flat'
$cdn = 'https://cdn.jsdelivr.net/gh/gflze/CS2-ZE-Configs@main'
$want = $Dirs.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }

Write-Host 'listing repo files...'
$listing = Invoke-RestMethod -Uri $api -TimeoutSec 60
$files = $listing.files | Where-Object {
  $p = $_.name.TrimStart('/')
  $top = ($p -split '/')[0]
  $want -contains $top -and $p -like '*.jsonc'
}
Write-Host ("files to fetch: {0}" -f $files.Count)

$ok = 0; $skip = 0; $fail = 0; $i = 0
foreach ($f in $files) {
  $i++
  $rel = $f.name.TrimStart('/')
  $dest = Join-Path $Root ("data/gfl/" + ($rel -replace '/', '\'))
  if (Test-Path $dest) { $skip++; continue }
  $dir = Split-Path -Parent $dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  try {
    Invoke-WebRequest -Uri "$cdn/$rel" -OutFile $dest -TimeoutSec 40 -UseBasicParsing
    $ok++
  } catch {
    $fail++
    Write-Warning ("  {0}: {1}" -f $rel, $_.Exception.Message)
    Start-Sleep -Seconds 1
  }
  if ($i % 50 -eq 0) { Write-Host ("  {0}/{1} (ok {2} | skip {3} | fail {4})" -f $i, $files.Count, $ok, $skip, $fail) }
  Start-Sleep -Milliseconds $DelayMs
}

Write-Host ("`ndone: downloaded {0} | already had {1} | failed {2}" -f $ok, $skip, $fail)
$total = (Get-ChildItem (Join-Path $Root 'data/gfl') -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum)
Write-Host ("local configs: {0} files, {1:N2} MB" -f $total.Count, ($total.Sum / 1MB))
