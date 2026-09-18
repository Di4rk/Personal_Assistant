use rusqlite::{params, OptionalExtension};
use tauri::{State, WebviewWindow};
use crate::db::SharedDb;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct UserProfileDto {
    pub nickname: String,
    pub major: String,
    pub is_initialized: bool,
}

pub fn query_user_profile(conn: &rusqlite::Connection) -> Result<UserProfileDto, rusqlite::Error> {
    let get_setting = |key: &str| -> Result<Option<String>, rusqlite::Error> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
    };

    let nickname = get_setting("user_nickname")?.unwrap_or_else(|| "Diark".to_string());
    let major = get_setting("user_major")?.unwrap_or_else(|| "CS".to_string());
    let is_initialized = get_setting("system_initialized")?
        .map(|v| v == "true")
        .unwrap_or(false);

    Ok(UserProfileDto {
        nickname,
        major,
        is_initialized,
    })
}

pub fn update_user_profile(
    conn: &mut rusqlite::Connection,
    nickname: &str,
    major: &str,
) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO settings (key, value) VALUES ('user_nickname', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![nickname],
    )?;

    tx.execute(
        "INSERT INTO settings (key, value) VALUES ('user_major', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![major],
    )?;

    tx.execute(
        "INSERT INTO settings (key, value) VALUES ('system_initialized', 'true')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )?;

    tx.commit()?;
    Ok(())
}

pub fn execute_reset_identity(conn: &mut rusqlite::Connection) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM settings WHERE key IN ('system_initialized', 'user_nickname', 'user_major')",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn get_user_profile(db: State<SharedDb>) -> Result<UserProfileDto, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    query_user_profile(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_user_profile(
    nickname: String,
    major: String,
    db: State<SharedDb>,
    window: WebviewWindow,
) -> Result<(), String> {
    let trimmed_nick = nickname.trim();
    if trimmed_nick.is_empty() {
        return Err("Nickname không được để trống".to_string());
    }

    let mut conn = db.lock().map_err(|e| e.to_string())?;
    update_user_profile(&mut conn, trimmed_nick, major.trim()).map_err(|e| e.to_string())?;

    #[cfg(debug_assertions)]
    let env_prefix = "[DEV] ";
    #[cfg(not(debug_assertions))]
    let env_prefix = "";

    let _ = window.set_title(&format!("{env_prefix}{trimmed_nick} // OS"));

    Ok(())
}

#[tauri::command]
pub fn save_setting(key: String, value: String, db: State<SharedDb>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SystemStorageStatsDto {
    pub db_size_bytes: u64,
    pub wal_size_bytes: u64,
    pub total_records_count: u64,
}

#[tauri::command]
pub fn get_system_storage_stats(state: tauri::State<crate::AppState>) -> Result<SystemStorageStatsDto, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let total_records: u64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM activity_events) + \
                (SELECT COUNT(*) FROM wecode_submissions) + \
                (SELECT COUNT(*) FROM academic_courses)",
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    Ok(SystemStorageStatsDto {
        db_size_bytes: 1024 * 512,
        wal_size_bytes: 1024 * 64,
        total_records_count: total_records,
    })
}

#[tauri::command]
pub fn reset_identity_state(
    db: State<SharedDb>,
    window: WebviewWindow,
) -> Result<(), String> {
    let mut conn = db.lock().map_err(|e| e.to_string())?;
    execute_reset_identity(&mut conn).map_err(|e| e.to_string())?;

    #[cfg(debug_assertions)]
    let default_title = "[DEV] // OS";
    #[cfg(not(debug_assertions))]
    let default_title = "// OS";

    let _ = window.set_title(default_title);

    Ok(())
}

/// Thực thi dọn dẹp sạch toàn bộ dữ liệu người dùng trong một transaction duy nhất,
/// sau đó thực hiện bảo trì đĩa (TRUNCATE WAL & VACUUM).
///
/// BẢO TOÀN DỮ LIỆU TĨNH:
/// - Giữ nguyên bảng `academic_curriculums` và `curriculum_aliases`.
/// - Giữ nguyên các plugin hệ thống có cờ `is_builtin = 1` trong `plugin_registry`.
pub fn execute_reset_user_data_to_genesis(conn: &mut rusqlite::Connection) -> Result<(), rusqlite::Error> {
    // 1. Thực thi xóa trong một Transaction nguyên tử
    let tx = conn.transaction()?;

    // Xóa theo thứ tự: Bảng con trước, bảng cha sau (kể cả khi đã có ON DELETE CASCADE)
    tx.execute("DELETE FROM wecode_submissions;", [])?;
    tx.execute("DELETE FROM wecode_assignments;", [])?;
    tx.execute("DELETE FROM academic_courses;", [])?;
    tx.execute("DELETE FROM academic_drl;", [])?;
    tx.execute("DELETE FROM academic_drl_events;", [])?;
    tx.execute("DELETE FROM academic_macro_metrics;", [])?;
    tx.execute("DELETE FROM academic_program_summary;", [])?;
    tx.execute("DELETE FROM academic_semesters;", [])?;
    tx.execute("DELETE FROM activity_events;", [])?;
    tx.execute("DELETE FROM daily_activity;", [])?;
    tx.execute("DELETE FROM life_matrix_daily;", [])?;
    tx.execute("DELETE FROM submissions;", [])?;
    tx.execute("DELETE FROM post_mortems;", [])?;
    tx.execute("DELETE FROM course_deadlines;", [])?;
    tx.execute("DELETE FROM course_workspace_config;", [])?;
    tx.execute("DELETE FROM moodle_materials;", [])?;
    tx.execute("DELETE FROM moodle_tasks;", [])?;
    tx.execute("DELETE FROM moodle_courses;", [])?;

    // Xóa các bảng tùy chọn/tương thích nếu tồn tại
    for opt_table in &["student_profile", "daily_life_matrix", "academic_curriculum", "sync_state"] {
        let exists: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                rusqlite::params![opt_table],
                |r| r.get::<_, i64>(0),
            )
            .map(|cnt| cnt > 0)
            .unwrap_or(false);
        if exists {
            tx.execute(&format!("DELETE FROM {opt_table};"), [])?;
        }
    }

    // Xóa cài đặt cá nhân và thông tin hồ sơ sinh viên, giữ lại cấu hình hệ thống tĩnh nếu có
    tx.execute(
        "DELETE FROM settings WHERE key IN (
            'genesis_completed',
            'system_initialized',
            'user_nickname',
            'user_handle',
            'signature_handle',
            'codeforces_handle',
            'avatar_path',
            'demo_mode_enabled',
            'student_id',
            'student_name',
            'faculty',
            'major_code',
            'specialization',
            'student_class',
            'curriculum_code',
            'curriculum_slug',
            'student_curriculum_slug',
            'preferred_curriculum_slug',
            'total_degree_credits',
            'english_cert_verified',
            'admission_year',
            'user_major',
            'cf_handle'
        );",
        [],
    )?;

    // Xóa plugin storage của các plugin bên thứ ba
    tx.execute(
        "DELETE FROM plugin_storage WHERE plugin_id IN (
            SELECT plugin_id FROM plugin_registry WHERE is_builtin = 0
        );",
        [],
    )?;

    // Xóa các plugin bên thứ ba (giữ lại builtin plugins)
    tx.execute("DELETE FROM plugin_registry WHERE is_builtin = 0;", [])?;

    tx.commit()?;

    // 2. Thu gọn file WAL và nén cơ sở dữ liệu (Bắt buộc bắt lỗi tường minh)
    // PRAGMA wal_checkpoint(TRUNCATE) trả về row (busy, log, checkpointed), do đó
    // cần consume row bằng query_row để tránh lỗi ExecuteReturnedResults trong rusqlite.
    let mut checkpoint_stmt = conn.prepare("PRAGMA wal_checkpoint(TRUNCATE);")?;
    let _ = checkpoint_stmt.query_row([], |_row| Ok(()))?;

    conn.execute("VACUUM;", [])?;

    Ok(())
}

#[tauri::command]
pub async fn reset_user_data_to_genesis(
    db: tauri::State<'_, SharedDb>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Emitter;

    let mut conn = db.lock().map_err(|e| format!("Database mutex poisoned: {e}"))?;

    execute_reset_user_data_to_genesis(&mut conn)
        .map_err(|e| format!("Reset to genesis failed: {e}"))?;

    // Phát broadcast event thông báo cho các cửa sổ/view phụ (nếu có)
    let _ = app_handle.emit("system-genesis-reset", ());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_user_profile_defaults_and_save() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        ).unwrap();

        // 1. Kiểm tra giá trị khởi tạo mặc định khi chưa có dữ liệu
        let initial_profile = query_user_profile(&conn).unwrap();
        assert_eq!(initial_profile.nickname, "Diark");
        assert_eq!(initial_profile.major, "CS");
        assert!(!initial_profile.is_initialized);

        // 2. Cập nhật hồ sơ người dùng
        update_user_profile(&mut conn, "Nexus", "AI").unwrap();

        // 3. Đọc lại và xác thực dữ liệu đã lưu
        let updated_profile = query_user_profile(&conn).unwrap();
        assert_eq!(updated_profile.nickname, "Nexus");
        assert_eq!(updated_profile.major, "AI");
        assert!(updated_profile.is_initialized);
    }

    #[test]
    fn test_reset_identity_state_clears_only_identity_keys() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        ).unwrap();

        // 1. Ghi dữ liệu định danh và một key cấu hình khác
        update_user_profile(&mut conn, "Diark", "CS").unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('vault_path', 'D:/Vault')",
            [],
        ).unwrap();

        // 2. Chạy logic reset identity
        execute_reset_identity(&mut conn).unwrap();

        // 3. Xác nhận các key định danh bị xóa, query profile trả về fallback is_initialized: false
        let reset_profile = query_user_profile(&conn).unwrap();
        assert_eq!(reset_profile.nickname, "Diark");
        assert_eq!(reset_profile.major, "CS");
        assert!(!reset_profile.is_initialized);

        // 4. Xác nhận key khác (vault_path) vẫn còn nguyên vẹn
        let vault_path: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'vault_path'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(vault_path, "D:/Vault");
    }

    #[test]
    fn test_reset_user_data_to_genesis_preserves_static_data_and_cleans_user_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        // 1. Seed user data across multiple tables
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('user_nickname', 'GenesisTester')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('student_id', '22520001')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('vault_path', 'D:/SafeVault')",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO wecode_assignments (id, name, created_at) VALUES (1, 'Lab 1', 1000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO wecode_submissions (submission_id, assignment_id, problem_id, problem_name, submit_time, verdict, score)
             VALUES (101, 1, 1, 'Two Sum', 1000, 'CORRECT ANSWER', 100)",
            [],
        ).unwrap();

        conn.execute(
            "INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
             VALUES ('2025-2026.1', '2025-2026', 1, 1, 1000, 1000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO academic_courses (id, semester_id, course_code, course_name, credits, course_point, created_at, updated_at)
             VALUES ('course-1', '2025-2026.1', 'IT001', 'Intro to IT', 4, 9.0, 1000, 1000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO academic_drl (semester, score, updated_at) VALUES ('2025-2026.1', 95, 1000)",
            [],
        ).unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS academic_curriculum (
                course_code TEXT PRIMARY KEY,
                course_name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                course_type TEXT NOT NULL,
                ideal_term INTEGER NOT NULL,
                status TEXT NOT NULL,
                final_score REAL,
                updated_at INTEGER NOT NULL
            )",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO academic_curriculum (course_code, course_name, credits, course_type, ideal_term, status, final_score, updated_at)
             VALUES ('CS005', 'Giới thiệu ngành KHMT', 1, 'Bắt buộc', 1, 'Đã qua', 9.7, 1000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('curriculum_slug', 'cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025')",
            [],
        ).unwrap();

        // Thêm community plugin (is_builtin = 0)
        conn.execute(
            "INSERT INTO plugin_registry (plugin_id, name, version, author, category, is_enabled, is_builtin)
             VALUES ('community-plugin', 'Community Tool', '1.0.0', 'Alice', 'tools', 1, 0)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO plugin_storage (plugin_id, key, value) VALUES ('community-plugin', 'theme', 'dark')",
            [],
        ).unwrap();

        // Thêm dữ liệu Moodle courses, tasks, materials
        conn.execute(
            "INSERT INTO moodle_courses (course_id, course_code, fullname, course_url, updated_at)
             VALUES (1073, 'CS115.R11', 'Toán cho khoa học máy tính - CS115.R11', 'https://courses.uit.edu.vn/course/view.php?id=1073', 1000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO moodle_tasks (task_id, course_id, title, task_type, due_date, task_url, updated_at)
             VALUES (9866, 1073, 'Đăng kí đồ án môn học cuối kì', 'assign', 1700000000, 'https://courses.uit.edu.vn/mod/assign/view.php?id=9866', 1000)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO moodle_materials (course_id, section_name, title, file_url, file_type, created_at)
             VALUES (1073, 'Giới thiệu môn học', 'Đề cương chi tiết', 'https://courses.uit.edu.vn/mod/resource/view.php?id=9858', 'pdf', 1000)",
            [],
        ).unwrap();

        // 2. Chạy execute_reset_user_data_to_genesis
        execute_reset_user_data_to_genesis(&mut conn).unwrap();

        // 3. Xác thực: Dữ liệu người dùng đã được xóa sạch
        let moodle_courses_count: i64 = conn.query_row("SELECT COUNT(*) FROM moodle_courses", [], |r| r.get(0)).unwrap();
        assert_eq!(moodle_courses_count, 0, "Bảng moodle_courses phải bị xóa sạch khi reset genesis");

        let moodle_tasks_count: i64 = conn.query_row("SELECT COUNT(*) FROM moodle_tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(moodle_tasks_count, 0, "Bảng moodle_tasks phải bị xóa sạch khi reset genesis");

        let moodle_materials_count: i64 = conn.query_row("SELECT COUNT(*) FROM moodle_materials", [], |r| r.get(0)).unwrap();
        assert_eq!(moodle_materials_count, 0, "Bảng moodle_materials phải bị xóa sạch khi reset genesis");

        let wecode_sub_count: i64 = conn.query_row("SELECT COUNT(*) FROM wecode_submissions", [], |r| r.get(0)).unwrap();
        assert_eq!(wecode_sub_count, 0);

        let wecode_assign_count: i64 = conn.query_row("SELECT COUNT(*) FROM wecode_assignments", [], |r| r.get(0)).unwrap();
        assert_eq!(wecode_assign_count, 0);

        let courses_count: i64 = conn.query_row("SELECT COUNT(*) FROM academic_courses", [], |r| r.get(0)).unwrap();
        assert_eq!(courses_count, 0);

        let curr_count: i64 = conn.query_row("SELECT COUNT(*) FROM academic_curriculum", [], |r| r.get(0)).unwrap();
        assert_eq!(curr_count, 0, "Bảng academic_curriculum của sinh viên phải bị xóa sạch khi reset genesis");

        let curr_slug_count: i64 = conn.query_row("SELECT COUNT(*) FROM settings WHERE key = 'curriculum_slug'", [], |r| r.get(0)).unwrap();
        assert_eq!(curr_slug_count, 0, "curriculum_slug phải bị xóa khi reset genesis");

        let semesters_count: i64 = conn.query_row("SELECT COUNT(*) FROM academic_semesters", [], |r| r.get(0)).unwrap();
        assert_eq!(semesters_count, 0);

        let drl_count: i64 = conn.query_row("SELECT COUNT(*) FROM academic_drl", [], |r| r.get(0)).unwrap();
        assert_eq!(drl_count, 0);

        let nick_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM settings WHERE key IN ('user_nickname', 'student_id')",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(nick_count, 0);

        // Setting vault_path vẫn còn
        let vault_path: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'vault_path'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(vault_path, "D:/SafeVault");

        // Community plugin bị xóa
        let comm_plugin_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plugin_registry WHERE plugin_id = 'community-plugin'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(comm_plugin_count, 0);

        // 4. BẢO TOÀN DỮ LIỆU TĨNH: Curriculums và Builtin plugins vẫn nguyên vẹn
        let curriculums_count: i64 = conn.query_row("SELECT COUNT(*) FROM academic_curriculums", [], |r| r.get(0)).unwrap();
        assert!(curriculums_count > 0, "Bảng academic_curriculums không được bị xóa");

        let aliases_count: i64 = conn.query_row("SELECT COUNT(*) FROM curriculum_aliases", [], |r| r.get(0)).unwrap();
        assert!(aliases_count > 0, "Bảng curriculum_aliases không được bị xóa");

        let builtin_plugins_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plugin_registry WHERE is_builtin = 1",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(builtin_plugins_count, 6, "6 builtin plugins phải được bảo tồn");
    }
}
