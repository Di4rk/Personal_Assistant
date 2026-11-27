use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tower_http::cors::CorsLayer;

use crate::db::{insert_submission_and_update_daily, DbPools};

pub const SERVER_PORT: u16 = 3030;

use std::sync::{Arc, Mutex, OnceLock};

static LOCAL_SYNC_TOKEN: OnceLock<String> = OnceLock::new();

pub fn get_sync_token() -> &'static str {
    LOCAL_SYNC_TOKEN
        .get_or_init(|| {
            format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )
        })
        .as_str()
}

#[derive(Clone)]
pub struct ServerState {
    pub app: AppHandle,
    pub db: DbPools,
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
    let problem_id = payload.problem_id.clone();
    let problem_name = payload.problem_name.clone();
    let verdict = payload.verdict.clone();
    let language = payload.language.clone();
    let contest_id = payload.contest_id.clone();

    let xp_result = state
        .db
        .write(move |conn| {
            insert_submission_and_update_daily(
                conn,
                &problem_id,
                &problem_name,
                &verdict,
                language.as_deref(),
                contest_id.as_deref(),
                &raw_payload,
            )
            .map_err(crate::error::AppError::Database)
        })
        .await;

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
                let drl_clone = drl_payload.clone();
                let commit_res = state
                    .db
                    .write(move |conn| {
                        crate::services::portal_harvester::PortalIngestionEngine::commit_drl_records_on_conn(
                            conn,
                            drl_clone,
                        )
                        .map_err(crate::error::AppError::PortalSync)
                    })
                    .await;
                match commit_res {
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
                            Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
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
    let commit_res = state
        .db
        .write(move |conn| {
            crate::services::portal_harvester::PortalIngestionEngine::commit_academic_records_on_conn(
                conn,
                profile,
                drl_records,
                courses,
                summary,
                avg_drl,
                1,
                1,
            )
            .map_err(crate::error::AppError::PortalSync)
        })
        .await;

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
                    "message": e.to_string()
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
    let commit_res = state
        .db
        .write(move |conn| {
            crate::services::wecode_harvester::WecodeIngestionEngine::commit_wecode_sync_request_on_conn(
                conn,
                req,
            )
            .map_err(crate::error::AppError::Sync)
        })
        .await;

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
                    "message": e.to_string()
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
    let is_final = payload.is_final.unwrap_or(false);
    let current_course = payload.current_course.clone().unwrap_or_default();
    let progress_current = payload.progress_current.unwrap_or(0);
    let progress_total = payload.progress_total.unwrap_or(0);
    let progress_pct = payload.progress_pct.unwrap_or(0.0);

    let commit_res = state
        .db
        .write(move |conn| {
            crate::db::moodle::commit_moodle_payload(conn, payload)
                .map_err(crate::error::AppError::Sync)
        })
        .await;

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
                    "message": e.to_string()
                })),
            )
                .into_response()
        }
    }
}

/// Handler: POST /api/v1/sync/exam-schedule
async fn handle_sync_exam_schedule(
    State(state): State<ServerState>,
    Json(payload): Json<crate::db::exam::PortalExamSchedulePayload>,
) -> impl IntoResponse {
    let payload_clone = payload.clone();
    let commit_res = state
        .db
        .write(move |conn| {
            crate::db::exam::upsert_exam_schedules(conn, &payload_clone)
                .map_err(crate::error::AppError::Sync)
        })
        .await;

    match commit_res {
        Ok(count) => {
            println!("[SyncExam] Upserted {count} exam schedules via Browser Sync API!");
            let _ = state.app.emit("academic-data-synced", ());
            let _ = state.app.emit("exam-schedule-synced", count);
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "ok",
                    "message": "Exam schedule committed successfully",
                    "exam_count": count
                })),
            ).into_response()
        }
        Err(e) => {
            eprintln!("[SyncExam] Error upserting exam schedules: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
            ).into_response()
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct SsoCredentialsPayload {
    username: String,
    password: String,
}

/// Handler: POST /api/v1/sync/sso-credentials
async fn handle_sync_sso_credentials(
    State(state): State<ServerState>,
    Json(payload): Json<SsoCredentialsPayload>,
) -> impl IntoResponse {
    let username = payload.username.trim().to_string();
    let password = payload.password;
    if username.is_empty() || password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "status": "error", "message": "Empty credentials" })),
        )
            .into_response();
    }

    let encrypted_password = match crate::db::secret_store::encrypt_secret(&password) {
        Ok(enc) => enc,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "status": "error", "message": e })),
            )
                .into_response();
        }
    };

    let write_res = state
        .db
        .write(move |conn| {
            crate::db::set_setting(conn, "sso_uit_username", &username)
                .map_err(crate::error::AppError::Database)?;
            crate::db::set_setting(conn, "sso_uit_password", &encrypted_password)
                .map_err(crate::error::AppError::Database)?;
            crate::db::set_setting(conn, "sso_uit_auto_login", "true")
                .map_err(crate::error::AppError::Database)?;
            Ok(())
        })
        .await;

    match write_res {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "ok" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct SyllabusPdfQuery {
    subject_code: String,
    #[serde(default)]
    subject_id: i64,
}

/// Handler: GET /api/v1/sync/syllabus-weights/known
async fn handle_get_known_syllabus_weights(State(state): State<ServerState>) -> impl IntoResponse {
    let res = state.db.read(|conn| {
        crate::db::portal_extra::get_known_syllabus_subject_codes(conn)
            .map_err(|e| crate::error::AppError::Sync(e.to_string()))
    });

    match res {
        Ok(codes) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "ok", "codes": codes })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
        )
            .into_response(),
    }
}

/// Handler: POST /api/v1/sync/syllabus-pdf?subject_code=...&subject_id=...
async fn handle_sync_syllabus_pdf(
    State(state): State<ServerState>,
    Query(params): Query<SyllabusPdfQuery>,
    body: Bytes,
) -> impl IntoResponse {
    let clean_code = params.subject_code.trim().to_uppercase();
    if clean_code.is_empty() || body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "status": "error", "message": "Missing subject_code or PDF body" })),
        )
            .into_response();
    }

    let Some(weights) = crate::services::syllabus_parser::parse_weights_from_syllabus_pdf(&body)
    else {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "ok", "parsed": false })),
        )
            .into_response();
    };

    let weights_clone = weights.clone();
    let code_clone = clean_code.clone();
    let subject_id = params.subject_id;
    let res = state
        .db
        .write(move |conn| {
            crate::db::portal_extra::upsert_course_syllabus_weight(
                conn,
                &code_clone,
                subject_id,
                &weights_clone,
            )
            .map_err(|e| crate::error::AppError::Sync(e.to_string()))
        })
        .await;

    match res {
        Ok(_) => {
            println!(
                "[SyncSyllabus] Parsed weights for {}: QT={}% TH={}% GK={}% CK={}%",
                clean_code, weights.qt, weights.th, weights.gk, weights.ck
            );
            let _ = state.app.emit("portal-extra-synced", ());
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "ok",
                    "parsed": true,
                    "subject_code": clean_code,
                    "weights": weights
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
        )
            .into_response(),
    }
}

/// Handler: POST /api/v1/sync/portal-extra
async fn handle_sync_portal_extra(
    State(state): State<ServerState>,
    Json(payload): Json<crate::db::portal_extra::PortalExtraSyncPayload>,
) -> impl IntoResponse {
    let commit_res = state
        .db
        .write(move |conn| {
            crate::db::portal_extra::commit_portal_extra_payload(conn, &payload)
                .map_err(crate::error::AppError::Sync)
        })
        .await;

    match commit_res {
        Ok(stats) => {
            println!(
                "[SyncPortalExtra] Committed {} classes, {} timetable slots, {} tuition, {} certs, {} activities!",
                stats.classes_count,
                stats.timetable_count,
                stats.tuition_count,
                stats.certificates_count,
                stats.activities_count
            );
            let _ = state.app.emit("portal-extra-synced", &stats);
            let _ = state.app.emit("academic-data-synced", ());
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "status": "ok",
                    "message": "Portal extra data committed successfully",
                    "stats": stats
                })),
            )
                .into_response()
        }
        Err(e) => {
            eprintln!("[SyncPortalExtra] Error committing portal extra data: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "status": "error", "message": e.to_string() })),
            )
                .into_response()
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn has_valid_sync_token(headers: &HeaderMap) -> bool {
    let Some(val) = headers.get("x-diark-sync-token") else {
        return false;
    };
    let Ok(provided) = val.to_str() else {
        return false;
    };
    constant_time_eq(provided.trim().as_bytes(), get_sync_token().as_bytes())
}

async fn require_sync_token_middleware(request: Request<axum::body::Body>, next: Next) -> Response {
    if request.method() == Method::OPTIONS {
        return next.run(request).await;
    }
    if !has_valid_sync_token(request.headers()) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "status": "error",
                "message": "Unauthorized sync token"
            })),
        )
            .into_response();
    }
    next.run(request).await
}

fn build_strict_cors_layer() -> CorsLayer {
    let allowed_origins = [
        "https://portal.uit.edu.vn",
        "https://courses.uit.edu.vn",
        "https://khmt.uit.edu.vn",
        "https://wecode.uit.edu.vn",
        "https://auth.uit.edu.vn",
        "https://sso.uit.edu.vn",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "tauri://localhost",
        "http://tauri.localhost",
    ]
    .into_iter()
    .filter_map(|origin| HeaderValue::from_str(origin).ok())
    .collect::<Vec<_>>();

    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-diark-sync-token"),
        ])
}

/// Middleware tự động tiêm Access-Control-Allow-Private-Network cho Chrome Private Network Access
async fn allow_private_network_middleware(request: Request<axum::body::Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        HeaderName::from_static("access-control-allow-private-network"),
        HeaderValue::from_static("true"),
    );
    response
}

fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/api/v1/events/submission", post(handle_submission))
        .route("/api/v1/academic/transcript", post(handle_academic_transcript))
        .route("/api/v1/academic/drl", post(handle_academic_drl))
        .route("/api/v1/sync/portal", post(handle_sync_portal))
        .route("/api/v1/sync/portal-extra", post(handle_sync_portal_extra))
        .route("/api/v1/sync/syllabus-weights/known", get(handle_get_known_syllabus_weights))
        .route(
            "/api/v1/sync/syllabus-pdf",
            post(handle_sync_syllabus_pdf).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/v1/sync/sso-credentials", post(handle_sync_sso_credentials))
        .route("/api/v1/sync/wecode", post(handle_sync_wecode))
        .route("/api/v1/sync/moodle", post(handle_sync_moodle))
        .route("/api/v1/sync/exam-schedule", post(handle_sync_exam_schedule))
        .layer(middleware::from_fn(require_sync_token_middleware))
        .layer(build_strict_cors_layer())
        .layer(middleware::from_fn(allow_private_network_middleware))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sync_token_middleware_rejects_missing_or_invalid_and_accepts_valid() {
        let app = Router::new()
            .route(
                "/test-protected",
                post(|| async { (StatusCode::OK, "ok") }),
            )
            .layer(middleware::from_fn(require_sync_token_middleware))
            .layer(build_strict_cors_layer());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let url = format!("http://{addr}/test-protected");

        let resp_missing = client.post(&url).send().await.unwrap();
        assert_eq!(resp_missing.status(), reqwest::StatusCode::UNAUTHORIZED);

        let resp_bad = client
            .post(&url)
            .header("X-Diark-Sync-Token", "invalid-token")
            .send()
            .await
            .unwrap();
        assert_eq!(resp_bad.status(), reqwest::StatusCode::UNAUTHORIZED);

        let resp_ok = client
            .post(&url)
            .header("X-Diark-Sync-Token", get_sync_token())
            .send()
            .await
            .unwrap();
        assert_eq!(resp_ok.status(), reqwest::StatusCode::OK);

        server_handle.abort();
    }
}

/// Khởi động server trong background.
pub async fn run_server(app: AppHandle, db: DbPools) {
    let state = ServerState { app, db };
    let app_router = build_router(state);
    let addr = format!("127.0.0.1:{SERVER_PORT}");

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[diark-server] Không bind được port {addr}: {e}");
            return;
        }
    };

    println!("[diark-server] Đang lắng nghe tại http://{addr}");

    if let Err(e) = axum::serve(listener, app_router).await {
        eprintln!("[diark-server] Server crash: {e}");
    }
}
