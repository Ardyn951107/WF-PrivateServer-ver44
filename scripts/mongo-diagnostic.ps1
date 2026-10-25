param(
    [string]$Target = "."
)

$ErrorActionPreference = "Continue"
$root = (Resolve-Path $Target).Path
Write-Host "SpaceNinjaServer MongoDB diagnostic" -ForegroundColor Cyan
Write-Host "Target: $root"
Write-Host "Time:   $(Get-Date -Format o)"
Write-Host ""

Write-Host "== Node ==" -ForegroundColor Yellow
try { node --version } catch { Write-Host "node not found: $($_.Exception.Message)" -ForegroundColor Red }
Write-Host ""

Write-Host "== Relevant processes ==" -ForegroundColor Yellow
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -in @("node.exe", "mongod.exe", "mongod-x64-win32-7.0.34.exe") } |
    Select-Object ProcessId, Name, CommandLine |
    Format-Table -Wrap -AutoSize

Write-Host "== Port 27117 ==" -ForegroundColor Yellow
try {
    Get-NetTCPConnection -LocalPort 27117 -ErrorAction Stop |
        Select-Object State, LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess |
        Format-Table -AutoSize
} catch {
    Write-Host "Nothing is listening on TCP 27117." -ForegroundColor DarkYellow
}

$mongoExe = Join-Path $root "node_modules\.cache\mongod-x64-win32-7.0.34.exe"
Write-Host "== Cached mongod ==" -ForegroundColor Yellow
if (Test-Path $mongoExe) {
    $item = Get-Item $mongoExe
    Write-Host "Path: $mongoExe"
    Write-Host "Size: $($item.Length) bytes"
    try { & $mongoExe --version | Select-Object -First 8 } catch { Write-Host "mongod --version failed: $($_.Exception.Message)" -ForegroundColor Red }
} else {
    Write-Host "Cached MongoDB 7.0.34 executable not found." -ForegroundColor DarkYellow
}

$runtimeLog = Join-Path $root "logs\mongod-runtime.log"
Write-Host ""
Write-Host "== mongod-runtime.log (last 120 lines) ==" -ForegroundColor Yellow
if (Test-Path $runtimeLog) {
    Get-Content $runtimeLog -Tail 120
} else {
    Write-Host "No runtime log yet. Install the Mongo Stability patch and reproduce the issue once." -ForegroundColor DarkYellow
}

$trace = Get-ChildItem (Join-Path $root "logs\trace.log*") -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
Write-Host ""
Write-Host "== latest SpaceNinja trace (last 80 lines) ==" -ForegroundColor Yellow
if ($trace) {
    Write-Host $trace.FullName
    Get-Content $trace.FullName -Tail 80
} else {
    Write-Host "No trace log found." -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "Diagnostic complete." -ForegroundColor Green
