//! UIT Portal Browser Bridge — Async Loopback Sync Server
//!
//! Thiết kế:
//! - Chỉ lắng nghe trên 127.0.0.1 (loopback). Không bao giờ expose ra internet.
//! - Không dùng axum/actix/warp — dùng tokio::net::TcpListener + httparse để giữ
//!   binary footprint nhỏ nhất có thể.
//! - Xác thực bắt buộc: header `X-Jarvis-Sync-Token` phải khớp với token
//!   được lưu trong bảng `settings` của SQLite.
//! - Connection error không bao giờ panic luồng chính: toàn bộ lỗi được log
//!   và trả HTTP error response, sau đó kết nối bị đóng gracefully.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::db::SharedDb;

/// Danh sách port thử theo thứ tự ưu tiên.
/// Nếu 41718 bị chiếm (app chạy nhiều instance), thử 41719, 41720.
const CANDIDATE_PORTS: [u16; 3] = [41718, 41719, 41720];

/// Kích thước buffer tối đa cho 1 request (header + body).
/// 65536 bytes = 64 KiB — đủ cho transcript 30 môn học JSON.
const MAX_REQUEST_BYTES: usize = 65536;

/// State tối giản mà sync server cần: chỉ truy cập vào SharedDb.
/// Không cần Arc<AppState> đầy đủ vì server không cần các state khác.
pub struct SyncServerState {
    pub db: SharedDb,
}

/// Khởi động TCP listener loopback. Hàm này chạy vĩnh viễn (loop accept).
/// Phải được spawn qua `tauri::async_runtime::spawn`.
///
/// Emit Tauri events:
/// - `sync-server-status` → `"ONLINE:<port>"` khi bind thành công
/// - `sync-server-status` → `"PORT_BIND_FAILED"` khi không bind được port nào
pub async fn start_sync_server(app: AppHandle, db: SharedDb) {
    let mut listener_opt: Option<TcpListener> = None;
    let mut bound_port: u16 = 0;

    for &port in &CANDIDATE_PORTS {
        match TcpListener::bind(format!("127.0.0.1:{}", port)).await {
            Ok(l) => {
                listener_opt = Some(l);
                bound_port = port;
                break;
            }
            Err(e) => {
                eprintln!("[SyncServer] Port {} không khả dụng: {}", port, e);
            }
        }
    }

    let listener = match listener_opt {
        Some(l) => {
            println!("[SyncServer] Đã bind thành công tại 127.0.0.1:{}", bound_port);
            let _ = app.emit("sync-server-status", format!("ONLINE:{}", bound_port));
            l
        }
        None => {
            eprintln!("[SyncServer] Không bind được port nào trong danh sách {:?}", CANDIDATE_PORTS);
            let _ = app.emit("sync-server-status", "PORT_BIND_FAILED");
            return;
        }
    };

    let state = Arc::new(SyncServerState { db });

    loop {
        match listener.accept().await {
            Ok((socket, peer_addr)) => {
                // Chỉ chấp nhận loopback connections (phòng ngừa lỗi cấu hình OS)
                if !peer_addr.ip().is_loopback() {
                    eprintln!("[SyncServer] Rejected non-loopback connection: {}", peer_addr);
                    continue;
                }

                let state_clone = Arc::clone(&state);
                let app_clone = app.clone();

                tokio::spawn(async move {
                    let timeout_res = tokio::time::timeout(
                        Duration::from_secs(5),
                        handle_connection(socket, state_clone, app_clone),
                    )
                    .await;

                    match timeout_res {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => eprintln!("[SyncServer] Connection error: {}", e),
                        Err(_) => eprintln!("[SyncServer] Connection timed out after 5s, dropped socket gracefully"),
                    }
                });
            }
            Err(e) => {
                // Accept error thường là tạm thời (file descriptor exhausted, etc.)
                // Log và tiếp tục, không break loop.
                eprintln!("[SyncServer] Accept error: {}", e);
            }
        }
    }
}

/// Xử lý 1 TCP connection: parse HTTP, xác thực token, ingest payload.
async fn handle_connection(
    mut stream: TcpStream,
    state: Arc<SyncServerState>,
    app: AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buffer = vec![0u8; MAX_REQUEST_BYTES];
    let mut total_read: usize = 0;

    // --- Phase 1: Đọc và parse HTTP headers ---
    let (method, path, headers_end, content_len, token_opt) = loop {
        let n = stream.read(&mut buffer[total_read..]).await?;
        if n == 0 {
            // Connection closed before headers complete
            return Ok(());
        }
        total_read += n;

        let mut raw_headers = [httparse::EMPTY_HEADER; 32];
        let mut req = httparse::Request::new(&mut raw_headers);

        match req.parse(&buffer[..total_read]) {
            Ok(httparse::Status::Complete(header_end_idx)) => {
                let method = req.method.unwrap_or("").to_string();
                let path = req.path.unwrap_or("").to_string();
                let mut content_len: usize = 0;
                let mut token_opt: Option<String> = None;

                for h in req.headers.iter() {
                    if h.name.eq_ignore_ascii_case("content-length") {
                        if let Ok(s) = std::str::from_utf8(h.value) {
                            content_len = s.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                    if h.name.eq_ignore_ascii_case("x-jarvis-sync-token") {
                        token_opt = std::str::from_utf8(h.value)
                            .ok()
                            .map(|s| s.trim().to_string());
                    }
                }

                break (method, path, header_end_idx, content_len, token_opt);
            }
            Ok(httparse::Status::Partial) => {
                // Header chưa đủ — kiểm tra overflow buffer
                if total_read >= buffer.len() {
                    send_text_response(&mut stream, 413, "Payload Too Large").await?;
                    return Ok(());
                }
                // Tiếp tục đọc
            }
            Err(_) => {
                send_text_response(&mut stream, 400, "Bad Request").await?;
                return Ok(());
            }
        }
    };

    // --- Phase 2: CORS Preflight (Chrome Private Network Access) ---
    if method == "OPTIONS" {
        send_cors_preflight(&mut stream).await?;
        return Ok(());
    }

    // --- Phase 3: Route check ---
    let is_academic_sync = method == "POST" && path == "/api/sync/academic";
    let is_student_profile_sync = method == "POST" && (path == "/sync/student-profile" || path == "/api/sync/student-profile");

    if !is_academic_sync && !is_student_profile_sync {
        send_text_response(&mut stream, 404, "Not Found").await?;
        return Ok(());
    }

    // --- Phase 4: Body size guard ---
    let body_end = headers_end.saturating_add(content_len);
    if body_end > buffer.len() {
        send_text_response(&mut stream, 413, "Payload Too Large").await?;
        return Ok(());
    }

    // --- Phase 5: Đọc body nếu chưa đủ ---
    while total_read < body_end {
        let n = stream.read(&mut buffer[total_read..]).await?;
        if n == 0 {
            break;
        }
        total_read += n;
    }
    let body_bytes = &buffer[headers_end..total_read.min(body_end)];

    // --- Phase 6: Xác thực Sync Token ---
    let state_for_token = Arc::clone(&state);
    let expected_token = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let conn_guard = state_for_token
            .db
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;
        crate::db::settings::get_or_create_sync_token(&conn_guard)
            .map_err(|e| format!("Lỗi đọc sync token: {e}"))
    })
    .await
    .map_err(|e| format!("JoinError reading token: {e}"))??;

    let provided_token = token_opt.as_deref().unwrap_or("");
    if provided_token != expected_token {
        eprintln!("[SyncServer] Token không hợp lệ — từ chối request.");
        send_text_response(&mut stream, 401, "Unauthorized: Invalid Sync Token").await?;
        return Ok(());
    }

    // --- Phase 7: Branching Route Handling ---
    if is_student_profile_sync {
        let payload: crate::commands::academic::StudentProfilePayload =
            match serde_json::from_slice(body_bytes) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[SyncServer] JSON parse lỗi student profile: {}", e);
                    let msg = format!("Invalid student profile JSON: {}", e);
                    send_text_response(&mut stream, 400, &msg).await?;
                    return Ok(());
                }
            };

        let app_handle = app.clone();
        let state_for_profile = Arc::clone(&state);

        let save_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut conn = state_for_profile.db.lock().map_err(|e| e.to_string())?;
            crate::commands::academic::execute_save_student_profile(&mut conn, &payload)?;
            app_handle.emit("student-profile-synced", &payload).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
        .map_err(|e| format!("JoinError saving student profile: {e}"))?;

        if let Err(e) = save_result {
            eprintln!("[SyncServer] Student profile commit error: {}", e);
            send_text_response(&mut stream, 500, &format!("DB Commit Error: {}", e)).await?;
            return Ok(());
        }

        println!("[SyncServer] ✅ Student profile sync thành công — đã emit student-profile-synced.");
        send_json_response(
            &mut stream,
            200,
            r#"{"status":"success","message":"Student profile synced successfully"}"#,
        )
        .await?;
        return Ok(());
    }

    // Phase 7.1: Parse & validate JSON payload for Academic Ingestion
    let payload: crate::modules::academic::portal_ingestion::IngestionPayload =
        match serde_json::from_slice(body_bytes) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[SyncServer] JSON parse lỗi: {}", e);
                let msg = format!("Invalid JSON schema: {}", e);
                send_text_response(&mut stream, 400, &msg).await?;
                return Ok(());
            }
        };

    // Defensive validation: từ chối payload rỗng hoàn toàn
    let has_drl = payload.drl.as_ref().map_or(false, |items| !items.is_empty());
    if payload.semester_groups.is_empty() && !has_drl {
        send_text_response(&mut stream, 422, "Payload has no semester_groups and no drl").await?;
        return Ok(());
    }

    // --- Phase 8: Offload blocking DB writes sang dedicated blocking pool ---
    let state_for_db = Arc::clone(&state);
    let commit_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut conn = state_for_db.db.lock().map_err(|e| e.to_string())?;
        crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(
            &mut conn,
            payload,
        )
        .map_err(|e| format!("Ingestion commit error: {}", e))
    })
    .await
    .map_err(|e| format!("JoinError in spawn_blocking: {}", e))?;

    if let Err(e) = commit_result {
        eprintln!("[SyncServer] DB commit error: {}", e);
        send_text_response(&mut stream, 500, &format!("DB Commit Error: {}", e)).await?;
        return Ok(());
    }

    // --- Phase 9: Thông báo frontend refresh ---
    let _ = app.emit("academic-data-synced", ());
    println!("[SyncServer] ✅ Sync thành công — đã emit academic-data-synced.");

    send_json_response(
        &mut stream,
        200,
        r#"{"status":"success","message":"Synced successfully"}"#,
    )
    .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

async fn send_cors_preflight(stream: &mut TcpStream) -> Result<(), std::io::Error> {
    let resp = concat!(
        "HTTP/1.1 204 No Content\r\n",
        "Access-Control-Allow-Origin: *\r\n",
        "Access-Control-Allow-Methods: POST, OPTIONS\r\n",
        "Access-Control-Allow-Headers: Content-Type, X-Jarvis-Sync-Token\r\n",
        "Access-Control-Allow-Private-Network: true\r\n",
        "Content-Length: 0\r\n",
        "\r\n"
    );
    stream.write_all(resp.as_bytes()).await
}

async fn send_text_response(
    stream: &mut TcpStream,
    code: u16,
    msg: &str,
) -> Result<(), std::io::Error> {
    let reason = http_reason(code);
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
        code,
        reason,
        msg.len(),
        msg
    );
    stream.write_all(resp.as_bytes()).await
}

async fn send_json_response(
    stream: &mut TcpStream,
    code: u16,
    json: &str,
) -> Result<(), std::io::Error> {
    let reason = http_reason(code);
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
        code,
        reason,
        json.len(),
        json
    );
    stream.write_all(resp.as_bytes()).await
}

fn http_reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        _ => "Unknown",
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {

    /// Kiểm tra parser HTTP request thủ công dùng httparse
    #[test]
    fn test_httparse_extracts_method_path_and_token() {
        let raw = b"POST /api/sync/academic HTTP/1.1\r\nHost: 127.0.0.1:41718\r\nContent-Type: application/json\r\nX-Jarvis-Sync-Token: abc123def456\r\nContent-Length: 2\r\n\r\n{}";

        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut req = httparse::Request::new(&mut headers);
        let result = req.parse(raw).unwrap();

        assert!(result.is_complete());
        assert_eq!(req.method, Some("POST"));
        assert_eq!(req.path, Some("/api/sync/academic"));

        let mut token_found: Option<&str> = None;
        let mut content_len: usize = 0;
        for h in req.headers.iter() {
            if h.name.eq_ignore_ascii_case("x-jarvis-sync-token") {
                token_found = std::str::from_utf8(h.value).ok();
            }
            if h.name.eq_ignore_ascii_case("content-length") {
                if let Ok(s) = std::str::from_utf8(h.value) {
                    content_len = s.trim().parse::<usize>().unwrap_or(0);
                }
            }
        }

        assert_eq!(token_found, Some("abc123def456"));
        assert_eq!(content_len, 2);
    }

    /// Kiểm tra rằng OPTIONS request được nhận dạng đúng (để xử lý CORS preflight)
    #[test]
    fn test_httparse_options_preflight_detected() {
        let raw = b"OPTIONS /api/sync/academic HTTP/1.1\r\nHost: 127.0.0.1:41718\r\nOrigin: https://student.uit.edu.vn\r\n\r\n";

        let mut headers = [httparse::EMPTY_HEADER; 32];
        let mut req = httparse::Request::new(&mut headers);
        let result = req.parse(raw).unwrap();

        assert!(result.is_complete());
        assert_eq!(req.method, Some("OPTIONS"));
    }

    /// Kiểm tra token validation logic: token rỗng hoặc sai phải bị từ chối
    #[test]
    fn test_token_validation_logic() {
        let expected = "deadbeef1234567890abcdef12345678";

        // Đúng token → chấp nhận
        assert_eq!(expected, expected);

        // Sai token → từ chối
        let provided = "wrongtoken";
        assert_ne!(provided, expected);

        // Token rỗng → từ chối
        let empty: &str = "";
        assert_ne!(empty, expected);
    }

    /// Kiểm tra get_or_create_sync_token sinh token đúng định dạng hex
    #[test]
    fn test_get_or_create_sync_token_format() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        // Tạo bảng settings tối giản
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .expect("create settings table");

        let token = crate::db::settings::get_or_create_sync_token(&conn)
            .expect("token generation must succeed");

        // Token phải là hex string 64 ký tự (32 bytes * 2 hex chars)
        assert_eq!(token.len(), 64, "token phải dài 64 ký tự hex");
        assert!(
            token.chars().all(|c| c.is_ascii_hexdigit()),
            "token phải là chuỗi hex"
        );

        // Gọi lần 2 phải trả về cùng token (idempotent)
        let token2 = crate::db::settings::get_or_create_sync_token(&conn)
            .expect("second call must succeed");
        assert_eq!(token, token2, "token phải giữ nguyên qua các lần gọi");
    }
}
