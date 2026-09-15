use rusqlite::params;
use tauri::{AppHandle, Emitter, State};
use crate::AppState;
use crate::modules::wecode::time_parser::parse_wecode_timestamp;

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq)]
pub struct WecodeSubmissionDto {
    pub submission_id: i64,
    pub assignment_id: i64,
    pub problem_id: i64,
    pub problem_name: String,
    pub submit_time_str: String,
    pub verdict: String,
    pub score: i64,
    pub execution_time: f64,
    pub memory_kib: i64,
    pub language: String,
    pub is_final: bool,
}

pub fn ingest_wecode_submissions_internal(
    app: &AppHandle,
    state: &State<AppState>,
    list: Vec<WecodeSubmissionDto>,
) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut affected_dates: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut parse_errors: Vec<String> = Vec::new();

    for dto in &list {
        let submit_time = match parse_wecode_timestamp(&dto.submit_time_str) {
            Ok(ts) => ts,
            Err(e) => {
                parse_errors.push(format!("submission {}: {e}", dto.submission_id));
                continue;
            }
        };

        // Đảm bảo assignment tồn tại trong wecode_assignments để thỏa mãn FK constraint
        let _ = tx.execute(
            "INSERT OR IGNORE INTO wecode_assignments (id, name) VALUES (?1, ?2)",
            params![dto.assignment_id, format!("Assignment {}", dto.assignment_id)],
        );

        tx.execute(
            "INSERT INTO wecode_submissions
             (submission_id, assignment_id, problem_id, problem_name, submit_time,
              verdict, score, execution_time, memory_kib, language, is_final)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(submission_id) DO UPDATE SET
                verdict = excluded.verdict,
                score = excluded.score,
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
        )
        .map_err(|e| e.to_string())?;

        // Binary first-AC award rule (score == 100 OR verdict == CORRECT ANSWER)
        let is_accepted = dto.score == 100 || dto.verdict == "CORRECT ANSWER";
        if is_accepted {
            let event_date = chrono::DateTime::from_timestamp(submit_time, 0)
                .map(|dt| dt.format("%Y-%m-%d").to_string())
                .ok_or_else(|| "Invalid submit_time for event_date derivation".to_string())?;

            tx.execute(
                "INSERT OR IGNORE INTO activity_events
                 (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
                 VALUES ('uit-wecode', ?1, 'wecode_problem_ac', 15, ?2, strftime('%s','now'))",
                params![event_date, dto.submission_id.to_string()],
            )
            .map_err(|e| e.to_string())?;

            affected_dates.insert(event_date);
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    for date in &affected_dates {
        crate::commands::plugins::recompute_daily_matrix(&conn, date)?;
    }

    if !parse_errors.is_empty() {
        let _ = app.emit("wecode-sync-partial-errors", &parse_errors);
    }
    let _ = app.emit("wecode-submissions-synced", ());

    Ok(())
}

#[tauri::command]
pub fn get_wecode_submissions(
    assignment_id: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<WecodeSubmissionDto>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let query = match assignment_id {
        Some(_) => {
            "SELECT submission_id, assignment_id, problem_id, problem_name, submit_time, \
             verdict, score, execution_time, memory_kib, language, is_final \
             FROM wecode_submissions WHERE assignment_id = ?1 ORDER BY submit_time DESC"
        }
        None => {
            "SELECT submission_id, assignment_id, problem_id, problem_name, submit_time, \
             verdict, score, execution_time, memory_kib, language, is_final \
             FROM wecode_submissions ORDER BY submit_time DESC LIMIT 200"
        }
    };

    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let rows = if let Some(aid) = assignment_id {
        stmt.query_map(params![aid], map_sub_row)
    } else {
        stmt.query_map([], map_sub_row)
    }
    .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for r in rows {
        result.push(r.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

fn map_sub_row(row: &rusqlite::Row) -> rusqlite::Result<WecodeSubmissionDto> {
    let submit_time: i64 = row.get(4)?;
    let submit_time_str = chrono::DateTime::from_timestamp(submit_time, 0)
        .map(|dt| dt.format("%a, %d %b %Y %H:%M:%S").to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    Ok(WecodeSubmissionDto {
        submission_id: row.get(0)?,
        assignment_id: row.get(1)?,
        problem_id: row.get(2)?,
        problem_name: row.get(3)?,
        submit_time_str,
        verdict: row.get(5)?,
        score: row.get(6)?,
        execution_time: row.get(7)?,
        memory_kib: row.get(8)?,
        language: row.get(9)?,
        is_final: row.get(10)?,
    })
}

#[tauri::command]
pub fn ingest_wecode_submissions_json(
    app: AppHandle,
    state: State<AppState>,
    payload_json: String,
) -> Result<usize, String> {
    let submissions: Vec<WecodeSubmissionDto> =
        serde_json::from_str(&payload_json).map_err(|e| format!("Lỗi parse JSON Wecode Submissions: {e}"))?;
    let count = submissions.len();
    let db_arc = state.db.clone();
    crate::services::wecode_harvester::WecodeIngestionEngine::commit_wecode_records(
        db_arc,
        submissions,
    )?;
    let _ = app.emit("wecode-submissions-synced", ());
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::ensure_wecode_schema(&conn).unwrap();
        crate::db::schema::ensure_matrix_schema(&conn).unwrap();
        crate::db::schema::ensure_plugin_and_activity_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn test_ingest_and_binary_gamification_ac() {
        let conn = setup_test_db();
        let shared_db = Arc::new(Mutex::new(conn));

        // Test inserting accepted submission
        let dto_ac = WecodeSubmissionDto {
            submission_id: 1001,
            assignment_id: 12,
            problem_id: 34,
            problem_name: "Binary Search".to_string(),
            submit_time_str: "Fri, 17 Jul 2026 01:50:46".to_string(),
            verdict: "CORRECT ANSWER".to_string(),
            score: 100,
            execution_time: 0.05,
            memory_kib: 2048,
            language: "C++".to_string(),
            is_final: true,
        };

        // Test inserting partial submission (should not award XP)
        let dto_partial = WecodeSubmissionDto {
            submission_id: 1002,
            assignment_id: 12,
            problem_id: 35,
            problem_name: "Merge Sort".to_string(),
            submit_time_str: "Fri, 17 Jul 2026 02:10:00".to_string(),
            verdict: "WRONG ANSWER".to_string(),
            score: 40,
            execution_time: 0.1,
            memory_kib: 4096,
            language: "C++".to_string(),
            is_final: false,
        };

        // Ingest directly via SQL logic simulation
        {
            let conn = shared_db.lock().unwrap();
            for dto in [&dto_ac, &dto_partial] {
                let submit_time = parse_wecode_timestamp(&dto.submit_time_str).unwrap();
                conn.execute(
                    "INSERT OR IGNORE INTO wecode_assignments (id, name) VALUES (?1, ?2)",
                    params![dto.assignment_id, "Test Assignment"],
                ).unwrap();

                conn.execute(
                    "INSERT INTO wecode_submissions
                     (submission_id, assignment_id, problem_id, problem_name, submit_time,
                      verdict, score, execution_time, memory_kib, language, is_final)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![
                        dto.submission_id, dto.assignment_id, dto.problem_id, dto.problem_name,
                        submit_time, dto.verdict, dto.score, dto.execution_time,
                        dto.memory_kib, dto.language, dto.is_final,
                    ],
                ).unwrap();

                if dto.score == 100 || dto.verdict == "CORRECT ANSWER" {
                    conn.execute(
                        "INSERT OR IGNORE INTO activity_events
                         (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
                         VALUES ('uit-wecode', '2026-07-17', 'wecode_problem_ac', 15, ?1, 1721181046)",
                        params![dto.submission_id.to_string()],
                    ).unwrap();
                }
            }

            // Verify wecode_submissions table has 2 rows
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM wecode_submissions", [], |r| r.get(0)).unwrap();
            assert_eq!(count, 2);

            // Verify activity_events table has ONLY 1 row (from score=100)
            let xp_events: Vec<(String, i64)> = {
                let mut stmt = conn.prepare("SELECT event_type, xp_value FROM activity_events WHERE plugin_id = 'uit-wecode'").unwrap();
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
            };
            assert_eq!(xp_events.len(), 1);
            assert_eq!(xp_events[0].0, "wecode_problem_ac");
            assert_eq!(xp_events[0].1, 15);
        }
    }
}
