//! UIT Portal Ingestion Service
//!
//! Module xử lý việc nạp và chuẩn hoá bảng điểm từ Cổng thông tin Next.js mới
//! của Đại học Công nghệ Thông tin (UIT) — `portal.uit.edu.vn`.
//!
//! Đảm bảo:
//! 1. Phân giải định dạng header học kỳ (`Học kỳ {term}/{start_year}-{end_year}` -> `{start_year}_{end_year}_HK{term}`).
//! 2. Phân loại chuẩn GPA exclusion: Các mã môn bắt đầu bằng `PE` (Thể chất) và `ME` (Quốc phòng)
//!    bị loại khỏi GPA (`is_gpa_calculated = 0`). Mọi mã khác (`IT002`, `ENG01`, `CS005`, `SS007`) đều tính GPA.
//! 3. Batch upsert an toàn vào cơ sở dữ liệu SQLite qua transaction.

use crate::db::{
    get_all_semesters_with_stats, upsert_courses, upsert_semester, SemesterOverview,
    UpsertCourseDto, UpsertSemesterDto,
};
use crate::error::{AppError, AppResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPortalCourse {
    pub course_code: String,
    pub course_name: String,
    pub credits: i64,
    #[serde(default)]
    pub process_score: Option<f64>,
    #[serde(default)]
    pub practice_score: Option<f64>,
    #[serde(default)]
    pub midterm_score: Option<f64>,
    #[serde(default)]
    pub final_score: Option<f64>,
    pub summary_score_10: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPortalSemester {
    pub header: String, // e.g. "Học kỳ 1/2024-2025" hoặc "2024_2025_HK1"
    pub courses: Vec<RawPortalCourse>,
}

/// Kiểm tra xem mã môn học có được tính vào GPA hay không theo quy chế ĐHQG-HCM / UIT.
///
/// Quy tắc:
/// - Môn bắt đầu bằng "PE" (Physical Education - GDTC): Không tính GPA (`false`).
/// - Môn bắt đầu bằng "ME" (Military Education - GDQP): Không tính GPA (`false`).
/// - Mọi mã khác (kể cả ENG, CS, SS, IT, MA...): Tính GPA (`true`).
pub fn is_course_gpa_calculated(course_code: &str) -> bool {
    let normalized = course_code.trim().to_uppercase();
    !normalized.starts_with("PE") && !normalized.starts_with("ME")
}

/// Phân giải header học kỳ sang (semester_id, academic_year, semester_term).
///
/// Hỗ trợ các mẫu header phổ biến trên portal UIT:
/// - "Học kỳ 1/2024-2025" -> ("2024_2025_HK1", "2024-2025", 1)
/// - "Học kỳ 2/2023-2024" -> ("2023_2024_HK2", "2023-2024", 2)
/// - "Học kỳ hè/2023-2024" hoặc "Học kỳ 3/..." -> ("2023_2024_HK3", "2023-2024", 3)
/// - "HK1/2024-2025" -> ("2024_2025_HK1", "2024-2025", 1)
/// - "2024_2025_HK1" -> ("2024_2025_HK1", "2024-2025", 1)
pub fn parse_semester_header(header: &str) -> Option<(String, String, i64)> {
    let raw = header.trim();
    if raw.is_empty() {
        return None;
    }

    // Pattern 1: {start}_{end}_HK{term}
    if let Some(rest) = raw.strip_prefix(|c: char| c.is_ascii_digit()) {
        let parts: Vec<&str> = raw.split('_').collect();
        if parts.len() == 3 && parts[2].starts_with("HK") {
            let start = parts[0];
            let end = parts[1];
            let term_str = parts[2].strip_prefix("HK")?;
            let term: i64 = term_str.parse().ok()?;
            let academic_year = format!("{start}-{end}");
            return Some((raw.to_string(), academic_year, term));
        }
        let _ = rest;
    }

    // Pattern 2: "Học kỳ X/YYYY-ZZZZ" hoặc "HK X/YYYY-ZZZZ"
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() == 2 {
        let left = parts[0].trim();
        let right = parts[1].trim();

        // Parse academic year "YYYY-ZZZZ"
        let year_parts: Vec<&str> = right.split('-').collect();
        if year_parts.len() == 2 {
            let start_year = year_parts[0].trim();
            let end_year = year_parts[1].trim();

            let term: i64 = if left.contains('1') {
                1
            } else if left.contains('2') {
                2
            } else if left.contains('3') || left.to_lowercase().contains("hè") || left.to_lowercase().contains("he") {
                3
            } else {
                1
            };

            let semester_id = format!("{start_year}_{end_year}_HK{term}");
            let academic_year = format!("{start_year}-{end_year}");
            return Some((semester_id, academic_year, term));
        }
    }

    None
}

/// Phân giải payload JSON bảng điểm từ API hoặc DOM hydrate payload.
pub fn parse_portal_json_payload(json_str: &str) -> AppResult<Vec<RawPortalSemester>> {
    serde_json::from_str::<Vec<RawPortalSemester>>(json_str).map_err(|e| {
        AppError::TranscriptParse(format!("JSON bảng điểm không hợp lệ: {e}"))
    })
}

/// Nạp danh sách học kỳ và môn học từ Cổng UIT vào SQLite trong 1 transaction an toàn.
/// Trả về `SemesterOverview` của học kỳ vừa nạp (hoặc học kỳ mới nhất).
pub fn ingest_portal_transcript(
    conn: &mut Connection,
    semesters: &[RawPortalSemester],
) -> AppResult<SemesterOverview> {
    if semesters.is_empty() {
        return Err(AppError::TranscriptParse("Không có dữ liệu học kỳ nào để nạp".to_string()));
    }

    let mut last_semester_id = String::new();

    for sem in semesters {
        let (semester_id, academic_year, term) = parse_semester_header(&sem.header).ok_or_else(|| {
            AppError::TranscriptParse(format!("Không thể nhận dạng tiêu đề học kỳ: '{}'", sem.header))
        })?;

        last_semester_id = semester_id.clone();

        // 1. Tạo hoặc cập nhật metadata học kỳ
        upsert_semester(
            conn,
            &UpsertSemesterDto {
                id: semester_id.clone(),
                academic_year,
                semester_term: term,
                target_gpa: None,
                target_drl: None,
                is_completed: Some(true),
            },
        )?;

        // 2. Chuẩn bị danh sách UpsertCourseDto
        let mut courses_to_upsert = Vec::with_capacity(sem.courses.len());
        for c in &sem.courses {
            let is_gpa = is_course_gpa_calculated(&c.course_code);
            courses_to_upsert.push(UpsertCourseDto {
                id: None,
                semester_id: semester_id.clone(),
                course_code: c.course_code.trim().to_uppercase(),
                course_name: c.course_name.trim().to_string(),
                credits: c.credits,
                midterm_score: c.midterm_score,
                final_score: c.final_score,
                other_scores: None,
                summary_score_10: Some(c.summary_score_10),
                is_gpa_calculated: Some(is_gpa),
            });
        }

        // 3. Batch upsert môn học
        upsert_courses(conn, &courses_to_upsert)?;
    }

    // 4. Lấy overview mới nhất sau khi upsert
    let all_overviews = get_all_semesters_with_stats(conn)?;
    let target_overview = all_overviews
        .iter()
        .find(|s| s.id == last_semester_id)
        .cloned()
        .or_else(|| all_overviews.first().cloned())
        .ok_or_else(|| AppError::TranscriptParse("Không tìm thấy thống kê học kỳ sau khi nạp".to_string()))?;

    Ok(target_overview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_semester_header_standard_vietnamese() {
        let parsed = parse_semester_header("Học kỳ 1/2024-2025");
        assert_eq!(
            parsed,
            Some(("2024_2025_HK1".to_string(), "2024-2025".to_string(), 1))
        );

        let parsed2 = parse_semester_header("Học kỳ 2/2023-2024");
        assert_eq!(
            parsed2,
            Some(("2023_2024_HK2".to_string(), "2023-2024".to_string(), 2))
        );

        let parsed_summer = parse_semester_header("Học kỳ hè/2023-2024");
        assert_eq!(
            parsed_summer,
            Some(("2023_2024_HK3".to_string(), "2023-2024".to_string(), 3))
        );
    }

    #[test]
    fn test_parse_semester_header_short_or_direct_id() {
        let parsed = parse_semester_header("HK1/2024-2025");
        assert_eq!(
            parsed,
            Some(("2024_2025_HK1".to_string(), "2024-2025".to_string(), 1))
        );

        let parsed_direct = parse_semester_header("2024_2025_HK1");
        assert_eq!(
            parsed_direct,
            Some(("2024_2025_HK1".to_string(), "2024-2025".to_string(), 1))
        );
    }

    #[test]
    fn test_gpa_exclusion_rule_pe_and_me() {
        // PE (Thể chất) & ME (Quốc phòng) -> false
        assert!(!is_course_gpa_calculated("PE001"));
        assert!(!is_course_gpa_calculated("pe002"));
        assert!(!is_course_gpa_calculated("ME001"));
        assert!(!is_course_gpa_calculated("me005"));

        // Tất cả môn học khác -> true
        assert!(is_course_gpa_calculated("IT002"));
        assert!(is_course_gpa_calculated("ENG01"));
        assert!(is_course_gpa_calculated("CS005"));
        assert!(is_course_gpa_calculated("SS007"));
        assert!(is_course_gpa_calculated("MA004"));
    }

    #[test]
    fn test_ingest_portal_transcript_calculates_and_excludes_properly() {
        let mut conn = Connection::open_in_memory().expect("open memory db");
        conn.execute_batch(
            r#"
            CREATE TABLE academic_semesters (
                id TEXT PRIMARY KEY,
                academic_year TEXT NOT NULL,
                semester_term INTEGER NOT NULL,
                target_gpa REAL,
                target_drl INTEGER,
                is_completed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE academic_courses (
                id TEXT PRIMARY KEY,
                semester_id TEXT NOT NULL,
                course_code TEXT NOT NULL,
                course_name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                midterm_score REAL,
                final_score REAL,
                other_scores TEXT,
                summary_score_10 REAL,
                summary_score_4 REAL,
                grade_char TEXT,
                is_passed INTEGER NOT NULL DEFAULT 0,
                is_gpa_calculated INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(semester_id) REFERENCES academic_semesters(id) ON DELETE CASCADE,
                UNIQUE(semester_id, course_code)
            );
            CREATE TABLE academic_drl_events (
                id TEXT PRIMARY KEY,
                semester_id TEXT NOT NULL,
                event_name TEXT NOT NULL,
                category TEXT NOT NULL,
                points INTEGER NOT NULL,
                proof_url TEXT,
                status TEXT NOT NULL DEFAULT 'PLANNED',
                created_at INTEGER NOT NULL
            );
            "#,
        )
        .expect("init schema");

        let payload = vec![RawPortalSemester {
            header: "Học kỳ 1/2024-2025".to_string(),
            courses: vec![
                RawPortalCourse {
                    course_code: "IT002".to_string(),
                    course_name: "Lập trình hướng đối tượng".to_string(),
                    credits: 4,
                    process_score: Some(9.0),
                    practice_score: None,
                    midterm_score: Some(8.5),
                    final_score: Some(9.0),
                    summary_score_10: 9.0, // A+ (4.0)
                },
                RawPortalCourse {
                    course_code: "PE001".to_string(),
                    course_name: "Giáo dục thể chất 1".to_string(),
                    credits: 2,
                    process_score: None,
                    practice_score: None,
                    midterm_score: None,
                    final_score: None,
                    summary_score_10: 10.0, // Không được tính vào GPA!
                },
            ],
        }];

        let overview = ingest_portal_transcript(&mut conn, &payload).expect("ingest success");
        assert_eq!(overview.id, "2024_2025_HK1");
        assert_eq!(overview.academic_year, "2024-2025");
        assert_eq!(overview.semester_term, 1);
        assert_eq!(overview.total_credits, 6); // 4 + 2
        assert_eq!(overview.passed_credits, 6);

        // GPA chỉ tính IT002 (9.0 hệ 10, 4.0 hệ 4) — PE001 bị loại trừ
        assert!(
            (overview.actual_gpa_10.unwrap() - 9.0).abs() < 0.001,
            "actual_gpa_10 must be 9.0, got {:?}",
            overview.actual_gpa_10
        );
        assert!(
            (overview.actual_gpa_4.unwrap() - 4.0).abs() < 0.001,
            "actual_gpa_4 must be 4.0, got {:?}",
            overview.actual_gpa_4
        );
    }
}
