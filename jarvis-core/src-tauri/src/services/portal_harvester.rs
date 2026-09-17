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
        pub total_program_credits: Option<i64>,
        #[serde(default)]
        pub semester_summaries: Vec<SemesterSummaryItem>,
        #[serde(default)]
        pub ctdt_curriculum_courses: Vec<crate::modules::academic::parser::CurriculumCourseRecord>,
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

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitSubject {
        pub subject_code: String,
        pub subject_name: String,
        pub number_of_credit: i64,
        #[serde(default)]
        pub process_point: Option<String>,
        #[serde(default)]
        pub practice_point: Option<String>,
        #[serde(default)]
        pub midterm_score: Option<String>,
        #[serde(default)]
        pub final_point: Option<String>,
        #[serde(default)]
        pub course_point: Option<String>,
        #[serde(default)]
        pub note: Option<String>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitSemesterGroup {
        pub semester_key: String,
        pub semester_label: String,
        pub year_name: String,
        pub subjects: Vec<OfficialUitSubject>,
        #[serde(default)]
        pub total_credit: Option<i64>,
        #[serde(default)]
        pub average_point: Option<f64>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitBySemesterSummary {
        #[serde(default)]
        pub total_credits_all: Option<f64>,
        #[serde(default)]
        pub accumulated_credits: Option<f64>,
        #[serde(default)]
        pub gpa_all: Option<f64>,
        #[serde(default)]
        pub gpa_accumulated: Option<f64>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitBySemester {
        pub semester_groups: Vec<OfficialUitSemesterGroup>,
        #[serde(default)]
        pub summary: Option<OfficialUitBySemesterSummary>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    #[allow(non_snake_case)]
    pub struct OfficialUitTermSummary {
        #[serde(default)]
        pub yearName: Option<String>,
        #[serde(default)]
        pub semester: Option<String>,
        #[serde(default)]
        pub termGpa: Option<f64>,
        #[serde(default)]
        pub cumulativeGpa: Option<f64>,
        #[serde(default)]
        pub termCredit: Option<i64>,
        #[serde(default)]
        pub accumulatedCredit: Option<i64>,
        #[serde(default)]
        pub classifyLabel: Option<String>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitDrlHistoryItem {
        #[serde(default)]
        pub id: Option<String>,
        #[serde(default)]
        pub semester: Option<String>,
        #[serde(default)]
        pub semester_label: Option<String>,
        #[serde(default)]
        pub year_name: Option<String>,
        #[serde(default)]
        pub specialized_class_name: Option<String>,
        #[serde(default)]
        pub point: Option<i64>,
        #[serde(default)]
        pub rank: Option<String>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitDrlPayload {
        #[serde(default)]
        pub average_training_point: Option<f64>,
        #[serde(default)]
        pub average_rank: Option<String>,
        #[serde(default)]
        pub training_point_history: Option<Vec<OfficialUitDrlHistoryItem>>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitCtdtStatistics {
        #[serde(default)]
        pub not_learned: Option<i64>,
        #[serde(default)]
        pub passed: Option<i64>,
        #[serde(default)]
        pub retake: Option<i64>,
        #[serde(default)]
        pub in_progress: Option<i64>,
        #[serde(default)]
        pub outside_program: Option<i64>,
        #[serde(default)]
        pub elective_learned: Option<i64>,
        #[serde(default)]
        pub passed_credit: Option<i64>,
        #[serde(default)]
        pub total_program_credit: Option<i64>,
        #[serde(default)]
        pub total_studied_credit: Option<i64>,
        #[serde(default)]
        pub avg_score: Option<f64>,
        #[serde(default)]
        pub accumulated_gpa: Option<f64>,
        #[serde(default)]
        pub credit_in_ctdt: Option<i64>,
        #[serde(default)]
        pub credit_outside: Option<i64>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitCtdtLine {
        #[serde(default)]
        pub subject_id: Option<String>,
        pub subject_code: String,
        pub subject_name: String,
        pub credit: i64,
        #[serde(default)]
        pub credit_theory: Option<i64>,
        #[serde(default)]
        pub credit_pract: Option<i64>,
        #[serde(default)]
        pub subject_required: Option<bool>,
        #[serde(default)]
        pub course_point: Option<String>,
        #[serde(default)]
        pub status: Option<String>,
        #[serde(default)]
        pub weights: Option<serde_json::Value>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    pub struct OfficialUitCtdtProgramScore {
        pub semester: i64,
        #[serde(default)]
        pub semester_label: Option<String>,
        #[serde(default)]
        pub lines: Vec<OfficialUitCtdtLine>,
        #[serde(default)]
        pub total_credit: Option<i64>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    #[allow(non_snake_case)]
    pub struct OfficialUitByCtdt {
        #[serde(default)]
        pub statistics: Option<OfficialUitCtdtStatistics>,
        #[serde(default)]
        pub program_scores: Option<Vec<OfficialUitCtdtProgramScore>>,
        #[serde(default)]
        pub outsideProgramSubjects: Option<Vec<serde_json::Value>>,
        #[serde(default)]
        pub defenseEducation: Option<serde_json::Value>,
        #[serde(default)]
        pub foreignLanguage: Option<serde_json::Value>,
    }

    #[derive(Deserialize, Serialize, Clone, Debug, Default)]
    #[allow(non_snake_case)]
    pub struct OfficialUitTranscriptPayload {
        pub bySemester: OfficialUitBySemester,
        #[serde(default)]
        pub byCtdt: Option<OfficialUitByCtdt>,
        #[serde(default)]
        pub termSummaries: Option<Vec<OfficialUitTermSummary>>,
        #[serde(default)]
        pub drl: Option<OfficialUitDrlPayload>,
        #[serde(default)]
        pub profile: Option<PortalProfilePayload>,
        #[serde(default)]
        pub drl_records: Option<Vec<DrlItem>>,
        #[serde(default)]
        pub avg_drl: Option<f64>,
    }

    pub fn parse_point_string(s: &Option<String>) -> Option<f64> {
        s.as_deref().and_then(|v| {
            let t = v.trim().replace(',', ".");
            if t.is_empty() || t == "—" || t == "-" || t == "null" {
                None
            } else {
                t.parse::<f64>().ok()
            }
        })
    }

    pub fn convert_official_uit_payload(
        official: OfficialUitTranscriptPayload,
    ) -> (PortalProfilePayload, Vec<DrlItem>, Vec<AcademicCourseItem>, Option<PortalSummaryPayload>, Option<f64>) {
        let mut courses = Vec::new();

        for grp in &official.bySemester.semester_groups {
            let sem_label = &grp.semester_label;
            for subj in &grp.subjects {
                let score_10 = parse_point_string(&subj.course_point).unwrap_or(0.0);
                let is_passed = if score_10 >= 5.0 { 1 } else { 0 };

                courses.push(AcademicCourseItem {
                    course_code: subj.subject_code.clone(),
                    course_name: subj.subject_name.clone(),
                    semester: sem_label.clone(),
                    credits: subj.number_of_credit,
                    score_qt: parse_point_string(&subj.process_point),
                    score_th: parse_point_string(&subj.practice_point),
                    score_gk: parse_point_string(&subj.midterm_score),
                    score_ck: parse_point_string(&subj.final_point),
                    score_10,
                    is_passed,
                });
            }
        }

        let total_credits = official.bySemester.summary.as_ref().and_then(|s| s.accumulated_credits).unwrap_or(0.0);
        let cgpa_10 = official.bySemester.summary.as_ref().and_then(|s| s.gpa_accumulated).unwrap_or(0.0);

        let mut semester_summaries = Vec::new();
        if let Some(ref terms) = official.termSummaries {
            for t in terms {
                let term_sem_num = t.semester.as_deref().unwrap_or("");
                let matched_group = official.bySemester.semester_groups.iter().find(|g| {
                    g.semester_key == format!("semester_{}", term_sem_num)
                        || (t.yearName.as_deref().map(|y| g.year_name.starts_with(y)).unwrap_or(false)
                            && g.semester_label.contains(term_sem_num))
                });

                let sem_str = if let Some(g) = matched_group {
                    g.semester_label.clone()
                } else {
                    format!("Học kỳ {}/{}", term_sem_num, t.yearName.as_deref().unwrap_or_default())
                };

                semester_summaries.push(SemesterSummaryItem {
                    semester: Some(sem_str),
                    gpa_semester: t.termGpa,
                    cpa_cumulative: t.cumulativeGpa,
                    ranking: t.classifyLabel.clone(),
                    credits_semester: t.termCredit,
                    credits_cumulative: t.accumulatedCredit,
                });
            }
        }

        let mut ctdt_curriculum_courses = Vec::new();
        let mut total_program_credits = None;

        if let Some(ref ctdt) = official.byCtdt {
            if let Some(ref stats) = ctdt.statistics {
                if let Some(tot) = stats.total_program_credit {
                    if tot > 0 {
                        total_program_credits = Some(tot);
                    }
                }
            }

            if let Some(ref scores) = ctdt.program_scores {
                for sem_group in scores {
                    let term = sem_group.semester;
                    for line in &sem_group.lines {
                        let c_code = line.subject_code.trim().to_string();
                        if c_code.is_empty() {
                            continue;
                        }
                        let c_type = if line.subject_required.unwrap_or(true) {
                            "Bắt buộc".to_string()
                        } else {
                            "Tự chọn".to_string()
                        };

                        let c_status = match line.status.as_deref().unwrap_or("not_learned") {
                            "passed" => "Đã qua".to_string(),
                            "in_progress" => "Đang học".to_string(),
                            "retake" => "Học lại".to_string(),
                            "outside_program" => "Ngoài CTĐT".to_string(),
                            _ => "Chưa học".to_string(),
                        };

                        let final_score = parse_point_string(&line.course_point);

                        ctdt_curriculum_courses.push(crate::modules::academic::parser::CurriculumCourseRecord {
                            course_code: c_code,
                            course_name: line.subject_name.trim().to_string(),
                            credits: line.credit,
                            course_type: c_type,
                            ideal_term: term,
                            status: c_status,
                            final_score,
                        });
                    }
                }
            }
        }

        let summary = PortalSummaryPayload {
            total_credits,
            cgpa_10,
            total_program_credits,
            semester_summaries,
            ctdt_curriculum_courses,
        };

        let mut profile = official.profile.unwrap_or_default();
        let mut drl_records = official.drl_records.unwrap_or_default();
        let mut avg_drl = official.avg_drl;

        if let Some(drl_data) = official.drl {
            if avg_drl.is_none() {
                avg_drl = drl_data.average_training_point;
            }
            if let Some(history) = drl_data.training_point_history {
                for item in history {
                    let sem_lbl = item.semester_label.as_deref().unwrap_or("");
                    let yr = item.year_name.as_deref().unwrap_or("");
                    let sem_name = if !sem_lbl.is_empty() && !yr.is_empty() {
                        format!("{sem_lbl}/{yr}")
                    } else if !sem_lbl.is_empty() {
                        sem_lbl.to_string()
                    } else {
                        item.semester.clone().unwrap_or_default()
                    };

                    if !sem_name.is_empty() {
                        drl_records.push(DrlItem {
                            semester: sem_name,
                            score: item.point.unwrap_or(0),
                            grade_text: item.rank.unwrap_or_default(),
                        });
                    }

                    if profile.student_class.is_empty() {
                        if let Some(ref cls) = item.specialized_class_name {
                            if !cls.trim().is_empty() {
                                profile.student_class = cls.trim().to_string();
                            }
                        }
                    }
                }
            }
        }

        (profile, drl_records, courses, Some(summary), avg_drl)
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

        // Đảm bảo các cột phái sinh và phân loại của academic_courses luôn tồn tại
        let _ = tx.execute("ALTER TABLE academic_courses ADD COLUMN summary_score_4 REAL", []);
        let _ = tx.execute("ALTER TABLE academic_courses ADD COLUMN grade_4 REAL", []);
        let _ = tx.execute("ALTER TABLE academic_courses ADD COLUMN grade_char TEXT", []);
        let _ = tx.execute("ALTER TABLE academic_courses ADD COLUMN category TEXT DEFAULT 'dai_cuong'", []);

        // 2. Phân giải mã ngành động thông qua Curriculum Resolver 4-tier
        let combined_hint = format!("{} {} {}", profile.specialization, profile.student_class, profile.faculty);
        let resolved_major = crate::modules::academic::curriculum_resolver::resolve_curriculum(
            &tx,
            &profile.curriculum_code,
            Some(&combined_hint),
        ).unwrap_or_else(|_| crate::modules::academic::curriculum_resolver::CurriculumResolution {
            major_code: if !profile.curriculum_code.is_empty() {
                profile.curriculum_code.clone()
            } else {
                "D480101".to_string()
            },
            total_credits: 126,
            matched_via: "hard_fallback".to_string(),
        });

        // Ưu tiên total_program_credits chính thức từ API UIT portal (byCtdt.statistics.total_program_credit)
        let official_program_credits = summary.as_ref().and_then(|s| s.total_program_credits);
        let effective_total_credits = official_program_credits.unwrap_or(resolved_major.total_credits);

        // 3. Upsert vào bảng student_profile (chỉ khi có student_id)
        if !profile.student_id.trim().is_empty() {
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
        }

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
        if !profile.student_id.trim().is_empty() {
            upsert_setting("major_code", &resolved_major.major_code, &tx)?;
        }
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
        upsert_setting("total_degree_credits", &effective_total_credits.to_string(), &tx)?;

        // Cập nhật academic_program_summary với effective_total_credits
        if !profile.student_id.trim().is_empty() {
            let _ = tx.execute(
                "INSERT INTO academic_program_summary (id, total_degree_credits, updated_at)
                 VALUES ('MAIN', ?1, strftime('%s', 'now'))
                 ON CONFLICT(id) DO UPDATE SET total_degree_credits = excluded.total_degree_credits, updated_at = excluded.updated_at",
                params![effective_total_credits],
            );
        }

        // 5. Upsert danh sách DRL
        for drl in &drl_list {
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
            let scale = crate::db::academic::GradeScale::from_score_10(c.score_10);
            let (summary_score_4, grade_char) = (Some(scale.to_scale_4()), Some(scale.as_char().to_string()));

            let code_norm = c.course_code.trim().to_uppercase();
            let category = if ["IT001", "IT002", "IT003", "IT012", "CS005", "MA004", "MA005"].contains(&code_norm.as_str()) {
                "co_so_nganh"
            } else if code_norm.starts_with("PE") || code_norm.starts_with("ME") {
                "auxiliary"
            } else if code_norm.starts_with("MA") || code_norm.starts_with("PH") || code_norm.starts_with("SS") || code_norm.starts_with("ENG") {
                "dai_cuong"
            } else {
                "chuyen_nganh"
            };

            let course_id = format!("{sem_id}_{}", c.course_code.trim());
            tx.execute(
                "INSERT INTO academic_courses (
                    id, semester_id, course_code, course_name, credits,
                    process_point, practice_point, midterm_score, final_point,
                    course_point, final_score, summary_score_10,
                    summary_score_4, grade_4, grade_char, category,
                    is_passed, is_gpa_calculated, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?11, ?11, ?12, ?13, ?14, ?15, ?16)
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
                    summary_score_4 = excluded.summary_score_4,
                    grade_4 = excluded.grade_4,
                    grade_char = excluded.grade_char,
                    category = excluded.category,
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
                    summary_score_4,
                    grade_char,
                    category,
                    c.is_passed,
                    is_gpa,
                    now,
                ],
            ).map_err(|e| format!("Failed to upsert academic_courses: {}", e))?;
        }

        // 7. Cập nhật Macro Metrics nếu có summary
        if let Some(ref sum) = summary {
            let latest_drl = avg_drl.or_else(|| {
                if !drl_list.is_empty() {
                    let s: i64 = drl_list.iter().map(|d| d.score).sum();
                    Some(s as f64 / drl_list.len() as f64)
                } else {
                    None
                }
            });

            // Ghi nhận tóm tắt toàn khóa vào academic_program_summary (id='MAIN')
            // Single Source of Truth: Ưu tiên total_program_credits chính thức từ UIT portal
            let _ = tx.execute(
                "INSERT INTO academic_program_summary (
                    id, cumulative_gpa, cumulative_drl, cumulative_credits, total_degree_credits, updated_at
                ) VALUES ('MAIN', ?1, ?2, ?3, ?4, strftime('%s', 'now'))
                ON CONFLICT(id) DO UPDATE SET
                    cumulative_gpa = excluded.cumulative_gpa,
                    cumulative_drl = excluded.cumulative_drl,
                    cumulative_credits = excluded.cumulative_credits,
                    total_degree_credits = excluded.total_degree_credits,
                    updated_at = excluded.updated_at",
                params![sum.cgpa_10, latest_drl, sum.total_credits as i64, effective_total_credits],
            );

            for sem in &sum.semester_summaries {
                if let Some(ref s_name) = sem.semester {
                    let (sem_id, acad_year, term_num) = if let Some(p) = crate::services::uit_portal::parse_semester_header(s_name) {
                        p
                    } else {
                        (s_name.replace(' ', "_").replace('/', "."), "2025-2026".to_string(), 1)
                    };

                    let sem_drl = drl_list.iter()
                        .find(|d| d.semester.contains(s_name) || s_name.contains(&d.semester) || d.semester.contains(&format!("Học kỳ {term_num}")))
                        .map(|d| d.score)
                        .or(latest_drl.map(|v| v.round() as i64));

                    let sem_label = format!("Học kỳ {}/{}", term_num, acad_year);

                    let _ = tx.execute(
                        "INSERT INTO academic_macro_metrics (
                            semester_id, semester_label, year_name, term_gpa, cumulative_gpa, classification, rank_label,
                            term_credits, cumulative_credits, drl, drl_score, updated_at
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?9, strftime('%s', 'now'))
                        ON CONFLICT(semester_id) DO UPDATE SET
                            semester_label = excluded.semester_label,
                            year_name = excluded.year_name,
                            term_gpa = excluded.term_gpa,
                            cumulative_gpa = excluded.cumulative_gpa,
                            classification = excluded.classification,
                            rank_label = excluded.rank_label,
                            term_credits = excluded.term_credits,
                            cumulative_credits = excluded.cumulative_credits,
                            drl = excluded.drl,
                            drl_score = excluded.drl_score,
                            updated_at = excluded.updated_at",
                        params![
                            sem_id,
                            sem_label,
                            acad_year,
                            sem.gpa_semester.unwrap_or(0.0),
                            sem.cpa_cumulative.unwrap_or(0.0),
                            sem.ranking.as_deref().unwrap_or("Giỏi"),
                            sem.credits_semester.unwrap_or(0),
                            sem.credits_cumulative.unwrap_or(0),
                            sem_drl.unwrap_or(0),
                        ],
                    );
                }
            }

            // 8. Đảm bảo bảng academic_curriculum tồn tại và nạp danh mục môn học theo khung CTĐT
            tx.execute(
                "CREATE TABLE IF NOT EXISTS academic_curriculum (
                    course_code TEXT PRIMARY KEY,
                    course_name TEXT NOT NULL,
                    credits INTEGER NOT NULL,
                    course_type TEXT NOT NULL,
                    ideal_term INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    final_score REAL,
                    updated_at INTEGER NOT NULL
                )",
                [],
            ).map_err(|e| format!("Failed to ensure academic_curriculum table: {e}"))?;

            if !sum.ctdt_curriculum_courses.is_empty() {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO academic_curriculum (
                        course_code, course_name, credits, course_type, ideal_term, status, final_score, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s', 'now'))
                    ON CONFLICT(course_code) DO UPDATE SET
                        course_name = excluded.course_name,
                        credits = excluded.credits,
                        course_type = excluded.course_type,
                        ideal_term = excluded.ideal_term,
                        status = excluded.status,
                        final_score = excluded.final_score,
                        updated_at = excluded.updated_at",
                ).map_err(|e| format!("Failed to prepare academic_curriculum stmt: {e}"))?;

                for c in &sum.ctdt_curriculum_courses {
                    stmt.execute(params![
                        c.course_code,
                        c.course_name,
                        c.credits,
                        c.course_type,
                        c.ideal_term,
                        c.status,
                        c.final_score,
                    ]).map_err(|e| format!("Failed to upsert academic_curriculum: {e}"))?;
                }
            }
        }

        let _ = tx.execute(
            "CREATE TABLE IF NOT EXISTS sync_state (
                service TEXT PRIMARY KEY,
                last_synced_at INTEGER NOT NULL DEFAULT 0
            )",
            [],
        );

        tx.execute(
            "INSERT INTO sync_state (service, last_synced_at) VALUES ('portal', strftime('%s', 'now'))
             ON CONFLICT(service) DO UPDATE SET last_synced_at = excluded.last_synced_at",
            [],
        ).map_err(|e| format!("Failed to update portal sync_state: {e}"))?;

        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;
        println!("[Diark DB] Portal Academic Ingestion committed successfully with dynamic major: {}.", resolved_major.major_code);
        Ok(())
    }

    pub fn commit_drl_records(
        db: Arc<Mutex<Connection>>,
        drl_payload: OfficialUitDrlPayload,
    ) -> Result<usize, String> {
        let mut conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
        let tx = conn.transaction().map_err(|e| format!("Transaction error: {e}"))?;

        tx.execute(
            "CREATE TABLE IF NOT EXISTS academic_drl (
                semester TEXT PRIMARY KEY,
                score INTEGER NOT NULL,
                grade_text TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            )",
            [],
        ).map_err(|e| format!("Failed to ensure academic_drl: {e}"))?;

        let history = drl_payload.training_point_history.unwrap_or_default();
        let count = history.len();
        let mut latest_class = String::new();

        for item in &history {
            let sem_label = item.semester_label.as_deref().unwrap_or("");
            let yr = item.year_name.as_deref().unwrap_or("");
            let sem_name = if !sem_label.is_empty() && !yr.is_empty() {
                format!("{sem_label}/{yr}")
            } else if !sem_label.is_empty() {
                sem_label.to_string()
            } else {
                item.semester.clone().unwrap_or_default()
            };

            if sem_name.trim().is_empty() {
                continue;
            }

            let score = item.point.unwrap_or(0);
            let rank = item.rank.as_deref().unwrap_or("");

            tx.execute(
                "INSERT INTO academic_drl (semester, score, grade_text, updated_at)
                 VALUES (?1, ?2, ?3, strftime('%s', 'now'))
                 ON CONFLICT(semester) DO UPDATE SET
                     score = excluded.score,
                     grade_text = excluded.grade_text,
                     updated_at = excluded.updated_at",
                params![sem_name.trim(), score, rank],
            ).map_err(|e| format!("Failed to upsert academic_drl: {e}"))?;

            if latest_class.is_empty() {
                if let Some(ref cls) = item.specialized_class_name {
                    if !cls.trim().is_empty() {
                        latest_class = cls.trim().to_string();
                    }
                }
            }
        }

        if !latest_class.is_empty() {
            let _ = tx.execute(
                "INSERT INTO settings (key, value) VALUES ('student_class', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![latest_class],
            );
        }

        if let Some(avg) = drl_payload.average_training_point {
            let _ = tx.execute(
                "INSERT INTO academic_program_summary (
                    id, cumulative_drl, updated_at
                ) VALUES ('MAIN', ?1, strftime('%s', 'now'))
                ON CONFLICT(id) DO UPDATE SET
                    cumulative_drl = excluded.cumulative_drl,
                    updated_at = excluded.updated_at",
                params![avg],
            );
        }

        let _ = tx.execute(
            "CREATE TABLE IF NOT EXISTS sync_state (
                service TEXT PRIMARY KEY,
                last_synced_at INTEGER NOT NULL DEFAULT 0
            )",
            [],
        );

        tx.execute(
            "INSERT INTO sync_state (service, last_synced_at) VALUES ('portal', strftime('%s', 'now'))
             ON CONFLICT(service) DO UPDATE SET last_synced_at = excluded.last_synced_at",
            [],
        ).map_err(|e| format!("Failed to update portal sync_state: {e}"))?;

        tx.commit().map_err(|e| format!("Commit error: {e}"))?;
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::ensure_sync_state_schema(&conn).unwrap();
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
                summary_score_4 REAL,
                grade_4 REAL,
                grade_char TEXT,
                category TEXT NOT NULL DEFAULT 'dai_cuong',
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
                cumulative_gpa REAL,
                cumulative_drl REAL,
                cumulative_credits INTEGER,
                total_degree_credits INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS academic_macro_metrics (
                semester_id TEXT PRIMARY KEY,
                semester_label TEXT NOT NULL DEFAULT '',
                year_name TEXT NOT NULL DEFAULT '',
                term_gpa REAL NOT NULL DEFAULT 0.0,
                cumulative_gpa REAL NOT NULL DEFAULT 0.0,
                classification TEXT NOT NULL DEFAULT 'Chưa xếp loại',
                rank_label TEXT NOT NULL DEFAULT 'Chưa xếp loại',
                term_credits INTEGER NOT NULL DEFAULT 0,
                cumulative_credits INTEGER NOT NULL DEFAULT 0,
                drl INTEGER,
                drl_score INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS academic_curriculum (
                course_code TEXT PRIMARY KEY,
                course_name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                course_type TEXT NOT NULL,
                ideal_term INTEGER NOT NULL,
                status TEXT NOT NULL,
                final_score REAL,
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
            "SELECT count(*) FROM academic_courses WHERE semester_id = '2024-2025.1'",
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

    #[test]
    fn test_official_uit_payload_conversion_and_commit() {
        let json_data = r#"{
            "bySemester": {
                "semester_groups": [
                    {
                        "semester_key": "semester_2",
                        "semester_label": "Học kỳ 2/2025-2026",
                        "year_name": "2025-2026",
                        "subjects": [
                            {
                                "id": "IT002-1",
                                "subject_code": "IT002",
                                "subject_name": "Lập trình hướng đối tượng",
                                "number_of_credit": 4,
                                "training_type_code": "CQUI",
                                "process_point": "10",
                                "midterm_score": "",
                                "practice_point": "9",
                                "final_point": "6.5",
                                "course_point": "8.0"
                            },
                            {
                                "id": "IT003-2",
                                "subject_code": "IT003",
                                "subject_name": "Cấu trúc dữ liệu và giải thuật",
                                "number_of_credit": 4,
                                "training_type_code": "CQUI",
                                "process_point": "10",
                                "midterm_score": "",
                                "practice_point": "9",
                                "final_point": "7.5",
                                "course_point": "8.5"
                            }
                        ],
                        "total_credit": 8,
                        "average_point": 8.25
                    }
                ],
                "summary": {
                    "total_credits_all": 42,
                    "accumulated_credits": 42,
                    "gpa_all": 8.4,
                    "gpa_accumulated": 8.4,
                    "graduation_credits": 0
                }
            },
            "termSummaries": [
                {
                    "yearName": "2025",
                    "semester": "2",
                    "termGpa": 8.25,
                    "cumulativeGpa": 8.4,
                    "termCredit": 8,
                    "accumulatedCredit": 42,
                    "classifyLabel": "Giỏi"
                }
            ],
            "byCtdt": {
                "statistics": {
                    "total_program_credit": 126,
                    "passed_credit": 42,
                    "avg_score": 8.4,
                    "accumulated_gpa": 8.4
                },
                "program_scores": [
                    {
                        "semester": 1,
                        "semester_label": "Học kỳ 1",
                        "lines": [
                            {
                                "subject_code": "CS005",
                                "subject_name": "Giới thiệu ngành Khoa học Máy tính",
                                "credit": 1,
                                "subject_required": true,
                                "course_point": "9.7",
                                "status": "passed"
                            },
                            {
                                "subject_code": "IT001",
                                "subject_name": "Nhập môn lập trình",
                                "credit": 4,
                                "subject_required": true,
                                "course_point": "9.1",
                                "status": "passed"
                            }
                        ]
                    }
                ]
            }
        }"#;

        let official: OfficialUitTranscriptPayload = serde_json::from_str(json_data).unwrap();
        let (profile, drl_records, courses, summary, avg_drl) = convert_official_uit_payload(official);

        assert_eq!(courses.len(), 2);
        assert_eq!(courses[0].course_code, "IT002");
        assert_eq!(courses[0].score_10, 8.0);
        assert_eq!(courses[0].score_qt, Some(10.0));
        assert_eq!(courses[0].score_gk, None);
        assert_eq!(courses[0].score_th, Some(9.0));
        assert_eq!(courses[0].score_ck, Some(6.5));

        assert_eq!(summary.as_ref().unwrap().cgpa_10, 8.4);
        assert_eq!(summary.as_ref().unwrap().total_credits, 42.0);
        assert_eq!(summary.as_ref().unwrap().total_program_credits, Some(126));
        assert_eq!(summary.as_ref().unwrap().ctdt_curriculum_courses.len(), 2);

        let db = setup_test_db();
        let res = PortalIngestionEngine::commit_academic_records(
            db.clone(),
            profile,
            drl_records,
            courses,
            summary,
            avg_drl,
            1,
            1,
        );
        assert!(res.is_ok());

        let conn = db.lock().unwrap();
        let course_count: i64 = conn.query_row("SELECT count(*) FROM academic_courses", [], |r| r.get(0)).unwrap();
        assert_eq!(course_count, 2);

        let macro_count: i64 = conn.query_row("SELECT count(*) FROM academic_macro_metrics", [], |r| r.get(0)).unwrap();
        assert!(macro_count >= 1);

        // Kiểm tra số tín chỉ tốt nghiệp chính thức từ byCtdt được lưu đúng 126
        let total_degree_cred: i64 = conn.query_row(
            "SELECT total_degree_credits FROM academic_program_summary WHERE id = 'MAIN'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(total_degree_cred, 126);

        let setting_deg_cred: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'total_degree_credits'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(setting_deg_cred, "126");

        // Kiểm tra danh mục môn học theo CTĐT (Tab 3) được lưu đúng
        let ctdt_count: i64 = conn.query_row(
            "SELECT count(*) FROM academic_curriculum",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(ctdt_count, 2);

        let (c_name, c_status, c_score): (String, String, Option<f64>) = conn.query_row(
            "SELECT course_name, status, final_score FROM academic_curriculum WHERE course_code = 'CS005'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(c_name, "Giới thiệu ngành Khoa học Máy tính");
        assert_eq!(c_status, "Đã qua");
        assert_eq!(c_score, Some(9.7));
    }
}
