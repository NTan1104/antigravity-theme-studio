use crate::builder::{build_bundle, BuildOptions, DEFAULT_MAX_DIM};
use crate::cdp::{connect_ws, fetch_targets, filter_antigravity_pages, CdpTarget};
use crate::config::{append_log, read_config, save_config_merge};
use crate::media::{
    percent_decode_query, resolve_local_media_as_data_uri, scan_user_media, start_media_server,
};
use crate::paths::{resolve_cdp_ports, AppPaths};
use crate::sys::{is_ats_daemon_pid, register_shutdown_flag, trim_working_set};
use crate::ws::{WsClient, WsEvent};
use crate::Result;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
pub struct DaemonOptions {
    pub paths: AppPaths,
    pub echo_stdout: bool,
    pub watch_themes: bool,
}

enum SessionCmd {
    Reinject(bool),
    SyncConfig(Map<String, Value>),
    ApplyExtRect(String),
    RequestSyncRect,
    OpenStudio,
    Close,
}

#[derive(Clone)]
struct SessionEntry {
    tx: Sender<SessionCmd>,
    port: u16,
    is_ide_target: bool,
    is_ext_target: bool,
    workspace_hint: String,
    last_title: String,
    last_rect: Option<Value>,
}

struct SharedState {
    sessions: HashMap<String, SessionEntry>,
    port_rects: HashMap<u16, Value>,
}

type SharedMap = Arc<Mutex<SharedState>>;

struct PidGuard {
    pid_file: std::path::PathBuf,
    pid: u32,
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        if let Ok(raw) = fs::read_to_string(&self.pid_file) {
            if raw.trim().parse::<u32>().ok() == Some(self.pid) {
                let _ = fs::remove_file(&self.pid_file);
            }
        }
    }
}

fn acquire_pid_lock(paths: &AppPaths, echo_stdout: bool) -> Result<Option<PidGuard>> {
    let my_pid = std::process::id();
    if let Ok(raw) = fs::read_to_string(&paths.pid_file) {
        if let Ok(existing_pid) = raw.trim().parse::<u32>() {
            if existing_pid != 0 && existing_pid != my_pid && is_ats_daemon_pid(existing_pid) {
                append_log(
                    &paths.log_file,
                    &format!(
                        "Another daemon instance is already running (PID {existing_pid}). Exiting."
                    ),
                    echo_stdout,
                );
                return Ok(None);
            }
        }
    }
    fs::write(&paths.pid_file, my_pid.to_string())?;
    Ok(Some(PidGuard {
        pid_file: paths.pid_file.clone(),
        pid: my_pid,
    }))
}

fn file_stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    Some((modified, meta.len()))
}

fn extract_workspace_hint(url_str: &str) -> String {
    let Some((_, query)) = url_str.split_once('?') else {
        return String::new();
    };
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == "workspaceUri" && !v.is_empty() {
            let dec1 = percent_decode_query(v);
            let dec2 = percent_decode_query(&dec1);
            let clean = dec2.trim_end_matches(['/', '\\']);
            let last = clean.rsplit(['/', '\\']).next().unwrap_or("");
            return last.to_ascii_lowercase();
        }
    }
    String::new()
}

/// Reads config + dist/bundle.js on-demand so large wallpaper/media payloads are never retained in idle RAM.
fn build_injected_source(
    paths: &AppPaths,
    media_port: u16,
    is_ide: bool,
    missing_logged: &AtomicBool,
    echo_stdout: bool,
) -> Option<(String, String, String)> {
    if !paths.bundle_js.is_file() {
        if !missing_logged.swap(true, Ordering::Relaxed) {
            append_log(
                &paths.log_file,
                &format!(
                    "Bundle not built yet ({}). Run: ats-theme build",
                    paths.bundle_js.display()
                ),
                echo_stdout,
            );
        }
        return None;
    }
    missing_logged.store(false, Ordering::Relaxed);

    let bundle_code = match fs::read_to_string(&paths.bundle_js) {
        Ok(s) => s,
        Err(e) => {
            append_log(
                &paths.log_file,
                &format!("Failed reading dist/bundle.js: {e}"),
                echo_stdout,
            );
            return None;
        }
    };

    let cfg = read_config(&paths.config_json);
    let active_img_key = cfg
        .get("activeImage")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let active_vid_key = cfg
        .get("activeVideo")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let cfg_json = serde_json::to_string(&Value::Object(cfg)).unwrap_or_else(|_| "{}".into());
    let user_media = scan_user_media(paths);
    let media_json = serde_json::to_string(&user_media)
        .unwrap_or_else(|_| r#"{"videos":[],"images":[],"audios":[]}"#.into());
    let media_base = if media_port > 0 {
        format!("http://127.0.0.1:{media_port}")
    } else {
        String::new()
    };

    let (inline_image, inline_video) = if is_ide {
        let img_uri = if !active_img_key.is_empty() {
            resolve_local_media_as_data_uri(paths, &active_img_key, 15 * 1024 * 1024)
        } else {
            String::new()
        };
        let vid_uri = if active_vid_key.to_ascii_lowercase().ends_with(".webm") {
            resolve_local_media_as_data_uri(paths, &active_vid_key, 25 * 1024 * 1024)
        } else {
            String::new()
        };
        (img_uri, vid_uri)
    } else {
        (String::new(), String::new())
    };

    let inline_img_json = serde_json::to_string(&inline_image).unwrap_or_else(|_| "\"\"".into());
    let inline_vid_json = serde_json::to_string(&inline_video).unwrap_or_else(|_| "\"\"".into());
    let media_base_json = serde_json::to_string(&media_base).unwrap_or_else(|_| "\"\"".into());

    let mut out = String::with_capacity(
        cfg_json.len()
            + media_json.len()
            + inline_img_json.len()
            + inline_vid_json.len()
            + bundle_code.len()
            + 200,
    );
    out.push_str("window.__ATS_MEDIA_BASE__ = ");
    out.push_str(&media_base_json);
    out.push_str(";\nwindow.__ATS_INIT_CONFIG__ = ");
    out.push_str(&cfg_json);
    out.push_str(";\nwindow.__ATS_USER_MEDIA__ = ");
    out.push_str(&media_json);
    out.push_str(";\nwindow.__ATS_INLINE_IMAGE__ = ");
    out.push_str(&inline_img_json);
    out.push_str(";\nwindow.__ATS_INLINE_VIDEO__ = ");
    out.push_str(&inline_vid_json);
    out.push_str(";\n");
    out.push_str(&bundle_code);

    Some((out, active_img_key, active_vid_key))
}

fn find_matching_rect_for_ext(state: &SharedState, port: u16, workspace_hint: &str) -> Option<Value> {
    let ide_sessions: Vec<&SessionEntry> = state
        .sessions
        .values()
        .filter(|s| s.port == port && s.is_ide_target && s.last_rect.is_some())
        .collect();
    if !workspace_hint.is_empty() && ide_sessions.len() > 1 {
        if let Some(matched) = ide_sessions
            .iter()
            .find(|s| s.last_title.contains(workspace_hint))
        {
            return matched.last_rect.clone();
        }
    }
    if ide_sessions.len() == 1 {
        return ide_sessions[0].last_rect.clone();
    }
    state.port_rects.get(&port).cloned()
}

fn spawn_session(
    port: u16,
    target: CdpTarget,
    media_port: u16,
    paths: Arc<AppPaths>,
    shared: SharedMap,
    missing_logged: Arc<AtomicBool>,
    echo_stdout: bool,
) {
    let (tx, rx) = mpsc::channel::<SessionCmd>();
    let session_key = format!("{port}:{}", target.id);
    let is_ide_target = target.url.starts_with("vscode-file://");
    let is_ext_target = target.url.contains("extensionView=true");
    let workspace_hint = if is_ext_target {
        extract_workspace_hint(&target.url)
    } else {
        String::new()
    };

    {
        let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
        if st.sessions.contains_key(&session_key) {
            return;
        }
        st.sessions.insert(
            session_key.clone(),
            SessionEntry {
                tx,
                port,
                is_ide_target,
                is_ext_target,
                workspace_hint: workspace_hint.clone(),
                last_title: target.title.to_ascii_lowercase(),
                last_rect: None,
            },
        );
    }

    let thread_name = format!("cdp-{}", &target.id[..target.id.len().min(8)]);
    let builder = thread::Builder::new()
        .name(thread_name)
        .stack_size(256 * 1024);

    let shared_cleanup = Arc::clone(&shared);
    let key_cleanup = session_key.clone();
    let res = builder.spawn(move || {
        run_session_loop(
            port,
            session_key.clone(),
            target,
            is_ide_target,
            is_ext_target,
            workspace_hint,
            media_port,
            rx,
            &paths,
            &shared,
            &missing_logged,
            echo_stdout,
        );
        shared.lock().unwrap_or_else(|e| e.into_inner()).sessions.remove(&session_key);
        trim_working_set();
    });

    if res.is_err() {
        shared_cleanup.lock().unwrap_or_else(|e| e.into_inner()).sessions.remove(&key_cleanup);
    }
}

#[allow(clippy::too_many_arguments)]
fn run_session_loop(
    port: u16,
    session_key: String,
    target: CdpTarget,
    is_ide_target: bool,
    is_ext_target: bool,
    workspace_hint: String,
    media_port: u16,
    rx: Receiver<SessionCmd>,
    paths: &AppPaths,
    shared: &SharedMap,
    missing_logged: &AtomicBool,
    echo_stdout: bool,
) {
    let mut ws = match connect_ws(&target.web_socket_debugger_url, Duration::from_millis(200)) {
        Ok(ws) => ws,
        Err(e) => {
            append_log(
                &paths.log_file,
                &format!("Attach error for {session_key}: {e}"),
                echo_stdout,
            );
            return;
        }
    };

    let mut next_id: u64 = 1;
    let mut doc_script_id: Option<String> = None;
    let mut pending_doc_script_call_id: Option<u64> = None;
    let mut last_inline_img_key = String::new();
    let mut last_inline_vid_key = String::new();

    let send_cdp =
        |ws: &mut WsClient, next_id: &mut u64, method: &str, params: Value| -> Result<u64> {
            let id = *next_id;
            *next_id += 1;
            let msg = json!({ "id": id, "method": method, "params": params }).to_string();
            ws.send_text(&msg)?;
            Ok(id)
        };

    let push_rect_to_ext = |ws: &mut WsClient, next_id: &mut u64| {
        if !is_ext_target {
            return;
        }
        let (rect_opt, ide_txs) = {
            let st = shared.lock().unwrap_or_else(|e| e.into_inner());
            let r = find_matching_rect_for_ext(&st, port, &workspace_hint);
            let txs: Vec<Sender<SessionCmd>> = st
                .sessions
                .values()
                .filter(|s| s.port == port && s.is_ide_target)
                .map(|s| s.tx.clone())
                .collect();
            (r, txs)
        };
        if let Some(rect) = rect_opt {
            if let Ok(rect_json) = serde_json::to_string(&rect) {
                let expr = format!(
                    "window.__ATS_APPLY_EXT_RECT__&&window.__ATS_APPLY_EXT_RECT__({rect_json});"
                );
                let _ = send_cdp(
                    ws,
                    next_id,
                    "Runtime.evaluate",
                    json!({ "expression": expr, "awaitPromise": false }),
                );
            }
        }
        for tx in ide_txs {
            let _ = tx.send(SessionCmd::RequestSyncRect);
        }
    };

    let inject_full = |ws: &mut WsClient,
                       next_id: &mut u64,
                       update_new_doc: bool,
                       doc_script_id: &mut Option<String>,
                       pending_doc_script_call_id: &mut Option<u64>,
                       last_img: &mut String,
                       last_vid: &mut String|
     -> Result<()> {
        let Some((src, img_key, vid_key)) =
            build_injected_source(paths, media_port, is_ide_target, missing_logged, echo_stdout)
        else {
            return Ok(());
        };
        *last_img = img_key;
        *last_vid = vid_key;

        if update_new_doc {
            if let Some(old_id) = doc_script_id.take() {
                let _ = send_cdp(
                    ws,
                    next_id,
                    "Page.removeScriptToEvaluateOnNewDocument",
                    json!({ "identifier": old_id }),
                );
            }
            let reg_id = send_cdp(
                ws,
                next_id,
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": &src }),
            )?;
            *pending_doc_script_call_id = Some(reg_id);
        }

        send_cdp(
            ws,
            next_id,
            "Runtime.evaluate",
            json!({ "expression": &src, "awaitPromise": false }),
        )?;
        drop(src);
        push_rect_to_ext(ws, next_id);
        trim_working_set();
        Ok(())
    };

    // Only enable Page + Page.setBypassCSP + Runtime.addBinding.
    // Deliberately omit `Runtime.enable`: bindings and `Runtime.evaluate` work without it,
    // avoiding V8 console stack-trace capture and RemoteObject heap retention inside Electron!
    if send_cdp(&mut ws, &mut next_id, "Page.enable", json!({})).is_err() {
        return;
    }
    let _ = send_cdp(
        &mut ws,
        &mut next_id,
        "Page.setBypassCSP",
        json!({ "enabled": true }),
    );
    for binding_name in ["atsSaveConfig", "atsReportWebviewRect", "atsOpenStudio"] {
        let _ = send_cdp(
            &mut ws,
            &mut next_id,
            "Runtime.addBinding",
            json!({ "name": binding_name }),
        );
    }

    if let Err(e) = inject_full(
        &mut ws,
        &mut next_id,
        true,
        &mut doc_script_id,
        &mut pending_doc_script_call_id,
        &mut last_inline_img_key,
        &mut last_inline_vid_key,
    ) {
        append_log(
            &paths.log_file,
            &format!("Initial inject error for {session_key}: {e}"),
            echo_stdout,
        );
        return;
    }

    append_log(
        &paths.log_file,
        &format!(
            "Attached to target {session_key}: {} ({})",
            target.title, target.url
        ),
        echo_stdout,
    );

    while !SHUTDOWN.load(Ordering::Relaxed) {
        loop {
            match rx.try_recv() {
                Ok(SessionCmd::Reinject(update_new_doc)) => {
                    if inject_full(
                        &mut ws,
                        &mut next_id,
                        update_new_doc,
                        &mut doc_script_id,
                        &mut pending_doc_script_call_id,
                        &mut last_inline_img_key,
                        &mut last_inline_vid_key,
                    )
                    .is_err()
                    {
                        return;
                    }
                }
                Ok(SessionCmd::SyncConfig(saved)) => {
                    let mut expr = String::new();
                    if is_ide_target {
                        let img_key = saved
                            .get("activeImage")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let vid_key = saved
                            .get("activeVideo")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if last_inline_img_key != img_key {
                            last_inline_img_key = img_key.clone();
                            let in_img = if !img_key.is_empty() {
                                resolve_local_media_as_data_uri(paths, &img_key, 15 * 1024 * 1024)
                            } else {
                                String::new()
                            };
                            if let Ok(s) = serde_json::to_string(&in_img) {
                                expr.push_str(&format!("window.__ATS_INLINE_IMAGE__={s};"));
                            }
                        }
                        if last_inline_vid_key != vid_key {
                            last_inline_vid_key = vid_key.clone();
                            let in_vid = if vid_key.to_ascii_lowercase().ends_with(".webm") {
                                resolve_local_media_as_data_uri(paths, &vid_key, 25 * 1024 * 1024)
                            } else {
                                String::new()
                            };
                            if let Ok(s) = serde_json::to_string(&in_vid) {
                                expr.push_str(&format!("window.__ATS_INLINE_VIDEO__={s};"));
                            }
                        }
                    }
                    if let Ok(cfg_json) = serde_json::to_string(&Value::Object(saved)) {
                        expr.push_str(&format!(
                            "window.__ATS_ENGINE__&&window.__ATS_ENGINE__.updateConfig?window.__ATS_ENGINE__.updateConfig({cfg_json}):(window.__ATS_ENGINE__&&window.__ATS_ENGINE__.reapply());"
                        ));
                    }
                    if send_cdp(
                        &mut ws,
                        &mut next_id,
                        "Runtime.evaluate",
                        json!({ "expression": expr, "awaitPromise": false }),
                    )
                    .is_err()
                    {
                        return;
                    }
                    trim_working_set();
                }
                Ok(SessionCmd::ApplyExtRect(rect_json)) => {
                    let expr = format!(
                        "window.__ATS_APPLY_EXT_RECT__&&window.__ATS_APPLY_EXT_RECT__({rect_json});"
                    );
                    if send_cdp(
                        &mut ws,
                        &mut next_id,
                        "Runtime.evaluate",
                        json!({ "expression": expr, "awaitPromise": false }),
                    )
                    .is_err()
                    {
                        return;
                    }
                }
                Ok(SessionCmd::RequestSyncRect) => {
                    let expr = "window.__ATS_ENGINE__&&window.__ATS_ENGINE__.syncRect&&window.__ATS_ENGINE__.syncRect(true);";
                    if send_cdp(
                        &mut ws,
                        &mut next_id,
                        "Runtime.evaluate",
                        json!({ "expression": expr, "awaitPromise": false }),
                    )
                    .is_err()
                    {
                        return;
                    }
                }
                Ok(SessionCmd::OpenStudio) => {
                    let expr = "window.__ATS_ENGINE__&&window.__ATS_ENGINE__.openStudio&&window.__ATS_ENGINE__.openStudio();";
                    if send_cdp(
                        &mut ws,
                        &mut next_id,
                        "Runtime.evaluate",
                        json!({ "expression": expr, "awaitPromise": false }),
                    )
                    .is_err()
                    {
                        return;
                    }
                }
                Ok(SessionCmd::Close) | Err(TryRecvError::Disconnected) => {
                    ws.close();
                    return;
                }
                Err(TryRecvError::Empty) => break,
            }
        }

        match ws.read_event() {
            Ok(WsEvent::Text(txt)) => {
                let Ok(msg) = serde_json::from_str::<Value>(&txt) else {
                    continue;
                };

                if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                    if pending_doc_script_call_id == Some(id) {
                        pending_doc_script_call_id = None;
                        if let Some(ident) =
                            msg.pointer("/result/identifier").and_then(Value::as_str)
                        {
                            doc_script_id = Some(ident.to_string());
                        }
                    }
                    continue;
                }

                let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
                if method == "Runtime.bindingCalled" {
                    let name = msg
                        .pointer("/params/name")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let raw_payload = msg
                        .pointer("/params/payload")
                        .and_then(Value::as_str)
                        .unwrap_or("{}");

                    if name == "atsSaveConfig" {
                        if let Ok(Value::Object(incoming)) =
                            serde_json::from_str::<Value>(raw_payload)
                        {
                            match save_config_merge(&paths.config_json, &incoming) {
                                Ok(merged) => {
                                    if is_ide_target {
                                        let img_key = merged
                                            .get("activeImage")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .to_string();
                                        let vid_key = merged
                                            .get("activeVideo")
                                            .and_then(Value::as_str)
                                            .unwrap_or("")
                                            .to_string();
                                        let mut parts = String::new();
                                        if last_inline_img_key != img_key {
                                            last_inline_img_key = img_key.clone();
                                            let in_img = if !img_key.is_empty() {
                                                resolve_local_media_as_data_uri(
                                                    paths,
                                                    &img_key,
                                                    15 * 1024 * 1024,
                                                )
                                            } else {
                                                String::new()
                                            };
                                            if let Ok(s) = serde_json::to_string(&in_img) {
                                                parts.push_str(&format!(
                                                    "window.__ATS_INLINE_IMAGE__={s};"
                                                ));
                                            }
                                        }
                                        if last_inline_vid_key != vid_key {
                                            last_inline_vid_key = vid_key.clone();
                                            let in_vid =
                                                if vid_key.to_ascii_lowercase().ends_with(".webm") {
                                                    resolve_local_media_as_data_uri(
                                                        paths,
                                                        &vid_key,
                                                        25 * 1024 * 1024,
                                                    )
                                                } else {
                                                    String::new()
                                                };
                                            if let Ok(s) = serde_json::to_string(&in_vid) {
                                                parts.push_str(&format!(
                                                    "window.__ATS_INLINE_VIDEO__={s};"
                                                ));
                                            }
                                        }
                                        if !parts.is_empty() {
                                            parts.push_str(
                                                "window.__ATS_ENGINE__&&window.__ATS_ENGINE__.reapply();",
                                            );
                                            let _ = send_cdp(
                                                &mut ws,
                                                &mut next_id,
                                                "Runtime.evaluate",
                                                json!({ "expression": parts, "awaitPromise": false }),
                                            );
                                        }
                                    }

                                    let other_txs: Vec<Sender<SessionCmd>> = {
                                        let st = shared.lock().unwrap_or_else(|e| e.into_inner());
                                        st.sessions
                                            .iter()
                                            .filter(|(k, _)| *k != &session_key)
                                            .map(|(_, entry)| entry.tx.clone())
                                            .collect()
                                    };
                                    for tx in other_txs {
                                        let _ = tx.send(SessionCmd::SyncConfig(merged.clone()));
                                    }
                                    trim_working_set();
                                }
                                Err(e) => append_log(
                                    &paths.log_file,
                                    &format!("Failed saving theme_config.json: {e}"),
                                    echo_stdout,
                                ),
                            }
                        }
                    } else if name == "atsReportWebviewRect" {
                        if let Ok(rect) = serde_json::from_str::<Value>(raw_payload) {
                            let wb_w = rect.get("wbW").and_then(Value::as_f64).unwrap_or(0.0);
                            let wb_h = rect.get("wbH").and_then(Value::as_f64).unwrap_or(0.0);
                            if wb_w > 0.0 && wb_h > 0.0 {
                                let rect_title = rect
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .unwrap_or(&target.title)
                                    .to_ascii_lowercase();
                                let rect_json = rect.to_string();

                                let ext_txs: Vec<Sender<SessionCmd>> = {
                                    let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                                    if let Some(me) = st.sessions.get_mut(&session_key) {
                                        me.last_rect = Some(rect.clone());
                                        if !rect_title.is_empty() {
                                            me.last_title = rect_title.clone();
                                        }
                                    }
                                    st.port_rects.insert(port, rect);

                                    let ide_count = st
                                        .sessions
                                        .values()
                                        .filter(|s| s.port == port && s.is_ide_target)
                                        .count();

                                    st.sessions
                                        .values()
                                        .filter(|s| {
                                            if s.port != port || !s.is_ext_target {
                                                return false;
                                            }
                                            if ide_count > 1
                                                && !s.workspace_hint.is_empty()
                                                && !rect_title.is_empty()
                                                && !rect_title.contains(&s.workspace_hint)
                                            {
                                                return false;
                                            }
                                            true
                                        })
                                        .map(|s| s.tx.clone())
                                        .collect()
                                };

                                for tx in ext_txs {
                                    let _ = tx.send(SessionCmd::ApplyExtRect(rect_json.clone()));
                                }
                            }
                        }
                    } else if name == "atsOpenStudio" {
                        let target_tx: Option<Sender<SessionCmd>> = {
                            let st = shared.lock().unwrap_or_else(|e| e.into_inner());
                            let ide_candidates: Vec<&SessionEntry> = st
                                .sessions
                                .values()
                                .filter(|s| s.port == port && s.is_ide_target)
                                .collect();
                            let matched = if !workspace_hint.is_empty() && ide_candidates.len() > 1
                            {
                                ide_candidates
                                    .iter()
                                    .find(|s| s.last_title.contains(&workspace_hint))
                                    .copied()
                                    .or_else(|| ide_candidates.first().copied())
                            } else {
                                ide_candidates.first().copied()
                            };
                            matched.map(|m| m.tx.clone())
                        };
                        if let Some(tx) = target_tx {
                            let _ = tx.send(SessionCmd::OpenStudio);
                        }
                    }
                } else if method == "Page.frameNavigated" {
                    let is_top_frame = msg.pointer("/params/frame").is_some()
                        && msg
                            .pointer("/params/frame/parentId")
                            .map(Value::is_null)
                            .unwrap_or(true);
                    if is_top_frame {
                        if inject_full(
                            &mut ws,
                            &mut next_id,
                            false,
                            &mut doc_script_id,
                            &mut pending_doc_script_call_id,
                            &mut last_inline_img_key,
                            &mut last_inline_vid_key,
                        )
                        .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            Ok(WsEvent::Ping(data)) => {
                if ws.send_pong(&data).is_err() {
                    return;
                }
            }
            Ok(WsEvent::Close) => return,
            Ok(WsEvent::Timeout | WsEvent::Binary(_) | WsEvent::Pong(_)) => continue,
            Err(_) => return,
        }
    }

    ws.close();
}

fn close_all_sessions(shared: &SharedMap) {
    let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
    for (_, entry) in st.sessions.drain() {
        let _ = entry.tx.send(SessionCmd::Close);
    }
}

pub fn run(opts: DaemonOptions) -> Result<()> {
    SHUTDOWN.store(false, Ordering::SeqCst);
    register_shutdown_flag(&SHUTDOWN);

    let Some(_pid_guard) = acquire_pid_lock(&opts.paths, opts.echo_stdout)? else {
        return Ok(());
    };

    let paths = Arc::new(opts.paths);
    let media_port = start_media_server(Arc::clone(&paths), &SHUTDOWN)?;

    let shared: SharedMap = Arc::new(Mutex::new(SharedState {
        sessions: HashMap::new(),
        port_rects: HashMap::new(),
    }));
    let missing_logged = Arc::new(AtomicBool::new(false));

    append_log(
        &paths.log_file,
        &format!(
            "Rust Theme Studio daemon started (PID {}, os={}, mediaServer=http://127.0.0.1:{media_port}, watchThemes={}).",
            std::process::id(),
            std::env::consts::OS,
            opts.watch_themes
        ),
        opts.echo_stdout,
    );

    let mut last_bundle_stamp = file_stamp(&paths.bundle_js);
    let mut last_presets_stamp = file_stamp(&paths.presets_json);
    let mut last_css_stamp = file_stamp(&paths.style_css);
    let mut last_engine_stamp = file_stamp(&paths.engine_js);
    let mut last_scan = Instant::now() - Duration::from_secs(10);

    // Trim initial startup pages immediately so idle RAM starts minimal (~1 MB).
    trim_working_set();

    while !SHUTDOWN.load(Ordering::Relaxed) {
        if opts.watch_themes {
            let cur_presets = file_stamp(&paths.presets_json);
            let cur_css = file_stamp(&paths.style_css);
            let cur_engine = file_stamp(&paths.engine_js);
            if cur_presets != last_presets_stamp
                || cur_css != last_css_stamp
                || cur_engine != last_engine_stamp
            {
                last_presets_stamp = cur_presets;
                last_css_stamp = cur_css;
                last_engine_stamp = cur_engine;
                thread::sleep(Duration::from_millis(120));
                let build_opts = BuildOptions {
                    presets_path: paths.presets_json.clone(),
                    css_path: paths.style_css.clone(),
                    engine_path: paths.engine_js.clone(),
                    out_path: paths.bundle_js.clone(),
                    max_dim: DEFAULT_MAX_DIM,
                };
                match build_bundle(&build_opts) {
                    Ok(rep) => append_log(
                        &paths.log_file,
                        &format!(
                            "Auto-rebuilt dist/bundle.js ({:.1} KB in {} ms).",
                            rep.size_bytes as f64 / 1024.0,
                            rep.elapsed_ms
                        ),
                        opts.echo_stdout,
                    ),
                    Err(e) => append_log(
                        &paths.log_file,
                        &format!("Auto-rebuild failed: {e}"),
                        opts.echo_stdout,
                    ),
                }
            }
        }

        let cur_bundle = file_stamp(&paths.bundle_js);
        if cur_bundle.is_some() && cur_bundle != last_bundle_stamp {
            thread::sleep(Duration::from_millis(150));
            last_bundle_stamp = file_stamp(&paths.bundle_js);
            append_log(
                &paths.log_file,
                "Detected dist/bundle.js update; hot-reloading attached windows.",
                opts.echo_stdout,
            );
            let txs: Vec<Sender<SessionCmd>> = {
                let st = shared.lock().unwrap_or_else(|e| e.into_inner());
                st.sessions.values().map(|s| s.tx.clone()).collect()
            };
            for tx in txs {
                let _ = tx.send(SessionCmd::Reinject(true));
            }
        }

        let has_sessions = !shared.lock().unwrap_or_else(|e| e.into_inner()).sessions.is_empty();
        let scan_interval = if has_sessions {
            Duration::from_millis(2500)
        } else {
            Duration::from_millis(1800)
        };

        if last_scan.elapsed() >= scan_interval {
            last_scan = Instant::now();
            let ports = resolve_cdp_ports();
            let mut live_keys = HashSet::new();
            let mut discovered: Vec<(u16, CdpTarget)> = Vec::new();

            for port in ports {
                if let Ok(targets) = fetch_targets(port, Duration::from_millis(450)) {
                    for page in filter_antigravity_pages(targets) {
                        let key = format!("{port}:{}", page.id);
                        live_keys.insert(key);
                        discovered.push((port, page));
                    }
                }
            }

            {
                let mut st = shared.lock().unwrap_or_else(|e| e.into_inner());
                let stale: Vec<String> = st
                    .sessions
                    .keys()
                    .filter(|k| !live_keys.contains(*k))
                    .cloned()
                    .collect();
                for key in stale {
                    if let Some(entry) = st.sessions.remove(&key) {
                        let _ = entry.tx.send(SessionCmd::Close);
                    }
                }
            }

            for (port, page) in discovered {
                let key = format!("{port}:{}", page.id);
                let already = shared.lock().unwrap_or_else(|e| e.into_inner()).sessions.contains_key(&key);
                if !already {
                    spawn_session(
                        port,
                        page,
                        media_port,
                        Arc::clone(&paths),
                        Arc::clone(&shared),
                        Arc::clone(&missing_logged),
                        opts.echo_stdout,
                    );
                }
            }
        }

        thread::sleep(Duration::from_millis(150));
    }

    append_log(
        &paths.log_file,
        "Shutting down Rust Theme Studio daemon cleanly.",
        opts.echo_stdout,
    );
    close_all_sessions(&shared);
    thread::sleep(Duration::from_millis(120));
    Ok(())
}
