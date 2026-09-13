//! Automated Multi-Stage Portal UIT Harvester Service (AMENDED v2.1)
//!
//! Provides batch buffering, hash fragment checkpoint handling, completeness guard,
//! dynamic curriculum resolution, and atomic SQLite transaction committing.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub mod models {
    use super::*;

    #[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq)]
    pub struct PortalProfilePayload {
        pub student_id: String,
        pub full_name: String,
        #[serde(default)]
        pub faculty: String,
        #[serde(default)]
        pub major_code: String,
        #[serde(default)]
        pub specialization: String,
        #[serde(default)]
        pub student_class: String,
        #[serde(default)]
        pub curriculum_code: String,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq)]
    pub struct DrlItem {
        pub semester: String,
        pub score: i64,
        #[serde(default)]
        pub grade_text: String,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq)]
    pub struct AcademicCourseItem {
        pub course_code: String,
        pub course_name: String,
        #[serde(default)]
        pub semester: String,
        #[serde(default)]
        pub credits: i64,
        #[serde(default)]
        pub score_qt: Option<f64>,
        #[serde(default)]
        pub score_th: Option<f64>,
        #[serde(default)]
        pub score_gk: Option<f64>,
        #[serde(default)]
        pub score_ck: Option<f64>,
        #[serde(default)]
        pub score_10: f64,
        #[serde(default)]
        pub is_passed: i64,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct SemesterSummaryItem {
        #[serde(default)]
        pub semester: Option<String>,
        #[serde(default)]
        pub gpa_semester: Option<f64>,
        #[serde(default)]
        pub cpa_cumulative: Option<f64>,
        #[serde(default)]
        pub ranking: Option<String>,
        #[serde(default)]
        pub credits_semester: Option<i64>,
        #[serde(default)]
        pub credits_cumulative: Option<i64>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct PortalSummaryPayload {
        #[serde(default)]
        pub total_credits: f64,
        #[serde(default)]
        pub cgpa_10: f64,
        #[serde(default)]
        pub semester_summaries: Vec<SemesterSummaryItem>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct PortalMetaPayload {
        pub profile: Option<PortalProfilePayload>,
        pub summary: Option<PortalSummaryPayload>,
        pub avg_drl: Option<f64>,
        #[serde(default)]
        pub drl_records: Option<Vec<DrlItem>>,
        #[serde(default)]
        pub total_course_batches: usize,
    }
}

pub use models::*;

#[derive(Default, Clone, Debug)]
pub struct PortalBatchBuffer {
    pub meta: Option<PortalMetaPayload>,
    pub courses_batches: HashMap<usize, Vec<AcademicCourseItem>>,
}

#[derive(Default, Clone)]
pub struct PortalHarvesterRegistry {
    pub sessions: Arc<Mutex<HashMap<String, PortalBatchBuffer>>>,
}

impl PortalHarvesterRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn handle_meta(&self, window_label: &str, meta: PortalMetaPayload) -> Result<(), String> {
        let mut guard = self.sessions.lock().map_err(|e| format!("Mutex poisoned: {e}"))?;
        let buffer = guard.entry(window_label.to_string()).or_default();
        buffer.meta = Some(meta);
        Ok(())
    }

    pub fn handle_course_batch(
        &self,
        window_label: &str,
        batch_idx: usize,
        chunk: Vec<AcademicCourseItem>,
    ) -> Result<(), String> {
        let mut guard = self.sessions.lock().map_err(|e| format!("Mutex poisoned: {e}"))?;
        let buffer = guard.entry(window_label.to_string()).or_default();
        buffer.courses_batches.insert(batch_idx, chunk);
        Ok(())
    }

    pub fn commit_session(
        &self,
        window_label: &str,
        db: Arc<Mutex<Connection>>,
    ) -> Result<usize, String> {
        let buffer = {
            let mut guard = self.sessions.lock().map_err(|e| format!("Mutex poisoned: {e}"))?;
            guard.remove(window_label).ok_or_else(|| {
                format!("No harvester session found for window: {window_label}")
            })?
        };

        let meta = buffer.meta.ok_or_else(|| {
            "Meta payload missing from session buffer".to_string()
        })?;

        let profile = meta.profile.unwrap_or_default();
        let drl_list = meta.drl_records.unwrap_or_default();
        let expected_batches = meta.total_course_batches;
        let received_batches = buffer.courses_batches.len();

        // Ghép nối các khóa học theo đúng thứ tự batch_idx
        let mut all_courses = Vec::new();
        for i in 0..expected_batches {
            if let Some(chunk) = buffer.courses_batches.get(&i) {
                all_courses.extend(chunk.clone());
            }
        }

        let total_courses = all_courses.len();

        PortalIngestionEngine::commit_academic_records(
            db,
            profile,
            drl_list,
            all_courses,
            meta.summary,
            meta.avg_drl,
            received_batches,
            expected_batches,
        )?;

        Ok(total_courses)
    }
}

pub struct PortalIngestionEngine;

impl PortalIngestionEngine {
    pub fn commit_academic_records(
        db: Arc<Mutex<Connection>>,
        profile: PortalProfilePayload,
        drl_list: Vec<DrlItem>,
        courses: Vec<AcademicCourseItem>,
        summary: Option<PortalSummaryPayload>,
        avg_drl: Option<f64>,
        received_batches: usize,
        expected_batches: usize,
    ) -> Result<(), String> {
        // COMPLETENESS CHECK: Chặn đứng dữ liệu thiếu hụt do đứt gãy iframe batch
        if received_batches != expected_batches {
            return Err(format!(
                "Incomplete payload detected: received {}/{} course batches.",
                received_batches, expected_batches
            ));
        }

        let mut conn = db.lock().map_err(|e| format!("Mutex poisoned: {}", e))?;
        let tx = conn.transaction().map_err(|e| format!("Cannot begin transaction: {}", e))?;

        // 1. Đảm bảo bảng student_profile và academic_drl tồn tại
        tx.execute(
            "CREATE TABLE IF NOT EXISTS student_profile (
                student_id TEXT PRIMARY KEY,
                full_name TEXT NOT NULL,
                faculty TEXT NOT NULL DEFAULT '',
                major_code TEXT NOT NULL DEFAULT '',
                specialization TEXT NOT NULL DEFAULT '',
                student_class TEXT NOT NULL DEFAULT '',
                curriculum_code TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            )",
            [],
        ).map_err(|e| format!("Failed to ensure student_profile table: {e}"))?;

        tx.execute(
            "CREATE TABLE IF NOT EXISTS academic_drl (
                semester TEXT PRIMARY KEY,
                score INTEGER NOT NULL,
                grade_text TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            )",
            [],
        ).map_err(|e| format!("Failed to ensure academic_drl table: {e}"))?;

        // 2. Phân giải mã ngành động thông qua Curriculum Resolver 4-tier
        let resolved_major = crate::modules::academic::curriculum_resolver::resolve_curriculum(
            &tx,
            &profile.curriculum_code,
            Some(&profile.specialization),
        ).unwrap_or_else(|_| crate::modules::academic::curriculum_resolver::CurriculumResolution {
            major_code: if !profile.curriculum_code.is_empty() {
                profile.curriculum_code.clone()
            } else {
                "7480101".to_string()
            },
            total_credits: 130,
            matched_via: "hard_fallback".to_string(),
        });

        // 3. Upsert vào bảng student_profile
        tx.execute(
            "INSERT INTO student_profile (
                student_id, full_name, faculty, major_code, specialization,
                student_class, curriculum_code, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s', 'now'))
            ON CONFLICT(student_id) DO UPDATE SET
                full_name = excluded.full_name,
                faculty = excluded.faculty,
                major_code = excluded.major_code,
                specialization = excluded.specialization,
                student_class = excluded.student_class,
                curriculum_code = excluded.curriculum_code,
                updated_at = excluded.updated_at",
            params![
                profile.student_id,
                profile.full_name,
                profile.faculty,
                resolved_major.major_code, // Dynamic resolution
                profile.specialization,
                profile.student_class,
                profile.curriculum_code,
            ],
        ).map_err(|e| format!("Failed to update student_profile: {}", e))?;

        // 4. Đồng bộ vào bảng settings để phục vụ các hook hiện tại của app
        let upsert_setting = |key: &str, value: &str, t: &rusqlite::Transaction| -> Result<(), String> {
            t.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, value],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        };

        if !profile.student_id.trim().is_empty() {
            upsert_setting("student_id", profile.student_id.trim(), &tx)?;
        }
        if !profile.full_name.trim().is_empty() {
            upsert_setting("student_name", profile.full_name.trim(), &tx)?;
        }
        if !profile.faculty.trim().is_empty() {
            upsert_setting("faculty", profile.faculty.trim(), &tx)?;
        }
        upsert_setting("major_code", &resolved_major.major_code, &tx)?;
        if !profile.specialization.trim().is_empty() {
            upsert_setting("specialization", profile.specialization.trim(), &tx)?;
            upsert_setting("user_major", profile.specialization.trim(), &tx)?;
        }
        if !profile.student_class.trim().is_empty() {
            upsert_setting("student_class", profile.student_class.trim(), &tx)?;
        }
        if !profile.curriculum_code.trim().is_empty() {
            upsert_setting("curriculum_code", profile.curriculum_code.trim(), &tx)?;
        }

        // Cập nhật academic_program_summary với total_credits từ curriculum resolver
        let _ = tx.execute(
            "INSERT INTO academic_program_summary (id, total_degree_credits, updated_at)
             VALUES ('MAIN', ?1, strftime('%s', 'now'))
             ON CONFLICT(id) DO UPDATE SET total_degree_credits = excluded.total_degree_credits, updated_at = excluded.updated_at",
            params![resolved_major.total_credits],
        );

        // 5. Upsert danh sách DRL
        for drl in drl_list {
            if drl.semester.trim().is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO academic_drl (semester, score, grade_text, updated_at)
                 VALUES (?1, ?2, ?3, strftime('%s', 'now'))
                 ON CONFLICT(semester) DO UPDATE SET
                     score = excluded.score,
                     grade_text = excluded.grade_text,
                     updated_at = excluded.updated_at",
                params![drl.semester.trim(), drl.score, drl.grade_text.trim()],
            ).map_err(|e| format!("Failed to upsert academic_drl: {}", e))?;
        }

        // 6. Upsert danh sách khóa học vào academic_courses
        let now = chrono::Utc::now().timestamp();
        for c in courses {
            if c.course_code.trim().is_empty() {
                continue;
            }
            let (sem_id, acad_year, term) = if let Some(parsed) = crate::services::uit_portal::parse_semester_header(&c.semester) {
                parsed
            } else {
                let s = if c.semester.trim().is_empty() {
                    "2025_2026_HK1".to_string()
                } else {
                    c.semester.trim().replace(' ', "_")
                };
                (s, "2025-2026".to_string(), 1)
            };

            // Đảm bảo semester tồn tại cho foreign key
            let _ = tx.execute(
                "INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
                params![sem_id, acad_year, term, now],
            );

            let is_gpa = if crate::services::uit_portal::is_course_gpa_calculated(&c.course_code) { 1 } else { 0 };
            let course_id = format!("{sem_id}_{}", c.course_code.trim());
            tx.execute(
                "INSERT INTO academic_courses (
                    id, semester_id, course_code, course_name, credits,
                    process_point, practice_point, midterm_score, final_point,
                    course_point, final_score, summary_score_10, is_passed, is_gpa_calculated, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?11, ?12, ?13)
                ON CONFLICT(semester_id, course_code) DO UPDATE SET
                    course_name = excluded.course_name,
                    credits = excluded.credits,
                    process_point = excluded.process_point,
                    practice_point = excluded.practice_point,
                    midterm_score = excluded.midterm_score,
                    final_point = excluded.final_point,
                    course_point = excluded.course_point,
                    final_score = excluded.final_score,
                    summary_score_10 = excluded.summary_score_10,
                    is_passed = excluded.is_passed,
                    is_gpa_calculated = excluded.is_gpa_calculated,
                    updated_at = excluded.updated_at",
                params![
                    course_id,
                    sem_id,
                    c.course_code.trim(),
                    c.course_name.trim(),
                    c.credits,
                    c.score_qt,
                    c.score_th,
                    c.score_gk,
                    c.score_ck,
                    c.score_10,
                    c.is_passed,
                    is_gpa,
                    now,
                ],
            ).map_err(|e| format!("Failed to upsert academic_courses: {}", e))?;
        }

        // 7. Cập nhật Macro Metrics nếu có summary
        if let Some(ref sum) = summary {
            let latest_drl = avg_drl.map(|v| v as i64);
            let _ = tx.execute(
                "INSERT INTO academic_macro_metrics (
                    semester_id, term_gpa, cumulative_gpa, classification,
                    term_credits, cumulative_credits, drl, updated_at
                ) VALUES ('LATEST', ?1, ?1, 'Tự động', ?2, ?2, ?3, strftime('%s', 'now'))
                ON CONFLICT(semester_id) DO UPDATE SET
                    term_gpa = excluded.term_gpa,
                    cumulative_gpa = excluded.cumulative_gpa,
                    term_credits = excluded.term_credits,
                    cumulative_credits = excluded.cumulative_credits,
                    drl = excluded.drl,
                    updated_at = excluded.updated_at",
                params![sum.cgpa_10, sum.total_credits as i64, latest_drl],
            );
        }

        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;
        println!("[Diark DB] Portal Academic Ingestion committed successfully with dynamic major: {}.", resolved_major.major_code);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS academic_semesters (
                id TEXT PRIMARY KEY,
                academic_year TEXT NOT NULL,
                semester_term INTEGER NOT NULL,
                is_completed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS academic_courses (
                id TEXT PRIMARY KEY,
                semester_id TEXT NOT NULL,
                course_code TEXT NOT NULL,
                course_name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                process_point REAL,
                practice_point REAL,
                midterm_score REAL,
                final_point REAL,
                course_point REAL NOT NULL DEFAULT 0.0,
                final_score REAL,
                summary_score_10 REAL,
                is_passed INTEGER NOT NULL DEFAULT 0,
                is_gpa_calculated INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(semester_id) REFERENCES academic_semesters(id) ON DELETE CASCADE,
                UNIQUE(semester_id, course_code)
            );
            CREATE TABLE IF NOT EXISTS academic_curriculums (
                major_code TEXT PRIMARY KEY,
                major_name TEXT NOT NULL,
                total_credits INTEGER NOT NULL,
                cohort TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS curriculum_aliases (
                alias_token TEXT PRIMARY KEY,
                major_code TEXT NOT NULL,
                credit_override INTEGER
            );
            CREATE TABLE IF NOT EXISTS academic_program_summary (
                id TEXT PRIMARY KEY,
                total_degree_credits INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS academic_macro_metrics (
                semester_id TEXT PRIMARY KEY,
                term_gpa REAL NOT NULL DEFAULT 0.0,
                cumulative_gpa REAL NOT NULL DEFAULT 0.0,
                classification TEXT NOT NULL DEFAULT 'Chưa xếp loại',
                term_credits INTEGER NOT NULL DEFAULT 0,
                cumulative_credits INTEGER NOT NULL DEFAULT 0,
                drl INTEGER,
                updated_at INTEGER NOT NULL
            );"
        ).unwrap();
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn test_completeness_check_rejects_missing_batches() {
        let db = setup_test_db();
        let profile = PortalProfilePayload {
            student_id: "21520000".to_string(),
            full_name: "Test Student".to_string(),
            ..Default::default()
        };

        // Expected 3 batches, but only received 2
        let res = PortalIngestionEngine::commit_academic_records(
            db,
            profile,
            vec![],
            vec![],
            None,
            None,
            2,
            3,
        );

        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Incomplete payload detected: received 2/3 course batches"));
    }

    #[test]
    fn test_portal_ingestion_engine_commit_atomic_success() {
        let db = setup_test_db();
        let profile = PortalProfilePayload {
            student_id: "21520099".to_string(),
            full_name: "Nguyen Van Test".to_string(),
            faculty: "KHMT".to_string(),
            specialization: "Khoa học máy tính".to_string(),
            student_class: "KHMT2021.1".to_string(),
            curriculum_code: "D480101".to_string(),
            ..Default::default()
        };

        let drl_list = vec![
            DrlItem {
                semester: "HK1 2024-2025".to_string(),
                score: 92,
                grade_text: "Xuất sắc".to_string(),
            }
        ];

        let courses = vec![
            AcademicCourseItem {
                course_code: "IT001".to_string(),
                course_name: "Nhap mon lap trinh".to_string(),
                semester: "HK1 2024-2025".to_string(),
                credits: 4,
                score_qt: Some(8.0),
                score_th: Some(9.0),
                score_gk: Some(8.5),
                score_ck: Some(9.5),
                score_10: 9.0,
                is_passed: 1,
            },
            AcademicCourseItem {
                course_code: "MA006".to_string(),
                course_name: "Giai tich".to_string(),
                semester: "HK1 2024-2025".to_string(),
                credits: 4,
                score_qt: Some(7.5),
                score_th: None,
                score_gk: Some(8.0),
                score_ck: Some(9.0),
                score_10: 8.5,
                is_passed: 1,
            }
        ];

        let res = PortalIngestionEngine::commit_academic_records(
            db.clone(),
            profile,
            drl_list,
            courses,
            None,
            Some(92.0),
            1,
            1,
        );

        assert!(res.is_ok());

        // Kiểm tra dữ liệu được commit đầy đủ
        let conn = db.lock().unwrap();
        let student_name: String = conn.query_row(
            "SELECT full_name FROM student_profile WHERE student_id = '21520099'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(student_name, "Nguyen Van Test");

        let setting_name: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'student_name'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(setting_name, "Nguyen Van Test");

        let course_count: i64 = conn.query_row(
            "SELECT count(*) FROM academic_courses WHERE semester_id = '2024_2025_HK1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(course_count, 2);

        let (qt, th, gk, ck, score10): (Option<f64>, Option<f64>, Option<f64>, Option<f64>, f64) = conn.query_row(
            "SELECT process_point, practice_point, midterm_score, final_point, course_point FROM academic_courses WHERE course_code = 'IT001'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).unwrap();
        assert_eq!(qt, Some(8.0));
        assert_eq!(th, Some(9.0));
        assert_eq!(gk, Some(8.5));
        assert_eq!(ck, Some(9.5));
        assert_eq!(score10, 9.0);

        let drl_score: i64 = conn.query_row(
            "SELECT score FROM academic_drl WHERE semester = 'HK1 2024-2025'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(drl_score, 92);
    }
}
