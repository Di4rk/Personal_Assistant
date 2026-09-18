use chrono::{Local, Timelike, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::db::exam::AcademicExamRecord;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyBriefingDto {
    pub title: String,
    pub message: String,
    pub urgent_tasks_count: usize,
    pub new_materials_count: usize,
    pub upcoming_exam: Option<AcademicExamRecord>,
    pub generated_at: i64,
}

/// Tổng hợp dữ liệu từ SQLite và sinh nội dung Daily Briefing
pub fn generate_daily_briefing_content(conn: &Connection) -> Result<DailyBriefingDto, rusqlite::Error> {
    let now_ts = Utc::now().timestamp();
    let end_of_day_ts = now_ts + 86400;

    // 1. Đếm bài tập / nhiệm vụ Moodle & Wecode hạn trong ngày (< 24h) chưa nộp
    let mut urgent_tasks_count: usize = 0;
    let mut sample_task_title = String::new();

    let moodle_tasks: Vec<(String, i64)> = {
        let mut stmt = conn.prepare(
            r#"
            SELECT title, due_date
            FROM moodle_tasks
            WHERE is_submitted = 0 AND due_date > ?1 AND due_date <= ?2
            ORDER BY due_date ASC
            LIMIT 5
            "#,
        )?;

        let rows = stmt.query_map(params![now_ts - 3600, end_of_day_ts], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        list
    };

    urgent_tasks_count += moodle_tasks.len();
    if let Some((first_title, _)) = moodle_tasks.first() {
        sample_task_title = first_title.clone();
    }

    // 2. Đếm slide / tài liệu học tập mới cập nhật gần đây (trong 24h hoặc gần nhất)
    let new_materials: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            r#"
            SELECT title, section_name
            FROM moodle_materials
            WHERE created_at >= ?1
            ORDER BY created_at DESC
            LIMIT 5
            "#,
        )?;

        let rows = stmt.query_map(params![now_ts - 86400], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        list
    };

    let new_materials_count = new_materials.len();
    let sample_mat_title = new_materials.first().map(|(t, _)| t.clone()).unwrap_or_default();

    // 3. Kiểm tra môn thi sắp tới gần nhất
    let upcoming_exam = crate::db::exam::get_next_upcoming_exam(conn, now_ts).unwrap_or(None);

    // 4. Định dạng thông điệp thông báo súc tích chuẩn DIARK OS
    let mut parts = Vec::new();

    if let Some(ref exam) = upcoming_exam {
        let diff_seconds = exam.exam_timestamp - now_ts;
        let diff_days = diff_seconds / 86400;

        if diff_seconds > 0 && diff_days == 0 {
            parts.push(format!(
                "🎯 HÔM NAY THI: {} (Ca {} lúc {}, Phòng {})",
                exam.subject_name, exam.shift, exam.start_time, exam.room
            ));
        } else if diff_seconds > 0 && diff_days == 1 {
            parts.push(format!(
                "🎯 NGÀY MAI THI: {} (lúc {}, Phòng {})",
                exam.subject_name, exam.start_time, exam.room
            ));
        } else if diff_seconds > 0 && diff_days <= 5 {
            parts.push(format!(
                "🎯 Sắp thi {} (còn {} ngày nữa, {})",
                exam.subject_code, diff_days, exam.date_str
            ));
        }
    }

    if urgent_tasks_count > 0 {
        if urgent_tasks_count == 1 {
            parts.push(format!("Hôm nay có 1 nhiệm vụ cần nộp: \"{sample_task_title}\""));
        } else {
            parts.push(format!("Hôm nay có {urgent_tasks_count} nhiệm vụ sắp đến hạn!"));
        }
    }

    if new_materials_count > 0 {
        if new_materials_count == 1 {
            parts.push(format!("Có 1 tài liệu/slide mới: \"{sample_mat_title}\""));
        } else {
            parts.push(format!("Có {new_materials_count} tài liệu mới từ giảng viên"));
        }
    }

    let (title, message) = if parts.is_empty() {
        (
            "DIARK OS — Daily Briefing".to_string(),
            "Hôm nay bạn không có deadline nào gấp. Tiếp tục giữ vững phong độ học tập!".to_string(),
        )
    } else {
        (
            "DIARK OS — Nhắc Nhở Học Tập".to_string(),
            parts.join(". ") + ".",
        )
    };

    Ok(DailyBriefingDto {
        title,
        message,
        urgent_tasks_count,
        new_materials_count,
        upcoming_exam,
        generated_at: now_ts,
    })
}

/// Phát thông báo Windows Native và emit sự kiện qua Tauri.
/// Có cooldown 30 phút: nếu đã bắn gần đây thì bỏ qua tránh spam.
pub fn dispatch_daily_briefing(
    app: &AppHandle,
    conn: &Connection,
) -> Result<DailyBriefingDto, String> {
    // Cooldown check: không bắn nếu đã bắn trong vòng 30 phút qua
    let now_ts = Utc::now().timestamp();
    let last_ts: i64 = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'last_briefing_ts'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if now_ts - last_ts < 1800 {
        // Dưới 30 phút — trả về briefing content nhưng không bắn notification
        let briefing = generate_daily_briefing_content(conn)
            .map_err(|e| format!("Lỗi tạo Daily Briefing: {e}"))?;
        return Ok(briefing);
    }

    // Ghi timestamp trước để race condition không gây double-fire
    let _ = conn.execute(
        "INSERT INTO settings (key, value) VALUES ('last_briefing_ts', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![now_ts.to_string()],
    );

    let briefing = generate_daily_briefing_content(conn)
        .map_err(|e| format!("Lỗi tạo Daily Briefing: {e}"))?;

    // 1. Phát notification Windows Native qua plugin
    let _ = app
        .notification()
        .builder()
        .title(&briefing.title)
        .body(&briefing.message)
        .show();

    // 2. Emit event qua webview
    let _ = app.emit("daily-briefing-triggered", &briefing);

    Ok(briefing)
}

/// Background Worker: Kiểm tra định kỳ (mỗi 15 phút) xem đã đến khung giờ phát thông báo (08:00 hoặc 20:00) chưa
pub fn spawn_daily_briefing_scheduler(
    app: AppHandle,
    shared_db: Arc<Mutex<Connection>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut last_briefing_date = String::new();
        let mut last_briefing_slot = String::new();

        loop {
            // Ngủ 15 phút giữa các lần kiểm tra
            tokio::time::sleep(std::time::Duration::from_secs(900)).await;

            let now = Local::now();
            let date_str = now.format("%Y-%m-%d").to_string();
            let hour = now.hour();

            // Khung giờ sáng (08:00 - 08:30) hoặc tối (20:00 - 20:30)
            let current_slot = if hour == 8 {
                "morning"
            } else if hour == 20 {
                "evening"
            } else {
                ""
            };

            if !current_slot.is_empty() {
                // Kiểm tra xem đã bắn cho slot này trong ngày chưa
                if date_str != last_briefing_date || current_slot != last_briefing_slot {
                    if let Ok(conn) = shared_db.lock() {
                        let _ = dispatch_daily_briefing(&app, &conn);
                    }
                    last_briefing_date = date_str;
                    last_briefing_slot = current_slot.to_string();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_daily_briefing_clean_state() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        let briefing = generate_daily_briefing_content(&conn).unwrap();
        assert_eq!(briefing.urgent_tasks_count, 0);
        assert_eq!(briefing.new_materials_count, 0);
        assert!(briefing.message.contains("không có deadline nào"));
    }

    #[test]
    fn test_generate_daily_briefing_with_urgent_task_and_exam() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        let now_ts = Utc::now().timestamp();

        // Thêm môn Moodle
        conn.execute(
            "INSERT INTO moodle_courses (course_id, course_code, fullname, course_url, updated_at) VALUES (1, 'IT004', 'CSDL', '', ?1)",
            params![now_ts],
        ).unwrap();

        // Thêm task sắp đến hạn trong 5 tiếng nữa
        conn.execute(
            r#"
            INSERT INTO moodle_tasks (task_id, course_id, title, task_type, due_date, is_submitted, submission_status, task_url, updated_at)
            VALUES (1, 1, 'Bài tập CSDL Lab 3', 'assign', ?1, 0, 'Chưa nộp', '', ?2)
            "#,
            params![now_ts + 18000, now_ts],
        ).unwrap();

        // Thêm môn thi ngày mai (cách now 20 tiếng)
        let exam_payload = crate::db::exam::PortalExamSchedulePayload {
            items: vec![crate::db::exam::PortalExamItemDto {
                id: Some(10),
                subject_code: "IT012".to_string(),
                subject_name: "Tổ chức máy tính 2".to_string(),
                section_class_id: None,
                section_class_code: None,
                format: Some("tl".to_string()),
                examination: Some("midterm".to_string()),
                shift: Some("3".to_string()),
                start_time: Some("13:30".to_string()),
                end_time: Some("15:30".to_string()),
                weekday: Some("Thứ 3".to_string()),
                date: Some("07/04/2026".to_string()),
                room: Some("B1.18".to_string()),
                seat_number: None,
                absent: None,
                note: None,
            }],
        };
        crate::db::exam::upsert_exam_schedules(&mut conn, &exam_payload).unwrap();

        let briefing = generate_daily_briefing_content(&conn).unwrap();
        assert_eq!(briefing.urgent_tasks_count, 1);
        assert!(briefing.message.contains("Bài tập CSDL Lab 3"));
    }
}
