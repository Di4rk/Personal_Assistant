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
}
