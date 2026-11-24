param(
    [switch]$NoStartup,
    [switch]$SkipShortcuts,
    [switch]$WatchThemes
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$CargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $CargoBin) -and ($env:PATH -notlike "*$CargoBin*")) {
    $env:PATH = "$CargoBin;$env:PATH"
}

$CliExe = Join-Path $RepoRoot 'target\release\ats-theme.exe'
$DaemonExe = Join-Path $RepoRoot 'target\release\ats-theme-daemon.exe'

if (-not (Test-Path $CliExe) -or -not (Test-Path $DaemonExe)) {
    Write-Host "[install-win] Building native Rust release binaries (cargo build --release)..."
    Push-Location $RepoRoot
    try {
        & cargo build --release
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build --release failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

$ArgsList = @('--root', $RepoRoot, 'install')
if ($NoStartup) { $ArgsList += '--no-startup' }
if ($SkipShortcuts) { $ArgsList += '--skip-shortcuts' }
if ($WatchThemes) { $ArgsList += '--watch-themes' }

& $CliExe @ArgsList
exit $LASTEXITCODE
