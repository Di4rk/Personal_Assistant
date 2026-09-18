use chrono::{FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExamChecklistItem {
    pub id: String,
    pub label: String,
    pub is_checked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcademicExamRecord {
    pub id: i64,
    pub subject_code: String,
    pub subject_name: String,
    pub section_class_id: String,
    pub section_class_code: String,
    pub format: String,        // 'tl', 'essay', 'tn', 'practical', etc.
    pub examination: String,   // 'midterm', 'final_term'
    pub shift: String,         // '1', '2', '3', '4'
    pub start_time: String,    // '13:30'
    pub end_time: String,      // '15:30'
    pub weekday: String,       // 'Thứ 3'
    pub date_str: String,      // '07/04/2026'
    pub exam_timestamp: i64,   // Unix timestamp in seconds (UTC)
    pub room: String,          // 'B1.18'
    pub seat_number: String,   // Số báo danh
    pub absent: String,        // 'Không'
    pub note: String,          // 'Xác nhận đủ...'
    pub checklist_items: String, // JSON array string
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortalExamItemDto {
    #[serde(default)]
    pub id: Option<i64>,
    pub subject_code: String,
    pub subject_name: String,
    #[serde(default)]
    pub section_class_id: Option<String>,
    #[serde(default)]
    pub section_class_code: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub examination: Option<String>,
    #[serde(default)]
    pub shift: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
    #[serde(default)]
    pub weekday: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub room: Option<String>,
    #[serde(default)]
    pub seat_number: Option<String>,
    #[serde(default)]
    pub absent: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalExamSchedulePayload {
    #[serde(default)]
    pub items: Vec<PortalExamItemDto>,
}

pub fn parse_exam_timestamp(date_str: &str, start_time: &str) -> i64 {
    let clean_date = date_str.trim();
    let clean_time = start_time.trim();

    let date = NaiveDate::parse_from_str(clean_date, "%d/%m/%Y")
        .or_else(|_| NaiveDate::parse_from_str(clean_date, "%Y-%m-%d"))
        .unwrap_or_else(|_| Utc::now().date_naive());

    let time = NaiveTime::parse_from_str(clean_time, "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(clean_time, "%H:%M:%S"))
        .unwrap_or_else(|_| NaiveTime::from_hms_opt(7, 30, 0).unwrap_or_default());

    let naive_dt = NaiveDateTime::new(date, time);
    // Múi giờ UTC+7 (Asia/Ho_Chi_Minh)
    let vn_offset = FixedOffset::east_opt(7 * 3600).unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
    match vn_offset.from_local_datetime(&naive_dt).single() {
        Some(dt) => dt.timestamp(),
        None => naive_dt.and_utc().timestamp() - 7 * 3600,
    }
}

pub fn default_checklist_for_exam(format: &str, note: &str) -> Vec<ExamChecklistItem> {
    let mut items = vec![
        ExamChecklistItem {
            id: "student_card".to_string(),
            label: "Thẻ Sinh Viên UIT / CCCD".to_string(),
            is_checked: false,
        },
        ExamChecklistItem {
            id: "calculator".to_string(),
            label: "Máy tính bỏ túi (Casio FX-580VNX/880BTG)".to_string(),
            is_checked: false,
        },
        ExamChecklistItem {
            id: "pens".to_string(),
            label: "Bút viết (xanh/đen) & Bút chì 2B + Tẩy".to_string(),
            is_checked: false,
        },
    ];

    let norm_format = format.to_lowercase();
    let norm_note = note.to_lowercase();
    if norm_format.contains("tl") || norm_format.contains("essay") || norm_note.contains("tài liệu") {
        items.push(ExamChecklistItem {
            id: "allowed_materials".to_string(),
            label: "Tài liệu giấy A4 / Đề cương (nếu môn cho phép)".to_string(),
            is_checked: false,
        });
    }

    items
}

pub fn upsert_exam_schedules(
    conn: &mut Connection,
    payload: &PortalExamSchedulePayload,
) -> Result<usize, String> {
    crate::db::schema::ensure_exam_schema(conn).map_err(|e| format!("Schema error: {e}"))?;

    let tx = conn.transaction().map_err(|e| format!("Cannot start tx: {e}"))?;
    let now_ts = Utc::now().timestamp();
    let mut upserted_count = 0;

    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO academic_exams (
                    id, subject_code, subject_name, section_class_id, section_class_code,
                    format, examination, shift, start_time, end_time, weekday,
                    date_str, exam_timestamp, room, seat_number, absent, note,
                    checklist_items, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                ON CONFLICT(id) DO UPDATE SET
                    subject_code = excluded.subject_code,
                    subject_name = excluded.subject_name,
                    section_class_id = excluded.section_class_id,
                    section_class_code = excluded.section_class_code,
                    format = excluded.format,
                    examination = excluded.examination,
                    shift = excluded.shift,
                    start_time = excluded.start_time,
                    end_time = excluded.end_time,
                    weekday = excluded.weekday,
                    date_str = excluded.date_str,
                    exam_timestamp = excluded.exam_timestamp,
                    room = excluded.room,
                    seat_number = CASE WHEN excluded.seat_number != '' THEN excluded.seat_number ELSE academic_exams.seat_number END,
                    absent = excluded.absent,
                    note = excluded.note,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare insert exam error: {e}"))?;

        let mut next_id: i64 = tx
            .query_row("SELECT COALESCE(MAX(id), 0) FROM academic_exams", [], |r| r.get(0))
            .unwrap_or(0);

        for item in payload.items.iter() {
            let subject_code = item.subject_code.trim();
            let examination_val = item.examination.as_deref().unwrap_or("").trim();
            let date_str = item.date.as_deref().unwrap_or("").trim();
            let start_time = item.start_time.as_deref().unwrap_or("07:30").trim();
            let format_val = item.format.as_deref().unwrap_or("").trim();
            let note_val = item.note.as_deref().unwrap_or("").trim();

            let exam_ts = parse_exam_timestamp(date_str, start_time);

            // Tìm xem môn thi + kỳ thi này đã tồn tại chưa để giữ nguyên checklist và không ghi đè chéo
            let existing: Option<(i64, String)> = if !examination_val.is_empty() {
                tx.query_row(
                    "SELECT id, checklist_items FROM academic_exams WHERE subject_code = ?1 AND examination = ?2 LIMIT 1",
                    params![subject_code, examination_val],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok()
            } else {
                tx.query_row(
                    "SELECT id, checklist_items FROM academic_exams WHERE subject_code = ?1 AND date_str = ?2 LIMIT 1",
                    params![subject_code, date_str],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok()
            };

            let (id, checklist_json) = if let Some((eid, chk)) = existing {
                let cl = if !chk.trim().is_empty() && chk != "[]" {
                    chk
                } else {
                    let items = default_checklist_for_exam(format_val, note_val);
                    serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
                };
                (eid, cl)
            } else {
                next_id += 1;
                let items = default_checklist_for_exam(format_val, note_val);
                let cl = serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string());
                (next_id, cl)
            };

            stmt.execute(params![
                id,
                item.subject_code.trim(),
                item.subject_name.trim(),
                item.section_class_id.as_deref().unwrap_or("").trim(),
                item.section_class_code.as_deref().unwrap_or("").trim(),
                format_val,
                item.examination.as_deref().unwrap_or("").trim(),
                item.shift.as_deref().unwrap_or("").trim(),
                start_time,
                item.end_time.as_deref().unwrap_or("").trim(),
                item.weekday.as_deref().unwrap_or("").trim(),
                date_str,
                exam_ts,
                item.room.as_deref().unwrap_or("").trim(),
                item.seat_number.as_deref().unwrap_or("").trim(),
                item.absent.as_deref().unwrap_or("Không").trim(),
                note_val,
                checklist_json,
                now_ts
            ])
            .map_err(|e| format!("Execute insert exam {} error: {e}", item.subject_code))?;

            upserted_count += 1;
        }
    }

    tx.commit().map_err(|e| format!("Commit error: {e}"))?;
    Ok(upserted_count)
}

pub fn get_all_exam_schedules(conn: &Connection) -> SqlResult<Vec<AcademicExamRecord>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT
            id, subject_code, subject_name, section_class_id, section_class_code,
            format, examination, shift, start_time, end_time, weekday,
            date_str, exam_timestamp, room, seat_number, absent, note,
            checklist_items, updated_at
        FROM academic_exams
        ORDER BY exam_timestamp ASC, shift ASC
        "#,
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(AcademicExamRecord {
            id: row.get(0)?,
            subject_code: row.get(1)?,
            subject_name: row.get(2)?,
            section_class_id: row.get(3)?,
            section_class_code: row.get(4)?,
            format: row.get(5)?,
            examination: row.get(6)?,
            shift: row.get(7)?,
            start_time: row.get(8)?,
            end_time: row.get(9)?,
            weekday: row.get(10)?,
            date_str: row.get(11)?,
            exam_timestamp: row.get(12)?,
            room: row.get(13)?,
            seat_number: row.get(14)?,
            absent: row.get(15)?,
            note: row.get(16)?,
            checklist_items: row.get(17)?,
            updated_at: row.get(18)?,
        })
    })?;

    let mut exams = Vec::new();
    for r in rows {
        exams.push(r?);
    }
    Ok(exams)
}

pub fn get_next_upcoming_exam(conn: &Connection, now_ts: i64) -> SqlResult<Option<AcademicExamRecord>> {
    // Lấy môn thi kế tiếp mà chưa qua quá 2 tiếng (7200 giây sau giờ bắt đầu)
    let threshold = now_ts - 7200;
    let mut stmt = conn.prepare(
        r#"
        SELECT
            id, subject_code, subject_name, section_class_id, section_class_code,
            format, examination, shift, start_time, end_time, weekday,
            date_str, exam_timestamp, room, seat_number, absent, note,
            checklist_items, updated_at
        FROM academic_exams
        WHERE exam_timestamp >= ?1
        ORDER BY exam_timestamp ASC
        LIMIT 1
        "#,
    )?;

    let mut rows = stmt.query_map(params![threshold], |row| {
        Ok(AcademicExamRecord {
            id: row.get(0)?,
            subject_code: row.get(1)?,
            subject_name: row.get(2)?,
            section_class_id: row.get(3)?,
            section_class_code: row.get(4)?,
            format: row.get(5)?,
            examination: row.get(6)?,
            shift: row.get(7)?,
            start_time: row.get(8)?,
            end_time: row.get(9)?,
            weekday: row.get(10)?,
            date_str: row.get(11)?,
            exam_timestamp: row.get(12)?,
            room: row.get(13)?,
            seat_number: row.get(14)?,
            absent: row.get(15)?,
            note: row.get(16)?,
            checklist_items: row.get(17)?,
            updated_at: row.get(18)?,
        })
    })?;

    if let Some(first) = rows.next() {
        Ok(Some(first?))
    } else {
        Ok(None)
    }
}

pub fn update_exam_checklist_in_db(
    conn: &Connection,
    exam_id: i64,
    checklist_json: &str,
) -> SqlResult<()> {
    conn.execute(
        "UPDATE academic_exams SET checklist_items = ?1, updated_at = ?2 WHERE id = ?3",
        params![checklist_json, Utc::now().timestamp(), exam_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_exam_timestamp_vietnamese_date() {
        let ts = parse_exam_timestamp("07/04/2026", "13:30");
        assert!(ts > 0);
        // 2026-04-07 13:30 UTC+7 is 2026-04-07 06:30 UTC
        let dt = Utc.timestamp_opt(ts, 0).single().unwrap();
        assert_eq!(dt.format("%Y-%m-%d %H:%M").to_string(), "2026-04-07 06:30");
    }

    #[test]
    fn test_upsert_and_query_exam_schedule() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        let payload = PortalExamSchedulePayload {
            items: vec![
                PortalExamItemDto {
                    id: Some(1),
                    subject_code: "IT012".to_string(),
                    subject_name: "Tổ chức và cấu trúc máy tính 2".to_string(),
                    section_class_id: Some("IT012.Q22".to_string()),
                    section_class_code: Some("IT012.Q22".to_string()),
                    format: Some("tl".to_string()),
                    examination: Some("midterm".to_string()),
                    shift: Some("3".to_string()),
                    start_time: Some("13:30".to_string()),
                    end_time: Some("15:30".to_string()),
                    weekday: Some("Thứ 3".to_string()),
                    date: Some("07/04/2026".to_string()),
                    room: Some("B1.18".to_string()),
                    seat_number: Some("015".to_string()),
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
                PortalExamItemDto {
                    id: Some(2),
                    subject_code: "MA004".to_string(),
                    subject_name: "Cấu trúc rời rạc".to_string(),
                    section_class_id: Some("MA004.Q217".to_string()),
                    section_class_code: Some("MA004.Q217".to_string()),
                    format: Some("tl".to_string()),
                    examination: Some("midterm".to_string()),
                    shift: Some("2".to_string()),
                    start_time: Some("09:30".to_string()),
                    end_time: Some("11:30".to_string()),
                    weekday: Some("Thứ 2".to_string()),
                    date: Some("06/04/2026".to_string()),
                    room: Some("C309".to_string()),
                    seat_number: Some("".to_string()),
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
            ],
        };

        let count = upsert_exam_schedules(&mut conn, &payload).unwrap();
        assert_eq!(count, 2);

        let list = get_all_exam_schedules(&conn).unwrap();
        assert_eq!(list.len(), 2);
        // MA004 is on 06/04 so it should appear before IT012 on 07/04
        assert_eq!(list[0].subject_code, "MA004");
        assert_eq!(list[1].subject_code, "IT012");
        assert_eq!(list[1].room, "B1.18");

        // Checklist update
        let new_checklist = "[{\"id\":\"card\",\"label\":\"CCCD\",\"is_checked\":true}]";
        update_exam_checklist_in_db(&conn, 1, new_checklist).unwrap();

        let updated_list = get_all_exam_schedules(&conn).unwrap();
        assert_eq!(updated_list[1].checklist_items, new_checklist);
    }

    #[test]
    fn test_upsert_midterm_and_final_term_coexist_without_collision() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        // 1. Midterm payload (3 subjects)
        let midterm_payload = PortalExamSchedulePayload {
            items: vec![
                PortalExamItemDto {
                    id: Some(1),
                    subject_code: "IT012".to_string(),
                    subject_name: "Tổ chức và cấu trúc máy tính 2".to_string(),
                    section_class_id: Some("IT012.Q22".to_string()),
                    section_class_code: Some("IT012.Q22".to_string()),
                    format: Some("tl".to_string()),
                    examination: Some("midterm".to_string()),
                    shift: Some("3".to_string()),
                    start_time: Some("13:30".to_string()),
                    end_time: Some("15:30".to_string()),
                    weekday: Some("Thứ 3".to_string()),
                    date: Some("07/04/2026".to_string()),
                    room: Some("B1.18".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
                PortalExamItemDto {
                    id: Some(2),
                    subject_code: "MA004".to_string(),
                    subject_name: "Cấu trúc rời rạc".to_string(),
                    section_class_id: Some("MA004.Q217".to_string()),
                    section_class_code: Some("MA004.Q217".to_string()),
                    format: Some("tl".to_string()),
                    examination: Some("midterm".to_string()),
                    shift: Some("2".to_string()),
                    start_time: Some("09:30".to_string()),
                    end_time: Some("11:30".to_string()),
                    weekday: Some("Thứ 2".to_string()),
                    date: Some("06/04/2026".to_string()),
                    room: Some("C309".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
                PortalExamItemDto {
                    id: Some(3),
                    subject_code: "MA005".to_string(),
                    subject_name: "Xác suất thống kê".to_string(),
                    section_class_id: Some("MA005.Q219".to_string()),
                    section_class_code: Some("MA005.Q219".to_string()),
                    format: Some("tl".to_string()),
                    examination: Some("midterm".to_string()),
                    shift: Some("2".to_string()),
                    start_time: Some("09:30".to_string()),
                    end_time: Some("11:30".to_string()),
                    weekday: Some("Thứ 4".to_string()),
                    date: Some("08/04/2026".to_string()),
                    room: Some("B1.04".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
            ],
        };

        let mid_count = upsert_exam_schedules(&mut conn, &midterm_payload).unwrap();
        assert_eq!(mid_count, 3);

        // 2. Final term payload (6 subjects)
        let final_payload = PortalExamSchedulePayload {
            items: vec![
                PortalExamItemDto {
                    id: Some(1),
                    subject_code: "IT012".to_string(),
                    subject_name: "Tổ chức và cấu trúc máy tính 2".to_string(),
                    section_class_id: Some("IT012.Q22".to_string()),
                    section_class_code: Some("IT012.Q22".to_string()),
                    format: Some("essay".to_string()),
                    examination: Some("final_term".to_string()),
                    shift: Some("3".to_string()),
                    start_time: Some("13:30".to_string()),
                    end_time: Some("15:30".to_string()),
                    weekday: Some("Thứ 5".to_string()),
                    date: Some("09/07/2026".to_string()),
                    room: Some("B3.12".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("Xác nhận đủ_Nguyễn Hiếu Nghĩa_09/07/2026 08:17:53\n".to_string()),
                },
                PortalExamItemDto {
                    id: Some(2),
                    subject_code: "MA004".to_string(),
                    subject_name: "Cấu trúc rời rạc".to_string(),
                    section_class_id: Some("MA004.Q217".to_string()),
                    section_class_code: Some("MA004.Q217".to_string()),
                    format: Some("essay".to_string()),
                    examination: Some("final_term".to_string()),
                    shift: Some("2".to_string()),
                    start_time: Some("09:30".to_string()),
                    end_time: Some("11:30".to_string()),
                    weekday: Some("Thứ 4".to_string()),
                    date: Some("08/07/2026".to_string()),
                    room: Some("C309".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("Xác nhận đủ_Lê Anh Tuấn_08/07/2026 03:26:37\n".to_string()),
                },
                PortalExamItemDto {
                    id: Some(3),
                    subject_code: "IT003".to_string(),
                    subject_name: "Cấu trúc dữ liệu và giải thuật".to_string(),
                    section_class_id: Some("IT003.Q27".to_string()),
                    section_class_code: Some("IT003.Q27".to_string()),
                    format: Some("essay".to_string()),
                    examination: Some("final_term".to_string()),
                    shift: Some("2".to_string()),
                    start_time: Some("09:30".to_string()),
                    end_time: Some("11:30".to_string()),
                    weekday: Some("Thứ 5".to_string()),
                    date: Some("09/07/2026".to_string()),
                    room: Some("B3.20".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
                PortalExamItemDto {
                    id: Some(4),
                    subject_code: "IT002".to_string(),
                    subject_name: "Lập trình hướng đối tượng".to_string(),
                    section_class_id: Some("IT002.Q24".to_string()),
                    section_class_code: Some("IT002.Q24".to_string()),
                    format: Some("essay".to_string()),
                    examination: Some("final_term".to_string()),
                    shift: Some("2".to_string()),
                    start_time: Some("09:30".to_string()),
                    end_time: Some("11:30".to_string()),
                    weekday: Some("Thứ 6".to_string()),
                    date: Some("10/07/2026".to_string()),
                    room: Some("B4.20".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
                PortalExamItemDto {
                    id: Some(5),
                    subject_code: "SS007".to_string(),
                    subject_name: "Triết học Mác – Lênin".to_string(),
                    section_class_id: Some("SS007.Q26".to_string()),
                    section_class_code: Some("SS007.Q26".to_string()),
                    format: Some("essay".to_string()),
                    examination: Some("final_term".to_string()),
                    shift: Some("3".to_string()),
                    start_time: Some("13:30".to_string()),
                    end_time: Some("15:30".to_string()),
                    weekday: Some("Thứ 6".to_string()),
                    date: Some("10/07/2026".to_string()),
                    room: Some("B1.16".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("Xác nhận đủ_Đào Đức Cơ_10/07/2026 06:51:14".to_string()),
                },
                PortalExamItemDto {
                    id: Some(6),
                    subject_code: "MA005".to_string(),
                    subject_name: "Xác suất thống kê".to_string(),
                    section_class_id: Some("MA005.Q219".to_string()),
                    section_class_code: Some("MA005.Q219".to_string()),
                    format: Some("essay".to_string()),
                    examination: Some("final_term".to_string()),
                    shift: Some("2".to_string()),
                    start_time: Some("09:30".to_string()),
                    end_time: Some("11:30".to_string()),
                    weekday: Some("Thứ 2".to_string()),
                    date: Some("13/07/2026".to_string()),
                    room: Some("B1.04".to_string()),
                    seat_number: None,
                    absent: Some("Không".to_string()),
                    note: Some("".to_string()),
                },
            ],
        };

        let fin_count = upsert_exam_schedules(&mut conn, &final_payload).unwrap();
        assert_eq!(fin_count, 6);

        // Tổng cộng phải có 3 + 6 = 9 ca thi, không bị ghi đè lẫn nhau!
        let all_exams = get_all_exam_schedules(&conn).unwrap();
        assert_eq!(all_exams.len(), 9);

        // Ca thi đầu tiên theo thứ tự thời gian phải là MA004 Giữa kỳ (06/04/2026)
        assert_eq!(all_exams[0].subject_code, "MA004");
        assert_eq!(all_exams[0].examination, "midterm");
        assert_eq!(all_exams[0].date_str, "06/04/2026");

        // Ca thi cuối cùng theo thứ tự thời gian phải là MA005 Cuối kỳ (13/07/2026)
        assert_eq!(all_exams[8].subject_code, "MA005");
        assert_eq!(all_exams[8].examination, "final_term");
        assert_eq!(all_exams[8].date_str, "13/07/2026");
    }
}
