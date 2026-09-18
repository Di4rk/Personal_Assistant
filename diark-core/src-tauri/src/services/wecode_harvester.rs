use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use rusqlite::{params, Connection};
use crate::commands::wecode::WecodeSubmissionDto;
use crate::modules::wecode::time_parser::parse_wecode_timestamp;

#[derive(Default, Clone, Debug)]
pub struct WecodeBatchBuffer {
    pub total_batches: usize,
    pub batches: HashMap<usize, Vec<WecodeSubmissionDto>>,
}

#[derive(Default, Clone)]
pub struct WecodeHarvesterRegistry {
    pub sessions: Arc<Mutex<HashMap<String, WecodeBatchBuffer>>>,
}

impl WecodeHarvesterRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn handle_batch(
        &self,
        window_label: &str,
        batch_idx: usize,
        total_batches: usize,
        submissions: Vec<WecodeSubmissionDto>,
    ) -> Result<(), String> {
        let mut guard = self.sessions.lock().map_err(|e| format!("Mutex poisoned: {e}"))?;
        let buffer = guard.entry(window_label.to_string()).or_default();
        if total_batches > 0 {
            buffer.total_batches = total_batches;
        }
        buffer.batches.insert(batch_idx, submissions);
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
                format!("No wecode harvester session found for window: {window_label}")
            })?
        };

        let expected_batches = buffer.total_batches;
        let received_batches = buffer.batches.len();

        if expected_batches > 0 && received_batches != expected_batches {
            return Err(format!(
                "Incomplete payload detected: received {}/{} wecode submission batches.",
                received_batches, expected_batches
            ));
        }

        let mut all_submissions = Vec::new();
        for i in 0..expected_batches {
            if let Some(chunk) = buffer.batches.get(&i) {
                all_submissions.extend(chunk.clone());
            }
        }

        let total = all_submissions.len();
        WecodeIngestionEngine::commit_wecode_records(db, all_submissions)?;
        Ok(total)
    }
}

pub struct WecodeIngestionEngine;

impl WecodeIngestionEngine {
    pub fn commit_wecode_sync_request(
        db: Arc<Mutex<Connection>>,
        req: crate::commands::wecode::WecodeSyncRequest,
    ) -> Result<usize, String> {
        let (submissions, assignments, problems) = match req {
            crate::commands::wecode::WecodeSyncRequest::Full(payload) => (
                payload.submissions,
                payload.assignments,
                payload.problems,
            ),
            crate::commands::wecode::WecodeSyncRequest::Legacy(subs) => (
                subs,
                Vec::new(),
                Vec::new(),
            ),
        };

        let mut conn = db.lock().map_err(|e| format!("Mutex poisoned: {e}"))?;
        let tx = conn.transaction().map_err(|e| format!("Cannot begin transaction: {e}"))?;

        // 1. Đảm bảo bảng tồn tại
        crate::db::schema::ensure_wecode_schema(&tx).map_err(|e| e.to_string())?;

        // 2. Upsert assignments metadata nếu có
        for a in &assignments {
            let start_time = a.start_time.as_deref().unwrap_or("");
            let finish_time = a.finish_time.as_deref().unwrap_or("");
            let base_url = a.base_url.as_deref().unwrap_or("");

            let _ = tx.execute(
                "INSERT INTO wecode_assignments (id, name, classes, total_problems, start_time, finish_time, base_url, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s', 'now'))
                 ON CONFLICT(id) DO UPDATE SET
                    name = CASE WHEN excluded.name != '' AND excluded.name NOT LIKE 'Assignment %' THEN excluded.name ELSE name END,
                    classes = CASE WHEN excluded.classes != '' THEN excluded.classes ELSE classes END,
                    total_problems = CASE WHEN excluded.total_problems > 0 THEN excluded.total_problems ELSE total_problems END,
                    start_time = CASE WHEN excluded.start_time != '' THEN excluded.start_time ELSE start_time END,
                    finish_time = CASE WHEN excluded.finish_time != '' THEN excluded.finish_time ELSE finish_time END,
                    base_url = CASE WHEN excluded.base_url != '' THEN excluded.base_url ELSE base_url END",
                params![a.id, a.name, a.classes.as_deref().unwrap_or(""), a.total_problems, start_time, finish_time, base_url],
            );
        }

        // 3. Upsert problems catalog nếu có
        for p in &problems {
            let _ = tx.execute(
                "INSERT INTO wecode_assignments (id, name, created_at) VALUES (?1, 'Assignment ' || ?1, strftime('%s', 'now'))
                 ON CONFLICT(id) DO NOTHING",
                params![p.assignment_id],
            );

            let problem_url = p.problem_url.as_deref().unwrap_or("");

            tx.execute(
                "INSERT INTO wecode_problems (assignment_id, problem_id, problem_name, problem_order, max_score, is_ac, problem_url, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s', 'now'))
                 ON CONFLICT(assignment_id, problem_id) DO UPDATE SET
                    problem_name = excluded.problem_name,
                    problem_order = excluded.problem_order,
                    max_score = excluded.max_score,
                    is_ac = CASE WHEN excluded.is_ac THEN 1 ELSE is_ac END,
                    problem_url = CASE WHEN excluded.problem_url != '' THEN excluded.problem_url ELSE problem_url END",
                params![p.assignment_id, p.problem_id, p.problem_name, p.problem_order, p.max_score, p.is_ac, problem_url],
            ).map_err(|e| format!("Failed to upsert wecode_problem: {e}"))?;
        }

        // 4. Upsert submissions & XP awards
        let mut affected_dates: HashSet<String> = HashSet::new();
        let now = chrono::Utc::now().timestamp();

        for dto in &submissions {
            let submit_time = match parse_wecode_timestamp(&dto.submit_time_str) {
                Ok(ts) => ts,
                Err(_) => now,
            };

            // Đảm bảo assignment tồn tại trong wecode_assignments
            let assign_name = dto.assignment_name.as_deref().unwrap_or("");
            let fallback_name = format!("Assignment {}", dto.assignment_id);
            let final_name = if assign_name.is_empty() { &fallback_name } else { assign_name };

            let assign_classes = dto.classes.as_deref().unwrap_or("");
            let _ = tx.execute(
                "INSERT INTO wecode_assignments (id, name, classes, created_at) VALUES (?1, ?2, ?3, strftime('%s', 'now'))
                 ON CONFLICT(id) DO UPDATE SET
                    name = CASE WHEN excluded.name != '' AND excluded.name NOT LIKE 'Assignment %' THEN excluded.name ELSE name END,
                    classes = CASE WHEN excluded.classes != '' THEN excluded.classes ELSE classes END",
                params![dto.assignment_id, final_name, assign_classes],
            );

            tx.execute(
                "INSERT INTO wecode_submissions
                 (submission_id, assignment_id, problem_id, problem_name, submit_time,
                  verdict, score, execution_time, memory_kib, language, is_final, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, strftime('%s', 'now'))
                 ON CONFLICT(submission_id) DO UPDATE SET
                    verdict = excluded.verdict,
                    score = excluded.score,
                    execution_time = excluded.execution_time,
                    memory_kib = excluded.memory_kib,
                    language = excluded.language,
                    is_final = excluded.is_final",
                params![
                    dto.submission_id,
                    dto.assignment_id,
                    dto.problem_id,
                    dto.problem_name,
                    submit_time,
                    dto.verdict,
                    dto.score,
                    dto.execution_time,
                    dto.memory_kib,
                    dto.language,
                    dto.is_final,
                ],
            ).map_err(|e| format!("Failed to upsert wecode_submission: {e}"))?;

            let is_accepted = dto.score == 100 || dto.verdict.to_uppercase() == "CORRECT ANSWER" || dto.verdict.to_uppercase() == "AC";
            if is_accepted {
                let _ = tx.execute(
                    "UPDATE wecode_problems SET is_ac = 1 WHERE assignment_id = ?1 AND problem_id = ?2",
                    params![dto.assignment_id, dto.problem_id],
                );

                if let Some(dt) = chrono::DateTime::from_timestamp(submit_time, 0) {
                    let event_date = dt.format("%Y-%m-%d").to_string();
                    let _ = tx.execute(
                        "INSERT OR IGNORE INTO activity_events
                         (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
                         VALUES ('uit-wecode', ?1, 'wecode_problem_ac', 15, ?2, strftime('%s','now'))",
                        params![event_date, dto.submission_id.to_string()],
                    );
                    affected_dates.insert(event_date);
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
            "INSERT INTO sync_state (service, last_synced_at) VALUES ('wecode', strftime('%s', 'now'))
             ON CONFLICT(service) DO UPDATE SET last_synced_at = excluded.last_synced_at",
            [],
        ).map_err(|e| format!("Failed to update wecode sync_state: {e}"))?;

        tx.commit().map_err(|e| format!("Failed to commit wecode transaction: {e}"))?;

        for date in &affected_dates {
            let _ = crate::commands::plugins::recompute_daily_matrix(&conn, date);
        }

        let total = submissions.len() + problems.len();
        println!("[Diark DB] Wecode records committed successfully. Submissions: {}, Problems: {}, Assignments: {}",
            submissions.len(), problems.len(), assignments.len());
        Ok(total)
    }

    pub fn commit_wecode_records(
        db: Arc<Mutex<Connection>>,
        submissions: Vec<WecodeSubmissionDto>,
    ) -> Result<(), String> {
        Self::commit_wecode_sync_request(
            db,
            crate::commands::wecode::WecodeSyncRequest::Legacy(submissions),
        ).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::ensure_wecode_schema(&conn).unwrap();
        crate::db::schema::ensure_plugin_and_activity_schema(&conn).unwrap();
        crate::db::schema::ensure_matrix_schema(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn test_wecode_completeness_check_rejects_missing_batches() {
        let registry = WecodeHarvesterRegistry::new();
        let sub = WecodeSubmissionDto {
            submission_id: 101,
            assignment_id: 1,
            assignment_name: Some("Assignment 1".to_string()),
            classes: Some("IT003.Q27.1".to_string()),
            problem_id: 2,
            problem_name: "Two Sum".to_string(),
            submit_time_str: "Fri, 17 Jul 2026 01:50:46".to_string(),
            verdict: "CORRECT ANSWER".to_string(),
            score: 100,
            execution_time: 0.05,
            memory_kib: 1024,
            language: "C++".to_string(),
            is_final: true,
        };

        // Gửi batch 0 trên tổng 2 batch
        registry.handle_batch("win1", 0, 2, vec![sub]).unwrap();

        let db = setup_test_db();
        let res = registry.commit_session("win1", db);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Incomplete payload detected: received 1/2 wecode submission batches"));
    }

    #[test]
    fn test_wecode_ingestion_engine_commit_atomic_success() {
        let registry = WecodeHarvesterRegistry::new();
        let sub1 = WecodeSubmissionDto {
            submission_id: 201,
            assignment_id: 5,
            assignment_name: Some("Assignment 5".to_string()),
            classes: Some("IT003.Q210.1".to_string()),
            problem_id: 10,
            problem_name: "Hello World".to_string(),
            submit_time_str: "Fri, 17 Jul 2026 01:50:46".to_string(),
            verdict: "CORRECT ANSWER".to_string(),
            score: 100,
            execution_time: 0.01,
            memory_kib: 512,
            language: "C++".to_string(),
            is_final: true,
        };
        let sub2 = WecodeSubmissionDto {
            submission_id: 202,
            assignment_id: 5,
            assignment_name: Some("Assignment 5".to_string()),
            classes: Some("IT003.Q210.1".to_string()),
            problem_id: 11,
            problem_name: "Sum Array".to_string(),
            submit_time_str: "Fri, 17 Jul 2026 02:10:00".to_string(),
            verdict: "WRONG ANSWER".to_string(),
            score: 0,
            execution_time: 0.02,
            memory_kib: 512,
            language: "C++".to_string(),
            is_final: false,
        };

        // 2 batch, gửi đủ 2 batch
        registry.handle_batch("win2", 0, 2, vec![sub1]).unwrap();
        registry.handle_batch("win2", 1, 2, vec![sub2]).unwrap();

        let db = setup_test_db();
        let count = registry.commit_session("win2", db.clone()).unwrap();
        assert_eq!(count, 2);

        let conn = db.lock().unwrap();
        let sub_count: i64 = conn.query_row("SELECT COUNT(*) FROM wecode_submissions", [], |r| r.get(0)).unwrap();
        assert_eq!(sub_count, 2);

        let assign_count: i64 = conn.query_row("SELECT COUNT(*) FROM wecode_assignments WHERE id = 5", [], |r| r.get(0)).unwrap();
        assert_eq!(assign_count, 1);
    }
}
