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

    let _ = window.set_title(&format!("{trimmed_nick} // OS"));

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
}
