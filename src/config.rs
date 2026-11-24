use crate::{utc_timestamp, Result};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

const MAX_LOG_BYTES: u64 = 256 * 1024;
static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn read_config(path: &Path) -> Map<String, Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Map::new();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub fn save_config_merge(path: &Path, incoming: &Map<String, Value>) -> Result<Map<String, Value>> {
    let _guard = config_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut merged = read_config(path);
    for (k, v) in incoming {
        merged.insert(k.clone(), v.clone());
    }
    let json = serde_json::to_string_pretty(&Value::Object(merged.clone()))?;
    atomic_write(path, json.as_bytes())?;
    Ok(merged)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), seq));
    let tmp_path = std::path::PathBuf::from(tmp);

    fs::write(&tmp_path, bytes)?;
    if fs::rename(&tmp_path, path).is_err() {
        // On Windows, rename over an existing file can fail if an indexer briefly holds a handle.
        fs::write(path, bytes)?;
        let _ = fs::remove_file(&tmp_path);
    }
    Ok(())
}

pub fn append_log(log_file: &Path, msg: &str, echo_stdout: bool) {
    let line = format!("[{}] {}\n", utc_timestamp(), msg);
    if let Ok(meta) = fs::metadata(log_file) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = fs::write(log_file, b"");
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_file) {
        let _ = f.write_all(line.as_bytes());
    }
    if echo_stdout {
        let _ = std::io::stdout().write_all(line.as_bytes());
    }
}
