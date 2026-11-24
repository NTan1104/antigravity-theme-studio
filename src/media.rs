//! Pure-Rust Local HTTP Media Server with Range 206 streaming, streaming upload with MD5 deduplication,
//! media deletion with config auto-cleanup, and global task completion sound claim lock.

use crate::config::{read_config, save_config_merge};
use crate::paths::AppPaths;
use crate::sys::trim_working_set;
use crate::ws::next_u64;
use crate::Result;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_UPLOAD_BYTES: usize = 150 * 1024 * 1024;
const MAX_DELETE_JSON_BYTES: usize = 64 * 1024;

static LAST_GLOBAL_TASK_SOUND_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
pub struct MediaItem {
    #[serde(rename = "fileName")]
    pub file_name: String,
    pub name: String,
    pub url: String,
    pub kind: String,
    pub size: u64,
    #[serde(rename = "addedAt")]
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaLibrary {
    pub videos: Vec<MediaItem>,
    pub images: Vec<MediaItem>,
    pub audios: Vec<MediaItem>,
}

/// Pure-Rust RFC 1321 MD5 streaming state (zero external crypto crates).
pub struct Md5Hasher {
    state: [u32; 4],
    count: u64,
    buf: [u8; 64],
    buf_len: usize,
}

impl Md5Hasher {
    pub fn new() -> Self {
        Self {
            state: [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476],
            count: 0,
            buf: [0u8; 64],
            buf_len: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.count = self.count.wrapping_add(data.len() as u64);
        if self.buf_len > 0 {
            let need = 64 - self.buf_len;
            if data.len() < need {
                self.buf[self.buf_len..self.buf_len + data.len()].copy_from_slice(data);
                self.buf_len += data.len();
                return;
            }
            self.buf[self.buf_len..64].copy_from_slice(&data[..need]);
            let block = self.buf;
            self.compress(&block);
            self.buf_len = 0;
            data = &data[need..];
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.compress(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    pub fn finalize_hex(mut self) -> String {
        let bit_len = self.count.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buf_len != 56 {
            self.update(&[0x00]);
        }
        self.update(&bit_len.to_le_bytes());

        let mut out = [0u8; 16];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::with_capacity(32);
        for &b in &out {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0x0F) as usize] as char);
        }
        s
    }

    fn compress(&mut self, block: &[u8; 64]) {
        const S: [u32; 64] = [
            7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20,
            5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
        ];
        const K: [u32; 64] = [
            0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
            0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
            0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
            0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
            0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
            0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
            0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
            0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
            0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
            0xeb86d391,
        ];

        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }

        let (mut a, mut b, mut c, mut d) =
            (self.state[0], self.state[1], self.state[2], self.state[3]);

        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(K[i])
                    .wrapping_add(m[g])
                    .rotate_left(S[i]),
            );
            a = temp;
        }

        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }
}

pub fn md5_hex(bytes: &[u8]) -> String {
    let mut h = Md5Hasher::new();
    h.update(bytes);
    h.finalize_hex()
}

fn md5_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn file_md5(path: &Path) -> Result<String> {
    let meta = fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let key = format!("{}:{}:{}", path.display(), meta.len(), mtime_ms);

    if let Ok(cache) = md5_cache().lock() {
        if let Some(cached) = cache.get(&key) {
            return Ok(cached.clone());
        }
    }

    let mut f = File::open(path)?;
    let mut hasher = Md5Hasher::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize_hex();

    if let Ok(mut cache) = md5_cache().lock() {
        if cache.len() > 500 {
            cache.clear();
        }
        cache.insert(key, digest.clone());
    }
    Ok(digest)
}

pub fn media_kind(file_name: &str) -> Option<&'static str> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())?;
    match ext.as_str() {
        "mp4" | "webm" | "mov" | "m4v" => Some("video"),
        "webp" | "png" | "jpg" | "jpeg" | "gif" | "svg" | "bmp" => Some("image"),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" => Some("audio"),
        _ => None,
    }
}

pub fn mime_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

pub fn strip_timestamp_prefix(name: &str) -> String {
    if let Some((prefix, rest)) = name.split_once('_') {
        if prefix.len() >= 10 && prefix.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty() {
            return rest.to_string();
        }
    }
    name.to_string()
}

pub fn percent_encode_component(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0F) as usize] as char);
        }
    }
    out
}

fn percent_decode_inner(s: &str, plus_as_space: bool) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        } else if plus_as_space && bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Decodes RFC 3986 percent-encoding in URL path segments (preserves literal `+`).
pub fn percent_decode_path(s: &str) -> String {
    percent_decode_inner(s, false)
}

/// Decodes `application/x-www-form-urlencoded` query values (`+` -> space).
pub fn percent_decode_query(s: &str) -> String {
    percent_decode_inner(s, true)
}

pub fn percent_decode(s: &str) -> String {
    percent_decode_query(s)
}

pub fn normalize_user_media_filename(url_or_name: &str) -> String {
    let mut s = url_or_name.trim();
    if s.is_empty() {
        return String::new();
    }
    if let Some(pos) = s.find("user_media/") {
        s = &s[pos + "user_media/".len()..];
    }
    if let Some(q) = s.find(['?', '#']) {
        s = &s[..q];
    }
    let decoded = percent_decode_path(s);
    let base = Path::new(&decoded)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if base.is_empty() || base == "." || base == ".." || base == ".gitkeep" {
        String::new()
    } else {
        base.to_string()
    }
}

pub fn scan_user_media(paths: &AppPaths) -> MediaLibrary {
    let mut videos = Vec::new();
    let mut images = Vec::new();
    let mut audios = Vec::new();

    if !paths.user_media_dir.is_dir() {
        return MediaLibrary {
            videos,
            images,
            audios,
        };
    }

    let cfg = read_config(&paths.config_json);
    let active_vid = cfg
        .get("activeVideo")
        .and_then(Value::as_str)
        .map(normalize_user_media_filename)
        .unwrap_or_default();
    let active_img = cfg
        .get("activeImage")
        .and_then(Value::as_str)
        .map(normalize_user_media_filename)
        .unwrap_or_default();
    let active_aud = cfg
        .get("activeAudio")
        .and_then(Value::as_str)
        .map(normalize_user_media_filename)
        .unwrap_or_default();
    let active_boot_aud = cfg
        .get("bootAudio")
        .and_then(Value::as_str)
        .map(normalize_user_media_filename)
        .unwrap_or_default();

    let Ok(entries) = fs::read_dir(&paths.user_media_dir) else {
        return MediaLibrary {
            videos,
            images,
            audios,
        };
    };

    let mut by_hash: HashMap<String, (MediaItem, bool)> = HashMap::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if file_name == ".gitkeep" || file_name.starts_with(".upload_") {
            continue;
        }
        let Some(kind) = media_kind(&file_name) else {
            continue;
        };
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let Ok(md5) = file_md5(&path) else {
            continue;
        };
        let added_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let item = MediaItem {
            name: strip_timestamp_prefix(&file_name),
            url: format!("user_media/{}", percent_encode_component(&file_name)),
            file_name: file_name.clone(),
            kind: kind.to_string(),
            size: meta.len(),
            added_at,
        };
        let is_active = file_name == active_vid
            || file_name == active_img
            || file_name == active_aud
            || file_name == active_boot_aud;

        match by_hash.get(&md5) {
            None => {
                by_hash.insert(md5, (item, is_active));
            }
            Some((_, existing_active)) if is_active && !*existing_active => {
                by_hash.insert(md5, (item, true));
            }
            Some((existing_item, existing_active))
                if !*existing_active && item.added_at > existing_item.added_at =>
            {
                by_hash.insert(md5, (item, false));
            }
            _ => {}
        }
    }

    for (item, _) in by_hash.into_values() {
        match item.kind.as_str() {
            "video" => videos.push(item),
            "image" => images.push(item),
            _ => audios.push(item),
        }
    }

    videos.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    images.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    audios.sort_by(|a, b| b.added_at.cmp(&a.added_at));

    MediaLibrary {
        videos,
        images,
        audios,
    }
}

pub fn resolve_local_media_as_data_uri(
    paths: &AppPaths,
    rel_path: &str,
    max_bytes: u64,
) -> String {
    let s = rel_path.trim();
    if s.is_empty()
        || s.starts_with("data:")
        || s.starts_with("http://")
        || s.starts_with("https://")
        || s.starts_with("blob:")
    {
        return String::new();
    }
    let (base_dir, rel) = if let Some(r) = s.strip_prefix("user_media/") {
        (&paths.user_media_dir, percent_decode_path(r))
    } else if let Some(r) = s.strip_prefix("assets/") {
        (&paths.assets_dir, percent_decode_path(r))
    } else {
        return String::new();
    };

    let Some(full_path) = safe_join(base_dir, &rel) else {
        return String::new();
    };
    let Ok(meta) = fs::metadata(&full_path) else {
        return String::new();
    };
    if !meta.is_file() || meta.len() == 0 || meta.len() > max_bytes {
        return String::new();
    }
    let Ok(bytes) = fs::read(&full_path) else {
        return String::new();
    };
    let mime = mime_type(&full_path);
    format!("data:{mime};base64,{}", BASE64.encode(&bytes))
}

pub fn cleanup_orphan_temp_uploads(user_media_dir: &Path) {
    let Ok(entries) = fs::read_dir(user_media_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".upload_") && name.ends_with(".tmp") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn safe_join(base_dir: &Path, rel: &str) -> Option<PathBuf> {
    let clean_rel = rel.trim_start_matches(['/', '\\']);
    if clean_rel.is_empty() || clean_rel.contains('\0') {
        return None;
    }
    let mut candidate = base_dir.to_path_buf();
    let mut has_component = false;
    for comp in Path::new(clean_rel).components() {
        match comp {
            Component::Normal(part) => {
                // On Windows, also guard against drive-colon syntax in a single segment.
                if part.to_string_lossy().contains(':') {
                    return None;
                }
                candidate.push(part);
                has_component = true;
            }
            Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir => {
                return None;
            }
        }
    }
    if !has_component {
        return None;
    }
    Some(candidate)
}

fn send_json(stream: &mut TcpStream, status: u16, status_text: &str, body_val: &Value) {
    let body = body_val.to_string();
    let hdr = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Range\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(hdr.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn parse_query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(percent_decode_query(v));
        }
    }
    None
}

fn sanitize_filename(raw: &str) -> String {
    let base = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    base.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn serve_static_with_range(
    stream: &mut TcpStream,
    file_path: &Path,
    range_hdr: Option<&str>,
    head_only: bool,
) {
    let Ok(meta) = fs::metadata(file_path) else {
        let _ = stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot found",
        );
        return;
    };
    if !meta.is_file() {
        let _ = stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot found",
        );
        return;
    }

    let size = meta.len();
    let content_type = mime_type(file_path);

    let (status_line, start, end, extra_content_range) = if let Some(r_str) = range_hdr {
        if size == 0 {
            let hdr = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */0\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(hdr.as_bytes());
            return;
        }
        let Some(spec_all) = r_str.trim().strip_prefix("bytes=") else {
            let hdr = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(hdr.as_bytes());
            return;
        };
        let spec = spec_all.split(',').next().unwrap_or("").trim();
        let Some((s_raw, e_raw)) = spec.split_once('-') else {
            let hdr = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(hdr.as_bytes());
            return;
        };
        let s_part = s_raw.trim();
        let e_part = e_raw.trim();

        let parsed_range: Option<(u64, u64)> = if s_part.is_empty() && !e_part.is_empty() {
            e_part.parse::<u64>().ok().filter(|&v| v > 0).map(|suffix| {
                let st = size.saturating_sub(suffix);
                (st, size - 1)
            })
        } else if !s_part.is_empty() {
            s_part.parse::<u64>().ok().and_then(|st| {
                let en = if e_part.is_empty() {
                    size - 1
                } else {
                    e_part.parse::<u64>().ok()?.min(size - 1)
                };
                if st <= en && st < size {
                    Some((st, en))
                } else {
                    None
                }
            })
        } else {
            None
        };

        let Some((st, en)) = parsed_range else {
            let hdr = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(hdr.as_bytes());
            return;
        };
        (
            "HTTP/1.1 206 Partial Content",
            st,
            en,
            Some(format!("Content-Range: bytes {st}-{en}/{size}\r\n")),
        )
    } else {
        if size == 0 {
            let hdr = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: 0\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(hdr.as_bytes());
            return;
        }
        ("HTTP/1.1 200 OK", 0, size - 1, None)
    };

    let Ok(mut file) = File::open(file_path) else {
        return;
    };
    if start > 0 && file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }

    let len = end - start + 1;
    let mut hdr = format!(
        "{status_line}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\nCache-Control: public, max-age=3600\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n"
    );
    if let Some(cr) = extra_content_range {
        hdr.push_str(&cr);
    }
    hdr.push_str("\r\n");

    if stream.write_all(hdr.as_bytes()).is_err() || head_only {
        return;
    }

    let mut remaining = len;
    let mut buf = [0u8; 8192];
    while remaining > 0 {
        let to_read = (remaining as usize).min(buf.len());
        match file.read(&mut buf[..to_read]) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).is_err() {
                    break;
                }
                remaining -= n as u64;
            }
        }
    }
}

fn handle_http_connection(mut stream: TcpStream, paths: &AppPaths) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_nodelay(true);

    let mut raw = Vec::with_capacity(2048);
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        match stream.read(&mut tmp) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                raw.extend_from_slice(&tmp[..n]);
                if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos;
                }
                if raw.len() > 32 * 1024 {
                    return;
                }
            }
        }
    };

    let header_text = String::from_utf8_lossy(&raw[..header_end]).into_owned();
    let mut lines = header_text.lines();
    let req_line = lines.next().unwrap_or("");
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let full_target = parts.next().unwrap_or("/");

    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Range\r\nAccess-Control-Allow-Private-Network: true\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    let mut content_length: Option<usize> = None;
    let mut is_chunked = false;
    let mut range_header: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let k_trim = k.trim();
            if k_trim.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().ok();
            } else if k_trim.eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
            {
                is_chunked = true;
            } else if k_trim.eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    let (raw_path, query) = full_target.split_once('?').unwrap_or((full_target, ""));
    let pathname = percent_decode_path(raw_path);
    let leftover = &raw[header_end + 4..];

    if method == "GET" && pathname == "/api/media" {
        let lib = scan_user_media(paths);
        send_json(
            &mut stream,
            200,
            "OK",
            &json!({
                "ok": true,
                "videos": lib.videos,
                "images": lib.images,
                "audios": lib.audios,
            }),
        );
        return;
    }

    if method == "POST" && pathname == "/api/claim-sound" {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut allowed = false;
        let mut prev = LAST_GLOBAL_TASK_SOUND_MS.load(Ordering::Acquire);
        loop {
            if now_ms.saturating_sub(prev) < 3000 {
                break;
            }
            match LAST_GLOBAL_TASK_SOUND_MS.compare_exchange_weak(
                prev,
                now_ms,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    allowed = true;
                    break;
                }
                Err(actual) => prev = actual,
            }
        }
        send_json(
            &mut stream,
            200,
            "OK",
            &json!({ "ok": true, "allowed": allowed }),
        );
        return;
    }

    if method == "POST" && pathname == "/upload" {
        let raw_name = parse_query_param(query, "name").unwrap_or_default();
        let safe_name = sanitize_filename(&raw_name);
        let Some(kind) = media_kind(&safe_name) else {
            send_json(
                &mut stream,
                400,
                "Bad Request",
                &json!({
                    "ok": false,
                    "error": "Định dạng tệp không được hỗ trợ (chỉ nhận Video, Ảnh hoặc Âm thanh)."
                }),
            );
            return;
        };

        let expected_len = content_length.unwrap_or(0);
        if expected_len > MAX_UPLOAD_BYTES {
            send_json(
                &mut stream,
                413,
                "Payload Too Large",
                &json!({ "ok": false, "error": "Tệp vượt quá giới hạn 150MB" }),
            );
            return;
        }
        if !is_chunked && content_length.is_some() && expected_len == 0 {
            send_json(
                &mut stream,
                400,
                "Bad Request",
                &json!({ "ok": false, "error": "Tệp tải lên rỗng (0 bytes)." }),
            );
            return;
        }

        let _ = fs::create_dir_all(&paths.user_media_dir);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let tmp_name = format!(".upload_{now_ms}_{:08x}.tmp", next_u64() as u32);
        let tmp_path = paths.user_media_dir.join(tmp_name);

        let Ok(mut out_file) = File::create(&tmp_path) else {
            send_json(
                &mut stream,
                500,
                "Internal Server Error",
                &json!({ "ok": false, "error": "Failed creating upload temp file" }),
            );
            return;
        };

        let mut hasher = Md5Hasher::new();
        let mut total_written = 0usize;

        if is_chunked {
            let mut chunk_buf = leftover.to_vec();
            let mut net_buf = [0u8; 8192];
            let mut eof_reached = false;
            loop {
                let crlf = loop {
                    if let Some(p) = chunk_buf.windows(2).position(|w| w == b"\r\n") {
                        break p;
                    }
                    if chunk_buf.len() > 64 * 1024 {
                        drop(out_file);
                        let _ = fs::remove_file(&tmp_path);
                        return;
                    }
                    match stream.read(&mut net_buf) {
                        Ok(0) | Err(_) => {
                            eof_reached = true;
                            break 0;
                        }
                        Ok(n) => chunk_buf.extend_from_slice(&net_buf[..n]),
                    }
                };
                if eof_reached {
                    drop(out_file);
                    let _ = fs::remove_file(&tmp_path);
                    return;
                }
                let size_hex = String::from_utf8_lossy(&chunk_buf[..crlf])
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let Ok(mut chunk_rem) = usize::from_str_radix(&size_hex, 16) else {
                    drop(out_file);
                    let _ = fs::remove_file(&tmp_path);
                    return;
                };
                chunk_buf.drain(..crlf + 2);
                if chunk_rem == 0 {
                    break;
                }
                while chunk_rem > 0 {
                    if chunk_buf.is_empty() {
                        match stream.read(&mut net_buf) {
                            Ok(0) | Err(_) => {
                                drop(out_file);
                                let _ = fs::remove_file(&tmp_path);
                                return;
                            }
                            Ok(n) => chunk_buf.extend_from_slice(&net_buf[..n]),
                        }
                    }
                    let take = chunk_buf.len().min(chunk_rem);
                    total_written += take;
                    if total_written > MAX_UPLOAD_BYTES {
                        drop(out_file);
                        let _ = fs::remove_file(&tmp_path);
                        send_json(
                            &mut stream,
                            413,
                            "Payload Too Large",
                            &json!({ "ok": false, "error": "Tệp vượt quá giới hạn 150MB" }),
                        );
                        return;
                    }
                    if out_file.write_all(&chunk_buf[..take]).is_err() {
                        drop(out_file);
                        let _ = fs::remove_file(&tmp_path);
                        return;
                    }
                    hasher.update(&chunk_buf[..take]);
                    chunk_buf.drain(..take);
                    chunk_rem -= take;
                }
                // Consume trailing CRLF after chunk payload
                while chunk_buf.len() < 2 {
                    match stream.read(&mut net_buf) {
                        Ok(0) | Err(_) => {
                            drop(out_file);
                            let _ = fs::remove_file(&tmp_path);
                            return;
                        }
                        Ok(n) => chunk_buf.extend_from_slice(&net_buf[..n]),
                    }
                }
                chunk_buf.drain(..2);
            }
        } else {
            if !leftover.is_empty() {
                let take = match content_length {
                    Some(cl) => leftover.len().min(cl),
                    None => leftover.len(),
                };
                if take > 0 {
                    if take > MAX_UPLOAD_BYTES {
                        drop(out_file);
                        let _ = fs::remove_file(&tmp_path);
                        send_json(
                            &mut stream,
                            413,
                            "Payload Too Large",
                            &json!({ "ok": false, "error": "Tệp vượt quá giới hạn 150MB" }),
                        );
                        return;
                    }
                    if out_file.write_all(&leftover[..take]).is_err() {
                        drop(out_file);
                        let _ = fs::remove_file(&tmp_path);
                        return;
                    }
                    hasher.update(&leftover[..take]);
                    total_written += take;
                }
            }

            let mut buf = [0u8; 8192];
            while total_written < expected_len {
                let to_read = (expected_len - total_written).min(buf.len());
                match stream.read(&mut buf[..to_read]) {
                    Ok(0) | Err(_) => {
                        drop(out_file);
                        let _ = fs::remove_file(&tmp_path);
                        return;
                    }
                    Ok(n) => {
                        total_written += n;
                        if total_written > MAX_UPLOAD_BYTES {
                            drop(out_file);
                            let _ = fs::remove_file(&tmp_path);
                            send_json(
                                &mut stream,
                                413,
                                "Payload Too Large",
                                &json!({ "ok": false, "error": "Tệp vượt quá giới hạn 150MB" }),
                            );
                            return;
                        }
                        if out_file.write_all(&buf[..n]).is_err() {
                            drop(out_file);
                            let _ = fs::remove_file(&tmp_path);
                            return;
                        }
                        hasher.update(&buf[..n]);
                    }
                }
            }
        }
        let _ = out_file.flush();
        drop(out_file);

        if total_written == 0 {
            let _ = fs::remove_file(&tmp_path);
            send_json(
                &mut stream,
                400,
                "Bad Request",
                &json!({ "ok": false, "error": "Tệp tải lên rỗng (0 bytes)." }),
            );
            return;
        }

        let upload_md5 = hasher.finalize_hex();

        // Check MD5 duplicate against existing user_media files
        if let Ok(entries) = fs::read_dir(&paths.user_media_dir) {
            for entry in entries.flatten() {
                let e_name = entry.file_name().to_string_lossy().into_owned();
                if e_name == ".gitkeep" || e_name.starts_with(".upload_") {
                    continue;
                }
                let e_path = entry.path();
                if let Ok(meta) = fs::metadata(&e_path) {
                    if meta.is_file()
                        && meta.len() == total_written as u64
                        && file_md5(&e_path).ok().as_deref() == Some(upload_md5.as_str())
                    {
                        let _ = fs::remove_file(&tmp_path);
                        let existing_kind = media_kind(&e_name).unwrap_or(kind);
                        send_json(
                            &mut stream,
                            200,
                            "OK",
                            &json!({
                                "ok": true,
                                "duplicate": true,
                                "fileName": e_name,
                                "name": strip_timestamp_prefix(&e_name),
                                "url": format!("user_media/{}", percent_encode_component(&e_name)),
                                "kind": existing_kind,
                            }),
                        );
                        trim_working_set();
                        return;
                    }
                }
            }
        }

        let mut final_name = format!("{now_ms}_{safe_name}");
        let mut final_path = paths.user_media_dir.join(&final_name);
        if final_path.exists() {
            final_name = format!("{now_ms}_{:04x}_{safe_name}", (next_u64() & 0xFFFF) as u16);
            final_path = paths.user_media_dir.join(&final_name);
        }
        if fs::rename(&tmp_path, &final_path).is_err() {
            let copied = fs::copy(&tmp_path, &final_path).is_ok();
            let _ = fs::remove_file(&tmp_path);
            if !copied {
                send_json(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    &json!({ "ok": false, "error": "Failed saving uploaded media" }),
                );
                return;
            }
        }

        send_json(
            &mut stream,
            200,
            "OK",
            &json!({
                "ok": true,
                "duplicate": false,
                "fileName": final_name,
                "name": strip_timestamp_prefix(&final_name),
                "url": format!("user_media/{}", percent_encode_component(&final_name)),
                "kind": kind,
            }),
        );
        trim_working_set();
        return;
    }

    if method == "POST" && pathname == "/api/delete" {
        let del_len = content_length.unwrap_or(0);
        if del_len > MAX_DELETE_JSON_BYTES {
            send_json(
                &mut stream,
                413,
                "Payload Too Large",
                &json!({ "ok": false, "error": "Payload too large" }),
            );
            return;
        }
        let mut body = Vec::with_capacity(del_len);
        let take = leftover.len().min(del_len);
        body.extend_from_slice(&leftover[..take]);
        if body.len() < del_len {
            let cur = body.len();
            body.resize(del_len, 0);
            if stream.read_exact(&mut body[cur..]).is_err() {
                return;
            }
        }

        let mut target_input = parse_query_param(query, "name").unwrap_or_default();
        if target_input.is_empty() && !body.is_empty() {
            if let Ok(val) = serde_json::from_slice::<Value>(&body) {
                target_input = val
                    .get("url")
                    .or_else(|| val.get("fileName"))
                    .or_else(|| val.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
        }

        let file_name = normalize_user_media_filename(&target_input);
        if file_name.is_empty() {
            send_json(
                &mut stream,
                400,
                "Bad Request",
                &json!({ "ok": false, "error": "Invalid media target" }),
            );
            return;
        }

        let Some(resolved) = safe_join(&paths.user_media_dir, &file_name) else {
            send_json(
                &mut stream,
                403,
                "Forbidden",
                &json!({ "ok": false, "error": "Forbidden path" }),
            );
            return;
        };

        let mut deleted_files = Vec::new();
        if resolved.is_file() {
            let target_len = fs::metadata(&resolved).map(|m| m.len()).unwrap_or(0);
            let target_md5 = file_md5(&resolved).ok();
            if let Ok(entries) = fs::read_dir(&paths.user_media_dir) {
                for entry in entries.flatten() {
                    let c_name = entry.file_name().to_string_lossy().into_owned();
                    if c_name == ".gitkeep" {
                        continue;
                    }
                    let c_path = entry.path();
                    if let Ok(c_meta) = fs::metadata(&c_path) {
                        if c_meta.is_file() {
                            let same_hash = target_md5.is_some()
                                && c_meta.len() == target_len
                                && file_md5(&c_path).ok() == target_md5;
                            if c_path == resolved || same_hash {
                                if fs::remove_file(&c_path).is_ok() {
                                    deleted_files.push(c_name);
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut deleted_set: HashSet<String> = deleted_files.iter().cloned().collect();
        deleted_set.insert(file_name);

        let cfg = read_config(&paths.config_json);
        let mut patch = Map::new();
        if let Some(v) = cfg.get("activeVideo").and_then(Value::as_str) {
            if deleted_set.contains(&normalize_user_media_filename(v)) {
                patch.insert("activeVideo".into(), json!("assets/wallpaper.mp4"));
            }
        }
        if let Some(v) = cfg.get("activeImage").and_then(Value::as_str) {
            if deleted_set.contains(&normalize_user_media_filename(v)) {
                patch.insert("activeImage".into(), json!(""));
                if cfg.get("mode").and_then(Value::as_str) == Some("image") {
                    patch.insert("mode".into(), json!("gradient"));
                }
            }
        }
        if let Some(v) = cfg.get("activeAudio").and_then(Value::as_str) {
            if deleted_set.contains(&normalize_user_media_filename(v)) {
                patch.insert("activeAudio".into(), json!(""));
            }
        }
        if let Some(v) = cfg.get("bootAudio").and_then(Value::as_str) {
            if deleted_set.contains(&normalize_user_media_filename(v)) {
                patch.insert("bootAudio".into(), json!(""));
            }
        }
        if !patch.is_empty() {
            let _ = save_config_merge(&paths.config_json, &patch);
        }

        let lib = scan_user_media(paths);
        send_json(
            &mut stream,
            200,
            "OK",
            &json!({
                "ok": true,
                "deleted": deleted_files,
                "media": lib,
            }),
        );
        return;
    }

    if method == "GET" || method == "HEAD" {
        let head_only = method == "HEAD";
        if let Some(rel) = pathname.strip_prefix("/assets/") {
            if let Some(full) = safe_join(&paths.assets_dir, rel) {
                serve_static_with_range(&mut stream, &full, range_header.as_deref(), head_only);
                return;
            }
        } else if let Some(rel) = pathname.strip_prefix("/user_media/") {
            if let Some(full) = safe_join(&paths.user_media_dir, rel) {
                serve_static_with_range(&mut stream, &full, range_header.as_deref(), head_only);
                return;
            }
        }
    }

    let _ = stream.write_all(
        b"HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot found",
    );
}

/// Starts the background HTTP Media Server on `127.0.0.1:0` and returns the bound port.
pub fn start_media_server(paths: Arc<AppPaths>, shutdown: &'static AtomicBool) -> Result<u16> {
    cleanup_orphan_temp_uploads(&paths.user_media_dir);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let _ = listener.set_nonblocking(true);

    let _ = thread::Builder::new()
        .name("ats-media".into())
        .stack_size(512 * 1024)
        .spawn(move || {
            while !shutdown.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let paths_clone = Arc::clone(&paths);
                        let _ = thread::Builder::new()
                            .name("ats-http".into())
                            .stack_size(512 * 1024)
                            .spawn(move || {
                                handle_http_connection(stream, &paths_clone);
                            });
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(40));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        });

    Ok(port)
}
