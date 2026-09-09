use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};

/// Đọc 1 setting theo key. Trả về Ok(None) nếu key chưa từng được set -
/// đây là trạng thái BÌNH THƯỜNG (VD: user chưa nhập CF handle lần đầu mở app),
/// không phải lỗi, nên KHÔNG trả Err trong trường hợp này.
pub fn get_setting(conn: &Connection, key: &str) -> SqlResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

/// Ghi/update 1 setting. Upsert bằng ON CONFLICT thay vì check-then-insert
/// để tránh race condition nếu sau này có gọi từ nhiều nơi cùng lúc.
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
