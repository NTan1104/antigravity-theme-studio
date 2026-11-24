param(
    [int]$Port = 0,
    [switch]$Ide,
    [switch]$Vscode,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$InstallWin = Join-Path $ScriptDir 'install-win.ps1'
$PidFile = Join-Path $RepoRoot 'daemon.pid'

if ($Port -le 0) {
    $Port = if ($Vscode) { 9224 } elseif ($Ide) { 9223 } else { 9222 }
}

$AppLabel = if ($Vscode) { 'Visual Studio Code' } elseif ($Ide) { 'Antigravity IDE' } else { 'Antigravity' }
$ProcName = if ($Vscode) { 'Code' } elseif ($Ide) { 'Antigravity IDE' } else { 'Antigravity' }

# 1. Ensure Rust Theme Studio daemon is running
$DaemonRunning = $false
if (Test-Path $PidFile) {
    $PidVal = 0
    $RawPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ([int]::TryParse(($RawPid -as [string]), [ref]$PidVal) -and $PidVal -gt 0) {
        $Proc = Get-Process -Id $PidVal -ErrorAction SilentlyContinue
        if ($Proc -and ($Proc.ProcessName -match '^ats-theme')) {
            $DaemonRunning = $true
        }
    }
}

if (-not $DaemonRunning) {
    Write-Host "[launch-app] Rust daemon chưa chạy, đang khởi động daemon..."
    & powershell -ExecutionPolicy Bypass -File $InstallWin -NoStartup -SkipShortcuts
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Không thể khởi động Theme Studio Rust daemon (exit code $LASTEXITCODE)."
    }
}

# 2. Locate executable
if ($Vscode) {
    $Candidates = @(
        "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
        "$env:ProgramFiles\Microsoft VS Code\Code.exe"
    )
} elseif ($Ide) {
    $Candidates = @(
        "$env:LOCALAPPDATA\Programs\Antigravity IDE\Antigravity IDE.exe",
        "$env:ProgramFiles\Antigravity IDE\Antigravity IDE.exe"
    )
} else {
    $Candidates = @(
        "$env:LOCALAPPDATA\Programs\antigravity\Antigravity.exe",
        "$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe",
        "$env:ProgramFiles\Antigravity\Antigravity.exe"
    )
}
$AppExe = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $AppExe) {
    Write-Error "Không tìm thấy $AppLabel (.exe). Vui lòng kiểm tra đường dẫn cài đặt."
}

# 3. Detect if already running without CDP
$RunningProc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
if ($RunningProc) {
    $CdpReachable = $false
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $CdpReachable = $true }
    } catch {}

    if (-not $CdpReachable) {
        if ($Restart) {
            Write-Host "[launch-app] Đang đóng $AppLabel hiện tại (thiếu cổng CDP $Port) để khởi động lại..."
            $RunningProc | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 700
        } else {
            Write-Warning "[launch-app] $AppLabel đang chạy sẵn nhưng KHÔNG có cổng CDP $Port."
            $hint = if ($Vscode) { "npm run launch-vscode -- -Restart" } elseif ($Ide) { "npm run launch-ide -- -Restart" } else { "npm run launch -- -Restart" }
            Write-Warning "             Hãy đóng hoàn toàn $AppLabel rồi chạy lại, hoặc dùng: $hint"
            exit 1
        }
    } else {
        Write-Host "[launch-app] $AppLabel đã mở sẵn cổng CDP $Port."
        exit 0
    }
}

Write-Host "[launch-app] Đang mở $AppLabel với cổng CDP (--remote-debugging-port=$Port)..."
$WmiLaunch = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "`"$AppExe`" --remote-debugging-port=$Port"
} -ErrorAction SilentlyContinue
if (-not $WmiLaunch -or $WmiLaunch.ReturnValue -ne 0) {
    Start-Process -FilePath $AppExe -ArgumentList "--remote-debugging-port=$Port"
}
Write-Host "[launch-app] Hoàn tất! Theme Studio (Rust Edition) sẽ tự động áp dụng giao diện sau vài giây."
