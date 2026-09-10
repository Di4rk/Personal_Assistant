use chrono::Local;
use rusqlite::{params, Connection, Result as SqlResult};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Alias cho state dùng chung giữa Tauri commands và Axum server.
/// Bọc trong Arc<Mutex<>> vì rusqlite::Connection không phải Send+Sync tự nhiên
/// khi bị mutate từ nhiều nơi -- Mutex đảm bảo chỉ 1 thread ghi tại 1 thời điểm.
pub type SharedDb = Arc<Mutex<Connection>>;

/// Khởi tạo connection SQLite tại đường dẫn chỉ định, bật WAL mode,
/// và chạy migration tạo bảng nếu chưa tồn tại (idempotent - chạy lại
/// bao nhiêu lần cũng an toàn).
pub fn init_db(db_path: &Path) -> SqlResult<Connection> {
    let conn = Connection::open(db_path)?;

    // busy_timeout: SQLite menunggu hingga 5s sebelum mengembalikan SQLITE_BUSY
    // ketika ada koneksi lain (misal DB Browser) yang sedang memegang lock.
    // Ini mencegah worker gagal total hanya karena inspeksi sesaat.
    conn.busy_timeout(Duration::from_millis(5000))?;

    // WAL mode: cho phép nhiều reader đọc song song với 1 writer,
    // giảm hẳn lỗi "database is locked" khi UI đang query mà server vừa ghi.
    // `journal_mode = WAL` trả về mode đã được SQLite chọn. `pragma_update`
    // dùng execute() nội bộ nên sẽ lỗi "Execute returned results" với PRAGMA
    // này; API _and_check đọc và tiêu thụ row kết quả đúng cách.
    let _: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    conn.pragma_update(None, "synchronous", "NORMAL")?; // an toàn đủ dùng, nhanh hơn FULL
    conn.pragma_update(None, "foreign_keys", "ON")?;

    run_migrations(&conn)?;
    ensure_worker_schema(&conn)?;
    ensure_post_mortem_schema(&conn)?;
    crate::db::academic::init_academic_module(&conn)?;
    ensure_moodle_schema(&conn)?;
    ensure_matrix_schema(&conn)?;
    apply_legacy_compatibility_migrations(&conn)?;
    purge_mock_submissions(&conn)?;

    Ok(conn)
}

/// Khởi tạo schema hoàn chỉnh phục vụ integration tests và in-memory SQLite database.
pub fn create_tables(conn: &Connection) -> SqlResult<()> {
    run_migrations(conn)?;
    ensure_worker_schema(conn)?;
    ensure_post_mortem_schema(conn)?;
    crate::db::academic::init_academic_module(conn)?;
    ensure_moodle_schema(conn)?;
    ensure_matrix_schema(conn)?;
    apply_legacy_compatibility_migrations(conn)?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS cf_submissions (
            id INTEGER PRIMARY KEY,
            contest_id TEXT,
            problem_index TEXT,
            submission_time INTEGER,
            verdict TEXT
        );

        CREATE TRIGGER IF NOT EXISTS trg_cf_submissions_sync AFTER INSERT ON cf_submissions
        BEGIN
            INSERT OR REPLACE INTO submissions (id, contest_id, problem_index, problem_id, problem_name, verdict, submission_time, submitted_at)
            VALUES (new.id, new.contest_id, new.problem_index, COALESCE(new.contest_id, '') || new.problem_index, 'Problem ' || new.problem_index, new.verdict, new.submission_time, datetime(new.submission_time, 'unixepoch'));
        END;
        "#,
    )?;

    Ok(())
}

/// Vá tương thích ngược cho các database đã tồn tại cục bộ từ các bản build trước.
pub fn apply_legacy_compatibility_migrations(conn: &Connection) -> SqlResult<()> {
    let has_macro_table: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'academic_macro_metrics'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if has_macro_table {
        // 1. Quét và vá các bản ghi cũ có classification bị NULL hoặc rỗng
        conn.execute(
            "UPDATE academic_macro_metrics 
             SET classification = 'Chưa xếp loại' 
             WHERE classification IS NULL OR classification = '';",
            [],
        )?;

        // 2. Bảo đảm rank_label cũng có fallback an toàn nếu tồn tại cột
        let has_rank_label: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('academic_macro_metrics') WHERE name = 'rank_label'")?
            .exists([])?;

        if has_rank_label {
            conn.execute(
                "UPDATE academic_macro_metrics 
                 SET rank_label = 'Chưa xếp loại' 
                 WHERE rank_label IS NULL OR rank_label = '';",
                [],
            )?;
        }
    }

    Ok(())
}

/// Migration cho hệ thống Post-Mortem + FTS5 full-text search.
///
/// QUAN TRỌNG: dùng pattern "external content" của FTS5 (content='post_mortems',
/// content_rowid='id') thay vì để FTS5 tự lưu bản sao dữ liệu - lý do:
/// 1. Tránh duplicate data (post_mortems đã có key_insight/tags rồi, FTS5 external
///    content chỉ lưu index, không lưu lại text gốc lần 2).
/// 2. Bắt buộc phải có trigger đồng bộ thủ công vì SQLite KHÔNG tự động sync
///    external-content FTS5 table khi bảng gốc thay đổi - thiếu trigger nào
///    trong 3 cái (INSERT/UPDATE/DELETE) là index bị lệch âm thầm, search vẫn
///    chạy được nhưng trả kết quả cũ/thiếu mà không có lỗi gì báo hiệu.
pub(crate) fn ensure_post_mortem_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS post_mortems (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            problem_id    TEXT NOT NULL UNIQUE,
            problem_name  TEXT NOT NULL,
            platform      TEXT NOT NULL DEFAULT 'codeforces',
            root_cause    TEXT NOT NULL CHECK (
                root_cause IN (
                    'LOGIC_BUG', 'CORNER_CASE', 'TIME_COMPLEXITY',
                    'IMPLEMENTATION', 'MISREAD'
                )
            ),
            key_insight   TEXT NOT NULL,
            -- Comma-separated, đã normalize (lowercase, trim, dedup) trước khi ghi -
            -- xem normalize_tags() trong post_mortem.rs. VD: 'dp,tree,bitmask'.
            tags          TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );

        -- External content FTS5 table: KHÔNG lưu lại dữ liệu, chỉ index trỏ về
        -- post_mortems qua content_rowid='id'. problem_id đánh dấu UNINDEXED vì
        -- đây là identifier tra cứu chính xác (exact match qua WHERE thường,
        -- không phải full-text search) - loại khỏi FTS index giúp giảm kích
        -- thước index mà không mất khả năng tra cứu (đã có UNIQUE index riêng
        -- trên post_mortems.problem_id).
        CREATE VIRTUAL TABLE IF NOT EXISTS post_mortems_fts USING fts5(
            problem_id UNINDEXED,
            problem_name,
            key_insight,
            tags,
            content='post_mortems',
            content_rowid='id'
        );

        -- AFTER INSERT: thêm entry mới vào FTS index, rowid khớp với id vừa insert.
        CREATE TRIGGER IF NOT EXISTS post_mortems_ai AFTER INSERT ON post_mortems BEGIN
            INSERT INTO post_mortems_fts(rowid, problem_id, problem_name, key_insight, tags)
            VALUES (new.id, new.problem_id, new.problem_name, new.key_insight, new.tags);
        END;

        -- AFTER DELETE: dùng lệnh 'delete' đặc biệt của FTS5 external-content -
        -- KHÔNG phải "DELETE FROM post_mortems_fts WHERE rowid = old.id" thông
        -- thường, vì external-content table cần command riêng để dọn sạch
        -- internal shadow tables (segment b-tree) đúng cách.
        CREATE TRIGGER IF NOT EXISTS post_mortems_ad AFTER DELETE ON post_mortems BEGIN
            INSERT INTO post_mortems_fts(post_mortems_fts, rowid, problem_id, problem_name, key_insight, tags)
            VALUES ('delete', old.id, old.problem_id, old.problem_name, old.key_insight, old.tags);
        END;

        -- AFTER UPDATE: FTS5 external-content KHÔNG hỗ trợ update tại chỗ -
        -- phải xoá bản ghi cũ (đúng nội dung CŨ, dùng 'old.*') rồi insert lại
        -- bản ghi mới. Thiếu bước xoá sẽ để lại rác trong index (từ khoá cũ
        -- vẫn match được dù nội dung đã đổi).
        CREATE TRIGGER IF NOT EXISTS post_mortems_au AFTER UPDATE ON post_mortems BEGIN
            INSERT INTO post_mortems_fts(post_mortems_fts, rowid, problem_id, problem_name, key_insight, tags)
            VALUES ('delete', old.id, old.problem_id, old.problem_name, old.key_insight, old.tags);
            INSERT INTO post_mortems_fts(rowid, problem_id, problem_name, key_insight, tags)
            VALUES (new.id, new.problem_id, new.problem_name, new.key_insight, new.tags);
        END;
        "#,
    )?;

    Ok(())
}

/// Migration bổ sung cho background worker: thêm cột `cf_submission_id` nếu
/// chưa có (idempotent - an toàn chạy lại mỗi lần app khởi động), tạo unique
/// index để SQLite tự chặn trùng lặp bằng INSERT OR IGNORE, và bảng settings
/// key-value để lưu CF handle.
///
/// KHÔNG dùng ALTER TABLE ADD COLUMN vô điều kiện vì SQLite sẽ throw lỗi
/// "duplicate column name" nếu cột đã tồn tại từ lần chạy trước - phải check
/// PRAGMA table_info trước.
fn ensure_worker_schema(conn: &Connection) -> SqlResult<()> {
    let has_cf_id_column = {
        let mut stmt = conn.prepare("PRAGMA table_info(submissions)")?;
        let column_names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut found = false;
        for name in column_names {
            if name? == "cf_submission_id" {
                found = true;
                break;
            }
        }
        found
    };

    if !has_cf_id_column {
        conn.execute_batch("ALTER TABLE submissions ADD COLUMN cf_submission_id INTEGER;")?;
    }

    let has_first_ac_column = {
        let mut stmt = conn.prepare("PRAGMA table_info(submissions)")?;
        let column_names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut found = false;
        for name in column_names {
            if name? == "is_first_ac" {
                found = true;
                break;
            }
        }
        found
    };

    if !has_first_ac_column {
        conn.execute_batch(
            "ALTER TABLE submissions ADD COLUMN is_first_ac INTEGER NOT NULL DEFAULT 0;",
        )?;
    }

    conn.execute_batch(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_cf_id
            ON submissions (cf_submission_id) WHERE cf_submission_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;

    Ok(())
}

/// Tạo schema cho Moodle deadline tracker và workspace config (idempotent).
pub fn ensure_moodle_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS course_workspace_config (
            course_code    TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL,
            target_score   REAL DEFAULT 8.5,
            updated_at     INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS course_deadlines (
            id             TEXT PRIMARY KEY,  -- Format: "{course_code}_{cmid}"
            course_code    TEXT NOT NULL,
            title          TEXT NOT NULL,
            due_timestamp  INTEGER NOT NULL,  -- Unix epoch seconds (UTC)
            due_date_raw   TEXT NOT NULL,     -- e.g. "18/09/2026 23:59"
            source_url     TEXT NOT NULL,
            is_submitted   INTEGER DEFAULT 0,
            updated_at     INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_deadlines_course
            ON course_deadlines(course_code);
        CREATE INDEX IF NOT EXISTS idx_deadlines_due
            ON course_deadlines(due_timestamp)
            WHERE is_submitted = 0;
        "#,
    )?;
    Ok(())
}

/// Tạo schema cho Master Life Matrix Daily Record và bảo đảm các cột cần thiết cho First-AC (idempotent).
pub fn ensure_matrix_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        -- Master Life Matrix Daily Record
        CREATE TABLE IF NOT EXISTS life_matrix_daily (
            date TEXT PRIMARY KEY, -- Format: 'YYYY-MM-DD' (Normalized to UTC+07:00 ICT)
            ac_count INTEGER NOT NULL DEFAULT 0,
            deadlines_cleared INTEGER NOT NULL DEFAULT 0,
            total_xp INTEGER NOT NULL DEFAULT 0,
            state_tier INTEGER NOT NULL DEFAULT 0, -- 0: Idle, 1: Low, 2: Mid, 3: High, 4: God Mode
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_life_matrix_date
            ON life_matrix_daily(date);
        "#,
    )?;

    // Bảo đảm bảng submissions có các cột submission_time và problem_index phục vụ P0 First-AC computation
    let has_submissions: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'submissions'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if has_submissions {
        let has_submission_time = {
            let mut stmt = conn.prepare("PRAGMA table_info(submissions)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let found = names.filter_map(Result::ok).any(|n| n == "submission_time");
            found
        };
        if !has_submission_time {
            conn.execute_batch("ALTER TABLE submissions ADD COLUMN submission_time INTEGER;")?;
            let _ = conn.execute(
                "UPDATE submissions SET submission_time = CAST(strftime('%s', submitted_at) AS INTEGER) WHERE submission_time IS NULL AND submitted_at IS NOT NULL",
                [],
            );
        }

        let has_problem_index = {
            let mut stmt = conn.prepare("PRAGMA table_info(submissions)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let found = names.filter_map(Result::ok).any(|n| n == "problem_index");
            found
        };
        if !has_problem_index {
            conn.execute_batch("ALTER TABLE submissions ADD COLUMN problem_index TEXT;")?;
            let _ = conn.execute(
                "UPDATE submissions SET problem_index = problem_id WHERE problem_index IS NULL AND problem_id IS NOT NULL",
                [],
            );
        }

        // Tạo trigger tự động đồng bộ submission_time và problem_index nếu được insert mà thiếu 2 trường này
        conn.execute_batch(
            r#"
            CREATE TRIGGER IF NOT EXISTS trg_submissions_matrix_defaults AFTER INSERT ON submissions
            BEGIN
                UPDATE submissions
                SET submission_time = COALESCE(new.submission_time, CAST(strftime('%s', new.submitted_at) AS INTEGER)),
                    problem_index = COALESCE(new.problem_index, new.problem_id)
                WHERE id = new.id AND (submission_time IS NULL OR problem_index IS NULL);
            END;
            "#,
        )?;
    }

    Ok(())
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

/// Dọn dẹp các bản ghi mock submission cũ còn sót lại từ giai đoạn test/dev.
/// Tự động chạy trong `init_db`. Nếu có bản ghi bị xoá, thực hiện `VACUUM` để
/// giải phóng triệt để disk space.
pub fn purge_mock_submissions(conn: &Connection) -> SqlResult<usize> {
    let deleted = conn.execute(
        "DELETE FROM submissions WHERE problem_name LIKE 'Mock Problem%' OR problem_id LIKE 'mock-%'",
        [],
    )?;
    if deleted > 0 {
        let _ = conn.execute_batch("VACUUM;");
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::init_db;

    #[test]
    fn init_db_consumes_journal_mode_result_and_runs_migrations() {
        let db_path = std::env::temp_dir().join(format!(
            "diark-schema-init-{}-{}.sqlite3",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));

        let connection = init_db(&db_path).expect("database initialization should succeed");
        let table_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'post_mortems'",
                [],
                |row| row.get(0),
            )
            .expect("post_mortems table query should succeed");
        assert_eq!(table_exists, 1);

        let curriculum_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'academic_curriculum'",
                [],
                |row| row.get(0),
            )
            .expect("academic_curriculum table query should succeed");
        assert_eq!(curriculum_exists, 1);

        let macro_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'academic_macro_metrics'",
                [],
                |row| row.get(0),
            )
            .expect("academic_macro_metrics table query should succeed");
        assert_eq!(macro_exists, 1);

        let program_summary_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'academic_program_summary'",
                [],
                |row| row.get(0),
            )
            .expect("academic_program_summary table query should succeed");
        assert_eq!(program_summary_exists, 1, "academic_program_summary phải được tạo bởi ensure_academic_schema");

        let matrix_exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'life_matrix_daily'",
                [],
                |row| row.get(0),
            )
            .expect("life_matrix_daily table query should succeed");
        assert_eq!(matrix_exists, 1, "life_matrix_daily phải được tạo bởi ensure_matrix_schema");

        drop(connection);
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn purge_mock_submissions_deletes_only_mock_records() {
        let db_path = std::env::temp_dir().join(format!(
            "diark-purge-test-{}-{}.sqlite3",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));

        let conn = init_db(&db_path).expect("init db failed");

        // Insert mix of real and mock submissions
        conn.execute(
            "INSERT INTO submissions (problem_id, problem_name, verdict, submitted_at)
             VALUES ('mock-1001A', 'Mock Problem 1001A', 'OK', '2026-03-01T10:00:00')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO submissions (problem_id, problem_name, verdict, submitted_at)
             VALUES ('1234B', 'Real Problem 1234B', 'OK', '2026-03-01T10:00:00')",
            [],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO submissions (problem_id, problem_name, verdict, submitted_at)
             VALUES ('mock-9999Z', 'Something Else', 'WA', '2026-03-01T10:00:00')",
            [],
        )
        .unwrap();

        let deleted = super::purge_mock_submissions(&conn).expect("purge should succeed");
        assert_eq!(deleted, 2);

        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM submissions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 1);

        drop(conn);
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn init_db_boots_with_zero_state_academic_tables() {
        let db_path = std::env::temp_dir().join(format!(
            "diark-zero-state-{}-{}.sqlite3",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));

        let conn = init_db(&db_path).expect("zero-state database initialization should succeed");

        let macro_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM academic_macro_metrics", [], |r| r.get(0))
            .unwrap();
        assert_eq!(macro_count, 0, "Zero-state boot must have 0 macro metric rows");

        let course_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM academic_courses", [], |r| r.get(0))
            .unwrap();
        assert_eq!(course_count, 0, "Zero-state boot must have 0 courses");

        drop(conn);
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("sqlite3-shm"));
    }

    #[test]
    fn test_apply_legacy_compatibility_migrations_null_safety() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::create_tables(&conn).unwrap();

        // Insert legacy row with empty string and another with null if possible
        conn.execute(
            "INSERT INTO academic_macro_metrics (semester_id, semester_label, classification, updated_at) 
             VALUES ('2023-2024.1', 'HK1 2023', '', 1710000000)",
            [],
        ).unwrap();

        super::apply_legacy_compatibility_migrations(&conn).expect("migration should succeed");

        let classification: String = conn.query_row(
            "SELECT classification FROM academic_macro_metrics WHERE semester_id = '2023-2024.1'",
            [],
            |r| r.get(0),
        ).unwrap();

        assert_eq!(classification, "Chưa xếp loại");
    }
}
