use std::collections::{HashMap, HashSet};

use chrono::Local;
use rusqlite::{params, Connection};

use crate::db::schema::calc_xp;
use crate::services::cf_worker::CfSubmission;

/// Bonus XP khi AC 1 problem_id LẦN ĐẦU TIÊN (chưa từng AC trước đó, kể cả ở
/// những lần sync trước). Thưởng cao hơn AC thường để khuyến khích làm bài mới
/// thay vì chỉ resubmit lại bài cũ để cày XP.
const FIRST_AC_BONUS_XP: i64 = 10;

/// Struct trung gian, tách biệt hoàn toàn khỏi format JSON của Codeforces API.
/// cf_worker.rs chịu trách nhiệm convert CfSubmission (raw API) -> NewSubmission
/// trước khi gọi xuống đây - DB layer không cần biết gì về Codeforces cả,
/// dễ tái sử dụng cho nguồn data khác (VD: CSES, AtCoder sau này).
#[derive(Debug, Clone)]
pub struct NewSubmission {
    pub cf_submission_id: i64,
    pub problem_id: String,
    pub problem_name: String,
    pub verdict: String,
    pub language: String,
    pub contest_id: Option<String>,
    pub submitted_at: String, // RFC3339
}

#[derive(Debug, Default, Clone)]
struct DailyDelta {
    xp: i64,
    ac: i64,
    wa: i64,
    other: i64,
}

/// Kết quả của 1 lần batch insert - đúng shape yêu cầu ở spec, và cũng chính
/// là payload emit thẳng qua Tauri event "cf://sync-event" (xem cf_worker.rs) -
/// không cần định nghĩa struct payload riêng, tránh 2 nguồn sự thật lệch nhau.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncResult {
    pub new_submissions_count: usize,
    pub total_daily_xp: i64,
    /// Số problem lần đầu AC trong batch này - hữu ích cho toast "🎉 First AC!"
    /// ở frontend, tách riêng khỏi total_daily_xp để UI dễ hiển thị nổi bật.
    pub first_ac_count: usize,
    #[serde(default)]
    pub affected_dates: Vec<String>,
}

/// Ingest raw Codeforces submissions in one SQLite transaction. Pending
/// verdicts and malformed timestamps are skipped; duplicate submission IDs are
/// ignored by the partial unique index created during migration.
pub fn ingest_cf_submissions(
    conn: &mut Connection,
    submissions: &[CfSubmission],
) -> rusqlite::Result<usize> {
    Ok(ingest_cf_submissions_with_result(conn, submissions)?.new_submissions_count)
}

/// Variant used by the sync worker when it needs the XP delta for its frontend
/// event payload.
pub fn ingest_cf_submissions_with_result(
    conn: &mut Connection,
    submissions: &[CfSubmission],
) -> rusqlite::Result<SyncResult> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    // Codeforces returns newest-first. Process oldest-first so a historical
    // sync awards the 20 XP first-AC bonus to the actual first accepted run.
    let mut ordered = submissions.to_vec();
    ordered.sort_by_key(|submission| submission.creation_time_seconds);

    let normalized = ordered
        .iter()
        .filter_map(NewSubmission::from_codeforces)
        .collect::<Vec<_>>();

    batch_insert_new_submissions(conn, &normalized, &today)
}

/// Insert hàng loạt submission mới trong 1 transaction duy nhất:
/// 1. Query trước danh sách problem_id đã từng AC (để xác định First AC chính xác,
///    kể cả AC đó xảy ra ở lần sync trước đó rồi, không chỉ trong batch hiện tại).
/// 2. INSERT OR IGNORE dùng UNIQUE INDEX(cf_submission_id) để SQLite tự dedup -
///    không cần Rust tự query-check-rồi-insert từng cái.
/// 3. Aggregate lại daily_activity cho MỌI ngày xuất hiện trong batch (không chỉ
///    hôm nay) - quan trọng khi worker restart sau thời gian dài offline.
pub fn batch_insert_new_submissions(
    conn: &mut Connection,
    subs: &[NewSubmission],
    today: &str,
) -> rusqlite::Result<SyncResult> {
    if subs.is_empty() {
        return Ok(SyncResult::default());
    }

    let tx = conn.transaction()?;

    // Bước 1: nạp trước tập problem_id đã từng AC, dùng để phát hiện First AC
    // chính xác tuyệt đối - kể cả problem đó được AC lần đầu ở 1 sync cycle
    // TRƯỚC ĐÓ chứ không phải trong batch hiện tại.
    let mut ac_problem_set: HashSet<String> = {
        let mut stmt = tx.prepare("SELECT DISTINCT problem_id FROM submissions WHERE verdict = 'OK'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        set
    };

    let mut new_submissions_count = 0usize;
    let mut first_ac_count = 0usize;
    let mut daily_deltas: HashMap<String, DailyDelta> = HashMap::new();

    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO submissions
                (cf_submission_id, problem_id, problem_name, verdict, language,
                 contest_id, xp_awarded, submitted_at, raw_payload, is_first_ac)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;

        for sub in subs {
            let is_ac = sub.verdict == "OK";
            // Xác định First AC TRƯỚC khi insert, và ghi nhận ngay vào set (không
            // đợi biết insert có thành công hay không) - đảm bảo 2 submission AC
            // cùng problem_id trong CÙNG 1 batch, chỉ cái đầu tiên được tính First AC.
            let is_first_ac = is_ac && !ac_problem_set.contains(&sub.problem_id);
            if is_ac {
                ac_problem_set.insert(sub.problem_id.clone());
            }

            let xp = if is_ac {
                calc_xp(&sub.verdict) + if is_first_ac { FIRST_AC_BONUS_XP } else { 0 }
            } else {
                2
            };

            let changes = stmt.execute(params![
                sub.cf_submission_id,
                sub.problem_id,
                sub.problem_name,
                sub.verdict,
                sub.language,
                sub.contest_id,
                xp,
                sub.submitted_at,
                "", // raw_payload: không lưu full JSON ở luồng worker để tiết kiệm dung lượng DB
                is_first_ac as i64,
            ])?;

            // changes == 0 nghĩa là INSERT OR IGNORE đã bỏ qua vì trùng cf_submission_id -
            // đây chính là cơ chế dedup, không cần logic Rust bổ sung.
            if changes > 0 {
                new_submissions_count += 1;
                if is_first_ac {
                    first_ac_count += 1;
                }

                let date_key = sub
                    .submitted_at
                    .get(0..10)
                    .map(str::to_string)
                    .unwrap_or_else(|| today.to_string());

                let entry = daily_deltas.entry(date_key).or_insert_with(DailyDelta::default);
                entry.xp += xp;
                match sub.verdict.as_str() {
                    "OK" => entry.ac += 1,
                    "WRONG_ANSWER" | "TIME_LIMIT_EXCEEDED" => entry.wa += 1,
                    _ => entry.other += 1,
                }
            }
        }
    }

    let updated_at = Local::now().to_rfc3339();
    for (date, delta) in &daily_deltas {
        tx.execute(
            r#"
            INSERT INTO daily_activity (date, total_xp, ac_count, wa_count, other_count, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(date) DO UPDATE SET
                total_xp    = total_xp + excluded.total_xp,
                ac_count    = ac_count + excluded.ac_count,
                wa_count    = wa_count + excluded.wa_count,
                other_count = other_count + excluded.other_count,
                updated_at  = excluded.updated_at
            "#,
            params![date, delta.xp, delta.ac, delta.wa, delta.other, updated_at],
        )?;
    }

    // Gom nhóm DISTINCT date bị ảnh hưởng (N <= Days) để batch trigger recompute
    let distinct_dates: HashSet<String> = daily_deltas.keys().cloned().collect();
    let affected_dates: Vec<String> = distinct_dates.iter().cloned().collect();

    tx.commit()?;

    // Cập nhật Master Life Matrix duy nhất 1 lần cho mỗi ngày duy nhất bị ảnh hưởng
    for date_key in &distinct_dates {
        let _ = crate::db::matrix::recompute_daily_matrix_for_date(conn, date_key);
    }

    // total_daily_xp trong SyncResult chỉ tính riêng XP của HÔM NAY (không phải
    // tổng cả batch, có thể gồm cả submission của ngày trước nếu worker vừa
    // restart sau thời gian dài offline) - đúng ngữ nghĩa tên field theo spec.
    let today_xp = daily_deltas.get(today).map(|d| d.xp).unwrap_or(0);

    Ok(SyncResult {
        new_submissions_count,
        total_daily_xp: today_xp,
        first_ac_count,
        affected_dates,
    })
}

impl NewSubmission {
    fn from_codeforces(submission: &CfSubmission) -> Option<Self> {
        let verdict = submission.verdict.as_deref()?;
        if matches!(verdict, "TESTING" | "SUBMITTED") {
            return None;
        }

        let submitted_at = chrono::DateTime::from_timestamp(submission.creation_time_seconds, 0)?
            .to_rfc3339();
        let contest_id = submission.contest_id.or(submission.problem.contest_id);
        let contest_id_string = contest_id.map(|id| id.to_string());
        let problem_id = contest_id_string
            .as_ref()
            .map(|id| format!("{id}{}", submission.problem.index))
            .unwrap_or_else(|| submission.problem.index.clone());

        Some(Self {
            cf_submission_id: submission.id,
            problem_id,
            problem_name: submission.problem.name.clone(),
            verdict: verdict.to_string(),
            language: submission.programming_language.clone(),
            contest_id: contest_id_string,
            submitted_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::ingest_cf_submissions;
    use crate::services::cf_worker::{CfProblem, CfSubmission};

    fn test_submission(id: i64, timestamp: i64, verdict: &str) -> CfSubmission {
        CfSubmission {
            id,
            contest_id: Some(1),
            creation_time_seconds: timestamp,
            problem: CfProblem {
                contest_id: Some(1),
                index: "A".to_string(),
                name: "Test problem".to_string(),
                tags: Vec::new(),
            },
            programming_language: "GNU C++17".to_string(),
            verdict: Some(verdict.to_string()),
        }
    }

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE submissions (
                    id INTEGER PRIMARY KEY,
                    cf_submission_id INTEGER,
                    problem_id TEXT NOT NULL,
                    problem_name TEXT NOT NULL,
                    verdict TEXT NOT NULL,
                    language TEXT,
                    contest_id TEXT,
                    xp_awarded INTEGER NOT NULL,
                    submitted_at TEXT NOT NULL,
                    raw_payload TEXT,
                    is_first_ac INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX idx_submissions_cf_id
                    ON submissions(cf_submission_id) WHERE cf_submission_id IS NOT NULL;
                CREATE TABLE daily_activity (
                    date TEXT PRIMARY KEY,
                    total_xp INTEGER NOT NULL DEFAULT 0,
                    ac_count INTEGER NOT NULL DEFAULT 0,
                    wa_count INTEGER NOT NULL DEFAULT 0,
                    other_count INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );
                "#,
            )
            .expect("test schema should initialize");
        connection
    }

    #[test]
    fn ingestion_orders_history_awards_xp_and_deduplicates() {
        let mut connection = test_connection();
        let newest_first = vec![
            test_submission(2, 200, "OK"),
            test_submission(1, 100, "OK"),
            test_submission(3, 300, "WRONG_ANSWER"),
        ];

        assert_eq!(ingest_cf_submissions(&mut connection, &newest_first).unwrap(), 3);

        let first_ac_xp: i64 = connection
            .query_row(
                "SELECT xp_awarded FROM submissions WHERE cf_submission_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let later_ac_xp: i64 = connection
            .query_row(
                "SELECT xp_awarded FROM submissions WHERE cf_submission_id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let rejected_xp: i64 = connection
            .query_row(
                "SELECT xp_awarded FROM submissions WHERE cf_submission_id = 3",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!((first_ac_xp, later_ac_xp, rejected_xp), (20, 10, 2));
        assert_eq!(ingest_cf_submissions(&mut connection, &newest_first).unwrap(), 0);
    }
}
