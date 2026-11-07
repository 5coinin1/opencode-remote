# Gỡ OpenCode Remote khỏi danh sách tự chạy khi đăng nhập.
# powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1

$ErrorActionPreference = 'SilentlyContinue'
$taskName = 'OpenCodeRemote'
Stop-ScheduledTask -TaskName $taskName
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Da go task '$taskName' (neu co)." -ForegroundColor Yellow
