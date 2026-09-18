//! Workspace IPC Commands — Sprint v0.3.3
//!
//! Cung cấp 2 commands:
//! - `ingest_moodle_course_html`: Parse + persist deadline từ Moodle course HTML
//! - `check_and_launch_vscode`: Mở thư mục workspace trong VS Code
//!
//! Design: nhận `SharedDb` State thay vì `db_path: String` để tái dùng connection
//! pool đã được quản lý, tránh tạo SQLite connection mới không cần thiết.

use crate::db::SharedDb;
use crate::modules::academic::moodle_parser::{parse_moodle_course_view, ScrapedDeadline};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::Path;

// ============================================================
//  DATA CONTRACTS (IPC boundary)
// ============================================================

/// Kết quả của 1 lần ingest Moodle course.
#[derive(Debug, Serialize)]
pub struct MoodleIngestResult {
    pub course_code: String,
    pub course_title: String,
    pub deadlines_upserted: usize,
    pub deadlines: Vec<ScrapedDeadline>,
}

/// Config workspace cho 1 môn học (dùng cho get/set workspace).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    pub course_code: String,
    pub workspace_path: String,
    pub target_score: f64,
}

// ============================================================
//  DEADLINE COMMANDS
// ============================================================

/// Parse HTML trang Moodle course view và persist danh sách deadline vào SQLite.
///
/// Nhận `SharedDb` State (kết nối dùng chung) — KHÔNG mở connection mới.
/// Dùng transaction để đảm bảo batch upsert nguyên tử.
#[tauri::command]
pub fn ingest_moodle_course_html(
    db: tauri::State<'_, SharedDb>,
    html_content: String,
) -> Result<MoodleIngestResult, String> {
    // 1. Parse (pure, không lock DB)
    let parsed =
        parse_moodle_course_view(&html_content).map_err(|e| format!("Parse lỗi: {e}"))?;

    // 2. Persist
    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Lỗi tạo transaction: {e}"))?;
    let now = chrono::Utc::now().timestamp();

    let mut count = 0usize;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO course_deadlines
                    (id, course_code, title, due_timestamp, due_date_raw, source_url, is_submitted, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    title         = excluded.title,
                    due_timestamp = excluded.due_timestamp,
                    due_date_raw  = excluded.due_date_raw,
                    source_url    = excluded.source_url,
                    updated_at    = excluded.updated_at",
            )
            .map_err(|e| format!("Lỗi prepare statement: {e}"))?;

        for d in &parsed.deadlines {
            stmt.execute(params![
                d.id,
                d.course_code,
                d.title,
                d.due_timestamp,
                d.due_date_raw,
                d.source_url,
                now,
            ])
            .map_err(|e| format!("Lỗi upsert deadline '{}': {e}", d.id))?;
            count += 1;
        }
    }

    tx.commit()
        .map_err(|e| format!("Lỗi commit transaction: {e}"))?;

    Ok(MoodleIngestResult {
        course_code: parsed.course_code,
        course_title: parsed.course_title,
        deadlines_upserted: count,
        deadlines: parsed.deadlines,
    })
}

/// Lấy toàn bộ deadlines còn hạn (due_timestamp > now) từ DB.
#[tauri::command]
pub fn get_upcoming_deadlines(
    db: tauri::State<'_, SharedDb>,
    course_code: Option<String>,
) -> Result<Vec<ScrapedDeadline>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let now = chrono::Utc::now().timestamp();

    // Phải collect trong cùng scope với stmt vì MappedRows mượn stmt.
    // Tách 2 branch rõ ràng để borrow checker thỏa mãn.
    let rows: Vec<ScrapedDeadline> = if let Some(ref code) = course_code {
        let mut stmt = conn
            .prepare(
                "SELECT id, course_code, title, due_timestamp, due_date_raw, source_url
                 FROM course_deadlines
                 WHERE due_timestamp > ?1 AND is_submitted = 0 AND course_code = ?2
                 ORDER BY due_timestamp ASC",
            )
            .map_err(|e| format!("Lỗi prepare: {e}"))?;
        let collected: rusqlite::Result<Vec<ScrapedDeadline>> = stmt
            .query_map(params![now, code], |row| {
                Ok(ScrapedDeadline {
                    id: row.get(0)?,
                    course_code: row.get(1)?,
                    title: row.get(2)?,
                    due_timestamp: row.get(3)?,
                    due_date_raw: row.get(4)?,
                    source_url: row.get(5)?,
                })
            })
            .map_err(|e| format!("Lỗi query: {e}"))?
            .collect();
        collected.map_err(|e| format!("Lỗi đọc rows: {e}"))?
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, course_code, title, due_timestamp, due_date_raw, source_url
                 FROM course_deadlines
                 WHERE due_timestamp > ?1 AND is_submitted = 0
                 ORDER BY due_timestamp ASC",
            )
            .map_err(|e| format!("Lỗi prepare: {e}"))?;
        let collected: rusqlite::Result<Vec<ScrapedDeadline>> = stmt
            .query_map(params![now], |row| {
                Ok(ScrapedDeadline {
                    id: row.get(0)?,
                    course_code: row.get(1)?,
                    title: row.get(2)?,
                    due_timestamp: row.get(3)?,
                    due_date_raw: row.get(4)?,
                    source_url: row.get(5)?,
                })
            })
            .map_err(|e| format!("Lỗi query: {e}"))?
            .collect();
        collected.map_err(|e| format!("Lỗi đọc rows: {e}"))?
    };

    Ok(rows)
}

/// Đánh dấu deadline đã nộp.
#[tauri::command]
pub fn mark_deadline_submitted(
    db: tauri::State<'_, SharedDb>,
    deadline_id: String,
) -> Result<(), String> {
    if deadline_id.trim().is_empty() {
        return Err("deadline_id không được để trống".to_string());
    }
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "UPDATE course_deadlines SET is_submitted = 1, updated_at = ?1 WHERE id = ?2",
        params![now, deadline_id],
    )
    .map_err(|e| format!("Lỗi update: {e}"))?;

    // Đồng bộ ngay lập tức Master Life Matrix cho ngày hoàn thành deadline theo UTC+7
    let offset_ict = chrono::FixedOffset::east_opt(7 * 3600).ok_or("Invalid UTC+7 offset")?;
    let today_ict = chrono::DateTime::from_timestamp(now, 0)
        .map(|dt| dt.with_timezone(&offset_ict).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| chrono::Utc::now().with_timezone(&offset_ict).format("%Y-%m-%d").to_string());

    crate::db::matrix::recompute_daily_matrix_for_date(&conn, &today_ict)
        .map_err(|e| format!("Lỗi cập nhật life matrix: {e}"))?;

    Ok(())
}

// ============================================================
//  WORKSPACE COMMANDS
// ============================================================

/// Upsert config workspace cho 1 môn học (đường dẫn folder + target score).
#[tauri::command]
pub fn upsert_workspace_config(
    db: tauri::State<'_, SharedDb>,
    config: WorkspaceConfig,
) -> Result<(), String> {
    if config.course_code.trim().is_empty() {
        return Err("course_code không được để trống".to_string());
    }
    if config.workspace_path.trim().is_empty() {
        return Err("workspace_path không được để trống".to_string());
    }

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO course_workspace_config (course_code, workspace_path, target_score, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(course_code) DO UPDATE SET
            workspace_path = excluded.workspace_path,
            target_score   = excluded.target_score,
            updated_at     = excluded.updated_at",
        params![
            config.course_code.trim(),
            config.workspace_path.trim(),
            config.target_score,
            now
        ],
    )
    .map_err(|e| format!("Lỗi upsert workspace config: {e}"))?;
    Ok(())
}

/// Lấy workspace config của 1 môn học.
#[tauri::command]
pub fn get_workspace_config(
    db: tauri::State<'_, SharedDb>,
    course_code: String,
) -> Result<Option<WorkspaceConfig>, String> {
    if course_code.trim().is_empty() {
        return Err("course_code không được để trống".to_string());
    }
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let result = conn.query_row(
        "SELECT course_code, workspace_path, target_score FROM course_workspace_config WHERE course_code = ?1",
        params![course_code.trim()],
        |row| {
            Ok(WorkspaceConfig {
                course_code: row.get(0)?,
                workspace_path: row.get(1)?,
                target_score: row.get(2)?,
            })
        },
    );
    match result {
        Ok(cfg) => Ok(Some(cfg)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Lỗi query workspace config: {e}")),
    }
}

/// Kiểm tra thư mục tồn tại rồi mở trong VS Code.
/// Non-blocking: spawn process và return ngay.
#[tauri::command]
pub fn check_and_launch_vscode(workspace_path: String) -> Result<(), String> {
    let path = Path::new(&workspace_path);

    if !path.exists() {
        return Err(format!("Thư mục không tồn tại: {workspace_path}"));
    }
    if !path.is_dir() {
        return Err(format!("Đường dẫn không phải thư mục: {workspace_path}"));
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "code", workspace_path.as_str()])
            .spawn()
            .map_err(|e| format!("Lỗi khởi chạy VS Code (Windows): {e}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("code")
            .arg(workspace_path.as_str())
            .spawn()
            .map_err(|e| format!("Lỗi khởi chạy VS Code: {e}"))?;
    }

    Ok(())
}
