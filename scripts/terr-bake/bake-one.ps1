param(
  [Parameter(Mandatory=$true)][string]$MapId,
  [Parameter(Mandatory=$true)][string]$WorkDir,
  [Parameter(Mandatory=$true)][string]$TerrDir,
  [string]$LocalCache = '',
  [Parameter(Mandatory=$true)][string]$DownloadCache,
  [Parameter(Mandatory=$true)][string]$Cli,
  [Parameter(Mandatory=$true)][string]$Bake,
  [Parameter(Mandatory=$true)][string]$Entity,
  [Parameter(Mandatory=$true)][string]$EntityDir,
  [Parameter(Mandatory=$true)][string]$BoundsDir,
  [int]$ErrorTolerance = 4,
  [switch]$KeepDownloaded
)

$ErrorActionPreference = 'Stop'
$sw = [Diagnostics.Stopwatch]::StartNew()
$cd = ''
$downloaded = $false
$stage = 'init'
$result = [ordered]@{ id=$MapId; ok=$false; stage=$stage; nt='?'; srcMB=0; seconds=0; error='' }

try {
  New-Item -ItemType Directory -Force -Path $WorkDir, $TerrDir, $EntityDir | Out-Null
  if ($LocalCache -and (Test-Path (Join-Path $LocalCache $MapId))) { $cd = Join-Path $LocalCache $MapId }
  elseif (Test-Path (Join-Path $DownloadCache $MapId)) { $cd = Join-Path $DownloadCache $MapId; $downloaded = $true }
  else { throw 'map is not downloaded' }

  $stage = 'find-vpk'
  $dlMB = [math]::Round(((Get-ChildItem $cd -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1MB, 0)
  $dirvpk = (Get-ChildItem $cd -Filter '*_dir.vpk' -File -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
  if (-not $dirvpk) { $dirvpk = (Get-ChildItem $cd -Filter '*.vpk' -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1).FullName }
  if (-not $dirvpk) { throw 'no vpk' }

  $jobWork = Join-Path $WorkDir $MapId
  New-Item -ItemType Directory -Force -Path $jobWork | Out-Null
  $stage = 'list-outer'
  $list1 = & $Cli -i $dirvpk --vpk_list 2>&1
  $inner = ($list1 | Select-String -Pattern '^\s*maps/[^/]+\.vpk\s' | ForEach-Object { ($_ -replace '.*?maps/','maps/').Split(' ')[0] } | Select-Object -First 1)
  $srcVpk = $dirvpk
  if ($inner) {
    $stage = 'extract-inner'
    $innerPath = Join-Path $jobWork 'inner.vpk'
    & $Cli -i $dirvpk -o $innerPath -f $inner 2>&1 | Out-Null
    if (-not (Test-Path $innerPath)) { throw 'inner extract failed' }
    $srcVpk = $innerPath
  }

  $stage = 'extract-entities'
  $listEnt = & $Cli -i $srcVpk --vpk_list 2>&1
  $el = $listEnt | Select-String 'entities/default_ents\.vents_c' | Select-Object -First 1
  if (-not $el) { throw 'no default_ents.vents_c' }
  $entityPath = ([regex]::Match($el.ToString(), 'maps/[^\s]+/entities/default_ents\.vents_c')).Value
  $mapName = ([regex]::Match($entityPath, 'maps/([^/]+)/entities')).Groups[1].Value
  if (-not $mapName) { throw 'map name not found in entity path' }
  $entityTxt = Join-Path $jobWork 'default_ents.txt'
  & $Cli -i $srcVpk -o $entityTxt -f $entityPath -d 2>&1 | Out-Null
  if (-not (Test-Path $entityTxt)) { throw 'entity decompile failed' }
  $entityJson = Join-Path $jobWork 'entities.json'
  node $Entity $entityTxt $entityJson $MapId 2>&1 | Out-Null
  if (-not (Test-Path $entityJson)) { throw 'entity parse failed' }

  # Brush entities carry no box_mins/box_maxs in the vents dump; their real size lives in the
  # per-entity brush model maps/<map>/entities/<name>_<id>.vmdl_c. Export those to GLB and read
  # the physics hull bounds (same source as the 云朵小铺 bb/bbm table).
  $stage = 'export-models'
  $modelsDir = Join-Path $jobWork 'models'
  New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
  & $Cli -i $srcVpk -o $modelsDir -f "maps/$mapName/entities/" -e "vmdl_c" -d --gltf_export_format glb 2>&1 | Out-Null
  $stage = 'extract-bounds'
  $boundsJson = Join-Path $jobWork 'bounds.json'
  $boundsScript = Join-Path (Split-Path $Entity -Parent) 'extract-bounds.mjs'
  node $boundsScript $entityJson $modelsDir $boundsJson 2>&1 | Out-Null
  if (-not (Test-Path $boundsJson)) { throw 'bounds extract failed' }

  $nativeBin = Join-Path $jobWork "2001-$mapName-$MapId.bin"
  $packer = Join-Path (Split-Path $Entity -Parent) 'build-entity-bin.mjs'
  node $packer $entityJson $boundsJson $nativeBin $mapName $MapId 2>&1 | Out-Null
  if (-not (Test-Path $nativeBin)) { throw 'entity bin build failed' }
  Copy-Item $nativeBin (Join-Path $EntityDir "2001-$mapName-$MapId.bin") -Force

  $stage = 'find-physics'
  $list2 = & $Cli -i $srcVpk --vpk_list 2>&1
  $pl = $list2 | Select-String 'world_physics\.vmdl_c' | Select-Object -First 1
  if (-not $pl) { throw 'no physics vmdl' }
  $pi = ([regex]::Match($pl.ToString(), 'maps/[^\s]+world_physics\.vmdl_c')).Value

  $stage = 'glb'
  $glb = Join-Path $jobWork "$MapId.glb"
  & $Cli -i $srcVpk -o $glb -f $pi -d --gltf_export_format glb 2>&1 | Out-Null
  $pg = Join-Path $jobWork "${MapId}_physics.glb"
  if (-not (Test-Path $pg)) { throw 'no physics glb' }

  $stage = 'bake'
  $tmp = Join-Path $jobWork 'terrain.bin'
  $bl = node $Bake $pg $tmp $ErrorTolerance 2>&1
  if (-not (Test-Path $tmp)) { throw ('bake failed: ' + ($bl -join ' ')) }

  $stage = 'install'
  Copy-Item $tmp (Join-Path $TerrDir "$MapId.bin") -Force
  $ntm = [regex]::Match(($bl | Select-String 'nt (\d+)').ToString(), 'nt (\d+)')
  if ($ntm.Success) { $result.nt = $ntm.Groups[1].Value }
  $result.ok = $true
  $result.srcMB = $dlMB
} catch {
  $result.stage = $stage
  $result.error = $_.Exception.Message
} finally {
  $sw.Stop()
  $result.stage = $stage
  $result.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 0)
  Remove-Item (Join-Path $WorkDir $MapId) -Recurse -Force -ErrorAction SilentlyContinue
  if ($result.ok -and $downloaded -and -not $KeepDownloaded) {
    Remove-Item (Join-Path $DownloadCache $MapId) -Recurse -Force -ErrorAction SilentlyContinue
  }
}

[pscustomobject]$result | ConvertTo-Json -Compress
