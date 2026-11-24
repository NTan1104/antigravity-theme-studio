use ats_theme::builder::{
    build_bundle, list_presets, percent_encode_svg, BuildOptions, DEFAULT_MAX_DIM,
};
use ats_theme::cdp::{evaluate_once, fetch_targets, filter_antigravity_pages, CdpTarget};
use ats_theme::config::{read_config, save_config_merge};
use ats_theme::media::{md5_hex, percent_decode_path, percent_decode_query, start_media_server};
use ats_theme::paths::AppPaths;
use ats_theme::ws::compute_accept_key;
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn mock_ws_accept(stream: &mut TcpStream) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 512];
    loop {
        let n = stream.read(&mut tmp).unwrap();
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let req = String::from_utf8_lossy(&buf);
    let key = req
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("sec-websocket-key") {
                Some(v.trim().to_string())
            } else {
                None
            }
        })
        .expect("Sec-WebSocket-Key header");
    let accept = compute_accept_key(&key);
    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(resp.as_bytes()).unwrap();
}

fn mock_ws_read_client_text(stream: &mut TcpStream) -> String {
    let mut hdr = [0u8; 2];
    stream.read_exact(&mut hdr).unwrap();
    let masked = (hdr[1] & 0x80) != 0;
    assert!(masked, "client frames must be masked per RFC 6455");
    let len7 = (hdr[1] & 0x7F) as usize;
    let len = match len7 {
        0..=125 => len7,
        126 => {
            let mut b = [0u8; 2];
            stream.read_exact(&mut b).unwrap();
            u16::from_be_bytes(b) as usize
        }
        127 => {
            let mut b = [0u8; 8];
            stream.read_exact(&mut b).unwrap();
            u64::from_be_bytes(b) as usize
        }
        _ => unreachable!(),
    };
    let mut mask = [0u8; 4];
    stream.read_exact(&mut mask).unwrap();
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).unwrap();
    for (i, b) in payload.iter_mut().enumerate() {
        *b ^= mask[i & 3];
    }
    String::from_utf8(payload).unwrap()
}

fn mock_ws_send_server_text(stream: &mut TcpStream, text: &str) {
    let bytes = text.as_bytes();
    let mut hdr = Vec::with_capacity(10);
    hdr.push(0x81);
    if bytes.len() <= 125 {
        hdr.push(bytes.len() as u8);
    } else if bytes.len() <= 65_535 {
        hdr.push(126);
        hdr.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    } else {
        hdr.push(127);
        hdr.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
    }
    stream.write_all(&hdr).unwrap();
    stream.write_all(bytes).unwrap();
}

#[test]
fn test_rfc6455_accept_key_vector() {
    assert_eq!(
        compute_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
}

#[test]
fn test_rfc1321_md5_vectors() {
    assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
    assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(
        md5_hex(b"The quick brown fox jumps over the lazy dog"),
        "9e107d9d372bb6826bd81d3542a419d6"
    );
}

#[test]
fn test_svg_percent_encoding_matches_browser_data_uri() {
    let encoded = percent_encode_svg("<svg viewBox=\"0 0 10 10\"></svg>");
    assert!(encoded.starts_with(
        "data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2010%2010%22%3E%3C/svg%3E"
    ));
}

#[test]
fn test_build_bundle_and_list_presets() {
    let root = repo_root();
    let out_path = std::env::temp_dir().join(format!(
        "ats_theme_test_bundle_{}.js",
        std::process::id()
    ));
    let _ = fs::remove_file(&out_path);

    let report = build_bundle(&BuildOptions {
        presets_path: root.join("themes").join("presets.json"),
        css_path: root.join("runtime").join("style.css"),
        engine_path: root.join("runtime").join("engine.js"),
        out_path: out_path.clone(),
        max_dim: DEFAULT_MAX_DIM,
    })
    .expect("build_bundle should succeed");

    assert_eq!(
        report.preset_names.first().map(String::as_str),
        Some("Dark Glass Live")
    );
    assert!(report.preset_names.len() >= 4);

    let compiled = fs::read_to_string(&out_path).expect("compiled bundle readable");
    assert!(!compiled.contains("/* __ATS_PRESETS__ */ {}"));
    assert!(!compiled.contains("/* __ATS_CSS__ */ ''"));
    assert!(compiled.contains("Frost Light"));
    assert!(compiled.contains("toShortBlobUrl"));
    assert!(compiled.contains("ats-metrics-style"));

    let presets = list_presets(&root.join("themes").join("presets.json")).unwrap();
    assert_eq!(presets[0].name, "Dark Glass Live");
    assert!(presets[0].has_video);
    assert!(presets.iter().any(|p| p.name == "Frost Light" && p.is_light));

    let _ = fs::remove_file(&out_path);
}

#[test]
fn test_config_atomic_merge_roundtrip() {
    let cfg_path = std::env::temp_dir().join(format!(
        "ats_theme_test_cfg_{}.json",
        std::process::id()
    ));
    let _ = fs::remove_file(&cfg_path);

    let mut first = Map::new();
    first.insert("preset".into(), json!("Dark Glass Live"));
    first.insert("dimOpacity".into(), json!(0.45));
    save_config_merge(&cfg_path, &first).expect("save first");

    let mut second = Map::new();
    second.insert("glassBlur".into(), json!(6));
    let merged = save_config_merge(&cfg_path, &second).expect("save merge");
    assert_eq!(merged.get("preset"), Some(&json!("Dark Glass Live")));
    assert_eq!(merged.get("dimOpacity"), Some(&json!(0.45)));
    assert_eq!(merged.get("glassBlur"), Some(&json!(6)));

    let loaded = read_config(&cfg_path);
    assert_eq!(loaded, merged);
    let _ = fs::remove_file(&cfg_path);
}

#[test]
fn test_filter_antigravity_and_ide_targets() {
    let targets = vec![
        CdpTarget {
            id: "1".into(),
            target_type: "page".into(),
            title: "Antigravity".into(),
            url: "https://127.0.0.1:61534/workbench".into(),
            web_socket_debugger_url: "ws://127.0.0.1:9222/devtools/page/1".into(),
        },
        CdpTarget {
            id: "2".into(),
            target_type: "page".into(),
            title: "DevTools".into(),
            url: "devtools://devtools/bundled/inspector.html".into(),
            web_socket_debugger_url: "ws://127.0.0.1:9222/devtools/page/2".into(),
        },
        CdpTarget {
            id: "3".into(),
            target_type: "page".into(),
            title: "Antigravity IDE".into(),
            url: "vscode-file://vscode-app/c:/Program%20Files/Antigravity%20IDE/workbench.html"
                .into(),
            web_socket_debugger_url: "ws://127.0.0.1:9223/devtools/page/3".into(),
        },
        CdpTarget {
            id: "4".into(),
            target_type: "iframe".into(),
            title: "Extension View".into(),
            url: "https://127.0.0.1:51234/?extensionView=true&workspaceUri=file:///d:/Projects"
                .into(),
            web_socket_debugger_url: "ws://127.0.0.1:9223/devtools/page/4".into(),
        },
        CdpTarget {
            id: "5".into(),
            target_type: "page".into(),
            title: "User Local Dev Server".into(),
            url: "http://127.0.0.1:3000/".into(),
            web_socket_debugger_url: "ws://127.0.0.1:9222/devtools/page/5".into(),
        },
    ];
    let filtered = filter_antigravity_pages(targets);
    assert_eq!(filtered.len(), 3);
    assert_eq!(filtered[0].id, "1");
    assert_eq!(filtered[1].id, "3");
    assert_eq!(filtered[2].id, "4");
}

#[test]
fn test_mock_cdp_http_and_websocket_evaluate() {
    let http_listener = TcpListener::bind("127.0.0.1:0").expect("bind mock http");
    let http_port = http_listener.local_addr().unwrap().port();

    let ws_listener = TcpListener::bind("127.0.0.1:0").expect("bind mock ws");
    let ws_port = ws_listener.local_addr().unwrap().port();
    let ws_url = format!("ws://127.0.0.1:{ws_port}/devtools/page/MOCK1");
    let ws_url_for_http = ws_url.clone();

    let http_handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = http_listener.accept() {
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let body = json!([{
                "id": "MOCK1",
                "type": "page",
                "title": "Antigravity Mock",
                "url": "https://127.0.0.1:9999/launchpad",
                "webSocketDebuggerUrl": ws_url_for_http
            }])
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            thread::sleep(Duration::from_millis(400));
        }
    });

    let ws_handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = ws_listener.accept() {
            mock_ws_accept(&mut stream);
            let txt = mock_ws_read_client_text(&mut stream);
            let req: Value = serde_json::from_str(&txt).unwrap();
            let id = req["id"].as_u64().unwrap();
            let reply = json!({
                "id": id,
                "result": {
                    "result": {
                        "type": "object",
                        "value": { "themeActive": true, "hasLiveBlurRule": false }
                    }
                }
            });
            mock_ws_send_server_text(&mut stream, &reply.to_string());
        }
    });

    let targets = fetch_targets(http_port, Duration::from_secs(2)).expect("fetch_targets");
    let pages = filter_antigravity_pages(targets);
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].web_socket_debugger_url, ws_url);

    let val = evaluate_once(&ws_url, "1+1", true, true, Duration::from_secs(2))
        .expect("evaluate_once");
    assert_eq!(val["themeActive"], json!(true));
    assert_eq!(val["hasLiveBlurRule"], json!(false));

    let _ = http_handle.join();
    let _ = ws_handle.join();
}

#[test]
fn test_media_server_range_206_and_claim_sound() {
    static TEST_SHUTDOWN: AtomicBool = AtomicBool::new(false);
    let paths = Arc::new(AppPaths::discover(Some(&repo_root())));
    let port = start_media_server(paths, &TEST_SHUTDOWN).expect("start media server");

    // 1. Test /api/media GET
    let mut s1 = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s1.write_all(
        format!("GET /api/media HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .unwrap();
    let mut resp1 = String::new();
    s1.read_to_string(&mut resp1).unwrap();
    assert!(resp1.starts_with("HTTP/1.1 200 OK"));
    assert!(resp1.contains("\"ok\":true"));

    // 2. Test HTTP Range 206 on /assets/wallpaper.mp4
    let mut s2 = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s2.write_all(
        format!(
            "GET /assets/wallpaper.mp4 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nRange: bytes=0-15\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    )
    .unwrap();
    let mut resp2 = Vec::new();
    s2.read_to_end(&mut resp2).unwrap();
    let hdr_pos = resp2.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let hdr_str = String::from_utf8_lossy(&resp2[..hdr_pos]);
    assert!(hdr_str.starts_with("HTTP/1.1 206 Partial Content"));
    assert!(hdr_str.contains("Content-Length: 16"));
    let body2 = &resp2[hdr_pos + 4..];
    assert_eq!(body2.len(), 16);

    // 3. Test HEAD request returns 200 headers with empty body
    let mut s3 = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s3.write_all(
        format!("HEAD /assets/wallpaper.mp4 HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .unwrap();
    let mut resp3 = Vec::new();
    s3.read_to_end(&mut resp3).unwrap();
    let hdr3_pos = resp3.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let hdr3_str = String::from_utf8_lossy(&resp3[..hdr3_pos]);
    assert!(hdr3_str.starts_with("HTTP/1.1 200 OK"));
    assert_eq!(resp3.len(), hdr3_pos + 4, "HEAD must not include body");

    // 4. Test path traversal & Windows drive-letter blocking
    for bad_path in [
        "/assets/../presets.json",
        "/assets/C:/Windows/win.ini",
        "/user_media/..%2Fpresets.json",
    ] {
        let mut s_bad = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s_bad
            .write_all(
                format!("GET {bad_path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap();
        let mut resp_bad = String::new();
        s_bad.read_to_string(&mut resp_bad).unwrap();
        assert!(
            resp_bad.starts_with("HTTP/1.1 404"),
            "Traversal path {bad_path} must be rejected with 404, got: {resp_bad}"
        );
    }

    // 5. Test atomic /api/claim-sound under concurrent requests (only 1 allowed in 3s window)
    let handles: Vec<_> = (0..6)
        .map(|_| {
            thread::spawn(move || {
                let mut sc = TcpStream::connect(("127.0.0.1", port)).unwrap();
                sc.write_all(
                    format!("POST /api/claim-sound HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .unwrap();
                let mut r = String::new();
                sc.read_to_string(&mut r).unwrap();
                r.contains("\"allowed\":true")
            })
        })
        .collect();
    let allowed_count = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .filter(|&ok| ok)
        .count();
    assert_eq!(allowed_count, 1, "Only one concurrent claim-sound should win");

    TEST_SHUTDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[test]
fn test_percent_decode_path_vs_query_and_upload_delete_cycle() {
    assert_eq!(percent_decode_path("a+b%20c.png"), "a+b c.png");
    assert_eq!(percent_decode_query("a+b%20c"), "a b c");

    // Isolated temp root for upload/dedup/delete testing
    let tmp_root = std::env::temp_dir().join(format!(
        "ats_theme_media_test_{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp_root);
    fs::create_dir_all(tmp_root.join("themes").join("user_media")).unwrap();
    fs::create_dir_all(tmp_root.join("themes").join("assets")).unwrap();

    static TEST_SHUTDOWN_2: AtomicBool = AtomicBool::new(false);
    let paths = Arc::new(AppPaths::discover(Some(&tmp_root)));
    let port = start_media_server(Arc::clone(&paths), &TEST_SHUTDOWN_2).expect("start server");

    let send_raw = |req: &[u8]| -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(req).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    };

    // Reject empty 0-byte upload
    let empty_resp = send_raw(
        format!("POST /upload?name=empty.png HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    );
    assert!(empty_resp.starts_with("HTTP/1.1 400"));

    // Upload valid image payload
    let payload = b"\x89PNG\r\n\x1a\nFAKE_PNG_DATA_12345";
    let mut req = format!(
        "POST /upload?name=sample.png HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    )
    .into_bytes();
    req.extend_from_slice(payload);
    let up_resp = send_raw(&req);
    assert!(up_resp.starts_with("HTTP/1.1 200 OK"), "got: {up_resp}");
    let body_str = up_resp.split("\r\n\r\n").nth(1).unwrap();
    let up_json: Value = serde_json::from_str(body_str).unwrap();
    assert_eq!(up_json["ok"], json!(true));
    assert_eq!(up_json["duplicate"], json!(false));
    let file_name = up_json["fileName"].as_str().unwrap().to_string();

    // Duplicate MD5 upload should reuse existing file
    let dup_resp = send_raw(&req);
    let dup_json: Value = serde_json::from_str(dup_resp.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(dup_json["duplicate"], json!(true));
    assert_eq!(dup_json["fileName"], json!(file_name));

    // Delete uploaded file
    let del_body = json!({ "fileName": file_name }).to_string();
    let del_req = format!(
        "POST /api/delete HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        del_body.len(),
        del_body
    );
    let del_resp = send_raw(del_req.as_bytes());
    assert!(del_resp.starts_with("HTTP/1.1 200 OK"));
    let del_json: Value = serde_json::from_str(del_resp.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(del_json["ok"], json!(true));
    assert!(!paths.user_media_dir.join(&file_name).exists());

    TEST_SHUTDOWN_2.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = fs::remove_dir_all(&tmp_root);
}

#[test]
fn test_concurrent_config_save_merge_is_thread_safe() {
    let cfg_path = Arc::new(std::env::temp_dir().join(format!(
        "ats_theme_concurrent_cfg_{}.json",
        std::process::id()
    )));
    let _ = fs::remove_file(cfg_path.as_ref());

    let handles: Vec<_> = (0..8)
        .map(|i| {
            let p = Arc::clone(&cfg_path);
            thread::spawn(move || {
                let mut m = Map::new();
                m.insert(format!("k{i}"), json!(i));
                save_config_merge(&p, &m).expect("concurrent save");
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }

    let final_cfg = read_config(cfg_path.as_ref());
    for i in 0..8 {
        assert_eq!(final_cfg.get(&format!("k{i}")), Some(&json!(i)));
    }
    let _ = fs::remove_file(cfg_path.as_ref());
}
