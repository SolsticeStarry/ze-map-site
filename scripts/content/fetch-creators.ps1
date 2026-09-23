# Resolve Steam persona names for workshop creators (uploaders).
#
# Why PowerShell + ?xml=1: steamcommunity.com blocks generic fetchers,
# but Invoke-WebRequest works and the profile XML is small and parseable.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/content/fetch-creators.ps1
#   ... -Limit 50        # only resolve 50 new ids this run
#
# Output: data/creators.json  (steamID64 -> persona name), resume-safe.
# NOTE: keep this file ASCII-only - Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.
param(
  [int]$Limit = 0,
  [int]$DelayMs = 420,
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$wsDir = Join-Path $Root 'data/workshop'
$outFile = Join-Path $Root 'data/creators.json'

$creators = @{}
if (Test-Path $outFile) {
  $existing = Get-Content $outFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($p in $existing.PSObject.Properties) { $creators[$p.Name] = $p.Value }
}

$ids = @()
Get-ChildItem $wsDir -Filter *.json | ForEach-Object {
  $j = Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($j.creator) { $ids += [string]$j.creator }
}
$ids = $ids | Select-Object -Unique | Where-Object { $_ -and -not $creators.ContainsKey($_) }
if ($Limit -gt 0) { $ids = @($ids | Select-Object -First $Limit) }

Write-Host ("creators: total {0} | to resolve {1}" -f $creators.Count, $ids.Count)

function Save-Creators {
  $json = $creators | ConvertTo-Json -Depth 3 -Compress
  [IO.File]::WriteAllText($outFile, $json, (New-Object Text.UTF8Encoding($false)))
}

$ok = 0; $fail = 0; $i = 0
foreach ($id in $ids) {
  $i++
  try {
    $resp = Invoke-WebRequest -Uri "https://steamcommunity.com/profiles/$id/?xml=1" -TimeoutSec 25 -UseBasicParsing
    $m = [regex]::Match($resp.Content, '<steamID><!\[CDATA\[(.*?)\]\]></steamID>')
    if (-not $m.Success) { $m = [regex]::Match($resp.Content, '<steamID>(.*?)</steamID>') }
    if ($m.Success -and $m.Groups[1].Value.Trim()) {
      $creators[$id] = $m.Groups[1].Value.Trim()
      $ok++
    } else {
      $creators[$id] = ''
      $fail++
    }
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 429) {
      Write-Host "  rate limited, backing off 20s..."
      Start-Sleep -Seconds 20
      $i--
      continue
    }
    $creators[$id] = ''
    $fail++
  }
  if ($i % 25 -eq 0) {
    Save-Creators
    Write-Host ("  {0}/{1} done (ok {2} | failed {3})" -f $i, $ids.Count, $ok, $fail)
  }
  Start-Sleep -Milliseconds $DelayMs
}

Save-Creators
Write-Host ("`nresolved {0} | unresolved {1} | total cached {2}" -f $ok, $fail, $creators.Count)
Write-Host ("output: data/creators.json")
