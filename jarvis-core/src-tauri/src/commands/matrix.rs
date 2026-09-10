//! Matrix IPC Commands — Sprint v0.4
//!
//! Exposes IPC commands for the Master Life Matrix:
//! - `recompute_today_xp`: Computes today's snapshot (UTC+07:00 ICT) and upserts to `life_matrix_daily`.
//! - `get_heatmap_matrix`: Returns records for all days of the specified year.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{Datelike, Duration as ChronoDuration, FixedOffset, NaiveDate, Utc};
use rusqlite::params;
use tauri::State;

use crate::db::SharedDb;
pub use crate::modules::gamification::xp_engine::DailyMatrixRecord;
use crate::modules::gamification::xp_engine::compute_and_upsert_daily_matrix;

/// Recompute today's XP and metrics based on latest submissions and deadlines,
/// and UPSERT the snapshot into `life_matrix_daily`.
#[tauri::command]
pub fn recompute_today_xp(db: State<'_, SharedDb>) -> Result<DailyMatrixRecord, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(|e| format!("Lỗi cấu hình busy_timeout: {e}"))?;

    // Current date normalized to ICT (UTC+07:00)
    let offset_ict = FixedOffset::east_opt(7 * 3600).ok_or("Invalid UTC+7 offset")?;
    let today_ict = Utc::now().with_timezone(&offset_ict).format("%Y-%m-%d").to_string();

    compute_and_upsert_daily_matrix(&conn, &today_ict)
        .map_err(|e| format!("Lỗi tính toán daily matrix record: {e}"))
}

/// Retrieve the full year's daily matrix records for the 365-day grid.
/// Fills any missing dates with tier 0 defaults to avoid client-side date calculation drift.
#[tauri::command]
pub fn get_heatmap_matrix(
    db: State<'_, SharedDb>,
    year: i32,
) -> Result<Vec<DailyMatrixRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(|e| format!("Lỗi cấu hình busy_timeout: {e}"))?;

    let pattern = format!("{year}-%");
    let mut stmt = conn
        .prepare(
            r#"
            SELECT date, ac_count, deadlines_cleared, total_xp, state_tier, updated_at
            FROM life_matrix_daily
            WHERE date LIKE ?1
            ORDER BY date ASC;
            "#,
        )
        .map_err(|e| format!("Lỗi prepare query life_matrix_daily: {e}"))?;

    let rows = stmt
        .query_map(params![pattern], |row| {
            Ok(DailyMatrixRecord {
                date: row.get(0)?,
                ac_count: row.get(1)?,
                deadlines_cleared: row.get(2)?,
                total_xp: row.get(3)?,
                state_tier: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| format!("Lỗi query life_matrix_daily: {e}"))?;

    let mut existing: HashMap<String, DailyMatrixRecord> = HashMap::new();
    for row in rows {
        let record = row.map_err(|e| format!("Lỗi đọc row life_matrix_daily: {e}"))?;
        existing.insert(record.date.clone(), record);
    }

    let start = NaiveDate::from_ymd_opt(year, 1, 1).ok_or("Năm không hợp lệ")?;
    let is_leap = NaiveDate::from_ymd_opt(year, 12, 31).ok_or("Năm không hợp lệ")?.ordinal() == 366;
    let days_in_year = if is_leap { 366 } else { 365 };

    let mut result = Vec::with_capacity(days_in_year);
    for offset in 0..days_in_year as i64 {
        let date = start + ChronoDuration::days(offset);
        let date_str = date.format("%Y-%m-%d").to_string();

        if let Some(record) = existing.remove(&date_str) {
            result.push(record);
        } else {
            result.push(DailyMatrixRecord {
                date: date_str,
                ac_count: 0,
                deadlines_cleared: 0,
                total_xp: 0,
                state_tier: 0,
                updated_at: 0,
            });
        }
    }

    Ok(result)
}

/// Retrieve continuous daily matrix records for an arbitrary date range via recursive CTE.
#[tauri::command]
pub fn get_life_matrix_range(
    db: State<'_, SharedDb>,
    start_date: String,
    end_date: String,
) -> Result<Vec<crate::db::matrix::LifeMatrixEntryDto>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    crate::db::matrix::query_life_matrix_range(&conn, &start_date, &end_date)
        .map_err(|e| format!("Database query error: {e}"))
}
