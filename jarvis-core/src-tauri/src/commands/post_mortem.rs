use crate::db::{self, PostMortemInput, PostMortemRecord, SearchResultItem, SharedDb};

/// Tạo mới hoặc cập nhật post-mortem cho 1 problem. UNIQUE constraint trên
/// problem_id đảm bảo mỗi problem chỉ có đúng 1 bản ghi - gọi lại lệnh này với
/// cùng problem_id sẽ ghi đè bản cũ (giữ nguyên created_at gốc).
#[tauri::command]
pub fn save_post_mortem(
    db: tauri::State<'_, SharedDb>,
    input: PostMortemInput,
) -> Result<PostMortemRecord, String> {
    if input.problem_id.trim().is_empty() {
        return Err("problem_id không được để trống".to_string());
    }
    if input.key_insight.trim().is_empty() {
        return Err("key_insight không được để trống - post-mortem cần có bài học rút ra".to_string());
    }

    // upsert_post_mortem cần &mut Connection (tự mở transaction bên trong) và
    // nhận input qua reference - MutexGuard<Connection> deref-mut được thẳng.
    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    db::upsert_post_mortem(&mut conn, &input).map_err(|e| e.to_string())
}

/// Lấy post-mortem của 1 problem cụ thể. Trả Ok(None) nếu chưa từng viết
/// post-mortem cho problem này - đây là trạng thái BÌNH THƯỜNG, không phải lỗi.
#[tauri::command]
pub fn get_post_mortem(
    db: tauri::State<'_, SharedDb>,
    problem_id: String,
) -> Result<Option<PostMortemRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    db::get_post_mortem_by_problem(&conn, &problem_id).map_err(|e| e.to_string())
}

/// Xoá post-mortem của 1 problem. Trả `false` nếu problem_id đó chưa từng có
/// post-mortem - không phải lỗi, chỉ đơn giản là không có gì để xoá.
#[tauri::command]
pub fn delete_post_mortem(db: tauri::State<'_, SharedDb>, problem_id: String) -> Result<bool, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    db::delete_post_mortem(&conn, &problem_id).map_err(|e| e.to_string())
}

/// Full-text search post-mortem theo BM25 ranking. `limit` mặc định 20 nếu
/// không truyền, chặn trong khoảng [1, 100] để tránh query nặng vô lý.
///
/// LƯU Ý cho frontend: SearchResultItem.rank là điểm BM25 THÔ (càng ÂM càng
/// khớp - quy ước gốc của SQLite, chưa đảo dấu như bản post_mortem.rs trước
/// đó) - phần IPC/TypeScript bridge tiếp theo cần xử lý đúng chiều dấu này.
#[tauri::command]
pub fn search_post_mortems(
    db: tauri::State<'_, SharedDb>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchResultItem>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    db::search_post_mortems(&conn, &query, limit.unwrap_or(20)).map_err(|e| e.to_string())
}
