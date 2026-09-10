//! IPC Commands — Academic Radar
//!
//! Tất cả commands ở đây đều map lỗi về `String` tại ranh giới IPC theo đúng
//! pattern của codebase (xem commands/mod.rs). Không dùng AppError trực tiếp
//! trong return type của #[tauri::command] vì Tauri cần type implement Serialize,
//! và String là cách đơn giản nhất đảm bảo điều đó.

use crate::db::{
    get_all_semesters_with_stats, get_courses_by_semester, upsert_courses, upsert_semester,
    AcademicCourseRecord, SemesterOverview, SharedDb, UpsertCourseDto, UpsertSemesterDto,
};
use crate::services::uit_portal::{ingest_portal_transcript, RawPortalSemester};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub type AcademicOverviewDto = SemesterOverview;

/// Trả về toàn bộ học kỳ kèm chỉ số GPA/DRL tính LIVE từ SQL aggregate.
///
/// Frontend gọi 1 lần duy nhất để render overview table. Không cache ở Rust —
/// SQLite đủ nhanh cho dataset cá nhân (< vài trăm môn học).
#[tauri::command]
pub fn get_academic_overview(db: tauri::State<'_, SharedDb>) -> Result<Vec<SemesterOverview>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_all_semesters_with_stats(&conn).map_err(|e| format!("Lỗi get_academic_overview: {e}"))
}

/// Trả về danh sách môn học của 1 học kỳ cụ thể.
#[tauri::command]
pub fn get_semester_courses(
    db: tauri::State<'_, SharedDb>,
    semester_id: String,
) -> Result<Vec<AcademicCourseRecord>, String> {
    if semester_id.trim().is_empty() {
        return Err("semester_id không được để trống".to_string());
    }
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_courses_by_semester(&conn, &semester_id)
        .map_err(|e| format!("Lỗi get_semester_courses: {e}"))
}

/// Upsert batch nhiều môn học trong 1 transaction.
///
/// Frontend gọi sau khi user nhập bảng điểm. Backend tự động:
/// 1. Tính `summary_score_10` từ midterm/final nếu chưa có.
/// 2. Quy đổi sang hệ 4 và grade char theo quy chế ĐHQG-HCM.
/// 3. Dedup theo `(semester_id, course_code)` qua ON CONFLICT.
#[tauri::command]
pub fn upsert_academic_courses(
    db: tauri::State<'_, SharedDb>,
    courses: Vec<UpsertCourseDto>,
) -> Result<(), String> {
    if courses.is_empty() {
        return Ok(());
    }
    // Validate trước khi lock DB — fail nhanh không tốn lock time.
    for c in &courses {
        if c.semester_id.trim().is_empty() {
            return Err(format!(
                "course '{}': semester_id không được trống",
                c.course_code
            ));
        }
        if c.course_code.trim().is_empty() {
            return Err("course_code không được trống".to_string());
        }
        if c.credits < 1 {
            return Err(format!(
                "course '{}': credits phải >= 1, got {}",
                c.course_code, c.credits
            ));
        }
    }

    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    upsert_courses(&mut conn, &courses)
        .map_err(|e| format!("Lỗi upsert_academic_courses: {e}"))
}

/// Tạo hoặc cập nhật metadata học kỳ (chỉ tiêu, trạng thái hoàn thành).
/// Không ảnh hưởng đến dữ liệu điểm hay DRL.
#[tauri::command]
pub fn upsert_academic_semester(
    db: tauri::State<'_, SharedDb>,
    semester: UpsertSemesterDto,
) -> Result<(), String> {
    if semester.id.trim().is_empty() {
        return Err("semester id không được trống".to_string());
    }
    if semester.academic_year.trim().is_empty() {
        return Err("academic_year không được trống".to_string());
    }
    if !(1..=3).contains(&semester.semester_term) {
        return Err(format!(
            "semester_term phải là 1, 2, hoặc 3 — got {}",
            semester.semester_term
        ));
    }

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    upsert_semester(&conn, &semester)
        .map_err(|e| format!("Lỗi upsert_academic_semester: {e}"))
}

const PORTAL_BANG_DIEM_URL: &str = "https://portal.uit.edu.vn/sinh-vien/bang-diem";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", content = "message")]
pub enum UitSyncState {
    Opening,
    Authenticating,
    Extracting,
    Parsing,
    Persisting,
    Completed,
    Failed(String),
}

/// Rust-Owned Lifecycle Controller: Mở cửa sổ SSO độc lập (không cấp quyền IPC cho remote webview),
/// tự động trích xuất bảng điểm Next.js đã hydrate qua eval DOM và đồng bộ vào SQLite.
#[tauri::command]
pub async fn sync_uit_portal(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<AcademicOverviewDto, String> {
    // 1. Emit State: Opening
    let _ = app.emit("academic://sync-state", UitSyncState::Opening);

    let window_label = "uit-sso-auth";
    if let Some(existing) = app.get_webview_window(window_label) {
        let _ = existing.close();
    }

    let url_parsed = PORTAL_BANG_DIEM_URL
        .parse()
        .map_err(|e| format!("URL không hợp lệ: {e}"))?;

    // Remote webview KHÔNG được cấp bất kỳ capability nào để gọi IPC commands (P0 Zero-Trust)
    let sso_window = WebviewWindowBuilder::new(&app, window_label, WebviewUrl::External(url_parsed))
        .title("Cổng thông tin UIT - Xác thực Sinh viên")
        .inner_size(950.0, 700.0)
        .center()
        .build()
        .map_err(|e| format!("Failed to create SSO window: {e}"))?;

    let _ = app.emit("academic://sync-state", UitSyncState::Authenticating);

    // Reset store HTML tạm thời
    let html_store = crate::server::get_extracted_html_store();
    if let Ok(mut guard) = html_store.lock() {
        *guard = None;
    }

    // 2. Poll kiểm tra xem DOM bảng điểm đã load xong chưa bằng Rust eval (timeout 120s)
    let extraction_script = r#"
        (async function() {
            try {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
                const summaryBtn = tabs.find(t => t.innerText && t.innerText.includes('Tổng kết theo kỳ'));
                const semesterBtn = tabs.find(t => t.innerText && t.innerText.includes('Chi tiết môn học'));
                const ctdtBtn = tabs.find(t => t.innerText && t.innerText.includes('Theo CTĐT'));

                if (summaryBtn && semesterBtn && ctdtBtn) {
                    // 1. Lấy Tab Summary
                    summaryBtn.click();
                    await sleep(250);
                    const summaryPanel = document.querySelector('div#radix-\\3a r0\\3a-content-summary') || document.querySelector('div[role="tabpanel"][data-state="active"]');
                    const summaryHtml = summaryPanel ? (summaryPanel.outerHTML || summaryPanel.innerHTML) : '';

                    // 2. Lấy Tab By-Semester
                    semesterBtn.click();
                    await sleep(350);
                    const semesterPanel = document.querySelector('div#radix-\\3a r0\\3a-content-by-semester') || document.querySelector('div[role="tabpanel"][data-state="active"]');
                    const semesterHtml = semesterPanel ? (semesterPanel.outerHTML || semesterPanel.innerHTML) : '';

                    // 3. Lấy Tab By-CTDT
                    ctdtBtn.click();
                    await sleep(350);
                    const ctdtPanel = document.querySelector('div#radix-\\3a r0\\3a-content-by-ctdt') || document.querySelector('div[role="tabpanel"][data-state="active"]');
                    const ctdtHtml = ctdtPanel ? (ctdtPanel.outerHTML || ctdtPanel.innerHTML) : '';

                    if (summaryHtml && semesterHtml && ctdtHtml) {
                        const payload = JSON.stringify({
                            summary: summaryHtml,
                            by_semester: semesterHtml,
                            by_ctdt: ctdtHtml
                        });
                        fetch('http://127.0.0.1:3030/api/v1/academic/transcript', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ html: payload })
                        }).catch(() => {});
                        return true;
                    }
                }

                // Fallback: nếu trang đang ở chế độ xem một bảng điểm đơn lẻ
                const table = document.querySelector('div.bang-diem-print-root') || document.querySelector('main') || document.querySelector('table');
                if (table && document.body.innerText.includes('Mã môn') && (document.body.innerText.includes('Điểm TB') || document.body.innerText.includes('Điểm HP') || document.body.innerText.includes('Tín chỉ'))) {
                    fetch('http://127.0.0.1:3030/api/v1/academic/transcript', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ html: table.outerHTML || table.innerHTML })
                    }).catch(() => {});
                    return true;
                }
            } catch(e) {}
            return false;
        })();
    "#;

    let mut extracted_html: Option<String> = None;
    let start_time = std::time::Instant::now();

    while start_time.elapsed().as_secs() < 120 {
        tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

        // Nếu user tắt cửa sổ giữa chừng -> Abort
        if app.get_webview_window(window_label).is_none() {
            let _ = app.emit(
                "academic://sync-state",
                UitSyncState::Failed("User closed window".into()),
            );
            return Err("Quá trình đăng nhập bị hủy bởi người dùng".into());
        }

        // Kiểm tra xem đã nhận được chuỗi HTML qua local bridge chưa
        if let Ok(mut guard) = html_store.lock() {
            if let Some(html) = guard.take() {
                extracted_html = Some(html);
                break;
            }
        }

        // Rust chủ động execute JS trên window và hứng kết quả (tránh remote IPC)
        let _ = sso_window.eval(extraction_script);
        let _ = app.emit("academic://sync-state", UitSyncState::Extracting);
    }

    // 3. Parsing Phase (KHÔNG LOCK DB)
    let _ = app.emit("academic://sync-state", UitSyncState::Parsing);
    let raw_html = extracted_html.ok_or_else(|| {
        let _ = app.emit(
            "academic://sync-state",
            UitSyncState::Failed("Hết thời gian chờ đăng nhập/bảng điểm (120s)".into()),
        );
        "Hết thời gian chờ đăng nhập/bảng điểm (120s)".to_string()
    })?;

    let unified_data = crate::modules::academic::parser::parse_unified_portal_payload(&raw_html)?;

    // 4. Persistence Phase (Lock DB ngắn hạn trong 1 transaction duy nhất)
    let _ = app.emit("academic://sync-state", UitSyncState::Persisting);
    {
        let mut conn = db.lock().map_err(|_| "Database lock poisoned".to_string())?;
        crate::db::academic::persist_unified_academic_sync(&mut conn, &unified_data)
            .map_err(|e| format!("Database persist error: {e}"))?;
    }

    // 5. Bước bổ sung: Cào trang ĐRL và cập nhật `drl` vào macro_metrics
    //    Bước này NON-FATAL: nếu thất bại chỉ emit warning, không abort sync.
    let _ = app.emit("academic://sync-state", UitSyncState::Extracting);

    const PORTAL_DRL_URL: &str = "https://portal.uit.edu.vn/sinh-vien/diem-ren-luyen";

    'drl_phase: {
        let Ok(drl_url) = tauri::Url::parse(PORTAL_DRL_URL) else {
            let _ = app.emit("academic://sync-warning", "URL trang ĐRL không hợp lệ");
            break 'drl_phase;
        };

        // Navigate webview hiện tại sang trang DRL (navigate nhận url::Url)
        if let Err(e) = sso_window.navigate(drl_url) {
            let _ = app.emit("academic://sync-warning", format!("Navigate DRL thất bại: {e}"));
            break 'drl_phase;
        }

        // Reset DRL store trước khi bắt đầu poll
        let drl_store = crate::server::get_extracted_drl_html_store();
        if let Ok(mut guard) = drl_store.lock() {
            *guard = None;
        }

        // JS script: chờ trang hydrate xong rồi POST outerHTML qua local bridge.
        // Dùng fetch (fire-and-forget) vì eval() không trả giá trị trong Tauri v2.
        let drl_extraction_script = r#"
            (async function() {
                try {
                    const sleep = ms => new Promise(r => setTimeout(r, ms));
                    const main = document.querySelector('main#main-content, main, div[role="main"]');
                    if (main && main.innerText && main.innerText.includes('r\u1ecdn luy\u1ec7n')) {
                        fetch('http://127.0.0.1:3030/api/v1/academic/drl', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ html: main.outerHTML })
                        }).catch(() => {});
                    }
                } catch(e) {}
            })();
        "#;

        // Poll store tối đa 20s (1.5s/lần)
        let mut extracted_drl_html: Option<String> = None;
        let drl_start = std::time::Instant::now();

        while drl_start.elapsed().as_secs() < 20 {
            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

            // Nếu user tắt cửa sổ → abort
            if app.get_webview_window(window_label).is_none() {
                break;
            }

            // Kiểm tra store
            if let Ok(mut guard) = drl_store.lock() {
                if let Some(html) = guard.take() {
                    extracted_drl_html = Some(html);
                    break;
                }
            }

            // Fire JS eval (không lấy return value)
            let _ = sso_window.eval(drl_extraction_script);
        }

        let Some(html) = extracted_drl_html else {
            let _ = app.emit("academic://sync-warning", "Hết thời gian chờ trang ĐRL (20s) — bỏ qua");
            break 'drl_phase;
        };

        match crate::modules::academic::parser::parse_portal_drl(&html) {
            Ok(drl_data) => {
                let mut conn = db.lock().map_err(|_| "Database lock poisoned".to_string())?;
                match crate::db::academic::update_drl_from_portal(&mut conn, &drl_data) {
                    Ok(n) => {
                        let _ = app.emit("academic://sync-state", UitSyncState::Persisting);
                        let _ = app.emit(
                            "academic://drl-updated",
                            format!("Đã cập nhật DRL cho {n} học kỳ (điểm TB toàn khóa: {})", drl_data.cumulative_drl),
                        );
                    }
                    Err(e) => {
                        let _ = app.emit("academic://sync-warning", format!("Ghi DRL thất bại: {e}"));
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("academic://sync-warning", format!("Parse DRL thất bại: {e}"));
            }
        }
    }

    // 6. Cleanup & Emit Complete
    if let Some(win) = app.get_webview_window(window_label) {
        let _ = win.close();
    }

    let _ = app.emit("academic://sync-state", UitSyncState::Completed);
    let _ = app.emit("academic://sync-complete", ());

    // Return latest overview
    let conn = db.lock().map_err(|_| "Database lock poisoned".to_string())?;
    let overviews = crate::modules::academic::db::calculate_academic_overview(&conn)
        .map_err(|e| e.to_string())?;

    overviews
        .first()
        .cloned()
        .ok_or_else(|| "Không tìm thấy dữ liệu học kỳ sau khi nạp".to_string())
}

/// Alias đồng bộ tương thích ngược với Sprint V0.3.1 trước đó
#[tauri::command]
pub async fn sync_portal_uit_data(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<AcademicOverviewDto, String> {
    sync_uit_portal(app, db).await
}

/// Ingest trực tiếp payload bảng điểm (từ fallback parser / paste).
#[tauri::command]
pub async fn submit_portal_transcript(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
    semesters: Vec<RawPortalSemester>,
) -> Result<AcademicOverviewDto, String> {
    if semesters.is_empty() {
        return Err("Payload bảng điểm học kỳ không có dữ liệu".to_string());
    }

    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let overview = ingest_portal_transcript(&mut conn, &semesters)
        .map_err(|e| format!("Lỗi nạp bảng điểm UIT: {e}"))?;

    // Đóng popup SSO nếu đang mở
    if let Some(w) = app.get_webview_window("uit-sso-auth") {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window("sso-login") {
        let _ = w.close();
    }

    // Trigger event academic://sync-complete
    let _ = app.emit("academic://sync-complete", &overview);

    Ok(overview)
}

/// Lấy toàn bộ macro metrics chính thức đối soát từ Cổng UIT
#[tauri::command]
pub fn get_academic_macro_metrics(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<crate::modules::academic::parser::MacroMetricRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::academic::get_all_macro_metrics(&conn)
        .map_err(|e| format!("Lỗi get_academic_macro_metrics: {e}"))
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicMacroMetricSSOT {
    pub semester_id: String,
    pub semester_label: String,
    pub year_name: String,
    pub term_gpa: f64,
    pub cumulative_gpa: f64,
    pub term_credits: i64,
    pub cumulative_credits: i64,
    pub drl_score: i64,
    pub rank_label: String,
    pub updated_at: i64,
}

/// Nạp toàn bộ bảng điểm và lịch sử ĐRL từ JSON payload
#[tauri::command]
pub fn ingest_full_academic_payload(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    match payload {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => {
            // Thử deserialize thành IngestionPayload trước
            if let Ok(dyn_payload) = serde_json::from_str::<crate::modules::academic::portal_ingestion::IngestionPayload>(&s) {
                crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(&mut conn, dyn_payload)?;
            } else {
                let req: crate::modules::academic::portal_ingestion::FullPortalIngestionRequest =
                    serde_json::from_str(&s).map_err(|e| format!("Lỗi parse JSON payload: {e}"))?;
                crate::modules::academic::portal_ingestion::execute_portal_ingest(&mut conn, req)?;
            }
        }
        Some(v) if !v.is_null() => {
            if let Ok(dyn_payload) = serde_json::from_value::<crate::modules::academic::portal_ingestion::IngestionPayload>(v.clone()) {
                crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(&mut conn, dyn_payload)?;
            } else {
                let req: crate::modules::academic::portal_ingestion::FullPortalIngestionRequest =
                    serde_json::from_value(v).map_err(|e| format!("Lỗi parse object payload: {e}"))?;
                crate::modules::academic::portal_ingestion::execute_portal_ingest(&mut conn, req)?;
            }
        }
        _ => {
            let req = crate::modules::academic::portal_ingestion::get_default_portal_seed();
            crate::modules::academic::portal_ingestion::execute_portal_ingest(&mut conn, req)?;
        }
    };

    let _ = app.emit("academic://sync-complete", ());
    Ok(())
}

/// Nạp dữ liệu học vụ linh hoạt từ chuỗi JSON generic
#[tauri::command]
pub fn ingest_dynamic_academic_data(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
    payload_json: String,
    db_path: Option<String>,
) -> Result<(), String> {
    let payload: crate::modules::academic::portal_ingestion::IngestionPayload =
        serde_json::from_str(&payload_json).map_err(|e| format!("Lỗi parse JSON payload: {e}"))?;

    if let Some(path) = db_path.filter(|p| !p.trim().is_empty()) {
        crate::modules::academic::portal_ingestion::ingest_dynamic_academic_data(path, payload_json)?;
    } else {
        let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(&mut conn, payload)?;
    }

    let _ = app.emit("academic://sync-complete", ());
    Ok(())
}

/// Lấy danh sách macro metrics theo chuẩn SSOT (phục vụ Cards và Semester Tabs)
#[tauri::command]
pub fn get_academic_macro_metrics_ssot(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<AcademicMacroMetricSSOT>, String> {
    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    let query_fn = |c: &rusqlite::Connection| -> Result<Vec<AcademicMacroMetricSSOT>, String> {
        let mut stmt = c
            .prepare(
                r#"
                SELECT semester_id, 
                       COALESCE(NULLIF(semester_label, ''), 'Học kỳ ' || semester_id),
                       COALESCE(NULLIF(year_name, ''), '2025-2026'),
                       term_gpa, cumulative_gpa, term_credits, cumulative_credits,
                       COALESCE(NULLIF(drl_score, 0), drl, 0),
                       COALESCE(NULLIF(rank_label, ''), classification, 'Giỏi'),
                       updated_at
                FROM academic_macro_metrics
                ORDER BY semester_id ASC
                "#,
            )
            .map_err(|e| format!("Lỗi prepare query: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(AcademicMacroMetricSSOT {
                    semester_id: row.get(0)?,
                    semester_label: row.get(1)?,
                    year_name: row.get(2)?,
                    term_gpa: row.get(3)?,
                    cumulative_gpa: row.get(4)?,
                    term_credits: row.get(5)?,
                    cumulative_credits: row.get(6)?,
                    drl_score: row.get(7)?,
                    rank_label: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|e| format!("Lỗi query: {e}"))?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r.map_err(|e| e.to_string())?);
        }
        Ok(list)
    };

    let has_mock: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM academic_courses WHERE course_code LIKE 'PE00%' OR (course_code = 'CS005' AND semester_id = '2025-2026.2')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|cnt| cnt > 0)
        .unwrap_or(false);

    let mut list = query_fn(&conn)?;

    // Tự động dọn dẹp mock và seed dữ liệu chuẩn nếu phát hiện mock courses hoặc DB trống
    if list.is_empty() || has_mock {
        crate::db::academic::purge_and_seed_canonical_data(&mut conn)
            .map_err(|e| format!("Lỗi purge_and_seed_canonical_data: {e}"))?;
        list = query_fn(&conn)?;
    }

    Ok(list)
}

/// Lệnh gọi trực tiếp để dọn sạch toàn bộ mock courses và nạp lại dữ liệu chuẩn xác 100% của UIT
#[tauri::command]
pub fn purge_and_seed_canonical_academic_data(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<(), String> {
    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::academic::purge_and_seed_canonical_data(&mut conn)
        .map_err(|e| format!("Lỗi purge_and_seed_canonical_data: {e}"))?;
    let _ = app.emit("academic://sync-complete", ());
    Ok(())
}

/// Lấy toàn bộ danh mục chương trình đào tạo & tiến độ học tập
#[tauri::command]
pub fn get_academic_curriculum(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<crate::modules::academic::parser::CurriculumCourseRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::academic::get_all_curriculum_courses(&conn)
        .map_err(|e| format!("Lỗi get_academic_curriculum: {e}"))
}
