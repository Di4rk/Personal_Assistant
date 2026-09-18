//! Database queries and synchronization logic for Master Life Matrix date range and daily scoring.

use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct LifeMatrixEntryDto {
    pub date: String,
    pub ac_count: i32,
    pub deadlines_cleared: i32,
    pub total_xp: i32,
    pub state_tier: u8,
}

/// Queries a continuous date range using SQLite recursive CTE,
/// left-joining with `life_matrix_daily` so that missing days default to 0.
pub fn query_life_matrix_range(
    conn: &Connection,
    start_date: &str,
    end_date: &str,
) -> SqlResult<Vec<LifeMatrixEntryDto>> {
    let mut stmt = conn.prepare_cached(
        "WITH RECURSIVE date_range(d) AS (
            SELECT date(?1)
            UNION ALL
            SELECT date(d, '+1 day') FROM date_range WHERE d < date(?2)
        )
        SELECT 
            date_range.d AS date,
            COALESCE(lmd.ac_count, 0)          AS ac_count,
            COALESCE(lmd.deadlines_cleared, 0) AS deadlines_cleared,
            COALESCE(lmd.total_xp, 0)          AS total_xp,
            COALESCE(lmd.state_tier, 0)        AS state_tier
        FROM date_range
        LEFT JOIN life_matrix_daily lmd ON lmd.date = date_range.d
        ORDER BY date_range.d ASC;"
    )?;

    let rows = stmt.query_map(params![start_date, end_date], |row| {
        let tier_val: u8 = row.get(4)?;
        Ok(LifeMatrixEntryDto {
            date: row.get(0)?,
            ac_count: row.get(1)?,
            deadlines_cleared: row.get(2)?,
            total_xp: row.get(3)?,
            state_tier: tier_val.min(4),
        })
    })?;

    let mut entries = Vec::with_capacity(364);
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

/// Computes daily matrix XP and state tier for `target_date_ict` (format: 'YYYY-MM-DD' in UTC+07:00),
/// then atomically upserts the record into `life_matrix_daily`.
///
/// Rules:
/// 1. Distinct First-AC: Only counts problems solved for the very first time on this date (verdict = 'OK').
///    Formula: Distinct_AC * 15 XP.
/// 2. Deadlines:
///    - On-time: is_submitted = 1 AND updated_at <= due_timestamp (+20 XP).
///    - Late: is_submitted = 1 AND updated_at > due_timestamp (+5 XP).
/// 3. Total XP = (Distinct_AC * 15) + (OnTime_Deadlines * 20) + (Late_Deadlines * 5).
/// 4. State Tier Mapping:
///    - Tier 0 (Idle): total_xp <= 0
///    - Tier 1 (Low): 1..=30
///    - Tier 2 (Mid): 31..=60
///    - Tier 3 (High): 61..=90
///    - Tier 4 (God Mode): total_xp > 90
pub fn recompute_daily_matrix_for_date(
    conn: &Connection,
    target_date_ict: &str,
) -> AppResult<()> {
    // 1. Calculate Distinct First-AC count using CTE with 'unixepoch', '+7 hours' normalization
    let ac_count: i64 = conn.query_row(
        r#"
        WITH first_ac AS (
            SELECT 
                contest_id,
                problem_index,
                MIN(COALESCE(submission_time, CAST(strftime('%s', submitted_at) AS INTEGER))) AS first_ac_ts
            FROM submissions
            WHERE verdict = 'OK'
            GROUP BY contest_id, problem_index
        )
        SELECT COUNT(*) 
        FROM first_ac 
        WHERE date(datetime(first_ac_ts, 'unixepoch', '+7 hours')) = ?1
        "#,
        params![target_date_ict],
        |row| row.get(0),
    ).unwrap_or(0);

    // 2. Calculate deadlines breakdown: on-time (+20 XP) vs late (+5 XP)
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
        params![target_date_ict],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap_or((0, 0, 0));

    // 3. Compute Total XP and Map Tier (0 -> 4)
    let total_xp = (ac_count * 15) + (on_time_count * 20) + (late_count * 5);
    let state_tier: u8 = match total_xp {
        xp if xp <= 0 => 0,
        1..=30 => 1,
        31..=60 => 2,
        61..=90 => 3,
        _ => 4,
    };

    // 4. UPSERT into life_matrix_daily
    let now = chrono::Utc::now().timestamp();
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
            target_date_ict,
            ac_count,
            deadlines_cleared,
            total_xp,
            state_tier,
            now,
        ],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db should open");
        crate::db::schema::ensure_matrix_schema(&conn).expect("matrix schema should be created");
        crate::db::schema::ensure_moodle_schema(&conn).expect("moodle schema should be created");

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
            CREATE VIEW IF NOT EXISTS cf_submissions AS SELECT * FROM submissions;
            "#,
        )
        .expect("submissions table should be created");

        conn
    }

    #[test]
    fn test_unixepoch_ict_conversion() {
        let conn = Connection::open_in_memory().unwrap();
        // 1710000000 = Sun Mar 09 2024 16:00:00 UTC -> 23:00:00 ICT (Cùng ngày 2024-03-09)
        // 1710005000 = Sun Mar 09 2024 17:23:20 UTC -> 00:23:20 ICT ngày hôm sau (2024-03-10)
        let res: String = conn
            .query_row(
                "SELECT date(datetime(1710005000, 'unixepoch', '+7 hours'))",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(res, "2024-03-10");
    }

    #[test]
    fn test_query_life_matrix_range_continuous_days() {
        let conn = setup_test_db();

        // Query a 7-day range with no records in life_matrix_daily
        let entries = query_life_matrix_range(&conn, "2026-03-01", "2026-03-07").expect("query should succeed");
        assert_eq!(entries.len(), 7, "7 continuous days must be returned");

        assert_eq!(entries[0].date, "2026-03-01");
        assert_eq!(entries[6].date, "2026-03-07");
        for entry in &entries {
            assert_eq!(entry.ac_count, 0);
            assert_eq!(entry.deadlines_cleared, 0);
            assert_eq!(entry.total_xp, 0);
            assert_eq!(entry.state_tier, 0);
        }
    }

    #[test]
    fn test_query_life_matrix_range_with_existing_records() {
        let conn = setup_test_db();

        // Insert a record for 2026-03-04
        conn.execute(
            "INSERT INTO life_matrix_daily (date, ac_count, deadlines_cleared, total_xp, state_tier, updated_at)
             VALUES ('2026-03-04', 3, 1, 150, 2, 123456789)",
            [],
        )
        .expect("insert should succeed");

        let entries = query_life_matrix_range(&conn, "2026-03-01", "2026-03-07").expect("query should succeed");
        assert_eq!(entries.len(), 7);

        let day4 = entries.iter().find(|e| e.date == "2026-03-04").expect("2026-03-04 should exist");
        assert_eq!(day4.ac_count, 3);
        assert_eq!(day4.deadlines_cleared, 1);
        assert_eq!(day4.total_xp, 150);
        assert_eq!(day4.state_tier, 2);

        let day1 = entries.iter().find(|e| e.date == "2026-03-01").expect("2026-03-01 should exist");
        assert_eq!(day1.total_xp, 0);
        assert_eq!(day1.state_tier, 0);
    }

    #[test]
    fn test_recompute_daily_matrix_ac_and_deadlines() {
        let conn = setup_test_db();
        let target_date = "2026-09-10";

        // 1789014997 is 2026-09-10 in UTC+7
        // Insert 1 First-AC problem, 1 duplicate AC problem, 1 on-time deadline, 1 late deadline
        conn.execute_batch(
            r#"
            INSERT INTO submissions (contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES ('1001', 'A', '1001A', 'Problem A', 'OK', 1789014997, '2026-09-10T04:36:37Z');

            INSERT INTO submissions (contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES ('1001', 'A', '1001A', 'Problem A', 'OK', 1789015000, '2026-09-10T04:36:40Z');

            INSERT INTO course_deadlines (id, course_code, title, due_timestamp, due_date_raw, source_url, is_submitted, updated_at)
            VALUES ('DL1', 'CS101', 'Assignment 1', 1789020000, '10/09/2026', 'http://moodle/1', 1, 1789014997);

            INSERT INTO course_deadlines (id, course_code, title, due_timestamp, due_date_raw, source_url, is_submitted, updated_at)
            VALUES ('DL2', 'CS102', 'Assignment 2', 1789010000, '10/09/2026', 'http://moodle/2', 1, 1789014997);
            "#,
        ).unwrap();

        recompute_daily_matrix_for_date(&conn, target_date).expect("recompute should succeed");

        let entry: LifeMatrixEntryDto = conn.query_row(
            "SELECT date, ac_count, deadlines_cleared, total_xp, state_tier FROM life_matrix_daily WHERE date = ?1",
            params![target_date],
            |row| {
                Ok(LifeMatrixEntryDto {
                    date: row.get(0)?,
                    ac_count: row.get(1)?,
                    deadlines_cleared: row.get(2)?,
                    total_xp: row.get(3)?,
                    state_tier: row.get(4)?,
                })
            },
        ).unwrap();

        assert_eq!(entry.date, target_date);
        assert_eq!(entry.ac_count, 1);
        assert_eq!(entry.deadlines_cleared, 2);
        // XP: (1 AC * 15) + (1 On-Time * 20) + (1 Late * 5) = 15 + 20 + 5 = 40 XP
        assert_eq!(entry.total_xp, 40);
        assert_eq!(entry.state_tier, 2); // 40 XP is Tier 2 (31..=60)
    }
}
