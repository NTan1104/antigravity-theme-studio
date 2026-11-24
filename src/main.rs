use ats_theme::builder::{build_bundle, list_presets, BuildOptions, DEFAULT_MAX_DIM};
use ats_theme::cdp::verify_live;
use ats_theme::daemon::{run as run_daemon, DaemonOptions};
use ats_theme::installer::{install, print_status, start_daemon, stop_daemon, uninstall};
use ats_theme::paths::AppPaths;
use ats_theme::sys::process_memory_stats;
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn print_help() {
    println!(
        r#"ats-theme v{} — Pure-Rust Ultra-Low-RAM Custom Theme, Video Media Server & Audio Engine for Antigravity, Antigravity IDE, and VS Code

USAGE:
  ats-theme <COMMAND> [OPTIONS]

COMMANDS:
  build       Compile themes/presets.json + runtime/style.css + runtime/engine.js -> dist/bundle.js
                [--presets <path>] [--css <path>] [--engine <path>] [--out <path>] [--max-dim <px>]
  daemon      Run CDP theme daemon + HTTP Range 206 media server in foreground (Ctrl+C to stop)
                [--watch-themes]
  start       Launch silent background Rust daemon (zero console window)
                [--watch-themes]
  stop        Stop running background daemon
  status      Show daemon PID, live RAM usage, bundle status, and active CDP targets
  install     Build bundle, patch Antigravity/IDE/VS Code shortcuts, register Task Scheduler, and start daemon
                [--no-startup] [--skip-shortcuts] [--watch-themes]
  uninstall   Remove auto-start, unpatch shortcuts, stop daemon, and restore default UI on open windows
  verify      Live CDP inspection across Antigravity (9222), IDE (9223), and VS Code (9224)
  themes      List all configured presets in themes/presets.json

GLOBAL OPTIONS:
  --root <dir>    Override repository root directory (default: auto-detected)
  -h, --help      Show this help message
  -V, --version   Show version"#,
        env!("CARGO_PKG_VERSION")
    );
}

fn take_value(args: &[String], idx: &mut usize, flag: &str) -> Result<String, String> {
    *idx += 1;
    args.get(*idx)
        .cloned()
        .ok_or_else(|| format!("Missing value for {flag}"))
}

fn run_cli() -> Result<ExitCode, String> {
    let raw_args: Vec<String> = env::args().skip(1).collect();
    if raw_args.is_empty() {
        print_help();
        return Ok(ExitCode::SUCCESS);
    }

    let mut explicit_root: Option<PathBuf> = None;
    let mut filtered: Vec<String> = Vec::with_capacity(raw_args.len());
    let mut i = 0;
    while i < raw_args.len() {
        match raw_args[i].as_str() {
            "--root" => {
                let val = take_value(&raw_args, &mut i, "--root")?;
                explicit_root = Some(PathBuf::from(val));
            }
            "-h" | "--help" => {
                print_help();
                return Ok(ExitCode::SUCCESS);
            }
            "-V" | "--version" => {
                println!("ats-theme {}", env!("CARGO_PKG_VERSION"));
                return Ok(ExitCode::SUCCESS);
            }
            other => filtered.push(other.to_string()),
        }
        i += 1;
    }

    let Some(cmd) = filtered.first().map(String::as_str) else {
        print_help();
        return Ok(ExitCode::SUCCESS);
    };
    let rest = &filtered[1..];
    let paths = AppPaths::discover(explicit_root.as_deref());

    match cmd {
        "build" => {
            let mut opts = BuildOptions {
                presets_path: paths.presets_json.clone(),
                css_path: paths.style_css.clone(),
                engine_path: paths.engine_js.clone(),
                out_path: paths.bundle_js.clone(),
                max_dim: DEFAULT_MAX_DIM,
            };
            let mut idx = 0;
            while idx < rest.len() {
                match rest[idx].as_str() {
                    "--presets" | "--themes" => {
                        opts.presets_path =
                            PathBuf::from(take_value(rest, &mut idx, "--presets")?)
                    }
                    "--css" => opts.css_path = PathBuf::from(take_value(rest, &mut idx, "--css")?),
                    "--engine" => {
                        opts.engine_path = PathBuf::from(take_value(rest, &mut idx, "--engine")?)
                    }
                    "--out" => opts.out_path = PathBuf::from(take_value(rest, &mut idx, "--out")?),
                    "--max-dim" => {
                        let v = take_value(rest, &mut idx, "--max-dim")?;
                        opts.max_dim = v
                            .parse()
                            .map_err(|_| format!("Invalid --max-dim value: {v}"))?;
                    }
                    other => return Err(format!("Unknown build option: {other}")),
                }
                idx += 1;
            }
            let report = build_bundle(&opts).map_err(|e| e.to_string())?;
            println!(
                "[build] Built {} ({:.1} KB in {} ms) with {} preset(s): {}",
                report.out_path.display(),
                report.size_bytes as f64 / 1024.0,
                report.elapsed_ms,
                report.preset_names.len(),
                report.preset_names.join(", ")
            );
            Ok(ExitCode::SUCCESS)
        }
        "daemon" => {
            let watch_themes = rest.iter().any(|a| a == "--watch-themes");
            run_daemon(DaemonOptions {
                paths,
                echo_stdout: true,
                watch_themes,
            })
            .map_err(|e| e.to_string())?;
            Ok(ExitCode::SUCCESS)
        }
        "start" => {
            let watch_themes = rest.iter().any(|a| a == "--watch-themes");
            let pid = start_daemon(&paths, watch_themes).map_err(|e| e.to_string())?;
            let mem = process_memory_stats(pid)
                .map(|m| format!(" (~{:.2} MB RAM)", m.working_set_kb as f64 / 1024.0))
                .unwrap_or_default();
            println!("[start] Rust Theme Studio daemon running silently (PID {pid}){mem}.");
            Ok(ExitCode::SUCCESS)
        }
        "stop" => {
            match stop_daemon(&paths).map_err(|e| e.to_string())? {
                Some(pid) => println!("[stop] Stopped daemon (PID {pid})."),
                None => println!("[stop] Daemon is not running."),
            }
            Ok(ExitCode::SUCCESS)
        }
        "status" => {
            print_status(&paths);
            Ok(ExitCode::SUCCESS)
        }
        "install" => {
            let no_startup = rest
                .iter()
                .any(|a| a == "--no-startup" || a.eq_ignore_ascii_case("-NoStartup"));
            let skip_shortcuts = rest
                .iter()
                .any(|a| a == "--skip-shortcuts" || a.eq_ignore_ascii_case("-SkipShortcuts"));
            let watch_themes = rest.iter().any(|a| a == "--watch-themes");
            install(&paths, no_startup, skip_shortcuts, watch_themes)
                .map_err(|e| e.to_string())?;
            Ok(ExitCode::SUCCESS)
        }
        "uninstall" => {
            uninstall(&paths).map_err(|e| e.to_string())?;
            Ok(ExitCode::SUCCESS)
        }
        "verify" => {
            let outcome = verify_live().map_err(|e| e.to_string())?;
            println!(
                "{}",
                serde_json::to_string_pretty(&outcome.results).unwrap_or_default()
            );
            if outcome.themed_count == 0 {
                eprintln!(
                    "\n[verify] FAIL — Chưa thấy Theme Studio được tiêm vào cửa sổ nào. Hãy đảm bảo daemon đang chạy."
                );
                return Ok(ExitCode::FAILURE);
            }
            if outcome.has_live_blur {
                eprintln!(
                    "\n[verify] FAIL — Phát hiện live backdrop-filter blur trên vùng cuộn."
                );
                return Ok(ExitCode::FAILURE);
            }
            if outcome.has_ext_leak {
                eprintln!(
                    "\n[verify] FAIL — Phát hiện .agy-shell::before (Unified Glass) bị rò sang khung extensionView của IDE."
                );
                return Ok(ExitCode::FAILURE);
            }
            println!(
                "\n[verify] PASS — Antigravity Theme Studio (Rust Edition) hoạt động ổn định trên {}/{} cửa sổ (0 live blur)!",
                outcome.themed_count, outcome.total_count
            );
            Ok(ExitCode::SUCCESS)
        }
        "themes" | "presets" => {
            let list = list_presets(&paths.presets_json).map_err(|e| e.to_string())?;
            println!("Configured presets ({}):", list.len());
            for (idx, t) in list.iter().enumerate() {
                let mode_str = if t.is_light { "Light" } else { "Dark " };
                let kind = if t.has_video {
                    "Live Video"
                } else if t.has_wallpaper {
                    "Wallpaper "
                } else {
                    "Pure-CSS  "
                };
                let def = if idx == 0 { " [default]" } else { "" };
                println!(
                    "  {}. {:<20} [{} | {}]{} — {}",
                    idx + 1,
                    t.name,
                    mode_str,
                    kind,
                    def,
                    t.concept
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        other => Err(format!(
            "Unknown command '{other}'. Run `ats-theme --help` for usage."
        )),
    }
}

fn main() -> ExitCode {
    match run_cli() {
        Ok(code) => code,
        Err(msg) => {
            eprintln!("[ats-theme] Error: {msg}");
            ExitCode::FAILURE
        }
    }
}
