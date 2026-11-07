# Đăng ký OpenCode Remote tự chạy khi bạn đăng nhập Windows.
# Chạy file này (PowerShell):  powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'OpenCodeRemote'
$log = Join-Path $dir 'bot.log'

# Lệnh chạy: vào thư mục project rồi chạy node, ghi log ra bot.log
$inner = "cd /d `"$dir`" && node src/index.js >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $inner"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'OpenCode Remote - Discord bridge cho OpenCode' -Force | Out-Null

Write-Host "OK: da dang ky task '$taskName'." -ForegroundColor Green
Write-Host "  - Bot se tu chay moi khi ban dang nhap Windows."
Write-Host "  - Log: $log"
Write-Host "  - Chay ngay bay gio:  Start-ScheduledTask -TaskName $taskName"
Write-Host "  - Tat:               Stop-ScheduledTask  -TaskName $taskName"
