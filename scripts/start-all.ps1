# รัน Hub + Card Reader บน PC เครื่องเดียวกัน (Windows)
# ใช้: powershell -ExecutionPolicy Bypass -File scripts/start-all.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "=== Thai ID Card Reader ===" -ForegroundColor Cyan
Write-Host "1) Starting Hub on port 18081..."
Write-Host "2) Starting Card Reader (connects to ws://localhost:18081)"
Write-Host ""
Write-Host "iPad/Web: ws://<this-pc-ip>:18081" -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop both." -ForegroundColor Gray
Write-Host ""

$env:HUB_PORT = "18081"
$env:HUB_URL = "ws://localhost:18081"

# Start hub in background job
$hubJob = Start-Job -ScriptBlock {
  Set-Location $using:root
  npm run hub 2>&1
}

Start-Sleep -Seconds 2

# Start reader in foreground
try {
  npm start
} finally {
  Stop-Job $hubJob -ErrorAction SilentlyContinue
  Remove-Job $hubJob -Force -ErrorAction SilentlyContinue
}
