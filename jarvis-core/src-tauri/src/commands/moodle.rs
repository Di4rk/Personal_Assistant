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
    let payload: MoodleSyncPayload = serde_json::from_str(&payload_json)
        .map_err(|e| format!("Invalid Moodle sync payload JSON: {e}"))?;

    let mut conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let (c, t, m) = crate::db::moodle::commit_moodle_payload(&mut conn, payload)?;
    Ok(c + t + m)
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
