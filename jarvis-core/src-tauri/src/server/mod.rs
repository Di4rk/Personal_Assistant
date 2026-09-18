use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::post,
    Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tower_http::cors::CorsLayer;

use crate::db::{insert_submission_and_update_daily, SharedDb};

pub const SERVER_PORT: u16 = 3030;

use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone)]
pub struct ServerState {
    pub app: AppHandle,
    pub db: SharedDb,
}

static EXTRACTED_HTML: OnceLock<Arc<Mutex<Option<String>>>> = OnceLock::new();

pub fn get_extracted_html_store() -> Arc<Mutex<Option<String>>> {
    EXTRACTED_HTML
        .get_or_init(|| Arc::new(Mutex::new(None)))
        .clone()
}

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

/// Handler: POST /api/v1/events/submission
async fn handle_submission(
    State(state): State<ServerState>,
    Json(payload): Json<SubmissionPayload>,
) -> impl IntoResponse {
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

    let raw_payload = serde_json::to_string(&payload).unwrap_or_default();

    let xp_result = {
        let mut conn = match state.db.lock() {
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

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct PortalSyncPayload {
    #[serde(default)]
    pub profile: Option<crate::services::portal_harvester::PortalProfilePayload>,
    #[serde(default)]
    pub summary: Option<crate::services::portal_harvester::PortalSummaryPayload>,
    #[serde(default)]
    pub avg_drl: Option<f64>,
    #[serde(default)]
    pub drl_records: Option<Vec<crate::services::portal_harvester::DrlItem>>,
    #[serde(default)]
    pub courses: Vec<crate::services::portal_harvester::AcademicCourseItem>,
}

/// Handler: POST /api/v1/sync/portal
async fn handle_sync_portal(
    State(state): State<ServerState>,
    Json(value): Json<serde_json::Value>,
) -> impl IntoResponse {
    if value.get("training_point_history").is_some() && value.get("bySemester").is_none() {
        match serde_json::from_value::<crate::services::portal_harvester::OfficialUitDrlPayload>(value) {
            Ok(drl_payload) => {
                let db_arc = state.db.clone();
                match crate::services::portal_harvester::PortalIngestionEngine::commit_drl_records(db_arc, drl_payload) {
                    Ok(count) => {
                        println!("[SyncPortal] Committed {count} DRL records successfully via Browser Sync API!");
                        let _ = state.app.emit("academic-data-synced", ());
                        let _ = state.app.emit("sso-callback-success", "portal");
                        return (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "status": "ok",
                                "message": "DRL records committed successfully",
                                "drl_count": count
                            })),
                        ).into_response();
                    }
                    Err(e) => {
                        eprintln!("[SyncPortal] Error committing DRL records: {e}");
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({ "status": "error", "message": e })),
                        ).into_response();
                    }
                }
            }
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "status": "error",
                        "message": format!("Official UIT DRL payload parse error: {e}")
                    })),
                ).into_response();
            }
        }
    }

    let (profile, drl_records, courses, summary, avg_drl) = if value.get("bySemester").is_some() {
        match serde_json::from_value::<crate::services::portal_harvester::OfficialUitTranscriptPayload>(value) {
            Ok(official) => crate::services::portal_harvester::convert_official_uit_payload(official),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "status": "error",
                        "message": format!("Official UIT payload parse error: {e}")
                    })),
                ).into_response();
            }
        }
    } else {
        match serde_json::from_value::<PortalSyncPayload>(value) {
            Ok(p) => (
                p.profile.unwrap_or_default(),
                p.drl_records.unwrap_or_default(),
                p.courses,
                p.summary,
                p.avg_drl,
            ),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "status": "error",
                        "message": format!("PortalSyncPayload parse error: {e}")
                    })),
                ).into_response();
            }
        }
    };

    let courses_count = courses.len();
    let db_arc = state.db.clone();
    let commit_res = crate::services::portal_harvester::PortalIngestionEngine::commit_academic_records(
        db_arc,
        profile,
        drl_records,
        courses,
        summary,
        avg_drl,
        1,
        1,
    );

    match commit_res {
        Ok(_) => {
            println!("[SyncPortal] Committed {courses_count} courses successfully via Browser Sync API!");
            let _ = state.app.emit("academic-data-synced", ());
            let _ = state.app.emit("sso-callback-success", "portal");
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "ok",
                    "message": "Portal data committed successfully",
                    "courses_count": courses_count
                })),
            )
                .into_response()
        }
        Err(e) => {
            eprintln!("[SyncPortal] Error committing portal data: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "status": "error",
                    "message": e
                })),
            )
                .into_response()
        }
    }
}

/// Handler: POST /api/v1/sync/wecode
async fn handle_sync_wecode(
    State(state): State<ServerState>,
    Json(req): Json<crate::commands::wecode::WecodeSyncRequest>,
) -> impl IntoResponse {
    let db_arc = state.db.clone();
    let commit_res = crate::services::wecode_harvester::WecodeIngestionEngine::commit_wecode_sync_request(
        db_arc,
        req,
    );

    match commit_res {
        Ok(count) => {
            println!("[SyncWecode] Committed {count} wecode records successfully via Browser Sync API!");
            let _ = state.app.emit("wecode-submissions-synced", ());
            let _ = state.app.emit("sso-callback-success", "wecode");
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "ok",
                    "message": "Wecode records committed successfully",
                    "count": count
                })),
            )
                .into_response()
        }
        Err(e) => {
            eprintln!("[SyncWecode] Error committing wecode submissions: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "status": "error",
                    "message": e
                })),
            )
                .into_response()
        }
    }
}

/// Handler: POST /api/v1/sync/moodle
async fn handle_sync_moodle(
    State(state): State<ServerState>,
    Json(payload): Json<crate::db::moodle::MoodleSyncPayload>,
) -> impl IntoResponse {
    let db_arc = state.db.clone();
    let is_final = payload.is_final.unwrap_or(false);
    let current_course = payload.current_course.clone().unwrap_or_default();
    let progress_current = payload.progress_current.unwrap_or(0);
    let progress_total = payload.progress_total.unwrap_or(0);
    let progress_pct = payload.progress_pct.unwrap_or(0.0);

    let commit_res = crate::services::moodle_harvester::MoodleIngestionEngine::commit_moodle_sync(
        db_arc,
        payload,
    );

    match commit_res {
        Ok((courses, tasks, materials)) => {
            println!("[SyncMoodle] Committed {courses} courses, {tasks} tasks, {materials} materials successfully via Browser Sync API! (is_final={is_final})");
            let _ = state.app.emit("moodle-data-synced", courses);
            let _ = state.app.emit(
                "moodle-sync-progress",
                serde_json::json!({
                    "current": progress_current,
                    "total": progress_total,
                    "course_name": current_course,
                    "percent": progress_pct,
                    "is_final": is_final
                }),
            );
            if is_final {
                let _ = state.app.emit("sso-callback-success", "moodle");
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "ok",
                    "message": "Moodle records committed successfully",
                    "courses": courses,
                    "tasks": tasks,
                    "materials": materials
                })),
            )
                .into_response()
        }
        Err(e) => {
            eprintln!("[SyncMoodle] Error committing moodle records: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "status": "error",
                    "message": e
                })),
            )
                .into_response()
        }
    }
}

/// Middleware tự động tiêm Access-Control-Allow-Private-Network cho Chrome Private Network Access
async fn allow_private_network_middleware(request: Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::HeaderName::from_static("access-control-allow-private-network"),
        axum::http::HeaderValue::from_static("true"),
    );
    response
}

fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/api/v1/events/submission", post(handle_submission))
        .route("/api/v1/academic/transcript", post(handle_academic_transcript))
        .route("/api/v1/academic/drl", post(handle_academic_drl))
        .route("/api/v1/sync/portal", post(handle_sync_portal))
        .route("/api/v1/sync/wecode", post(handle_sync_wecode))
        .route("/api/v1/sync/moodle", post(handle_sync_moodle))
        .layer(CorsLayer::permissive())
        .layer(middleware::from_fn(allow_private_network_middleware))
        .with_state(state)
}

/// Khởi động server trong background.
pub async fn run_server(app: AppHandle, db: SharedDb) {
    let state = ServerState { app, db };
    let app_router = build_router(state);
    let addr = format!("127.0.0.1:{SERVER_PORT}");

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[jarvis-server] Không bind được port {addr}: {e}");
            return;
        }
    };

    println!("[jarvis-server] Đang lắng nghe tại http://{addr}");

    if let Err(e) = axum::serve(listener, app_router).await {
        eprintln!("[jarvis-server] Server crash: {e}");
    }
}
