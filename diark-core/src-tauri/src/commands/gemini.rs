use tauri::{AppHandle, State};
use crate::db::SharedDb;
use crate::services::gemini::{
    self, ExtractedTaskDto, GeminiConfigDto, SocraticDebugRequestDto,
    TaskExtractionRequestDto,
};

#[tauri::command]
pub fn get_gemini_config(db: State<'_, SharedDb>) -> Result<GeminiConfigDto, String> {
    let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    gemini::query_gemini_config(&conn).map_err(|e| format!("Query gemini config error: {e}"))
}

#[tauri::command]
pub fn save_gemini_config(
    db: State<'_, SharedDb>,
    api_key: String,
    model: String,
) -> Result<(), String> {
    let mut conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    gemini::update_gemini_config(&mut conn, &api_key, &model)
        .map_err(|e| format!("Save gemini config error: {e}"))
}

#[tauri::command]
pub async fn test_gemini_key(api_key: String, model: String) -> Result<String, String> {
    gemini::test_gemini_api_key(&api_key, &model).await
}

#[tauri::command]
pub async fn trigger_socratic_debug(
    app: AppHandle,
    db: State<'_, SharedDb>,
    req: SocraticDebugRequestDto,
) -> Result<(), String> {
    let config = {
        let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
        gemini::query_gemini_config(&conn)
            .map_err(|e| format!("Không thể đọc cấu hình Gemini: {e}"))?
    };

    if config.api_key.trim().is_empty() {
        return Err("Chưa cấu hình Gemini API Key. Vui lòng nhập API Key cá nhân trong phần Cài đặt.".to_string());
    }

    let prompt = gemini::build_socratic_prompt(&req);
    gemini::stream_gemini_request(
        app,
        config.api_key,
        config.model,
        req.session_id,
        prompt,
    )
    .await
}

#[tauri::command]
pub async fn extract_moodle_tasks(
    db: State<'_, SharedDb>,
    req: TaskExtractionRequestDto,
) -> Result<Vec<ExtractedTaskDto>, String> {
    let config = {
        let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
        gemini::query_gemini_config(&conn)
            .map_err(|e| format!("Không thể đọc cấu hình Gemini: {e}"))?
    };

    if config.api_key.trim().is_empty() {
        return Err("Chưa cấu hình Gemini API Key. Vui lòng nhập API Key trong phần Cài đặt để bóc tách bài viết.".to_string());
    }

    gemini::extract_tasks_with_gemini(
        &config.api_key,
        &config.model,
        &req.prose_text,
        req.course_hint.as_deref(),
    )
    .await
}

#[tauri::command]
pub fn save_extracted_moodle_tasks(
    app: AppHandle,
    db: State<'_, SharedDb>,
    tasks: Vec<ExtractedTaskDto>,
) -> Result<usize, String> {
    let mut conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let mut saved_count = 0;

    for task in &tasks {
        match gemini::insert_extracted_moodle_task(&mut conn, task) {
            Ok(_) => {
                saved_count += 1;
            }
            Err(e) => {
                eprintln!("[save_extracted_moodle_tasks] Lỗi lưu task '{}': {e}", task.title);
            }
        }
    }

    if saved_count > 0 {
        use tauri::Emitter;
        let _ = app.emit("moodle-data-synced", saved_count);
        let _ = app.emit("academic-data-synced", ());
    }

    Ok(saved_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_gemini_config_persistence_in_db() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        // 1. Initial query: defaults
        let cfg = gemini::query_gemini_config(&conn).unwrap();
        assert_eq!(cfg.api_key, "");
        assert_eq!(cfg.model, "gemini-1.5-flash");

        // 2. Save config
        gemini::update_gemini_config(&mut conn, "AIzaSyFakeKey123", "gemini-1.5-pro").unwrap();

        // 3. Query updated
        let updated = gemini::query_gemini_config(&conn).unwrap();
        assert_eq!(updated.api_key, "AIzaSyFakeKey123");
        assert_eq!(updated.model, "gemini-1.5-pro");
    }

    #[test]
    fn test_socratic_prompt_generation() {
        let req = SocraticDebugRequestDto {
            session_id: "sess_001".to_string(),
            problem_name: "Tìm kiếm nhị phân".to_string(),
            problem_id: Some(42),
            verdict: "WRONG ANSWER".to_string(),
            score: 40,
            execution_time: 0.05,
            memory_kib: 1200,
            language: "C++".to_string(),
            code_snippet: Some("int mid = (l + r) / 2;".to_string()),
            user_query: Some("Tại sao em bị lặp vô tận?".to_string()),
        };

        let prompt = gemini::build_socratic_prompt(&req);
        assert!(prompt.contains("Tìm kiếm nhị phân"));
        assert!(prompt.contains("WRONG ANSWER"));
        assert!(prompt.contains("int mid = (l + r) / 2;"));
        assert!(prompt.contains("Tại sao em bị lặp vô tận?"));
        assert!(prompt.contains("KỶ LUẬT SƯ PHẠM TỐI THƯỢNG"));
    }
}
