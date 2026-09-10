//! Master Life Matrix & Scoring Engine — Sprint v0.4
//!
//! Provides daily XP scoring and state tier classification by aggregating:
//! 1. Distinct First-AC submissions (Codeforces) for the day (+15 XP per problem).
//! 2. Completed course deadlines (Moodle/Workspace) with late penalties (+20 XP on-time, +5 XP late).
//! 3. State Tier assignment (0: Idle, 1: Low, 2: Mid, 3: High, 4: God Mode).
//! All date groupings are strictly normalized to UTC+07:00 (ICT).

use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};

/// Master Life Matrix Daily Record snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DailyMatrixRecord {
    /// Date normalized to ICT ('YYYY-MM-DD').
    pub date: String,
    /// Number of unique problems first solved on this day.
    pub ac_count: i64,
    /// Number of course deadlines marked submitted on this day.
    pub deadlines_cleared: i64,
    /// Total calculated XP for this day.
    pub total_xp: i64,
    /// State tier: 0 (Idle), 1 (Low), 2 (Mid), 3 (High), 4 (God Mode).
    pub state_tier: i64,
    /// Timestamp of the last update in Unix epoch seconds.
    pub updated_at: i64,
}

/// Classify state tier based on total daily XP:
/// - Tier 0 (Idle): total_xp == 0
/// - Tier 1 (Low): 1 <= total_xp <= 30
/// - Tier 2 (Mid): 31 <= total_xp <= 60
/// - Tier 3 (High): 61 <= total_xp <= 90
/// - Tier 4 (God Mode): total_xp > 90
pub fn calculate_state_tier(total_xp: i64) -> i64 {
    match total_xp {
        xp if xp <= 0 => 0,
        1..=30 => 1,
        31..=60 => 2,
        61..=90 => 3,
        _ => 4,
    }
}

/// Compute the daily matrix record for a specific date ('YYYY-MM-DD' in UTC+7).
///
/// P0 Fixes:
/// - Hole 1: Distinct Problems first solved on this day (First-AC only).
/// - Hole 2: On-time (+20 XP) vs Late (+5 XP) deadline penalties.
/// - Hole 3: SQLite `'unixepoch', '+7 hours'` time normalization.
pub fn compute_daily_matrix(conn: &Connection, date: &str) -> SqlResult<DailyMatrixRecord> {
    // 1. Calculate First-AC count (distinct problems solved for the first time on this date)
    let ac_count: i64 = conn.query_row(
        r#"
        WITH first_ac AS (
            SELECT contest_id, problem_index, MIN(submission_time) as first_ac_time
            FROM submissions
            WHERE verdict = 'OK'
            GROUP BY contest_id, problem_index
        )
        SELECT COUNT(*)
        FROM first_ac
        WHERE date(datetime(first_ac_time, 'unixepoch', '+7 hours')) = ?1
        "#,
        params![date],
        |row| row.get(0),
    )?;

    // 2. Calculate deadlines cleared and breakdown for on-time vs late
    let (deadlines_cleared, on_time_count, late_count): (i64, i64, i64) = conn.query_row(
        r#"
        SELECT 
            COUNT(*) as total_cleared,
            COALESCE(SUM(CASE WHEN updated_at <= due_timestamp THEN 1 ELSE 0 END), 0) as on_time_count,
            COALESCE(SUM(CASE WHEN updated_at > due_timestamp THEN 1 ELSE 0 END), 0) as late_count
        FROM course_deadlines
        WHERE is_submitted = 1
          AND date(datetime(updated_at, 'unixepoch', '+7 hours')) = ?1
        "#,
        params![date],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;

    // 3. XP calculation:
    // - Each First-AC awards 15 XP
    // - On-time deadline awards 20 XP
    // - Late deadline awards 5 XP
    let ac_xp = ac_count * 15;
    let deadline_xp = (on_time_count * 20) + (late_count * 5);
    let total_xp = ac_xp + deadline_xp;

    let state_tier = calculate_state_tier(total_xp);
    let now = chrono::Utc::now().timestamp();

    Ok(DailyMatrixRecord {
        date: date.to_string(),
        ac_count,
        deadlines_cleared,
        total_xp,
        state_tier,
        updated_at: now,
    })
}

/// Upsert a computed daily matrix record into `life_matrix_daily`.
pub fn upsert_daily_matrix(conn: &Connection, record: &DailyMatrixRecord) -> SqlResult<()> {
    conn.execute(
        r#"
        INSERT INTO life_matrix_daily (date, ac_count, deadlines_cleared, total_xp, state_tier, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(date) DO UPDATE SET
            ac_count = excluded.ac_count,
            deadlines_cleared = excluded.deadlines_cleared,
            total_xp = excluded.total_xp,
            state_tier = excluded.state_tier,
            updated_at = excluded.updated_at
        "#,
        params![
            record.date,
            record.ac_count,
            record.deadlines_cleared,
            record.total_xp,
            record.state_tier,
            record.updated_at,
        ],
    )?;
    Ok(())
}

/// Compute and atomically persist today's record.
pub fn compute_and_upsert_daily_matrix(
    conn: &Connection,
    date: &str,
) -> SqlResult<DailyMatrixRecord> {
    let record = compute_daily_matrix(conn, date)?;
    upsert_daily_matrix(conn, &record)?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::ensure_matrix_schema(&conn).unwrap();

        // Create submissions table schema for testing
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contest_id TEXT,
                problem_index TEXT,
                problem_id TEXT NOT NULL,
                problem_name TEXT NOT NULL,
                verdict TEXT NOT NULL,
                language TEXT,
                xp_awarded INTEGER NOT NULL DEFAULT 0,
                submitted_at TEXT NOT NULL,
                raw_payload TEXT,
                submission_time INTEGER,
                is_first_ac INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS course_deadlines (
                id TEXT PRIMARY KEY,
                course_code TEXT NOT NULL,
                title TEXT NOT NULL,
                due_timestamp INTEGER NOT NULL,
                due_date_raw TEXT NOT NULL,
                source_url TEXT NOT NULL,
                is_submitted INTEGER DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();

        conn
    }

    #[test]
    fn test_unixepoch_utc7_conversion() {
        let conn = setup_test_db();
        // Timestamp 1789014997 (ngày 10/09/2026 UTC+7) phải trả về chính xác chuỗi "2026-09-10".
        let res: String = conn
            .query_row(
                "SELECT date(datetime(1789014997, 'unixepoch', '+7 hours'))",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(res, "2026-09-10");
    }

    #[test]
    fn test_first_ac_deduplication() {
        let conn = setup_test_db();
        let target_date = "2026-09-10";

        // Problem 1: 1001A solved on 2026-09-10 (timestamp 1789014997)
        conn.execute(
            r#"
            INSERT INTO submissions (contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES ('1001', 'A', '1001A', 'Test A', 'OK', 1789014997, '2026-09-10T04:36:37Z')
            "#,
            [],
        ).unwrap();

        // Problem 1: 1001A solved AGAIN on 2026-09-10 with later submission
        conn.execute(
            r#"
            INSERT INTO submissions (contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES ('1001', 'A', '1001A', 'Test A', 'OK', 1789015000, '2026-09-10T04:36:40Z')
            "#,
            [],
        ).unwrap();

        // Problem 2: 1001B solved for the first time before today (e.g. 2026-09-08), but resubmitted OK today
        // 1788800000 = 2026-09-07
        conn.execute(
            r#"
            INSERT INTO submissions (contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES ('1001', 'B', '1001B', 'Test B', 'OK', 1788800000, '2026-09-07T12:00:00Z')
            "#,
            [],
        ).unwrap();
        conn.execute(
            r#"
            INSERT INTO submissions (contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES ('1001', 'B', '1001B', 'Test B', 'OK', 1789015000, '2026-09-10T04:36:40Z')
            "#,
            [],
        ).unwrap();

        // Problem 3: 1002C WA today, no OK
        conn.execute(
            r#"
            INSERT INTO submissions (contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES ('1002', 'C', '1002C', 'Test C', 'WRONG_ANSWER', 1789014997, '2026-09-10T04:36:37Z')
            "#,
            [],
        ).unwrap();

        let record = compute_daily_matrix(&conn, target_date).unwrap();
        // Only 1001A was first solved on 2026-09-10!
        assert_eq!(record.ac_count, 1);
        assert_eq!(record.total_xp, 15); // 1 AC * 15 XP
        assert_eq!(record.state_tier, 1); // 15 XP => Tier 1 (1..=30)
    }

    #[test]
    fn test_deadline_on_time_and_late_penalties() {
        let conn = setup_test_db();
        let target_date = "2026-09-10";

        // Deadline 1: On-time (submitted at 1789014997 <= due at 1789020000) -> +20 XP
        conn.execute(
            r#"
            INSERT INTO course_deadlines (id, course_code, title, due_timestamp, due_date_raw, source_url, is_submitted, updated_at)
            VALUES ('DL1', 'CS101', 'Assignment 1', 1789020000, '10/09/2026', 'http://moodle/1', 1, 1789014997)
            "#,
            [],
        ).unwrap();

        // Deadline 2: Late (submitted at 1789014997 > due at 1789010000) -> +5 XP
        conn.execute(
            r#"
            INSERT INTO course_deadlines (id, course_code, title, due_timestamp, due_date_raw, source_url, is_submitted, updated_at)
            VALUES ('DL2', 'CS102', 'Assignment 2', 1789010000, '10/09/2026', 'http://moodle/2', 1, 1789014997)
            "#,
            [],
        ).unwrap();

        // Deadline 3: Not submitted yet (is_submitted = 0) -> ignored
        conn.execute(
            r#"
            INSERT INTO course_deadlines (id, course_code, title, due_timestamp, due_date_raw, source_url, is_submitted, updated_at)
            VALUES ('DL3', 'CS103', 'Assignment 3', 1789020000, '10/09/2026', 'http://moodle/3', 0, 1789014997)
            "#,
            [],
        ).unwrap();

        let record = compute_daily_matrix(&conn, target_date).unwrap();
        assert_eq!(record.deadlines_cleared, 2);
        // 20 (on-time) + 5 (late) = 25 XP
        assert_eq!(record.total_xp, 25);
        assert_eq!(record.state_tier, 1);
    }

    #[test]
    fn test_state_tier_boundaries() {
        assert_eq!(calculate_state_tier(0), 0);
        assert_eq!(calculate_state_tier(-5), 0);

        assert_eq!(calculate_state_tier(1), 1);
        assert_eq!(calculate_state_tier(30), 1);

        assert_eq!(calculate_state_tier(31), 2);
        assert_eq!(calculate_state_tier(60), 2);

        assert_eq!(calculate_state_tier(61), 3);
        assert_eq!(calculate_state_tier(90), 3);

        assert_eq!(calculate_state_tier(91), 4);
        assert_eq!(calculate_state_tier(200), 4);
    }

    #[test]
    fn test_upsert_and_persist() {
        let conn = setup_test_db();
        let target_date = "2026-09-10";

        let record = compute_and_upsert_daily_matrix(&conn, target_date).unwrap();
        assert_eq!(record.date, target_date);

        let queried: DailyMatrixRecord = conn
            .query_row(
                "SELECT date, ac_count, deadlines_cleared, total_xp, state_tier, updated_at FROM life_matrix_daily WHERE date = ?1",
                params![target_date],
                |row| {
                    Ok(DailyMatrixRecord {
                        date: row.get(0)?,
                        ac_count: row.get(1)?,
                        deadlines_cleared: row.get(2)?,
                        total_xp: row.get(3)?,
                        state_tier: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .unwrap();

        assert_eq!(record.date, queried.date);
        assert_eq!(record.total_xp, queried.total_xp);
        assert_eq!(record.state_tier, queried.state_tier);
    }
}
