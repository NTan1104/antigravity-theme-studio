use crate::builder::{build_bundle, BuildOptions, DEFAULT_MAX_DIM};
use crate::cdp::{cleanup_open_pages, fetch_targets, filter_antigravity_pages};
use crate::paths::{resolve_cdp_ports, resolve_daemon_exe, AppPaths};
use crate::sys::{is_ats_daemon_pid, process_memory_stats, spawn_detached, terminate_pid};
use crate::Result;
use std::fs;
use std::path::Path;
use std::thread;
use std::time::Duration;

#[cfg(target_os = "macos")]
const SERVICE_LABEL: &str = "io.antigravity.theme-studio";
#[cfg(all(unix, not(target_os = "macos")))]
const SYSTEMD_UNIT: &str = "antigravity-theme-studio.service";
#[cfg(windows)]
const WIN_TASK_NAME: &str = "AntigravityThemeStudio";

fn is_dedicated_daemon_exe(exe: &Path) -> bool {
    exe.file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("ats-theme-daemon"))
        .unwrap_or(false)
}

pub fn read_running_pid(paths: &AppPaths) -> Option<u32> {
    let raw = fs::read_to_string(&paths.pid_file).ok()?;
    let pid: u32 = raw.trim().parse().ok()?;
    if pid > 0 && is_ats_daemon_pid(pid) {
        Some(pid)
    } else {
        None
    }
}

pub fn stop_daemon(paths: &AppPaths) -> Result<Option<u32>> {
    if !paths.pid_file.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&paths.pid_file).unwrap_or_default();
    let pid: u32 = raw.trim().parse().unwrap_or(0);
    let stopped = if pid > 0 && is_ats_daemon_pid(pid) {
        terminate_pid(pid);
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(80));
            if !is_ats_daemon_pid(pid) {
                break;
            }
        }
        Some(pid)
    } else {
        None
    };
    let _ = fs::remove_file(&paths.pid_file);
    Ok(stopped)
}

pub fn start_daemon(paths: &AppPaths, watch_themes: bool) -> Result<u32> {
    if !paths.bundle_js.is_file() {
        println!("[ats-theme] dist/bundle.js missing; building bundle...");
        let rep = build_bundle(&BuildOptions {
            presets_path: paths.presets_json.clone(),
            css_path: paths.style_css.clone(),
            engine_path: paths.engine_js.clone(),
            out_path: paths.bundle_js.clone(),
            max_dim: DEFAULT_MAX_DIM,
        })?;
        println!(
            "[ats-theme] Built {} ({:.1} KB in {} ms).",
            rep.out_path.display(),
            rep.size_bytes as f64 / 1024.0,
            rep.elapsed_ms
        );
    }

    if let Some(old_pid) = stop_daemon(paths)? {
        println!("[ats-theme] Stopped previous daemon (PID {old_pid}).");
    }

    let daemon_exe = resolve_daemon_exe();
    let root_str = paths.root.to_string_lossy().to_string();
    let is_dedicated_daemon = is_dedicated_daemon_exe(&daemon_exe);

    let mut args: Vec<&str> = Vec::new();
    if !is_dedicated_daemon {
        args.push("daemon");
    }
    args.push("--root");
    args.push(&root_str);
    if watch_themes {
        args.push("--watch-themes");
    }

    let _spawned_pid = spawn_detached(&daemon_exe, &args, &paths.root)?;

    for _ in 0..25 {
        thread::sleep(Duration::from_millis(150));
        if let Some(pid) = read_running_pid(paths) {
            return Ok(pid);
        }
    }

    Err(format!(
        "Daemon did not write daemon.pid in time. Check {}",
        paths.log_file.display()
    )
    .into())
}

pub fn print_status(paths: &AppPaths) {
    println!("Root:        {}", paths.root.display());
    println!(
        "Bundle:      {} ({})",
        paths.bundle_js.display(),
        if let Ok(m) = fs::metadata(&paths.bundle_js) {
            format!("{:.1} KB", m.len() as f64 / 1024.0)
        } else {
            "not built".to_string()
        }
    );

    if let Some(pid) = read_running_pid(paths) {
        let mem_str = match process_memory_stats(pid) {
            Some(ms) => match ms.private_kb {
                Some(priv_kb) => format!(
                    "WorkingSet {:.2} MB | Private {:.2} MB",
                    ms.working_set_kb as f64 / 1024.0,
                    priv_kb as f64 / 1024.0
                ),
                None => format!("RSS {:.2} MB", ms.working_set_kb as f64 / 1024.0),
            },
            None => "RAM unavailable".to_string(),
        };
        println!("Daemon:      RUNNING (PID {pid} | {mem_str})");
    } else {
        println!("Daemon:      STOPPED");
    }

    let ports = resolve_cdp_ports();
    let mut active_ports = Vec::new();
    for port in ports {
        if let Ok(targets) = fetch_targets(port, Duration::from_millis(500)) {
            let count = filter_antigravity_pages(targets).len();
            if count > 0 {
                active_ports.push(format!("port {port} ({count} target(s))"));
            }
        }
    }
    if active_ports.is_empty() {
        println!("CDP Targets: No active Antigravity / IDE / VS Code targets on 9222/9223/9224");
    } else {
        println!("CDP Targets: {}", active_ports.join(", "));
    }

    #[cfg(windows)]
    print_windows_autostart_diagnostics();
}

#[cfg(windows)]
fn print_windows_autostart_diagnostics() {
    use std::process::Command;

    let ps = format!(
        r#"
$taskName = {task_q}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {{
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    $lastRun = if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 2000) {{ $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') }} else {{ 'never' }}
    Write-Output "Autostart:   Scheduled Task '$taskName' ($($task.State), LastRun: $lastRun)"
}} else {{
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'AntigravityThemeStudio.lnk'
    if (Test-Path $lnk) {{
        Write-Output "Autostart:   Startup Shortcut ($lnk)"
    }} else {{
        Write-Output "Autostart:   NOT CONFIGURED (run 'ats-theme install')"
    }}
}}

$wsh = New-Object -ComObject WScript.Shell
$dirs = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
) | Where-Object {{ $_ -and (Test-Path $_) }} | Select-Object -Unique

$missing = @()
$patched = 0
foreach ($d in $dirs) {{
    Get-ChildItem -Path $d -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Name -in @('Antigravity.lnk', 'Antigravity IDE.lnk', 'Visual Studio Code.lnk') }} |
        ForEach-Object {{
            try {{
                $sc = $wsh.CreateShortcut($_.FullName)
                if ($sc.TargetPath -match '(Antigravity IDE|Antigravity|Code)\.exe$') {{
                    if ($sc.Arguments -match '--remote-debugging-port=\d+') {{
                        $patched++
                    }} else {{
                        $missing += $_.FullName
                    }}
                }}
            }} catch {{}}
        }}
}}
if ($missing.Count -eq 0) {{
    Write-Output "Shortcuts:   OK ($patched shortcut(s) have --remote-debugging-port)"
}} else {{
    Write-Output "Shortcuts:   WARNING - $($missing.Count) shortcut(s) missing CDP flag (re-run 'ats-theme install'):"
    foreach ($m in $missing) {{ Write-Output "             - $m" }}
}}
"#,
        task_q = ps_single_quote(WIN_TASK_NAME),
    );

    if let Ok(out) = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .output()
    {
        let stdout = String::from_utf8_lossy(&out.stdout);
        for line in stdout.lines() {
            if !line.trim().is_empty() {
                println!("{line}");
            }
        }
    }
}

pub fn install(
    paths: &AppPaths,
    no_startup: bool,
    skip_shortcuts: bool,
    watch_themes: bool,
) -> Result<()> {
    println!("[install] Building dist/bundle.js...");
    let rep = build_bundle(&BuildOptions {
        presets_path: paths.presets_json.clone(),
        css_path: paths.style_css.clone(),
        engine_path: paths.engine_js.clone(),
        out_path: paths.bundle_js.clone(),
        max_dim: DEFAULT_MAX_DIM,
    })?;
    println!(
        "[install] Built {} ({:.1} KB in {} ms) with {} preset(s).",
        rep.out_path.display(),
        rep.size_bytes as f64 / 1024.0,
        rep.elapsed_ms,
        rep.preset_names.len()
    );

    if let Some(old_pid) = stop_daemon(paths)? {
        println!("[install] Stopped existing daemon (PID {old_pid}).");
    }

    // Remove legacy VBS launcher if migrating from Node.js version.
    if paths.legacy_vbs.is_file() {
        let _ = fs::remove_file(&paths.legacy_vbs);
    }

    #[cfg(windows)]
    {
        install_windows(paths, no_startup, skip_shortcuts, watch_themes)?;
    }

    #[cfg(target_os = "macos")]
    {
        let _ = skip_shortcuts;
        install_macos(paths, no_startup, watch_themes)?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = skip_shortcuts;
        install_linux(paths, no_startup, watch_themes)?;
    }

    Ok(())
}

pub fn uninstall(paths: &AppPaths) -> Result<()> {
    remove_autostart(paths);

    if let Some(pid) = stop_daemon(paths)? {
        println!("[uninstall] Stopped daemon PID {pid}.");
    } else {
        println!("[uninstall] No active daemon running.");
    }

    match cleanup_open_pages() {
        Ok(0) => println!("[uninstall] No open Antigravity/IDE/VS Code CDP pages to clear."),
        Ok(n) => println!("[uninstall] Cleared Theme Studio from {n} open CDP target(s)."),
        Err(e) => println!("[uninstall] CDP cleanup skipped ({e})."),
    }

    println!("[uninstall] Done. Antigravity Theme Studio removed.");
    Ok(())
}

#[cfg(windows)]
fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(windows)]
fn install_windows(
    paths: &AppPaths,
    no_startup: bool,
    skip_shortcuts: bool,
    watch_themes: bool,
) -> Result<()> {
    use std::process::Command;

    let daemon_exe = resolve_daemon_exe();
    let root_str = paths.root.to_string_lossy();
    let daemon_str = daemon_exe.to_string_lossy();
    let mut daemon_args = if is_dedicated_daemon_exe(&daemon_exe) {
        format!("--root \"{}\"", root_str)
    } else {
        format!("daemon --root \"{}\"", root_str)
    };
    if watch_themes {
        daemon_args.push_str(" --watch-themes");
    }

    let patch_shortcuts_block = if skip_shortcuts {
        String::new()
    } else {
        r#"
$SearchDirs = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

foreach ($Dir in $SearchDirs) {
    Get-ChildItem -Path $Dir -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @('Antigravity.lnk', 'Antigravity IDE.lnk', 'Visual Studio Code.lnk') } |
        ForEach-Object {
            try {
                $Sc = $WshShell.CreateShortcut($_.FullName)
                if ($Sc.TargetPath -match 'Antigravity IDE\.exe$' -and $Sc.Arguments -notmatch '--remote-debugging-port') {
                    $Sc.Arguments = ("$($Sc.Arguments) --remote-debugging-port=9223").Trim()
                    $Sc.Save()
                    Write-Host "[install] Patched CDP flag (--remote-debugging-port=9223) on: $($_.FullName)"
                } elseif ($Sc.TargetPath -match 'Antigravity\.exe$' -and $Sc.Arguments -notmatch '--remote-debugging-port') {
                    $Sc.Arguments = ("$($Sc.Arguments) --remote-debugging-port=9222").Trim()
                    $Sc.Save()
                    Write-Host "[install] Patched CDP flag (--remote-debugging-port=9222) on: $($_.FullName)"
                } elseif ($Sc.TargetPath -match 'Code\.exe$' -and $Sc.Arguments -notmatch '--remote-debugging-port') {
                    $Sc.Arguments = ("$($Sc.Arguments) --remote-debugging-port=9224").Trim()
                    $Sc.Save()
                    Write-Host "[install] Patched CDP flag (--remote-debugging-port=9224) on: $($_.FullName)"
                }
            } catch {}
        }
}
"#
        .to_string()
    };

    let setup_persistence_block = if no_startup {
        String::new()
    } else {
        format!(
            r#"
$TaskName = {task_q}
$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'AntigravityThemeStudio.lnk'
$LegacyShortcut = Join-Path $StartupDir 'AntigravityCustomTheme.lnk'
if (Test-Path $LegacyShortcut) {{ Remove-Item $LegacyShortcut -Force -ErrorAction SilentlyContinue }}

try {{
    $Action = New-ScheduledTaskAction -Execute {daemon_q} -Argument {args_q} -WorkingDirectory {root_q}
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description 'Antigravity Theme Studio Rust Daemon' -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if (Test-Path $ShortcutPath) {{ Remove-Item $ShortcutPath -Force -ErrorAction SilentlyContinue }}
    Write-Host "[install] Windows Scheduled Task registered & started: $TaskName (native Rust binary, zero console)"
}} catch {{
    Write-Host "[install] Task Scheduler unavailable ($($_.Exception.Message)); falling back to Startup shortcut."
    $Sc = $WshShell.CreateShortcut($ShortcutPath)
    $Sc.TargetPath = {daemon_q}
    $Sc.Arguments = {args_q}
    $Sc.WorkingDirectory = {root_q}
    $Sc.WindowStyle = 7
    $Sc.Description = 'Antigravity Theme Studio Rust Daemon'
    $Sc.Save()
    Write-Host "[install] Startup shortcut created (direct native Rust binary): $ShortcutPath"
}}
"#,
            task_q = ps_single_quote(WIN_TASK_NAME),
            daemon_q = ps_single_quote(&daemon_str),
            args_q = ps_single_quote(&daemon_args),
            root_q = ps_single_quote(&root_str),
        )
    };

    if !patch_shortcuts_block.is_empty() || !setup_persistence_block.is_empty() {
        let ps_script = format!(
            "$ErrorActionPreference = 'Stop'\n$WshShell = New-Object -ComObject WScript.Shell\n{patch_shortcuts_block}\n{setup_persistence_block}"
        );

        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps_script,
            ])
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            print!("{stdout}");
        }
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Windows shortcut/service setup failed: {stderr}").into());
        }
    }

    let mut running_pid = None;
    if !no_startup {
        for _ in 0..12 {
            if let Some(pid) = read_running_pid(paths) {
                running_pid = Some(pid);
                break;
            }
            thread::sleep(Duration::from_millis(150));
        }
    }
    let pid = match running_pid {
        Some(p) => p,
        None => start_daemon(paths, watch_themes)?,
    };

    let mem_note = process_memory_stats(pid)
        .map(|m| format!(" (~{:.2} MB RAM)", m.working_set_kb as f64 / 1024.0))
        .unwrap_or_default();
    println!("[install] Rust Theme Studio daemon running silently (PID {pid}){mem_note}.");
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_macos(paths: &AppPaths, no_startup: bool, watch_themes: bool) -> Result<()> {
    use std::process::Command;
    if no_startup {
        let pid = start_daemon(paths, watch_themes)?;
        println!("[install] Rust daemon running (PID {pid}).");
        return Ok(());
    }
    let daemon_exe = resolve_daemon_exe();
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let plist_dir = Path::new(&home).join("Library").join("LaunchAgents");
    fs::create_dir_all(&plist_dir)?;
    let plist_path = plist_dir.join(format!("{SERVICE_LABEL}.plist"));

    let subcmd_arg = if is_dedicated_daemon_exe(&daemon_exe) {
        ""
    } else {
        "        <string>daemon</string>\n"
    };
    let extra_arg = if watch_themes {
        "        <string>--watch-themes</string>\n"
    } else {
        ""
    };
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
{subcmd_arg}        <string>--root</string>
        <string>{}</string>
{extra_arg}    </array>
    <key>WorkingDirectory</key>
    <string>{}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{}</string>
    <key>StandardErrorPath</key>
    <string>{}</string>
</dict>
</plist>
"#,
        daemon_exe.display(),
        paths.root.display(),
        paths.root.display(),
        paths.log_file.display(),
        paths.log_file.display(),
    );
    fs::write(&plist_path, plist)?;

    let _ = Command::new("launchctl")
        .args(["unload", &plist_path.to_string_lossy()])
        .output();
    let _ = Command::new("launchctl")
        .args(["load", "-w", &plist_path.to_string_lossy()])
        .output();
    println!("[install] LaunchAgent installed: {}", plist_path.display());
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn install_linux(paths: &AppPaths, no_startup: bool, watch_themes: bool) -> Result<()> {
    use std::process::Command;
    if no_startup {
        let pid = start_daemon(paths, watch_themes)?;
        println!("[install] Rust daemon running (PID {pid}).");
        return Ok(());
    }
    let daemon_exe = resolve_daemon_exe();
    let has_systemd = Command::new("systemctl")
        .args(["--user", "status"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if has_systemd {
        let xdg = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
            format!("{}/.config", std::env::var("HOME").unwrap_or_default())
        });
        let unit_dir = Path::new(&xdg).join("systemd").join("user");
        fs::create_dir_all(&unit_dir)?;
        let unit_path = unit_dir.join(SYSTEMD_UNIT);
        let subcmd = if is_dedicated_daemon_exe(&daemon_exe) {
            ""
        } else {
            " daemon"
        };
        let extra = if watch_themes { " --watch-themes" } else { "" };
        let unit = format!(
            "[Unit]\nDescription=Antigravity Theme Studio Rust Daemon\nAfter=graphical-session.target\n\n[Service]\nType=simple\nWorkingDirectory={}\nExecStart={}{subcmd} --root \"{}\"{extra}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n",
            paths.root.display(),
            daemon_exe.display(),
            paths.root.display()
        );
        fs::write(&unit_path, unit)?;
        let _ = Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .status();
        let _ = Command::new("systemctl")
            .args(["--user", "enable", "--now", SYSTEMD_UNIT])
            .status();
        println!(
            "[install] systemd user service active: {}",
            unit_path.display()
        );
    } else {
        let pid = start_daemon(paths, watch_themes)?;
        println!(
            "[install] systemd --user unavailable; started detached Rust daemon (PID {pid})."
        );
    }
    Ok(())
}

fn remove_autostart(paths: &AppPaths) {
    #[cfg(windows)]
    {
        use std::process::Command;
        let ps = format!(
            r#"
foreach ($t in @({t1}, 'AntigravityCustomTheme')) {{
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {{
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "[uninstall] Removed Windows Scheduled Task: $t"
    }}
}}
$dirs = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
) | Where-Object {{ $_ -and (Test-Path $_) }} | Select-Object -Unique
$wsh = New-Object -ComObject WScript.Shell
foreach ($d in $dirs) {{
    Get-ChildItem -Path $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
        Where-Object {{ $_.Name -in @('Antigravity.lnk', 'Antigravity IDE.lnk', 'Visual Studio Code.lnk') }} |
        ForEach-Object {{
            try {{
                $sc = $wsh.CreateShortcut($_.FullName)
                if ($sc.Arguments -match '--remote-debugging-port=\d+') {{
                    $sc.Arguments = ($sc.Arguments -replace '\s*--remote-debugging-port=\d+', '').Trim()
                    $sc.Save()
                    Write-Host "[uninstall] Removed CDP flag from: $($_.FullName)"
                }}
            }} catch {{}}
        }}
}}
"#,
            t1 = ps_single_quote(WIN_TASK_NAME),
        );
        if let Ok(out) = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps,
            ])
            .output()
        {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if !stdout.trim().is_empty() {
                print!("{stdout}");
            }
        }

        if let Some(app_data) = std::env::var_os("APPDATA") {
            let startup_dir = Path::new(&app_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Startup");
            for name in ["AntigravityThemeStudio.lnk", "AntigravityCustomTheme.lnk"] {
                let lnk = startup_dir.join(name);
                if lnk.is_file() && fs::remove_file(&lnk).is_ok() {
                    println!(
                        "[uninstall] Removed Windows Startup shortcut: {}",
                        lnk.display()
                    );
                }
            }
        }
        if paths.legacy_vbs.is_file() && fs::remove_file(&paths.legacy_vbs).is_ok() {
            println!(
                "[uninstall] Removed legacy helper script: {}",
                paths.legacy_vbs.display()
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let plist = Path::new(&home)
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{SERVICE_LABEL}.plist"));
        let _ = Command::new("launchctl")
            .args(["unload", &plist.to_string_lossy()])
            .output();
        if plist.is_file() && fs::remove_file(&plist).is_ok() {
            println!("[uninstall] Removed LaunchAgent plist: {}", plist.display());
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::process::Command;
        let _ = Command::new("systemctl")
            .args(["--user", "disable", "--now", SYSTEMD_UNIT])
            .output();
        let xdg = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
            format!("{}/.config", std::env::var("HOME").unwrap_or_default())
        });
        let unit = Path::new(&xdg)
            .join("systemd")
            .join("user")
            .join(SYSTEMD_UNIT);
        if unit.is_file() && fs::remove_file(&unit).is_ok() {
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
            println!("[uninstall] Removed systemd user unit: {}", unit.display());
        }
    }
}
