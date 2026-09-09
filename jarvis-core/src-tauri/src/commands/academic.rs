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

/// Đồng bộ bảng điểm từ Cổng thông tin Next.js mới của UIT (portal.uit.edu.vn).
///
/// Flow:
/// 1. Mở cửa sổ Webview tạm thời `sso-login` trỏ tới `https://portal.uit.edu.vn/sinh-vien/bang-diem`.
/// 2. Bắt cookie session hoặc phân giải payload bảng điểm đã hydrate.
/// 3. Kéo dữ liệu bảng điểm học kỳ và batch upsert vào `academic_courses` qua transaction.
/// 4. Đóng popup và trigger event `academic://sync-complete`.
#[tauri::command]
pub async fn sync_portal_uit_data(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<AcademicOverviewDto, String> {
    // 1. Mở hoặc focus cửa sổ popup SSO
    if let Some(w) = app.get_webview_window("sso-login") {
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        let parsed_url = PORTAL_BANG_DIEM_URL
            .parse()
            .map_err(|e| format!("URL không hợp lệ: {e}"))?;

        let _ = WebviewWindowBuilder::new(&app, "sso-login", WebviewUrl::External(parsed_url))
            .title("Đăng nhập Cổng thông tin UIT (SSO)")
            .inner_size(1024.0, 768.0)
            .center()
            .build()
            .map_err(|e| format!("Không thể khởi tạo Webview SSO: {e}"))?;
    }

    // 2. Trả về overview hiện tại (hoặc overview mới nhất khi sync xong)
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let overviews = get_all_semesters_with_stats(&conn)
        .map_err(|e| format!("Lỗi truy vấn academic overview: {e}"))?;

    if let Some(first) = overviews.first() {
        Ok(first.clone())
    } else {
        Ok(SemesterOverview {
            id: "2024_2025_HK1".to_string(),
            academic_year: "2024-2025".to_string(),
            semester_term: 1,
            target_gpa: None,
            target_drl: None,
            is_completed: false,
            created_at: chrono::Utc::now().timestamp(),
            updated_at: chrono::Utc::now().timestamp(),
            actual_gpa_10: None,
            actual_gpa_4: None,
            actual_drl: 0,
            passed_credits: 0,
            total_credits: 0,
        })
    }
}

/// Ingest trực tiếp payload bảng điểm (từ Webview injected script hoặc từ fallback parser / paste).
/// Đóng cửa sổ `sso-login` nếu đang mở và phát event `academic://sync-complete`.
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
    if let Some(w) = app.get_webview_window("sso-login") {
        let _ = w.close();
    }

    // Trigger event academic://sync-complete
    let _ = app.emit("academic://sync-complete", &overview);

    Ok(overview)
}

