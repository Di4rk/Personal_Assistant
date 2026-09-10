use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;

use crate::db::{insert_submission_and_update_daily, SharedDb};

pub const SERVER_PORT: u16 = 3030;

use std::sync::{Arc, Mutex, OnceLock};

static EXTRACTED_HTML: OnceLock<Arc<Mutex<Option<String>>>> = OnceLock::new();

pub fn get_extracted_html_store() -> Arc<Mutex<Option<String>>> {
    EXTRACTED_HTML
        .get_or_init(|| Arc::new(Mutex::new(None)))
        .clone()
}

// Store tương đương cho HTML trang ĐRL — dùng cùng pattern với transcript bridge.
static EXTRACTED_DRL_HTML: OnceLock<Arc<Mutex<Option<String>>>> = OnceLock::new();

pub fn get_extracted_drl_html_store() -> Arc<Mutex<Option<String>>> {
    EXTRACTED_DRL_HTML
        .get_or_init(|| Arc::new(Mutex::new(None)))
        .clone()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TranscriptPayload {
    pub html: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DrlPayload {
    pub html: String,
}

async fn handle_academic_transcript(
    Json(payload): Json<TranscriptPayload>,
) -> impl IntoResponse {
    let store = get_extracted_html_store();
    if let Ok(mut guard) = store.lock() {
        *guard = Some(payload.html);
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "ok", "message": "transcript received" })),
    )
        .into_response()
}

async fn handle_academic_drl(
    Json(payload): Json<DrlPayload>,
) -> impl IntoResponse {
    let store = get_extracted_drl_html_store();
    if let Ok(mut guard) = store.lock() {
        *guard = Some(payload.html);
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "ok", "message": "drl received" })),
    )
        .into_response()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SubmissionPayload {
    pub problem_id: String,
    pub problem_name: String,
    pub verdict: String,
    pub language: Option<String>,
    pub contest_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SubmissionResponse {
    pub status: &'static str,
    pub xp_awarded: i64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub status: &'static str,
    pub message: String,
}

/// Handler duy nhất của MVP: POST /api/v1/events/submission
async fn handle_submission(
    State(db): State<SharedDb>,
    Json(payload): Json<SubmissionPayload>,
) -> impl IntoResponse {
    // Validate tối thiểu - tránh payload rác từ extension bị bug/tấn công.
    if payload.problem_id.trim().is_empty() || payload.verdict.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                status: "error",
                message: "problem_id và verdict là bắt buộc".to_string(),
            }),
        )
            .into_response();
    }

    // serde_json để lưu lại raw payload phục vụ debug / AI Bug Logbook sau này.
    let raw_payload = serde_json::to_string(&payload).unwrap_or_default();

    // Lock mutex trong 1 block riêng để tránh giữ lock qua await point
    // (rusqlite là sync, không cần .await, nhưng giữ thói quen scope gọn).
    let xp_result = {
        let mut conn = match db.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        status: "error",
                        message: "DB mutex bị poisoned - có thread trước đó panic".to_string(),
                    }),
                )
                    .into_response();
            }
        };

        insert_submission_and_update_daily(
            &mut conn,
            &payload.problem_id,
            &payload.problem_name,
            &payload.verdict,
            payload.language.as_deref(),
            payload.contest_id.as_deref(),
            &raw_payload,
        )
    };

    match xp_result {
        Ok(xp) => (
            StatusCode::OK,
            Json(SubmissionResponse {
                status: "ok",
                xp_awarded: xp,
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                status: "error",
                message: format!("Lỗi ghi DB: {e}"),
            }),
        )
            .into_response(),
    }
}

fn build_router(db: SharedDb) -> Router {
    Router::new()
        .route("/api/v1/events/submission", post(handle_submission))
        .route("/api/v1/academic/transcript", post(handle_academic_transcript))
        .route("/api/v1/academic/drl", post(handle_academic_drl))
        // permissive() vì server chỉ bind 127.0.0.1 (không expose ra mạng ngoài),
        // và caller duy nhất là Chrome extension với origin dạng chrome-extension://<id>
        // mà browser không cho set cụ thể trong CORS allow-list dễ dàng.
        .layer(CorsLayer::permissive())
        .with_state(db)
}

/// Khởi động server trong background. Gọi hàm này 1 lần lúc app setup,
/// KHÔNG block main thread vì dùng tokio::spawn.
pub async fn run_server(db: SharedDb) {
    let app = build_router(db);
    let addr = format!("127.0.0.1:{SERVER_PORT}");

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            // Port đã bị chiếm (VD: app chạy 2 instance cùng lúc) -
            // log rõ ràng thay vì panic, để UI vẫn dùng được app dù server chết.
            eprintln!("[jarvis-server] Không bind được port {addr}: {e}");
            return;
        }
    };

    println!("[jarvis-server] Đang lắng nghe tại http://{addr}");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[jarvis-server] Server crash: {e}");
    }
}
