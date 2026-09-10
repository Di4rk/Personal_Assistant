//! Portal JSON Ingestion Pipeline — Sprint v0.3.4 & v0.4.1 Generic Ingestion
//!
//! Nạp trực tiếp payload bảng điểm học kỳ và lịch sử ĐRL từ cổng thông tin UIT:
//! - Hỗ trợ arbitrary curriculums, majors, course codes, và terms thông qua generic JSON.
//! - Tạo/cập nhật `academic_macro_metrics` (Single Source of Truth cho Cards và DRL)
//! - Tạo/cập nhật `academic_courses` gắn chặt vào semester_id

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GenericSubject {
    pub id: Option<String>,
    pub subject_code: String,
    pub subject_name: String,
    pub number_of_credit: i32,
    pub course_point: Option<String>,
    pub midterm_score: Option<String>,
    pub practice_point: Option<String>,
    pub final_point: Option<String>,
    pub process_point: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GenericSemesterGroup {
    pub semester_key: String,   // E.g., "semester_1", "semester_2"
    pub semester_label: String, // E.g., "Học kỳ 1/2025-2026"
    pub year_name: String,
    pub total_credit: Option<i32>,
    pub average_point: Option<f64>,
    pub subjects: Vec<GenericSubject>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GenericTermSummary {
    pub semester: String,
    #[serde(alias = "termGpa", alias = "term_gpa")]
    pub term_gpa: Option<f64>,
    #[serde(alias = "cumulativeGpa", alias = "cumulative_gpa")]
    pub cumulative_gpa: Option<f64>,
    #[serde(alias = "termCredit", alias = "term_credit")]
    pub term_credit: Option<i32>,
    #[serde(alias = "accumulatedCredit", alias = "accumulated_credit")]
    pub accumulated_credit: Option<i32>,
    #[serde(alias = "classifyLabel", alias = "classify_label")]
    pub classify_label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GenericDrlItem {
    pub semester: String,
    pub point: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IngestionPayload {
    pub semester_groups: Vec<GenericSemesterGroup>,
    pub term_summaries: Option<Vec<GenericTermSummary>>,
    pub drl_history: Option<Vec<GenericDrlItem>>,
}

pub fn parse_score(val: &Option<String>) -> Option<f64> {
    val.as_ref().and_then(|s| s.trim().parse::<f64>().ok())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WeightsPayload {
    pub midterm: Option<f64>,
    pub process: Option<f64>,
    pub practice: Option<f64>,
    pub final_weight: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SubjectPayload {
    pub id: String,
    pub subject_code: String,
    pub subject_name: String,
    pub number_of_credit: i32,
    pub process_point: Option<String>,
    pub midterm_score: Option<String>,
    pub practice_point: Option<String>,
    pub final_point: Option<String>,
    pub course_point: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SemesterGroupPayload {
    pub semester_key: String,   // "semester_1", "semester_2"
    pub semester_label: String, // "Học kỳ 1/2025-2026"
    pub year_name: String,      // "2025-2026"
    pub total_credit: i32,
    pub average_point: f64,
    pub subjects: Vec<SubjectPayload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DrlItemPayload {
    pub semester: String,       // "semester_1", "semester_2"
    pub point: i32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FullPortalIngestionRequest {
    pub semester_groups: Vec<SemesterGroupPayload>,
    pub drl_history: Vec<DrlItemPayload>,
}

/// Nạp dữ liệu học vụ linh hoạt từ payload generic vào SQLite
pub fn ingest_dynamic_academic_payload(
    conn: &mut Connection,
    payload: IngestionPayload,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp();

    // 1. Build lookup map cho DRL (nếu có)
    let mut drl_map = std::collections::HashMap::new();
    if let Some(drl_list) = payload.drl_history {
        for d in drl_list {
            drl_map.insert(d.semester, d.point);
        }
    }

    // 2. Build lookup map cho Term Summary chính thức (nếu có)
    let mut summary_map = std::collections::HashMap::new();
    if let Some(summaries) = payload.term_summaries {
        for s in summaries {
            summary_map.insert(s.semester.clone(), s);
        }
    }

    let mut running_credits = 0;

    // 3. Dynamic iteration qua từng học kỳ của sinh viên
    for group in payload.semester_groups {
        let sem_num = group.semester_key.replace("semester_", "");
        let semester_id = format!("{}.{}", group.year_name, sem_num);

        let sum_item = summary_map.get(&sem_num);
        let term_gpa = sum_item.and_then(|s| s.term_gpa).or(group.average_point).unwrap_or(0.0);
        let cum_gpa = sum_item.and_then(|s| s.cumulative_gpa).unwrap_or(term_gpa);
        let term_credits = sum_item.and_then(|s| s.term_credit).or(group.total_credit).unwrap_or(0);
        running_credits += term_credits;
        let cum_credits = sum_item.and_then(|s| s.accumulated_credit).unwrap_or(running_credits);
        let classification = sum_item
            .and_then(|s| s.classify_label.clone())
            .unwrap_or_else(|| {
                if cum_gpa >= 9.0 {
                    "Xuất sắc".to_string()
                } else if cum_gpa >= 8.0 {
                    "Giỏi".to_string()
                } else if cum_gpa >= 6.5 {
                    "Khá".to_string()
                } else if cum_gpa >= 5.0 {
                    "Trung bình".to_string()
                } else if cum_gpa > 0.0 {
                    "Yếu".to_string()
                } else {
                    "Chưa xếp loại".to_string()
                }
            });
        let drl = *drl_map.get(&group.semester_key).unwrap_or(&0);

        // Đảm bảo academic_semesters có bản ghi để thỏa mãn foreign key
        tx.execute(
            "INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
            params![
                semester_id,
                group.year_name,
                sem_num.parse::<i64>().unwrap_or(1),
                now
            ],
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT INTO academic_macro_metrics 
                (semester_id, semester_label, year_name, term_gpa, cumulative_gpa, term_credits, cumulative_credits, drl_score, classification, rank_label, drl, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?8, ?10)
             ON CONFLICT(semester_id) DO UPDATE SET
                semester_label = excluded.semester_label,
                year_name = excluded.year_name,
                term_gpa = excluded.term_gpa,
                cumulative_gpa = excluded.cumulative_gpa,
                term_credits = excluded.term_credits,
                cumulative_credits = excluded.cumulative_credits,
                drl_score = excluded.drl_score,
                classification = excluded.classification,
                rank_label = excluded.rank_label,
                drl = excluded.drl,
                updated_at = excluded.updated_at",
            params![
                semester_id,
                group.semester_label,
                group.year_name,
                term_gpa,
                cum_gpa,
                term_credits,
                cum_credits,
                drl,
                classification,
                now
            ],
        ).map_err(|e| e.to_string())?;

        // 4. Ingest dynamic subjects
        let mut stmt = tx.prepare_cached(
            "INSERT INTO academic_courses 
                (id, semester_id, course_code, course_name, credits, process_point, practice_point, midterm_score, final_point, course_point, grade_4, grade_char, result_status, category, summary_score_10, summary_score_4, final_score, is_passed, is_gpa_calculated, status, note, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?10, ?11, ?9, 1, 1, 'passed', ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET
                course_point = excluded.course_point,
                process_point = excluded.process_point,
                practice_point = excluded.practice_point,
                midterm_score = excluded.midterm_score,
                final_point = excluded.final_point,
                grade_4 = excluded.grade_4,
                grade_char = excluded.grade_char,
                result_status = excluded.result_status,
                category = excluded.category,
                status = excluded.status,
                note = excluded.note,
                updated_at = excluded.updated_at"
        ).map_err(|e| e.to_string())?;

        for sub in group.subjects {
            let unique_id = sub.id.unwrap_or_else(|| format!("{}_{}", sub.subject_code, semester_id));
            let final_score = parse_score(&sub.course_point).unwrap_or(0.0);
            let grade = crate::db::academic::GradeScale::from_score_10(final_score);
            let grade_s4 = grade.to_scale_4();
            let grade_char = grade.as_char();
            let result_status = if grade.is_passed() { "Đạt" } else { "Không đạt" };
            let category = if sub.subject_code.starts_with("IT") || sub.subject_code.starts_with("CS") {
                "co_so_nganh"
            } else {
                "dai_cuong"
            };

            stmt.execute(params![
                unique_id,
                semester_id,
                sub.subject_code,
                sub.subject_name,
                sub.number_of_credit,
                parse_score(&sub.process_point),
                parse_score(&sub.practice_point),
                parse_score(&sub.midterm_score),
                parse_score(&sub.final_point),
                final_score,
                grade_s4,
                grade_char,
                result_status,
                category,
                sub.note.unwrap_or_default(),
                now
            ]).map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Nạp dữ liệu học vụ trực tiếp qua đường dẫn database và chuỗi JSON
pub fn ingest_dynamic_academic_data(db_path: String, payload_json: String) -> Result<(), String> {
    let payload: IngestionPayload = serde_json::from_str(&payload_json)
        .map_err(|e| format!("JSON parsing failure: {e}"))?;

    let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    ingest_dynamic_academic_payload(&mut conn, payload)
}

/// Tương thích ngược: Nạp dữ liệu học vụ từ FullPortalIngestionRequest
pub fn execute_portal_ingest(
    conn: &mut Connection,
    data: FullPortalIngestionRequest,
) -> Result<(), String> {
    let generic_groups: Vec<GenericSemesterGroup> = data
        .semester_groups
        .into_iter()
        .map(|g| GenericSemesterGroup {
            semester_key: g.semester_key,
            semester_label: g.semester_label,
            year_name: g.year_name,
            total_credit: Some(g.total_credit),
            average_point: Some(g.average_point),
            subjects: g
                .subjects
                .into_iter()
                .map(|s| GenericSubject {
                    id: Some(s.id),
                    subject_code: s.subject_code,
                    subject_name: s.subject_name,
                    number_of_credit: s.number_of_credit,
                    course_point: Some(s.course_point),
                    midterm_score: s.midterm_score,
                    practice_point: s.practice_point,
                    final_point: s.final_point,
                    process_point: s.process_point,
                    note: s.note,
                })
                .collect(),
        })
        .collect();

    let generic_drl: Vec<GenericDrlItem> = data
        .drl_history
        .into_iter()
        .map(|d| GenericDrlItem {
            semester: d.semester,
            point: d.point,
        })
        .collect();

    let payload = IngestionPayload {
        semester_groups: generic_groups,
        term_summaries: None,
        drl_history: Some(generic_drl),
    };

    ingest_dynamic_academic_payload(conn, payload)
}

/// Dữ liệu mẫu chuẩn của UIT theo đặc tả canonical (HK1: 6 môn - 18 TC, HK2: 7 môn - 24 TC)
pub fn get_default_portal_seed() -> FullPortalIngestionRequest {
    FullPortalIngestionRequest {
        semester_groups: vec![
            SemesterGroupPayload {
                semester_key: "semester_1".to_string(),
                semester_label: "Học kỳ 1/2025-2026".to_string(),
                year_name: "2025-2026".to_string(),
                total_credit: 18,
                average_point: 8.20,
                subjects: vec![
                    SubjectPayload {
                        id: "CS005-1".to_string(),
                        subject_code: "CS005".to_string(),
                        subject_name: "Giới thiệu ngành Khoa học Máy tính".to_string(),
                        number_of_credit: 1,
                        process_point: Some("10.0".to_string()),
                        midterm_score: None,
                        practice_point: None,
                        final_point: Some("9.5".to_string()),
                        course_point: "9.7".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "ENG01-2".to_string(),
                        subject_code: "ENG01".to_string(),
                        subject_name: "Anh văn 1".to_string(),
                        number_of_credit: 4,
                        process_point: Some("8.0".to_string()),
                        midterm_score: None,
                        practice_point: None,
                        final_point: Some("7.5".to_string()),
                        course_point: "7.7".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "IT001-3".to_string(),
                        subject_code: "IT001".to_string(),
                        subject_name: "Nhập môn lập trình".to_string(),
                        number_of_credit: 4,
                        process_point: Some("10.0".to_string()),
                        midterm_score: None,
                        practice_point: Some("9.5".to_string()),
                        final_point: Some("8.5".to_string()),
                        course_point: "9.1".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "MA003-4".to_string(),
                        subject_code: "MA003".to_string(),
                        subject_name: "Đại số tuyến tính".to_string(),
                        number_of_credit: 3,
                        process_point: Some("10.0".to_string()),
                        midterm_score: Some("9.5".to_string()),
                        practice_point: None,
                        final_point: Some("10.0".to_string()),
                        course_point: "9.9".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "MA006-5".to_string(),
                        subject_code: "MA006".to_string(),
                        subject_name: "Giải tích".to_string(),
                        number_of_credit: 4,
                        process_point: Some("10.0".to_string()),
                        midterm_score: Some("6.5".to_string()),
                        practice_point: None,
                        final_point: Some("7.0".to_string()),
                        course_point: "7.5".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "SS006-6".to_string(),
                        subject_code: "SS006".to_string(),
                        subject_name: "Pháp luật đại cương".to_string(),
                        number_of_credit: 2,
                        process_point: None,
                        midterm_score: Some("5.5".to_string()),
                        practice_point: None,
                        final_point: Some("5.5".to_string()),
                        course_point: "5.5".to_string(),
                        note: None,
                    },
                ],
            },
            SemesterGroupPayload {
                semester_key: "semester_2".to_string(),
                semester_label: "Học kỳ 2/2025-2026".to_string(),
                year_name: "2025-2026".to_string(),
                total_credit: 24,
                average_point: 8.55,
                subjects: vec![
                    SubjectPayload {
                        id: "IT002-1".to_string(),
                        subject_code: "IT002".to_string(),
                        subject_name: "Lập trình hướng đối tượng".to_string(),
                        number_of_credit: 4,
                        process_point: Some("10.0".to_string()),
                        midterm_score: None,
                        practice_point: Some("9.0".to_string()),
                        final_point: Some("6.5".to_string()),
                        course_point: "8.0".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "IT003-2".to_string(),
                        subject_code: "IT003".to_string(),
                        subject_name: "Cấu trúc dữ liệu và giải thuật".to_string(),
                        number_of_credit: 4,
                        process_point: Some("10.0".to_string()),
                        midterm_score: None,
                        practice_point: Some("9.0".to_string()),
                        final_point: Some("7.5".to_string()),
                        course_point: "8.5".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "IT012-3".to_string(),
                        subject_code: "IT012".to_string(),
                        subject_name: "Tổ chức và cấu trúc máy tính 2".to_string(),
                        number_of_credit: 4,
                        process_point: Some("10.0".to_string()),
                        midterm_score: Some("8.5".to_string()),
                        practice_point: Some("9.5".to_string()),
                        final_point: Some("8.5".to_string()),
                        course_point: "8.9".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "MA004-4".to_string(),
                        subject_code: "MA004".to_string(),
                        subject_name: "Cấu trúc rời rạc".to_string(),
                        number_of_credit: 4,
                        process_point: Some("10.0".to_string()),
                        midterm_score: Some("8.5".to_string()),
                        practice_point: None,
                        final_point: Some("10.0".to_string()),
                        course_point: "9.7".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "MA005-5".to_string(),
                        subject_code: "MA005".to_string(),
                        subject_name: "Xác suất thống kê".to_string(),
                        number_of_credit: 3,
                        process_point: Some("10.0".to_string()),
                        midterm_score: Some("8.0".to_string()),
                        practice_point: None,
                        final_point: Some("9.5".to_string()),
                        course_point: "9.3".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "SS004-6".to_string(),
                        subject_code: "SS004".to_string(),
                        subject_name: "Kỹ năng nghề nghiệp".to_string(),
                        number_of_credit: 2,
                        process_point: Some("10.0".to_string()),
                        midterm_score: None,
                        practice_point: None,
                        final_point: Some("9.5".to_string()),
                        course_point: "9.7".to_string(),
                        note: None,
                    },
                    SubjectPayload {
                        id: "SS007-7".to_string(),
                        subject_code: "SS007".to_string(),
                        subject_name: "Triết học Mác – Lênin".to_string(),
                        number_of_credit: 3,
                        process_point: Some("7.5".to_string()),
                        midterm_score: None,
                        practice_point: None,
                        final_point: Some("4.0".to_string()),
                        course_point: "5.8".to_string(),
                        note: None,
                    },
                ],
            },
        ],
        drl_history: vec![
            DrlItemPayload {
                semester: "semester_1".to_string(),
                point: 95,
            },
            DrlItemPayload {
                semester: "semester_2".to_string(),
                point: 100,
            },
        ],
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_execute_portal_ingest_two_semesters() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::academic::ensure_academic_schema(&conn).unwrap();

        let seed = get_default_portal_seed();
        execute_portal_ingest(&mut conn, seed).unwrap();

        // Kiểm tra macro metrics có đủ 2 học kỳ
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM academic_macro_metrics", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);

        // Kiểm tra HK1 (6 môn)
        let hk1_courses: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM academic_courses WHERE semester_id = '2025-2026.1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hk1_courses, 6);

        // Kiểm tra HK2 (7 môn)
        let hk2_courses: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM academic_courses WHERE semester_id = '2025-2026.2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hk2_courses, 7);

        // Kiểm tra DRL
        let drl_hk1: i64 = conn
            .query_row(
                "SELECT drl_score FROM academic_macro_metrics WHERE semester_id = '2025-2026.1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(drl_hk1, 95);

        let drl_hk2: i64 = conn
            .query_row(
                "SELECT drl_score FROM academic_macro_metrics WHERE semester_id = '2025-2026.2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(drl_hk2, 100);

        // Tín chỉ tích lũy HK2 = 42
        let cum_credits_hk2: i64 = conn
            .query_row(
                "SELECT cumulative_credits FROM academic_macro_metrics WHERE semester_id = '2025-2026.2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cum_credits_hk2, 42);
    }

    #[test]
    fn test_ingest_dynamic_academic_data_generic_payload() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::academic::init_academic_module(&conn).unwrap();

        let json_data = r#"{
            "semester_groups": [
                {
                    "semester_key": "semester_1",
                    "semester_label": "Học kỳ 1 Năm học 2024-2025",
                    "year_name": "2024-2025",
                    "total_credit": 15,
                    "average_point": 8.0,
                    "subjects": [
                        {
                            "subject_code": "SE104",
                            "subject_name": "Nhập môn Công nghệ phần mềm",
                            "number_of_credit": 3,
                            "course_point": "8.5"
                        }
                    ]
                }
            ],
            "term_summaries": [
                {
                    "semester": "1",
                    "termGpa": 8.0,
                    "cumulativeGpa": 8.0,
                    "termCredit": 15,
                    "accumulatedCredit": 15,
                    "classifyLabel": "Giỏi"
                }
            ],
            "drl_history": [
                {
                    "semester": "semester_1",
                    "point": 90
                }
            ]
        }"#;

        let payload: IngestionPayload = serde_json::from_str(json_data).unwrap();
        ingest_dynamic_academic_payload(&mut conn, payload).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM academic_macro_metrics", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let macro_class: String = conn
            .query_row(
                "SELECT classification FROM academic_macro_metrics WHERE semester_id = '2024-2025.1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(macro_class, "Giỏi");

        let course_code: String = conn
            .query_row("SELECT course_code FROM academic_courses", [], |r| r.get(0))
            .unwrap();
        assert_eq!(course_code, "SE104");
    }
}
