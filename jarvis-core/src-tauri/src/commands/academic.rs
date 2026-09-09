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
