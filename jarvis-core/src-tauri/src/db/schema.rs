use chrono::Local;
use rusqlite::{params, Connection, Result as SqlResult};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Alias cho state dùng chung giữa Tauri commands và Axum server.
/// Bọc trong Arc<Mutex<>> vì rusqlite::Connection không phải Send+Sync tự nhiên
/// khi bị mutate từ nhiều nơi -- Mutex đảm bảo chỉ 1 thread ghi tại 1 thời điểm.
pub type SharedDb = Arc<Mutex<Connection>>;

/// Khởi tạo connection SQLite tại đường dẫn chỉ định, bật WAL mode,
/// và chạy migration tạo bảng nếu chưa tồn tại (idempotent - chạy lại
/// bao nhiêu lần cũng an toàn).
pub fn init_db(db_path: &Path) -> SqlResult<Connection> {
    let conn = Connection::open(db_path)?;

    // WAL mode: cho phép nhiều reader đọc song song với 1 writer,
    // giảm hẳn lỗi "database is locked" khi UI đang query mà server vừa ghi.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?; // an toàn đủ dùng, nhanh hơn FULL
    conn.pragma_update(None, "foreign_keys", "ON")?;

    run_migrations(&conn)?;

    Ok(conn)
}

fn run_migrations(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS submissions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            problem_id      TEXT NOT NULL,
            problem_name    TEXT NOT NULL,
            verdict         TEXT NOT NULL,
            language        TEXT,
            contest_id      TEXT,
            xp_awarded      INTEGER NOT NULL DEFAULT 0,
            submitted_at    TEXT NOT NULL,
            raw_payload     TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at
            ON submissions (submitted_at);

        CREATE TABLE IF NOT EXISTS daily_activity (
            date            TEXT PRIMARY KEY,   -- format: YYYY-MM-DD
            total_xp        INTEGER NOT NULL DEFAULT 0,
            ac_count        INTEGER NOT NULL DEFAULT 0,
            wa_count        INTEGER NOT NULL DEFAULT 0,
            other_count     INTEGER NOT NULL DEFAULT 0,
            updated_at      TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

/// Tính XP dựa theo verdict. Đặt logic ở đây (thay vì rải trong server handler)
/// để sau này dễ mở rộng (VD: bonus First AC, streak multiplier...).
pub fn calc_xp(verdict: &str) -> i64 {
    match verdict.to_uppercase().as_str() {
        "OK" | "ACCEPTED" | "AC" => 10,
        "WRONG_ANSWER" | "WA" | "TIME_LIMIT_EXCEEDED" | "TLE" | "RUNTIME_ERROR" | "RE" => 2,
        _ => 0,
    }
}

/// Ghi 1 submission mới + cập nhật daily_activity trong CÙNG 1 transaction.
/// Transaction đảm bảo 2 bảng luôn đồng bộ - không bao giờ có trường hợp
/// insert submission thành công nhưng update daily_activity thất bại giữa chừng.
pub fn insert_submission_and_update_daily(
    conn: &mut Connection,
    problem_id: &str,
    problem_name: &str,
    verdict: &str,
    language: Option<&str>,
    contest_id: Option<&str>,
    raw_payload: &str,
) -> SqlResult<i64> {
    let xp = calc_xp(verdict);
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let now_iso = now.to_rfc3339();

    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO submissions
            (problem_id, problem_name, verdict, language, contest_id, xp_awarded, submitted_at, raw_payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![problem_id, problem_name, verdict, language, contest_id, xp, now_iso, raw_payload],
    )?;

    let verdict_upper = verdict.to_uppercase();
    let (ac_inc, wa_inc, other_inc) = if verdict_upper == "OK" || verdict_upper == "ACCEPTED" {
        (1, 0, 0)
    } else if verdict_upper.contains("WRONG") || verdict_upper.contains("TIME_LIMIT") {
        (0, 1, 0)
    } else {
        (0, 0, 1)
    };

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
        params![today, xp, ac_inc, wa_inc, other_inc, now_iso],
    )?;

    tx.commit()?;
    Ok(xp)
}
