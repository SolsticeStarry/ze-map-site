# 每周日自动收录新图：发现 → 建资料页 → 构建 → 提交 → 推送
# 由 Windows 计划任务调用（见 README / 任务计划里的「ze-map 每周新图收录」）
$ErrorActionPreference = 'Stop'
$repo = 'E:\Astro-code\ze-map-site'
$git = 'C:\Users\LENOVO\AppData\Local\GitHubDesktop\app-3.6.7\resources\app\git\cmd\git.exe'
Set-Location $repo
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
$env:HTTP_PROXY = 'http://127.0.0.1:7897'

$log = Join-Path $repo 'scripts\ops\weekly-new-maps.log'
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 开始" | Tee-Object -FilePath $log -Append

node scripts/ops/weekly-new-maps.mjs 2>&1 | Tee-Object -FilePath $log -Append

$changed = & $git status --porcelain
if (-not $changed) {
  "[$(Get-Date -Format 'HH:mm:ss')] 没有新图，结束" | Tee-Object -FilePath $log -Append
  exit 0
}

cmd /c "npm run build 2>&1" | Tee-Object -FilePath $log -Append | Select-Object -Last 3

& $git add data/research data/workshop src/content/maps
$prefix = 'update ' + (Get-Date -Format 'MM.dd') + '.'
$today = (& $git log --since '00:00' --pretty=%s) | Where-Object { $_ -like "$prefix*" }
$n = @($today).Count + 1
$msg = "$prefix$n"
& $git commit -m $msg 2>&1 | Tee-Object -FilePath $log -Append
& $git -c http.version=HTTP/1.1 pull --rebase --autostash origin main 2>&1 | Tee-Object -FilePath $log -Append | Select-Object -Last 1
& $git -c http.version=HTTP/1.1 push origin main 2>&1 | Tee-Object -FilePath $log -Append | Select-Object -Last 1
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 完成：$msg" | Tee-Object -FilePath $log -Append
