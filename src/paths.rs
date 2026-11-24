use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub presets_json: PathBuf,
    pub style_css: PathBuf,
    pub engine_js: PathBuf,
    pub dist_dir: PathBuf,
    pub bundle_js: PathBuf,
    pub assets_dir: PathBuf,
    pub user_media_dir: PathBuf,
    pub config_json: PathBuf,
    pub pid_file: PathBuf,
    pub log_file: PathBuf,
    pub legacy_vbs: PathBuf,
}

fn looks_like_repo_root(dir: &Path) -> bool {
    dir.join("themes").join("presets.json").is_file()
        || dir.join("runtime").join("engine.js").is_file()
        || dir.join("dist").join("bundle.js").is_file()
}

impl AppPaths {
    pub fn discover(explicit_root: Option<&Path>) -> Self {
        let root = resolve_root_dir(explicit_root);
        let config_json = env::var_os("ATS_CONFIG_PATH")
            .or_else(|| env::var_os("AGY_CONFIG_PATH"))
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("theme_config.json"));
        let dist_dir = root.join("dist");
        let themes_dir = root.join("themes");
        Self {
            presets_json: themes_dir.join("presets.json"),
            style_css: root.join("runtime").join("style.css"),
            engine_js: root.join("runtime").join("engine.js"),
            bundle_js: dist_dir.join("bundle.js"),
            dist_dir,
            assets_dir: themes_dir.join("assets"),
            user_media_dir: themes_dir.join("user_media"),
            config_json,
            pid_file: root.join("daemon.pid"),
            log_file: root.join("daemon.log"),
            legacy_vbs: root.join("silent-start.vbs"),
            root,
        }
    }
}

fn normalize_path(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(stripped) = s.strip_prefix(r"\\?\") {
            if !stripped.starts_with("UNC\\") {
                return PathBuf::from(stripped);
            }
        }
    }
    p
}

pub fn resolve_root_dir(explicit_root: Option<&Path>) -> PathBuf {
    if let Some(p) = explicit_root {
        let resolved = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        return normalize_path(resolved);
    }

    if let Some(env_root) = env::var_os("ATS_ROOT_DIR")
        .or_else(|| env::var_os("AGY_ROOT_DIR"))
        .filter(|v| !v.is_empty())
    {
        let p = PathBuf::from(env_root);
        let resolved = fs::canonicalize(&p).unwrap_or(p);
        return normalize_path(resolved);
    }

    if let Ok(cwd) = env::current_dir() {
        for ancestor in cwd.ancestors().take(4) {
            if looks_like_repo_root(ancestor) {
                return normalize_path(ancestor.to_path_buf());
            }
        }
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for ancestor in exe_dir.ancestors().take(5) {
                if looks_like_repo_root(ancestor) {
                    return normalize_path(ancestor.to_path_buf());
                }
            }
            return normalize_path(exe_dir.to_path_buf());
        }
    }

    normalize_path(env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub fn resolve_daemon_exe() -> PathBuf {
    let daemon_name = if cfg!(windows) {
        "ats-theme-daemon.exe"
    } else {
        "ats-theme-daemon"
    };

    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join(daemon_name);
            if sibling.is_file() {
                return sibling;
            }
        }
        return exe;
    }

    PathBuf::from(daemon_name)
}

pub fn default_port_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(custom) = env::var_os("ATS_PORT_FILE")
        .or_else(|| env::var_os("AGY_PORT_FILE"))
        .filter(|v| !v.is_empty())
    {
        candidates.push(PathBuf::from(custom));
    }

    #[cfg(windows)]
    {
        let base = env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("USERPROFILE")
                    .map(|h| PathBuf::from(h).join("AppData").join("Roaming"))
            })
            .unwrap_or_else(|| PathBuf::from("."));
        candidates.extend([
            base.join("antigravity").join("DevToolsActivePort"),
            base.join("Antigravity").join("DevToolsActivePort"),
            base.join("Antigravity IDE").join("DevToolsActivePort"),
            base.join("antigravity-ide").join("DevToolsActivePort"),
            base.join("Code").join("DevToolsActivePort"),
        ]);
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let sup = home.join("Library").join("Application Support");
        candidates.extend([
            sup.join("antigravity").join("DevToolsActivePort"),
            sup.join("Antigravity").join("DevToolsActivePort"),
            sup.join("Antigravity IDE").join("DevToolsActivePort"),
            sup.join("Code").join("DevToolsActivePort"),
        ]);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let xdg = env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::var_os("HOME")
                    .map(|h| PathBuf::from(h).join(".config"))
                    .unwrap_or_else(|| PathBuf::from(".config"))
            });
        candidates.extend([
            xdg.join("antigravity").join("DevToolsActivePort"),
            xdg.join("Antigravity").join("DevToolsActivePort"),
            xdg.join("Antigravity IDE").join("DevToolsActivePort"),
            xdg.join("Code").join("DevToolsActivePort"),
        ]);
    }
    candidates
}

/// Discovers all active/candidate CDP ports across Antigravity (9222), Antigravity IDE (9223),
/// VS Code (9224), `ATS_CDP_PORT`, and `DevToolsActivePort` files.
pub fn resolve_cdp_ports() -> Vec<u16> {
    let mut ports = BTreeSet::new();

    if let Ok(env_ports) = env::var("ATS_CDP_PORT") {
        for part in env_ports.split(',') {
            if let Ok(p) = part.trim().parse::<u16>() {
                if p > 0 {
                    ports.insert(p);
                }
            }
        }
    }

    for file in default_port_file_candidates() {
        if let Ok(content) = fs::read_to_string(&file) {
            if let Some(first_line) = content.lines().map(str::trim).find(|l| !l.is_empty()) {
                if let Ok(port) = first_line.parse::<u16>() {
                    if port > 0 {
                        ports.insert(port);
                    }
                }
            }
        }
    }

    ports.insert(9222);
    ports.insert(9223);
    ports.insert(9224);
    ports.into_iter().collect()
}
