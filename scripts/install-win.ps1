param(
    [switch]$NoStartup,
    [switch]$SkipShortcuts,
    [int]$CdpPort = 9222,
    [int]$IdeCdpPort = 9223,
    [int]$VscodeCdpPort = 9224
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$DaemonJs = Join-Path $RepoRoot 'daemon\server.js'
$BundleJs = Join-Path $RepoRoot 'dist\bundle.js'
$BuildPy = Join-Path $RepoRoot 'scripts\build.py'
$PidFile = Join-Path $RepoRoot 'daemon.pid'
$VbsPath = Join-Path $RepoRoot 'silent-start.vbs'

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "Không tìm thấy Node.js trong PATH. Vui lòng cài Node.js >= 22."
}
$NodeExe = $NodeCmd.Source
$NodeMajor = [int]((& $NodeExe -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 22) {
    Write-Error "Cần Node.js >= 22 (đang dùng v$NodeMajor)."
}

# Build dist/bundle.js
$PyCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $PyCmd) { $PyCmd = Get-Command python3 -ErrorAction SilentlyContinue }
if ($PyCmd) {
    Write-Host "[install-win] Đang đóng gói dist/bundle.js..."
    & $PyCmd.Source $BuildPy
    if ($LASTEXITCODE -ne 0) { Write-Error "build.py lỗi (exit code $LASTEXITCODE)." }
} elseif (-not (Test-Path $BundleJs)) {
    Write-Error "Thiếu dist/bundle.js và không tìm thấy Python để build."
}

# Stop existing daemon if running
if (Test-Path $PidFile) {
    $OldPidText = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $OldPid = 0
    if ([int]::TryParse(($OldPidText -as [string]), [ref]$OldPid) -and $OldPid -gt 0) {
        $Proc = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
        if ($Proc -and $Proc.ProcessName -eq 'node') {
            Write-Host "[install-win] Đang dừng daemon cũ (PID $OldPid)..."
            Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# Generate silent-start.vbs (Unicode encoding supports non-ASCII/Vietnamese paths safely in WSH)
$EscNode = $NodeExe.Replace('"', '""')
$EscDaemon = $DaemonJs.Replace('"', '""')
$VbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$($RepoRoot.Replace('"', '""'))"
WshShell.Run """$EscNode"" ""$EscDaemon""", 0, False
"@
Set-Content -Path $VbsPath -Value $VbsContent -Encoding Unicode

if (-not $NoStartup) {
    $StartupDir = [Environment]::GetFolderPath('Startup')
    $ShortcutPath = Join-Path $StartupDir 'AntigravityThemeStudio.lnk'
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = 'wscript.exe'
    $Shortcut.Arguments = """$VbsPath"""
    $Shortcut.WorkingDirectory = $RepoRoot
    $Shortcut.WindowStyle = 7
    $Shortcut.Description = 'Antigravity Theme Studio Daemon'
    $Shortcut.Save()
    Write-Host "[install-win] Đã tạo lối tắt tự khởi động cùng Windows: $ShortcutPath"
}

if (-not $SkipShortcuts) {
    $ShortcutDirs = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('StartMenu'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    ) | Where-Object { $_ -and (Test-Path $_) }

    $WshPatch = New-Object -ComObject WScript.Shell
    foreach ($dir in $ShortcutDirs) {
        Get-ChildItem -Path $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'Antigravity.lnk' -or $_.Name -eq 'Antigravity IDE.lnk' -or $_.Name -eq 'Visual Studio Code.lnk' } |
            ForEach-Object {
                try {
                    $sc = $WshPatch.CreateShortcut($_.FullName)
                    if ($sc.TargetPath -match 'Antigravity IDE\.exe$' -and $sc.Arguments -notmatch '--remote-debugging-port') {
                        $sc.Arguments = ($sc.Arguments + " --remote-debugging-port=$IdeCdpPort").Trim()
                        $sc.Save()
                        Write-Host "[install-win] Đã gắn cờ CDP IDE (--remote-debugging-port=$IdeCdpPort) vào: $($_.FullName)"
                    } elseif ($sc.TargetPath -match 'Antigravity\.exe$' -and $sc.Arguments -notmatch '--remote-debugging-port') {
                        $sc.Arguments = ($sc.Arguments + " --remote-debugging-port=$CdpPort").Trim()
                        $sc.Save()
                        Write-Host "[install-win] Đã gắn cờ CDP (--remote-debugging-port=$CdpPort) vào: $($_.FullName)"
                    } elseif ($sc.TargetPath -match 'Code\.exe$' -and $sc.Arguments -notmatch '--remote-debugging-port') {
                        $sc.Arguments = ($sc.Arguments + " --remote-debugging-port=$VscodeCdpPort").Trim()
                        $sc.Save()
                        Write-Host "[install-win] Đã gắn cờ CDP VS Code (--remote-debugging-port=$VscodeCdpPort) vào: $($_.FullName)"
                    }
                } catch {}
            }
    }
}

Write-Host "[install-win] Đang khởi chạy daemon chạy ngầm..."
$WmiRes = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "wscript.exe `"$VbsPath`""
    CurrentDirectory = $RepoRoot
} -ErrorAction SilentlyContinue
if (-not $WmiRes -or $WmiRes.ReturnValue -ne 0) {
    Start-Process -FilePath 'wscript.exe' -ArgumentList """$VbsPath""" -WorkingDirectory $RepoRoot
}

for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Path $PidFile) {
        $NewPidText = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        $NewPid = 0
        if ([int]::TryParse(($NewPidText -as [string]), [ref]$NewPid) -and $NewPid -gt 0) {
            $NewProc = Get-Process -Id $NewPid -ErrorAction SilentlyContinue
            if ($NewProc -and $NewProc.ProcessName -eq 'node') {
                Write-Host "[install-win] Daemon đang chạy ngầm ổn định (PID $NewPid)."
                exit 0
            }
        }
    }
}

Write-Warning "[install-win] Không thấy daemon.pid sau khi khởi chạy. Kiểm tra $RepoRoot\daemon.log."
exit 1
