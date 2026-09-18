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

/// Trả về sync token hiện có hoặc sinh token hex ngẫu nhiên 32 ký tự rồi lưu lại.
/// Token được dùng để xác thực request từ Tampermonkey userscript → sync server.
/// Idempotent: gọi nhiều lần trả về cùng 1 token.
pub fn get_or_create_sync_token(conn: &Connection) -> SqlResult<String> {
    // Kiểm tra token hiện có
    if let Some(token) = get_setting(conn, "sync_token")? {
        if !token.is_empty() {
            return Ok(token);
        }
    }

    // Sinh token ngẫu nhiên 32-byte dưới dạng hex (64 ký tự)
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let token: String = (0..32)
        .map(|_| format!("{:02x}", rng.gen::<u8>()))
        .collect();

    set_setting(conn, "sync_token", &token)?;
    Ok(token)
}

