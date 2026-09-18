use chrono::Local;
use rusqlite::{params, Connection, Result as SqlResult};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Alias cho state dùng chung giữa Tauri commands và Axum server.
/// Bọc trong Arc<Mutex<>> vì rusqlite::Connection không phải Send+Sync tự nhiên
/// khi bị mutate từ nhiều nơi -- Mutex đảm bảo chỉ 1 thread ghi tại 1 thời điểm.
pub type SharedDb = Arc<Mutex<Connection>>;

/// Nạp dynamic extension sqlite-vec (vec0) vào SQLite connection.
/// Tuyệt đối không unwrap(), ưu tiên tìm kiếm file binary tại các đường dẫn quy ước.
pub fn load_sqlite_vec_extension(conn: &Connection) -> SqlResult<()> {
    let candidate_paths = [
        std::path::PathBuf::from("./binaries/extensions/vec0"),
        std::path::PathBuf::from("binaries/extensions/vec0"),
        std::path::PathBuf::from("src-tauri/binaries/extensions/vec0"),
        std::path::PathBuf::from("../src-tauri/binaries/extensions/vec0"),
    ];

    let mut resolved_path = None;
    for p in &candidate_paths {
        let with_dll = p.with_extension("dll");
        if with_dll.exists() || p.exists() {
            resolved_path = Some(p.clone());
            break;
        }
    }

    let target = resolved_path.unwrap_or_else(|| std::path::PathBuf::from("./binaries/extensions/vec0"));
    unsafe {
        conn.load_extension(&target, None)?;
    }
    println!("[SQLite] Loaded sqlite-vec extension successfully from: {}", target.display());
    Ok(())
}

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
    // Khóa cache_size ở mức ~8MB (giá trị âm tính theo KiB: -8000 = 8000 KiB)
    conn.pragma_update(None, "cache_size", -8000)?;
    // Vô hiệu hóa mmap để tránh phình ảo virtual memory trên Windows.
    // Lưu ý: PRAGMA mmap_size = 0 trả về 1 row (giá trị mmap_size mới), nên dùng pragma_update_and_check để consume row.
    let _: i64 = conn.pragma_update_and_check(None, "mmap_size", 0, |row| row.get(0))?;

    // Bắt buộc mở cờ nạp dynamic extension trên Connection cho sqlite-vec
    if let Err(e) = load_sqlite_vec_extension(&conn) {
        eprintln!("[WARN] sqlite-vec extension load deferred: {e}");
    }

    run_migrations(&conn)?;
    ensure_worker_schema(&conn)?;
    ensure_post_mortem_schema(&conn)?;
    crate::db::academic::init_academic_module(&conn)?;
    ensure_curriculum_schema(&conn)?;
    ensure_wecode_schema(&conn)?;
    ensure_sync_state_schema(&conn)?;
    ensure_moodle_schema(&conn)?;
    ensure_matrix_schema(&conn)?;
    ensure_plugin_and_activity_schema(&conn)?;
    apply_legacy_compatibility_migrations(&conn)?;
    crate::db::vault_schema::init_vault_tables(&conn)?;
    purge_mock_submissions(&conn)?;

    Ok(conn)
}

/// Khởi tạo schema hoàn chỉnh phục vụ integration tests và in-memory SQLite database.
pub fn create_tables(conn: &Connection) -> SqlResult<()> {
    run_migrations(conn)?;
    ensure_worker_schema(conn)?;
    ensure_post_mortem_schema(conn)?;
    crate::db::academic::init_academic_module(conn)?;
    ensure_curriculum_schema(conn)?;
    ensure_wecode_schema(conn)?;
    ensure_moodle_schema(conn)?;
    ensure_matrix_schema(conn)?;
    ensure_plugin_and_activity_schema(conn)?;
    ensure_sync_state_schema(conn)?;
    apply_legacy_compatibility_migrations(conn)?;
    crate::db::vault_schema::init_vault_tables(conn)?;

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

/// Tạo schema cho Moodle deadline tracker, workspace config và UIT Courses Engine (idempotent).
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

        -- 1. Lớp môn học Moodle kỳ hiện tại
        CREATE TABLE IF NOT EXISTS moodle_courses (
            course_id        INTEGER PRIMARY KEY,
            course_code      TEXT NOT NULL,          -- 'SS009.R12', 'IT004.R19'
            fullname         TEXT NOT NULL,          -- 'Chủ nghĩa xã hội khoa học - SS009.R12'
            term             TEXT NOT NULL DEFAULT '',-- 'HK2 2025-2026'
            instructor_name  TEXT NOT NULL DEFAULT '',-- 'ThS. Trịnh Bá Phương'
            instructor_mail  TEXT NOT NULL DEFAULT '',-- 'phuongtbhcmue@gmail.com'
            instructor_phone TEXT NOT NULL DEFAULT '',-- '0376 333 654'
            course_url       TEXT NOT NULL,
            status           TEXT NOT NULL DEFAULT 'active', -- 'active' | 'archived'
            updated_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );

        -- 2. Bài tập / Nhiệm vụ Moodle
        CREATE TABLE IF NOT EXISTS moodle_tasks (
            task_id           INTEGER PRIMARY KEY,    -- ID activity Moodle
            course_id         INTEGER NOT NULL,
            title             TEXT NOT NULL,          -- 'ĐĂNG KÝ ĐỀ TÀI NHÓM'
            task_type         TEXT NOT NULL,          -- 'assign', 'quiz', 'forum'
            due_date          INTEGER NOT NULL,       -- Unix Epoch seconds
            is_submitted      BOOLEAN NOT NULL DEFAULT 0,
            submission_status TEXT NOT NULL DEFAULT '',-- 'No submissions have been made yet'
            template_file_url TEXT NOT NULL DEFAULT '',-- File docx mẫu đính kèm đề bài
            task_url          TEXT NOT NULL,          -- Deep-link tới trang nộp bài
            updated_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY(course_id) REFERENCES moodle_courses(course_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_moodle_tasks_due ON moodle_tasks(due_date, is_submitted);
        CREATE INDEX IF NOT EXISTS idx_moodle_tasks_course ON moodle_tasks(course_id);

        -- 3. Slide & Tài liệu học tập môn học
        CREATE TABLE IF NOT EXISTS moodle_materials (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            course_id         INTEGER NOT NULL,
            section_name      TEXT NOT NULL,               -- 'Chung', 'Tuần 1', 'Tuần 2'
            title             TEXT NOT NULL,               -- 'C1_Slide BG'
            file_url          TEXT NOT NULL,
            file_type         TEXT NOT NULL,               -- 'pdf', 'pptx', 'docx', 'link'
            created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            local_file_path   TEXT NOT NULL DEFAULT '',
            download_status   TEXT NOT NULL DEFAULT 'online_only', -- 'online_only' | 'downloading' | 'synced' | 'failed'
            file_size_bytes   INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(course_id) REFERENCES moodle_courses(course_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_moodle_mat_course ON moodle_materials(course_id);
        "#,
    )?;

    // Idempotent migrations cho các DB đã tồn tại trước v0.5.0 / v0.6.0
    let has_local_file_path: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('moodle_materials') WHERE name = 'local_file_path'")?
        .exists([])?;
    if !has_local_file_path {
        conn.execute("ALTER TABLE moodle_materials ADD COLUMN local_file_path TEXT NOT NULL DEFAULT '';", [])?;
    }

    let has_download_status: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('moodle_materials') WHERE name = 'download_status'")?
        .exists([])?;
    if !has_download_status {
        conn.execute("ALTER TABLE moodle_materials ADD COLUMN download_status TEXT NOT NULL DEFAULT 'online_only';", [])?;
    }

    let has_file_size_bytes: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('moodle_materials') WHERE name = 'file_size_bytes'")?
        .exists([])?;
    if !has_file_size_bytes {
        conn.execute("ALTER TABLE moodle_materials ADD COLUMN file_size_bytes INTEGER NOT NULL DEFAULT 0;", [])?;
    }

    let has_moodle_course_status: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('moodle_courses') WHERE name = 'status'")?
        .exists([])?;
    if !has_moodle_course_status {
        conn.execute("ALTER TABLE moodle_courses ADD COLUMN status TEXT NOT NULL DEFAULT 'active';", [])?;
    }

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

/// Tạo schema và dữ liệu hạt giống cho CTĐT đa ngành UIT và bí danh phân giải (idempotent).
pub fn ensure_curriculum_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS academic_curriculums (
            major_code      TEXT PRIMARY KEY,
            major_name      TEXT NOT NULL,
            faculty         TEXT NOT NULL,
            total_credits   INTEGER NOT NULL,
            standard_years  REAL NOT NULL DEFAULT 4.0
        );

        CREATE TABLE IF NOT EXISTS curriculum_aliases (
            alias_token     TEXT PRIMARY KEY,
            major_code      TEXT NOT NULL,
            credit_override INTEGER,
            FOREIGN KEY (major_code) REFERENCES academic_curriculums(major_code)
        );

        INSERT OR IGNORE INTO academic_curriculums (major_code, major_name, faculty, total_credits, standard_years)
        VALUES
            ('D480101', 'Khoa học Máy tính', 'Khoa KHMT', 126, 4.0),
            ('D480102', 'Mạng máy tính và TT', 'Khoa MMT&TT', 130, 4.0),
            ('D480103', 'Kỹ thuật Phần mềm', 'Khoa KTPM', 130, 4.0),
            ('D480104', 'Hệ thống Thông tin', 'Khoa HTTT', 130, 4.0),
            ('D480201', 'An toàn Thông tin', 'Khoa ATTT', 132, 4.0),
            ('D520216', 'Kỹ thuật Máy tính', 'Khoa KTMT', 132, 4.0);

        INSERT OR IGNORE INTO curriculum_aliases (alias_token, major_code, credit_override)
        VALUES
            ('KHMT-CLC',  'D480101', 130),
            ('KHMT-CTTT', 'D480101', 133),
            ('KHMT-CQUI', 'D480101', NULL),
            ('KHMT',      'D480101', NULL),
            ('KTPM-CLC',  'D480103', 133),
            ('KTPM',      'D480103', NULL),
            ('ATTT-CLC',  'D480201', 135),
            ('ATTT',      'D480201', NULL),
            ('HTTT',      'D480104', NULL),
            ('MMT',       'D480102', NULL),
            ('KTMT',      'D520216', NULL);

        CREATE TABLE IF NOT EXISTS curriculum_index (
            slug              TEXT PRIMARY KEY,
            major_name        TEXT NOT NULL,
            degree_level      TEXT,
            cohort_year       INTEGER,
            cohort_num        INTEGER,
            total_credits     REAL,
            training_duration TEXT,
            training_form     TEXT,
            is_cached         INTEGER DEFAULT 0,
            updated_at        INTEGER
        );

        CREATE TABLE IF NOT EXISTS curriculum_rules (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            slug              TEXT NOT NULL,
            knowledge_block   TEXT NOT NULL,
            required_credits  REAL NOT NULL,
            percent           REAL,
            FOREIGN KEY (slug) REFERENCES curriculum_index(slug) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS curriculum_courses (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            slug                 TEXT NOT NULL,
            course_code          TEXT NOT NULL,
            course_name          TEXT NOT NULL,
            credits              REAL NOT NULL,
            theory_credits       REAL,
            practical_credits    REAL,
            knowledge_block      TEXT NOT NULL,
            is_compulsory        INTEGER NOT NULL DEFAULT 1,
            recommended_semester INTEGER,
            FOREIGN KEY (slug) REFERENCES curriculum_index(slug) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_curr_courses_slug_block
            ON curriculum_courses(slug, knowledge_block);
        CREATE INDEX IF NOT EXISTS idx_curr_courses_code
            ON curriculum_courses(course_code);
        CREATE INDEX IF NOT EXISTS idx_curr_rules_slug
            ON curriculum_rules(slug);
        CREATE INDEX IF NOT EXISTS idx_curr_index_lookup
            ON curriculum_index(cohort_year, major_name);
        "#,
    )?;

    if let Err(e) = crate::services::curriculum_harvester::seed_curriculum_catalog_if_empty(conn) {
        eprintln!("[Curriculum] Seeding catalog deferred: {e}");
    }

    Ok(())
}

/// Tạo schema cho Wecode submissions, assignments và problems (idempotent).
pub fn ensure_wecode_schema(conn: &Connection) -> SqlResult<()> {
    ensure_sync_state_schema(conn)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS wecode_assignments (
            id              INTEGER PRIMARY KEY,
            name            TEXT NOT NULL DEFAULT '',
            classes         TEXT NOT NULL DEFAULT '',
            total_problems  INTEGER NOT NULL DEFAULT 0,
            start_time      TEXT NOT NULL DEFAULT '',
            finish_time     TEXT NOT NULL DEFAULT '',
            base_url        TEXT NOT NULL DEFAULT '',
            created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE IF NOT EXISTS wecode_problems (
            assignment_id   INTEGER NOT NULL,
            problem_id      INTEGER NOT NULL,
            problem_name    TEXT NOT NULL,
            problem_order   INTEGER NOT NULL DEFAULT 0,
            max_score       INTEGER NOT NULL DEFAULT 100,
            is_ac           BOOLEAN NOT NULL DEFAULT 0,
            problem_url     TEXT NOT NULL DEFAULT '',
            created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            PRIMARY KEY (assignment_id, problem_id),
            FOREIGN KEY (assignment_id) REFERENCES wecode_assignments(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS wecode_submissions (
            submission_id   INTEGER PRIMARY KEY,
            assignment_id   INTEGER NOT NULL,
            problem_id      INTEGER NOT NULL,
            problem_name    TEXT NOT NULL,
            submit_time     INTEGER NOT NULL,
            verdict         TEXT NOT NULL,
            score           INTEGER NOT NULL DEFAULT 0,
            execution_time  REAL NOT NULL DEFAULT 0.0,
            memory_kib      INTEGER NOT NULL DEFAULT 0,
            language        TEXT NOT NULL DEFAULT 'C++',
            is_final        BOOLEAN NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            FOREIGN KEY (assignment_id) REFERENCES wecode_assignments(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_wecode_prob_assign ON wecode_problems(assignment_id);
        CREATE INDEX IF NOT EXISTS idx_wecode_sub_assign_prob ON wecode_submissions(assignment_id, problem_id);
        CREATE INDEX IF NOT EXISTS idx_wecode_sub_time ON wecode_submissions(submit_time);
        "#,
    )?;

    // Kiểm tra và bổ sung cột nếu table đã tồn tại từ trước mà chưa có các cột mở rộng
    let mut stmt = conn.prepare("PRAGMA table_info(wecode_assignments)")?;
    let mut has_classes_col = false;
    let mut has_total_problems_col = false;
    let mut has_start_time_col = false;
    let mut has_finish_time_col = false;
    let mut has_base_url_col = false;

    let col_names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in col_names {
        if let Ok(n) = name {
            match n.as_str() {
                "classes" => has_classes_col = true,
                "total_problems" => has_total_problems_col = true,
                "start_time" => has_start_time_col = true,
                "finish_time" => has_finish_time_col = true,
                "base_url" => has_base_url_col = true,
                _ => {}
            }
        }
    }

    if !has_classes_col {
        let _ = conn.execute("ALTER TABLE wecode_assignments ADD COLUMN classes TEXT NOT NULL DEFAULT ''", []);
    }
    if !has_total_problems_col {
        let _ = conn.execute("ALTER TABLE wecode_assignments ADD COLUMN total_problems INTEGER NOT NULL DEFAULT 0", []);
    }
    if !has_start_time_col {
        let _ = conn.execute("ALTER TABLE wecode_assignments ADD COLUMN start_time TEXT NOT NULL DEFAULT ''", []);
    }
    if !has_finish_time_col {
        let _ = conn.execute("ALTER TABLE wecode_assignments ADD COLUMN finish_time TEXT NOT NULL DEFAULT ''", []);
    }
    if !has_base_url_col {
        let _ = conn.execute("ALTER TABLE wecode_assignments ADD COLUMN base_url TEXT NOT NULL DEFAULT ''", []);
    }

    // Kiểm tra cột problem_url trên bảng wecode_problems
    let mut prob_stmt = conn.prepare("PRAGMA table_info(wecode_problems)")?;
    let mut has_problem_url_col = false;
    let prob_col_names = prob_stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in prob_col_names {
        if let Ok(n) = name {
            if n == "problem_url" {
                has_problem_url_col = true;
            }
        }
    }
    if !has_problem_url_col {
        let _ = conn.execute("ALTER TABLE wecode_problems ADD COLUMN problem_url TEXT NOT NULL DEFAULT ''", []);
    }

    Ok(())
}

/// Tạo bảng lưu trữ mốc thời gian đồng bộ cho các dịch vụ (Unix Epoch INTEGER).
pub fn ensure_sync_state_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sync_state (
            service        TEXT PRIMARY KEY,
            last_synced_at INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO sync_state (service, last_synced_at) VALUES ('portal', 0), ('wecode', 0);
        "#,
    )?;
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
/// Tạo schema cho Plugin Registry, Plugin Storage, Activity Events và backfill lịch sử (idempotent).
pub fn ensure_plugin_and_activity_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS plugin_registry (
            plugin_id    TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            version      TEXT NOT NULL,
            author       TEXT NOT NULL,
            category     TEXT NOT NULL,
            is_enabled   BOOLEAN NOT NULL DEFAULT 1,
            is_builtin   BOOLEAN NOT NULL DEFAULT 0,
            installed_at TEXT NOT NULL DEFAULT (datetime('now', '+7 hours'))
        );

        CREATE TABLE IF NOT EXISTS plugin_storage (
            plugin_id    TEXT NOT NULL,
            key          TEXT NOT NULL,
            value        TEXT NOT NULL,
            updated_at   TEXT NOT NULL DEFAULT (datetime('now', '+7 hours')),
            PRIMARY KEY (plugin_id, key),
            FOREIGN KEY (plugin_id) REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS activity_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            plugin_id   TEXT NOT NULL,
            event_date  TEXT NOT NULL,
            event_type  TEXT NOT NULL,
            xp_value    INTEGER NOT NULL DEFAULT 0,
            ref_id      TEXT,
            created_at  INTEGER NOT NULL,
            FOREIGN KEY (plugin_id) REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE,
            UNIQUE(plugin_id, event_type, ref_id)
        );

        CREATE INDEX IF NOT EXISTS idx_activity_events_date ON activity_events(event_date);
        CREATE INDEX IF NOT EXISTS idx_activity_events_plugin_date ON activity_events(plugin_id, event_date);

        -- Seed First-Party Builtin Plugins
        INSERT OR IGNORE INTO plugin_registry (plugin_id, name, version, author, category, is_enabled, is_builtin)
        VALUES 
            ('cp-codeforces', 'Codeforces Engine', '1.0.0', 'Diark', 'competitive_programming', 1, 1),
            ('cp-leetcode', 'LeetCode Tracker', '1.0.0', 'Diark', 'competitive_programming', 0, 1),
            ('uit-wecode', 'Wecode UIT Tracker', '1.0.0', 'Diark', 'education', 1, 1),
            ('uit-courses', 'Courses Engine (Moodle)', '1.0.0', 'Diark', 'education', 1, 1),
            ('sec-ctf', 'CTF Log & Writeups', '1.0.0', 'Diark', 'cyber_security', 0, 1),
            ('ai-lab', 'AI & Kaggle Hub', '1.0.0', 'Diark', 'ai_datascience', 0, 1);
        "#,
    )?;

    // Backfill Codeforces Submissions (10 XP / AC submission)
    // Tính toán timestamp và date theo UTC+7 (+25200s)
    let has_submissions: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'submissions'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if has_submissions {
        let _ = conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO activity_events (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
            SELECT 
                'cp-codeforces' AS plugin_id,
                date(COALESCE(s.submission_time, CAST(strftime('%s', s.submitted_at) AS INTEGER)) + 25200, 'unixepoch') AS event_date,
                'submission_ac' AS event_type,
                10 AS xp_value,
                CAST(s.id AS TEXT) AS ref_id,
                COALESCE(s.submission_time, CAST(strftime('%s', s.submitted_at) AS INTEGER)) AS created_at
            FROM submissions s
            WHERE s.verdict = 'OK' AND (s.submission_time IS NOT NULL OR s.submitted_at IS NOT NULL);
            "#,
        );
    }

    // Backfill Moodle Completed Deadlines (25 XP / deadline)
    let has_deadlines: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'course_deadlines'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if has_deadlines {
        let _ = conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO activity_events (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
            SELECT 
                'cp-codeforces' AS plugin_id, -- Hoặc uit-moodle nếu có registry, fallback an toàn là cp-codeforces hoặc plugin_registry
                date(d.updated_at + 25200, 'unixepoch') AS event_date,
                'deadline_cleared' AS event_type,
                25 AS xp_value,
                CAST(d.id AS TEXT) AS ref_id,
                d.updated_at AS created_at
            FROM course_deadlines d
            WHERE d.is_submitted = 1;
            "#,
        );
    }

    Ok(())
}

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

    #[test]
    fn test_sqlite_vec_extension_loads_and_queries_version() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        let result = super::load_sqlite_vec_extension(&conn);
        assert!(result.is_ok(), "sqlite-vec should load successfully: {:?}", result.err());

        let version: String = conn
            .query_row("SELECT vec_version()", [], |row| row.get(0))
            .expect("query vec_version");
        assert!(!version.is_empty(), "vec_version should return non-empty string");
        println!("sqlite-vec loaded version: {version}");
    }

    #[test]
    fn test_ensure_wecode_schema_classes_column_migration() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // Giả lập bảng legacy chưa có cột classes
        conn.execute_batch(
            r#"
            CREATE TABLE wecode_assignments (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
            );
            "#,
        ).unwrap();

        super::ensure_wecode_schema(&conn).expect("migration should add classes and total_problems columns and wecode_problems table");

        // Insert thử với classes, total_problems, start_time, finish_time, base_url
        conn.execute(
            "INSERT INTO wecode_assignments (id, name, classes, total_problems, start_time, finish_time, base_url)
             VALUES (1, 'Lab 1', 'IT003.Q27.1', 34, 'Thu, 4 Jun 2026 03:33', 'Wed, 3 Jun 2026 03:33', 'https://khmt.uit.edu.vn/wecode25/it00x')",
            [],
        ).expect("should insert into wecode_assignments with migrated columns");

        let (classes, total_problems, start_time, finish_time, base_url): (String, i64, String, String, String) = conn.query_row(
            "SELECT classes, total_problems, start_time, finish_time, base_url FROM wecode_assignments WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).unwrap();

        assert_eq!(classes, "IT003.Q27.1");
        assert_eq!(total_problems, 34);
        assert_eq!(start_time, "Thu, 4 Jun 2026 03:33");
        assert_eq!(finish_time, "Wed, 3 Jun 2026 03:33");
        assert_eq!(base_url, "https://khmt.uit.edu.vn/wecode25/it00x");

        // Insert thử vào wecode_problems kèm problem_url
        conn.execute(
            "INSERT INTO wecode_problems (assignment_id, problem_id, problem_name, problem_order, max_score, is_ac, problem_url)
             VALUES (1, 2275, 'Tìm kiếm', 1, 100, 1, 'https://khmt.uit.edu.vn/wecode25/it00x/assignment/1/2275')",
            [],
        ).expect("should insert into wecode_problems");

        let (prob_name, prob_url): (String, String) = conn.query_row(
            "SELECT problem_name, problem_url FROM wecode_problems WHERE assignment_id = 1 AND problem_id = 2275",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(prob_name, "Tìm kiếm");
        assert_eq!(prob_url, "https://khmt.uit.edu.vn/wecode25/it00x/assignment/1/2275");
    }
}
