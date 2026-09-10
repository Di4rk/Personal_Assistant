pub mod academic;
pub mod matrix;
pub mod post_mortem;
pub mod workspace;

use chrono::Local;
use rusqlite::params;
use serde::Serialize;

use crate::db::SharedDb;
use crate::gamification::{calc_level_info, LevelInfo};
use crate::services::cf_worker::{self, SyncLock};

#[derive(Debug, Serialize, Clone)]
pub struct DailyStats {
    pub date: String,
    pub total_xp: i64,
    pub ac_count: i64,
    pub wa_count: i64,
    pub other_count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SubmissionRecord {
    pub id: i64,
    pub problem_id: String,
    pub problem_name: String,
    pub verdict: String,
    pub language: Option<String>,
    pub contest_id: Option<String>,
    pub xp_awarded: i64,
    pub submitted_at: String,
}

/// Payload trả về từ `trigger_cf_sync` — khớp với SyncCompletePayload trong
/// tauri-client.ts. Dùng i64 cho count thay vì usize vì JSON/JS không có unsigned.
#[derive(Debug, Serialize, Clone)]
pub struct SyncCompletePayload {
    pub success: bool,
    pub message: String,
    pub new_submissions_count: i64,
}

/// Lấy stats hôm nay để render lên Dashboard (XP, số AC/WA trong ngày).
/// Trả về default 0 nếu chưa có hoạt động nào hôm nay (không phải lỗi).
#[tauri::command]
pub fn get_today_stats(db: tauri::State<'_, SharedDb>) -> Result<DailyStats, String> {
    let today = Local::now().format("%Y-%m-%d").to_string();

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    let result = conn.query_row(
        "SELECT date, total_xp, ac_count, wa_count, other_count
         FROM daily_activity WHERE date = ?1",
        params![today],
        |row| {
            Ok(DailyStats {
                date: row.get(0)?,
                total_xp: row.get(1)?,
                ac_count: row.get(2)?,
                wa_count: row.get(3)?,
                other_count: row.get(4)?,
            })
        },
    );

    match result {
        Ok(stats) => Ok(stats),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(DailyStats {
            date: today,
            total_xp: 0,
            ac_count: 0,
            wa_count: 0,
            other_count: 0,
        }),
        Err(e) => Err(format!("Lỗi query daily stats: {e}")),
    }
}

/// Lấy N submission gần nhất, mặc định 20, để hiển thị feed hoạt động.
#[tauri::command]
pub fn get_recent_submissions(
    db: tauri::State<'_, SharedDb>,
    limit: Option<i64>,
) -> Result<Vec<SubmissionRecord>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 200); // chặn limit vô lý tránh query nặng

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, problem_id, problem_name, verdict, language, contest_id, xp_awarded, submitted_at
             FROM submissions
             ORDER BY submitted_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("Lỗi prepare statement: {e}"))?;

    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(SubmissionRecord {
                id: row.get(0)?,
                problem_id: row.get(1)?,
                problem_name: row.get(2)?,
                verdict: row.get(3)?,
                language: row.get(4)?,
                contest_id: row.get(5)?,
                xp_awarded: row.get(6)?,
                submitted_at: row.get(7)?,
            })
        })
        .map_err(|e| format!("Lỗi query submissions: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Lỗi đọc rows: {e}"))
}

#[derive(Debug, Serialize, Clone)]
pub struct HeatmapDay {
    pub date: String,
    pub total_xp: i64,
    pub ac_count: i64,
    /// Tier để frontend map thẳng ra màu, không phải tính lại logic ở React.
    /// "rest" | "productive" | "god_mode"
    pub tier: &'static str,
}

fn xp_to_tier(xp: i64) -> &'static str {
    if xp <= 0 {
        "rest"
    } else if xp < 50 {
        "productive"
    } else {
        "god_mode"
    }
}

/// Lấy toàn bộ daily_activity của 1 năm để render lưới Heatmap 365 ô.
/// Trả về TẤT CẢ ngày trong năm (kể cả ngày 0 hoạt động) để frontend không phải
/// tự tính ngày thiếu - tránh lệch lịch giữa Rust (server-side date) và JS (client-side date).
#[tauri::command]
pub fn get_yearly_heatmap(
    db: tauri::State<'_, SharedDb>,
    year: i32,
) -> Result<Vec<HeatmapDay>, String> {
    use chrono::{Datelike, Duration, NaiveDate};
    use std::collections::HashMap;

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT date, total_xp, ac_count FROM daily_activity
             WHERE date LIKE ?1 ORDER BY date ASC",
        )
        .map_err(|e| format!("Lỗi prepare statement: {e}"))?;

    let pattern = format!("{year}-%");
    let rows = stmt
        .query_map(params![pattern], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("Lỗi query heatmap: {e}"))?;

    let mut existing: HashMap<String, (i64, i64)> = HashMap::new();
    for row in rows {
        let (date, xp, ac) = row.map_err(|e| format!("Lỗi đọc row: {e}"))?;
        existing.insert(date, (xp, ac));
    }

    // Điền đủ 365/366 ngày, ngày nào không có data thì mặc định 0 (tier "rest").
    let start = NaiveDate::from_ymd_opt(year, 1, 1).ok_or("Năm không hợp lệ")?;
    let is_leap = NaiveDate::from_ymd_opt(year, 12, 31).unwrap().ordinal() == 366;
    let days_in_year = if is_leap { 366 } else { 365 };

    let mut result = Vec::with_capacity(days_in_year);
    for offset in 0..days_in_year as i64 {
        let date = start + Duration::days(offset);
        let date_str = date.format("%Y-%m-%d").to_string();
        let (xp, ac) = existing.get(&date_str).copied().unwrap_or((0, 0));

        result.push(HeatmapDay {
            date: date_str,
            total_xp: xp,
            ac_count: ac,
            tier: xp_to_tier(xp),
        });
    }

    Ok(result)
}

/// Lấy level + progress hiện tại, tính từ TỔNG XP mọi thời điểm (không phải hôm nay).
#[tauri::command]
pub fn get_level_info(db: tauri::State<'_, SharedDb>) -> Result<LevelInfo, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    let total_xp: i64 = conn
        .query_row("SELECT COALESCE(SUM(total_xp), 0) FROM daily_activity", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("Lỗi tính tổng XP: {e}"))?;

    Ok(calc_level_info(total_xp))
}

#[tauri::command]
pub fn set_cf_handle(db: tauri::State<'_, SharedDb>, handle: String) -> Result<(), String> {
    let trimmed = handle.trim();
    if trimmed.is_empty() {
        return Err("CF handle không được để trống".to_string());
    }

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::set_setting(&conn, "cf_handle", trimmed)
        .map_err(|e| format!("Lỗi lưu cf_handle: {e}"))
}

#[tauri::command]
pub fn get_cf_handle(db: tauri::State<'_, SharedDb>) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::get_setting(&conn, "cf_handle").map_err(|e| format!("Lỗi đọc cf_handle: {e}"))
}

/// Trigger 1 sync cycle ngay lập tức từ UI, được bảo vệ bởi SyncLock để tránh
/// chồng chéo với background worker. Trả về SyncCompletePayload để UI có thể
/// hiển thị trạng thái sync mà không cần đợi event riêng.
#[tauri::command]
pub async fn trigger_cf_sync(
    app: tauri::AppHandle,
    client: tauri::State<'_, reqwest::Client>,
    db: tauri::State<'_, SharedDb>,
    sync_lock: tauri::State<'_, SyncLock>,
) -> Result<SyncCompletePayload, String> {
    // Nếu lock đã bị giữ (background worker đang chạy hoặc IPC call khác),
    // trả về thông báo rõ ràng thay vì đứng chờ.
    let _guard = sync_lock.try_acquire().ok_or_else(|| {
        "Sync đang chạy — vui lòng đợi chu kỳ hiện tại hoàn tất".to_string()
    })?;

    match cf_worker::perform_sync(&app, &client, &db, 200).await {
        Ok(result) => Ok(SyncCompletePayload {
            success: true,
            message: if result.new_submissions_count > 0 {
                format!(
                    "+{} submission mới, +{} XP hôm nay",
                    result.new_submissions_count, result.total_daily_xp
                )
            } else {
                "Không có submission mới".to_string()
            },
            new_submissions_count: result.new_submissions_count as i64,
        }),
        Err(e) => Ok(SyncCompletePayload {
            success: false,
            message: format!("Sync thất bại: {e}"),
            new_submissions_count: 0,
        }),
    }
}
