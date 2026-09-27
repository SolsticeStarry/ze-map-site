# 由提升权限的 PowerShell 运行：注册/更新 SYSTEM 计划任务，指向本目录的 watchdog.ps1。
# 该任务「仅手动触发」（无触发器），启动后以 SYSTEM 身份脱离会话运行。
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $Root 'install-task.log'
function Log([string]$m) { ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Add-Content $log }
$elev = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log "install elevated=$elev"

try {
  Unregister-ScheduledTask -TaskName 'ze-terr-bake-svc' -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'watchdog.ps1') + '"')
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'ze-terr-bake-svc' -Action $action -Principal $principal `
    -Settings $settings -Force -ErrorAction Stop | Out-Null
  Log "registered ze-terr-bake-svc -> $Root\watchdog.ps1"
} catch { Log "register FAILED: $($_.Exception.Message)" }

# 清理历史遗留任务
Unregister-ScheduledTask -TaskName 'ze-terr-bake-watchdog' -Confirm:$false -ErrorAction SilentlyContinue
