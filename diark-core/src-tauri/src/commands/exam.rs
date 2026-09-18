use tauri::{AppHandle, State};
use crate::AppState;
use crate::db::exam::{
    get_all_exam_schedules, update_exam_checklist_in_db, upsert_exam_schedules,
    AcademicExamRecord, PortalExamSchedulePayload,
};
use crate::modules::system::daily_briefing::{dispatch_daily_briefing, DailyBriefingDto};

#[tauri::command]
pub fn get_exam_schedules(state: State<AppState>) -> Result<Vec<AcademicExamRecord>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    get_all_exam_schedules(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_exam_schedules(
    state: State<AppState>,
    payload: PortalExamSchedulePayload,
) -> Result<usize, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    upsert_exam_schedules(&mut conn, &payload)
}

#[tauri::command]
pub fn update_exam_checklist(
    state: State<AppState>,
    exam_id: i64,
    checklist_json: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    update_exam_checklist_in_db(&conn, exam_id, &checklist_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trigger_daily_briefing(
    app: AppHandle,
    state: State<AppState>,
) -> Result<DailyBriefingDto, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    dispatch_daily_briefing(&app, &conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::exam::PortalExamItemDto;

    #[test]
    fn test_sync_exam_schedules_command_logic() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        let payload = PortalExamSchedulePayload {
            items: vec![PortalExamItemDto {
                id: Some(1),
                subject_code: "IT012".to_string(),
                subject_name: "Tổ chức và cấu trúc máy tính 2".to_string(),
                section_class_id: None,
                section_class_code: None,
                format: Some("essay".to_string()),
                examination: Some("final_term".to_string()),
                shift: Some("3".to_string()),
                start_time: Some("13:30".to_string()),
                end_time: Some("15:30".to_string()),
                weekday: Some("Thứ 5".to_string()),
                date: Some("09/07/2026".to_string()),
                room: Some("B3.12".to_string()),
                seat_number: Some("024".to_string()),
                absent: Some("Không".to_string()),
                note: Some("Xác nhận đủ".to_string()),
            }],
        };

        let mut conn_mut = conn;
        let upserted = upsert_exam_schedules(&mut conn_mut, &payload).unwrap();
        assert_eq!(upserted, 1);

        let list = get_all_exam_schedules(&conn_mut).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].room, "B3.12");
        assert_eq!(list[0].seat_number, "024");
    }
}
