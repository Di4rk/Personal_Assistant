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
        (function() {
            try {
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

    let parsed_semesters = crate::modules::academic::parser::parse_portal_transcript(&raw_html)?;

    // 4. Persistence Phase (Lock DB ngắn hạn)
    let _ = app.emit("academic://sync-state", UitSyncState::Persisting);
    {
        let mut conn = db.lock().map_err(|_| "Database lock poisoned".to_string())?;
        crate::db::academic::persist_portal_sync(&mut conn, &parsed_semesters)
            .map_err(|e| format!("Database persist error: {e}"))?;
    }

    // 5. Cleanup & Emit Complete
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


