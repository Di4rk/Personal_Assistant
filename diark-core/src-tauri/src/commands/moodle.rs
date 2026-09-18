use tauri::State;
use crate::db::moodle::{
    MoodleCourseRecord, MoodleMaterialRecord, MoodleSyncPayload, MoodleTaskRecord,
};
use crate::db::SharedDb;

#[tauri::command]
pub fn get_moodle_courses(db: State<'_, SharedDb>) -> Result<Vec<MoodleCourseRecord>, String> {
    let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    crate::db::moodle::get_all_moodle_courses(&conn).map_err(|e| format!("Get moodle courses error: {e}"))
}

#[tauri::command]
pub fn get_moodle_tasks(
    db: State<'_, SharedDb>,
    course_id: Option<i64>,
) -> Result<Vec<MoodleTaskRecord>, String> {
    let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    crate::db::moodle::get_moodle_tasks(&conn, course_id).map_err(|e| format!("Get moodle tasks error: {e}"))
}

#[tauri::command]
pub fn get_moodle_materials(
    db: State<'_, SharedDb>,
    course_id: i64,
) -> Result<Vec<MoodleMaterialRecord>, String> {
    let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    crate::db::moodle::get_moodle_materials(&conn, course_id).map_err(|e| format!("Get moodle materials error: {e}"))
}

#[tauri::command]
pub fn ingest_moodle_sync_payload_json(
    db: State<'_, SharedDb>,
    payload_json: String,
) -> Result<usize, String> {
    let payload: MoodleSyncPayload = if let Ok(p) = serde_json::from_str::<MoodleSyncPayload>(&payload_json) {
        p
    } else if let Ok(courses) = serde_json::from_str::<Vec<crate::db::moodle::MoodleCourseRecord>>(&payload_json) {
        MoodleSyncPayload {
            courses,
            tasks: Vec::new(),
            materials: Vec::new(),
            ..Default::default()
        }
    } else {
        return Err("Invalid Moodle sync payload JSON (must be MoodleSyncPayload or Course array)".to_string());
    };

    let mut conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let (c, t, m) = crate::db::moodle::commit_moodle_payload(&mut conn, payload)?;
    Ok(c + t + m)
}

#[tauri::command]
pub fn update_moodle_course_instructor(
    db: State<'_, SharedDb>,
    course_id: i64,
    instructor_name: String,
    instructor_mail: String,
    instructor_phone: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    crate::db::moodle::update_moodle_course_instructor(
        &conn,
        course_id,
        &instructor_name,
        &instructor_mail,
        &instructor_phone,
    )
    .map_err(|e| format!("Update moodle course instructor error: {e}"))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MaterialDownloadProgress {
    pub course_id: i64,
    pub current: usize,
    pub total: usize,
    pub filename: String,
}

#[tauri::command]
pub async fn download_course_materials(
    app: tauri::AppHandle,
    db: State<'_, SharedDb>,
    course_id: i64,
    vault_root: String,
) -> Result<usize, String> {
    use tauri::Emitter;

    let (cookie_header, slides_dir, to_download) = {
        let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;

        // Trích xuất cookie nếu đã lưu trong settings
        let cookie: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key IN ('moodle_session', 'moodle_cookie') LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap_or_default();

        let slides_dir = crate::modules::academic::material_downloader::resolve_course_slides_dir(
            std::path::Path::new(&vault_root),
            course_id,
            &conn,
        )?;

        let materials = crate::db::moodle::get_moodle_materials(&conn, course_id)
            .map_err(|e| format!("Lỗi đọc danh sách tài liệu: {e}"))?;

        let to_download: Vec<MoodleMaterialRecord> = materials
            .into_iter()
            .filter(|m| m.file_type != "url" && m.file_type != "link")
            .filter(|m| {
                m.download_status != "synced"
                    || m.local_file_path.is_empty()
                    || !std::path::Path::new(&m.local_file_path).exists()
            })
            .collect();

        (cookie, slides_dir, to_download)
    };

    if to_download.is_empty() {
        return Ok(0);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Lỗi tạo HTTP client: {e}"))?;

    let total = to_download.len();
    let mut downloaded_count = 0;

    for (idx, mat) in to_download.iter().enumerate() {
        let filename = crate::modules::academic::material_downloader::sanitize_material_filename(
            &mat.title,
            &mat.file_type,
            &mat.file_url,
        );
        let target_path = slides_dir.join(&filename);

        // Đánh dấu trạng thái downloading trong DB
        {
            if let Ok(conn) = db.lock() {
                let _ = crate::db::moodle::update_material_download_status(
                    &conn,
                    mat.id,
                    "downloading",
                    "",
                    0,
                );
            }
        }

        let _ = app.emit(
            "moodle-material-download-progress",
            MaterialDownloadProgress {
                course_id,
                current: idx + 1,
                total,
                filename: filename.clone(),
            },
        );

        match crate::modules::academic::material_downloader::download_single_material(
            &client,
            &cookie_header,
            &mat.file_url,
            &target_path,
        )
        .await
        {
            Ok(bytes) => {
                let path_str = target_path.to_string_lossy().to_string();
                if let Ok(conn) = db.lock() {
                    let _ = crate::db::moodle::update_material_download_status(
                        &conn,
                        mat.id,
                        "synced",
                        &path_str,
                        bytes as i64,
                    );
                }
                downloaded_count += 1;
            }
            Err(e) => {
                eprintln!("[moodle-download] Lỗi tải tài liệu {}: {e}", mat.title);
                if let Ok(conn) = db.lock() {
                    let _ = crate::db::moodle::update_material_download_status(
                        &conn,
                        mat.id,
                        "failed",
                        "",
                        0,
                    );
                }
            }
        }
    }

    Ok(downloaded_count)
}

#[tauri::command]
pub fn open_local_material(
    db: State<'_, SharedDb>,
    material_id: i64,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let material = crate::db::moodle::get_material_by_id(&conn, material_id)
        .map_err(|e| format!("Lỗi truy vấn tài liệu: {e}"))?
        .ok_or_else(|| format!("Không tìm thấy tài liệu với ID {material_id}"))?;

    let path = std::path::Path::new(&material.local_file_path);
    if !path.exists() {
        return Err(format!(
            "File tài liệu không tồn tại trên đĩa tại: {}",
            material.local_file_path
        ));
    }

    open::that(path).map_err(|e| format!("Lỗi mở file tài liệu: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn create_test_db() -> SharedDb {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::ensure_moodle_schema(&conn).unwrap();
        crate::db::schema::ensure_sync_state_schema(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn test_ingest_and_query_via_commands_logic() {
        let db = create_test_db();
        let payload = serde_json::json!({
            "courses": [
                {
                    "course_id": 1289,
                    "course_code": "SS009.R12",
                    "fullname": "Chủ nghĩa xã hội khoa học - SS009.R12",
                    "term": "HK2 2025-2026",
                    "instructor_name": "ThS. Trịnh Bá Phương",
                    "instructor_mail": "phuongtbhcmue@gmail.com",
                    "instructor_phone": "0376 333 654",
                    "course_url": "https://courses.uit.edu.vn/course/view.php?id=1289",
                    "updated_at": 1789663457
                }
            ],
            "tasks": [
                {
                    "task_id": 11792,
                    "course_id": 1289,
                    "title": "ĐĂNG KÝ ĐỀ TÀI NHÓM",
                    "task_type": "assign",
                    "due_date": 1789750740,
                    "is_submitted": false,
                    "submission_status": "Chưa nộp",
                    "template_file_url": "https://courses.uit.edu.vn/mau.docx",
                    "task_url": "https://courses.uit.edu.vn/mod/assign/view.php?id=11792",
                    "updated_at": 1789663457
                }
            ],
            "materials": [
                {
                    "id": 1,
                    "course_id": 1289,
                    "section_name": "Tuần 2",
                    "title": "C1_Slide BG",
                    "file_url": "https://courses.uit.edu.vn/slide.pdf",
                    "file_type": "pdf",
                    "created_at": 1789662966
                }
            ]
        });

        let json_str = payload.to_string();
        let parsed: MoodleSyncPayload = serde_json::from_str(&json_str).unwrap();

        {
            let mut conn = db.lock().unwrap();
            let (c, t, m) = crate::db::moodle::commit_moodle_payload(&mut conn, parsed).unwrap();
            assert_eq!(c, 1);
            assert_eq!(t, 1);
            assert_eq!(m, 1);
        }

        {
            let conn = db.lock().unwrap();
            let courses = crate::db::moodle::get_all_moodle_courses(&conn).unwrap();
            assert_eq!(courses.len(), 1);
            assert_eq!(courses[0].course_code, "SS009.R12");

            let tasks = crate::db::moodle::get_moodle_tasks(&conn, Some(1289)).unwrap();
            assert_eq!(tasks.len(), 1);
            assert_eq!(tasks[0].title, "ĐĂNG KÝ ĐỀ TÀI NHÓM");

            let materials = crate::db::moodle::get_moodle_materials(&conn, 1289).unwrap();
            assert_eq!(materials.len(), 1);
            assert_eq!(materials[0].file_type, "pdf");
        }
    }
}
