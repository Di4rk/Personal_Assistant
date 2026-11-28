use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

use crate::db::exam::get_all_exam_schedules;
use crate::db::portal_extra::{
    delete_google_calendar, delete_oauth_calendars, delete_single_calendar_event,
    get_all_course_syllabus_weights, get_calendar_events_range, get_certificates,
    get_class_activities, get_google_calendar_by_id, get_moodle_grades as db_get_moodle_grades,
    get_moodle_notifications as db_get_moodle_notifications, get_registered_classes,
    get_timetable_range, get_tuition_records, list_google_calendars as db_list_google_calendars,
    replace_calendar_events, set_google_calendar_enabled, upsert_google_calendar,
    upsert_oauth_google_calendar, upsert_single_calendar_event, CalendarEventRecord,
    CourseSyllabusWeightDto, GoogleCalendarConfig, MoodleGradeRecord, MoodleNotificationRecord,
    PortalCertificateRecord, PortalClassActivityRecord, PortalRegisteredClassRecord,
    PortalTimetableRecord, PortalTuitionRecord,
};
use crate::db::SharedDb;
use crate::services::gcal_ics::{export_uit_schedule_to_ics, fetch_and_parse_ics};
use crate::services::gcal_oauth::{
    self, CreateGoogleEventInput, GoogleOAuthStatus, PushUitScheduleSummary,
};

#[tauri::command]
pub fn get_portal_registered_classes(
    db: State<'_, SharedDb>,
) -> Result<Vec<PortalRegisteredClassRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_registered_classes(&conn).map_err(|e| format!("Lỗi đọc lớp học phần: {e}"))
}

#[tauri::command]
pub fn get_course_syllabus_weights(
    db: State<'_, SharedDb>,
) -> Result<Vec<CourseSyllabusWeightDto>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_all_course_syllabus_weights(&conn)
        .map_err(|e| format!("Lỗi đọc trọng số đề cương môn học: {e}"))
}

#[tauri::command]
pub fn get_portal_timetable(
    db: State<'_, SharedDb>,
    start_date: Option<String>,
    end_date: Option<String>,
) -> Result<Vec<PortalTimetableRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_timetable_range(&conn, start_date.as_deref(), end_date.as_deref())
        .map_err(|e| format!("Lỗi đọc thời khóa biểu: {e}"))
}

#[tauri::command]
pub fn get_portal_tuition(db: State<'_, SharedDb>) -> Result<Vec<PortalTuitionRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_tuition_records(&conn).map_err(|e| format!("Lỗi đọc học phí: {e}"))
}

#[tauri::command]
pub fn get_portal_certificates(
    db: State<'_, SharedDb>,
) -> Result<Vec<PortalCertificateRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_certificates(&conn).map_err(|e| format!("Lỗi đọc chứng chỉ: {e}"))
}

#[tauri::command]
pub fn get_portal_class_activities(
    db: State<'_, SharedDb>,
) -> Result<Vec<PortalClassActivityRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_class_activities(&conn).map_err(|e| format!("Lỗi đọc lịch sinh hoạt: {e}"))
}

#[tauri::command]
pub fn preview_exam_excel(
    file_path: String,
    db: State<'_, SharedDb>,
) -> Result<crate::services::exam_excel_parser::ExamExcelParsePreview, String> {
    let clean_path = file_path.trim();
    if clean_path.is_empty() {
        return Err("Đường dẫn file Excel không được để trống.".to_string());
    }
    let path = std::path::PathBuf::from(clean_path);
    if !path.exists() {
        return Err(format!("Không tìm thấy file: {}", path.display()));
    }

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let registered = get_registered_classes(&conn)
        .map_err(|e| format!("Lỗi đọc danh sách lớp đăng ký: {e}"))?;

    let mut class_codes: Vec<String> = Vec::new();
    let mut subject_codes: Vec<String> = Vec::new();
    for rc in registered {
        if !rc.code.trim().is_empty() {
            class_codes.push(rc.code.trim().to_string());
        }
        if !rc.subject_code.trim().is_empty() {
            subject_codes.push(rc.subject_code.trim().to_string());
        }
    }

    if let Ok(mut stmt) = conn.prepare(
        "SELECT DISTINCT course_code FROM academic_courses WHERE summary_score_10 IS NULL AND course_code != ''",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for code in rows.flatten() {
                let trimmed = code.trim();
                if !trimmed.is_empty()
                    && !subject_codes
                        .iter()
                        .any(|existing| existing.eq_ignore_ascii_case(trimmed))
                {
                    subject_codes.push(trimmed.to_string());
                }
            }
        }
    }

    crate::services::exam_excel_parser::parse_exam_excel_for_student(
        &path,
        &class_codes,
        &subject_codes,
    )
}

#[tauri::command]
pub fn get_moodle_grades(db: State<'_, SharedDb>) -> Result<Vec<MoodleGradeRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    db_get_moodle_grades(&conn).map_err(|e| format!("Lỗi đọc điểm Moodle: {e}"))
}

#[tauri::command]
pub fn get_moodle_notifications(
    db: State<'_, SharedDb>,
) -> Result<Vec<MoodleNotificationRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    db_get_moodle_notifications(&conn).map_err(|e| format!("Lỗi đọc thông báo Moodle: {e}"))
}

#[tauri::command]
pub fn list_google_calendars(
    db: State<'_, SharedDb>,
) -> Result<Vec<GoogleCalendarConfig>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    db_list_google_calendars(&conn).map_err(|e| format!("Lỗi đọc danh sách lịch Google: {e}"))
}

#[tauri::command]
pub fn add_google_calendar(
    db: State<'_, SharedDb>,
    name: String,
    ics_url: String,
    color: Option<String>,
) -> Result<GoogleCalendarConfig, String> {
    let clean_name = name.trim();
    let clean_url = ics_url.trim();
    if clean_name.is_empty() {
        return Err("Tên lịch không được để trống".to_string());
    }
    if !clean_url.starts_with("https://") && !clean_url.starts_with("webcal://") {
        return Err("URL lịch ICS phải bắt đầu bằng https:// hoặc webcal://".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let final_color = color
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "#10b981".to_string());

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    upsert_google_calendar(&conn, &id, clean_name, clean_url, &final_color)
        .map_err(|e| format!("Lỗi thêm lịch Google: {e}"))
}

#[tauri::command]
pub fn remove_google_calendar(db: State<'_, SharedDb>, id: String) -> Result<(), String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    delete_google_calendar(&conn, id.trim()).map_err(|e| format!("Lỗi xóa lịch Google: {e}"))
}

#[tauri::command]
pub fn toggle_google_calendar(
    db: State<'_, SharedDb>,
    id: String,
    is_enabled: bool,
) -> Result<(), String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    set_google_calendar_enabled(&conn, id.trim(), is_enabled)
        .map_err(|e| format!("Lỗi cập nhật trạng thái lịch: {e}"))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GoogleCalendarSyncSummary {
    pub synced_calendars: usize,
    pub total_events: usize,
    pub errors: Vec<String>,
}

async fn sync_all_calendars_internal(
    app: &AppHandle,
    db: &SharedDb,
) -> Result<GoogleCalendarSyncSummary, String> {
    let mut errors = Vec::new();
    let mut oauth_token_opt: Option<String> = None;

    if gcal_oauth::get_oauth_status(db).connected {
        match gcal_oauth::get_valid_access_token(db).await {
            Ok(token) => {
                match gcal_oauth::fetch_remote_calendars(&token).await {
                    Ok(remote_cals) => {
                        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
                        for rc in remote_cals {
                            if let Err(e) = upsert_oauth_google_calendar(
                                &conn,
                                &rc.id,
                                &rc.summary,
                                &rc.color,
                                rc.can_write,
                            ) {
                                errors.push(format!("{}: {e}", rc.summary));
                            }
                        }
                    }
                    Err(e) => errors.push(e),
                }
                oauth_token_opt = Some(token);
            }
            Err(e) => errors.push(e),
        }
    }

    let calendars: Vec<GoogleCalendarConfig> = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        db_list_google_calendars(&conn)
            .map_err(|e| format!("Lỗi đọc danh sách lịch: {e}"))?
            .into_iter()
            .filter(|c| c.is_enabled)
            .collect()
    };

    let mut total_events = 0usize;
    let mut synced_calendars = 0usize;

    for cal in calendars {
        let fetched_res = if cal.source == "oauth" {
            if let Some(ref token) = oauth_token_opt {
                gcal_oauth::fetch_remote_events(token, &cal.id, &cal.google_calendar_id).await
            } else {
                continue;
            }
        } else {
            fetch_and_parse_ics(&cal.id, &cal.ics_url).await
        };

        match fetched_res {
            Ok(events) => {
                let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
                match replace_calendar_events(&mut conn, &cal.id, &events) {
                    Ok(count) => {
                        synced_calendars += 1;
                        total_events += count;
                    }
                    Err(e) => errors.push(format!("{}: {e}", cal.name)),
                }
            }
            Err(e) => errors.push(format!("{}: {e}", cal.name)),
        }
    }

    let _ = app.emit("calendar-events-synced", total_events);
    Ok(GoogleCalendarSyncSummary {
        synced_calendars,
        total_events,
        errors,
    })
}

#[tauri::command]
pub async fn sync_google_calendars(
    app: AppHandle,
    db: State<'_, SharedDb>,
) -> Result<GoogleCalendarSyncSummary, String> {
    sync_all_calendars_internal(&app, db.inner()).await
}

#[tauri::command]
pub fn get_google_oauth_status(db: State<'_, SharedDb>) -> GoogleOAuthStatus {
    gcal_oauth::get_oauth_status(db.inner())
}

#[tauri::command]
pub fn save_google_oauth_client_config(
    db: State<'_, SharedDb>,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    gcal_oauth::save_custom_oauth_client_config(db.inner(), &client_id, &client_secret)
}

#[tauri::command]
pub async fn connect_google_calendar_oauth(
    app: AppHandle,
    db: State<'_, SharedDb>,
) -> Result<GoogleCalendarSyncSummary, String> {
    let cfg = gcal_oauth::resolve_oauth_client_config(db.inner()).ok_or_else(|| {
        "Ứng dụng chưa được cấu hình Google OAuth Client ID. Vui lòng nhập Client ID trong mục Cấu hình OAuth.".to_string()
    })?;
    let bundle = gcal_oauth::run_oauth_loopback_flow(&cfg).await?;
    gcal_oauth::save_oauth_tokens(db.inner(), &bundle)?;
    sync_all_calendars_internal(&app, db.inner()).await
}

#[tauri::command]
pub fn disconnect_google_calendar_oauth(
    app: AppHandle,
    db: State<'_, SharedDb>,
) -> Result<(), String> {
    gcal_oauth::clear_oauth_tokens(db.inner())?;
    {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        delete_oauth_calendars(&conn)
            .map_err(|e| format!("Lỗi xóa lịch Google OAuth: {e}"))?;
    }
    let _ = app.emit("calendar-events-synced", 0usize);
    Ok(())
}

#[tauri::command]
pub async fn create_google_calendar_event(
    app: AppHandle,
    db: State<'_, SharedDb>,
    input: CreateGoogleEventInput,
) -> Result<CalendarEventRecord, String> {
    let cal = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        get_google_calendar_by_id(&conn, input.calendar_id.trim())
            .map_err(|e| format!("Lỗi đọc thông tin lịch: {e}"))?
            .ok_or_else(|| "Không tìm thấy lịch đích để thêm sự kiện.".to_string())?
    };

    if cal.source != "oauth" || !cal.can_write || cal.google_calendar_id.trim().is_empty() {
        return Err("Lịch này chỉ hỗ trợ đọc hoặc không phải lịch Google đã đăng nhập.".to_string());
    }

    let token = gcal_oauth::get_valid_access_token(db.inner()).await?;
    let created =
        gcal_oauth::create_remote_event(&token, &cal.id, &cal.google_calendar_id, &input).await?;
    {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        upsert_single_calendar_event(&conn, &created)
            .map_err(|e| format!("Lỗi lưu sự kiện vào SQLite: {e}"))?;
    }
    let _ = app.emit("calendar-events-synced", 1usize);
    Ok(created)
}

#[tauri::command]
pub async fn delete_google_calendar_event(
    app: AppHandle,
    db: State<'_, SharedDb>,
    calendar_id: String,
    uid: String,
) -> Result<(), String> {
    let cal = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        get_google_calendar_by_id(&conn, calendar_id.trim())
            .map_err(|e| format!("Lỗi đọc thông tin lịch: {e}"))?
            .ok_or_else(|| "Không tìm thấy lịch chứa sự kiện.".to_string())?
    };

    if cal.source != "oauth" || !cal.can_write || cal.google_calendar_id.trim().is_empty() {
        return Err("Chỉ xóa được sự kiện trên lịch Google có quyền ghi.".to_string());
    }

    let token = gcal_oauth::get_valid_access_token(db.inner()).await?;
    gcal_oauth::delete_remote_event(&token, &cal.google_calendar_id, uid.trim()).await?;
    {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        delete_single_calendar_event(&conn, &cal.id, uid.trim())
            .map_err(|e| format!("Lỗi xóa sự kiện trong SQLite: {e}"))?;
    }
    let _ = app.emit("calendar-events-synced", 0usize);
    Ok(())
}

#[tauri::command]
pub async fn push_uit_schedule_to_google(
    app: AppHandle,
    db: State<'_, SharedDb>,
) -> Result<PushUitScheduleSummary, String> {
    let (timetable, exams) = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        let tt = get_timetable_range(&conn, None, None)
            .map_err(|e| format!("Lỗi đọc thời khóa biểu: {e}"))?;
        let ex = get_all_exam_schedules(&conn).map_err(|e| format!("Lỗi đọc lịch thi: {e}"))?;
        (tt, ex)
    };

    let token = gcal_oauth::get_valid_access_token(db.inner()).await?;
    let summary =
        gcal_oauth::push_uit_schedule_to_google(db.inner(), &token, &timetable, &exams).await?;

    let _ = sync_all_calendars_internal(&app, db.inner()).await;
    Ok(summary)
}

#[tauri::command]
pub fn get_calendar_events(
    db: State<'_, SharedDb>,
    start_ts: i64,
    end_ts: i64,
) -> Result<Vec<CalendarEventRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_calendar_events_range(&conn, start_ts, end_ts)
        .map_err(|e| format!("Lỗi đọc sự kiện lịch: {e}"))
}

#[tauri::command]
pub fn export_uit_schedule_ics(db: State<'_, SharedDb>) -> Result<String, String> {
    let (timetable, exams) = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        let tt = get_timetable_range(&conn, None, None)
            .map_err(|e| format!("Lỗi đọc thời khóa biểu: {e}"))?;
        let ex = get_all_exam_schedules(&conn).map_err(|e| format!("Lỗi đọc lịch thi: {e}"))?;
        (tt, ex)
    };
    Ok(export_uit_schedule_to_ics(&timetable, &exams))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SsoCredentialsStatus {
    pub username: String,
    pub has_password: bool,
    pub auto_login: bool,
}

#[tauri::command]
pub fn get_local_sync_token() -> String {
    crate::server::get_sync_token().to_string()
}

pub(crate) fn read_sso_settings(db: &SharedDb) -> (String, String, bool) {
    let Ok(conn) = db.lock() else {
        return (String::new(), String::new(), false);
    };
    let username = crate::db::get_setting(&conn, "sso_uit_username")
        .ok()
        .flatten()
        .unwrap_or_default();
    let stored_password = crate::db::get_setting(&conn, "sso_uit_password")
        .ok()
        .flatten()
        .unwrap_or_default();
    let password = crate::db::secret_store::decrypt_secret(&stored_password).unwrap_or_default();
    let auto_login = crate::db::get_setting(&conn, "sso_uit_auto_login")
        .ok()
        .flatten()
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true);
    (username, password, auto_login)
}

pub fn has_saved_sso_autologin(db: &SharedDb) -> bool {
    let (u, p, auto) = read_sso_settings(db);
    auto && !u.trim().is_empty() && !p.is_empty()
}

pub fn build_sso_autofill_script(db: &SharedDb) -> String {
    let (username, password, auto_login) = read_sso_settings(db);
    let user_json = serde_json::to_string(&username).unwrap_or_else(|_| "\"\"".to_string());
    let pass_json = serde_json::to_string(&password).unwrap_or_else(|_| "\"\"".to_string());
    let token_json =
        serde_json::to_string(crate::server::get_sync_token()).unwrap_or_else(|_| "\"\"".to_string());
    let auto_flag = if auto_login { "true" } else { "false" };

    format!(
        r#"(() => {{
  if (window.__DIARK_SSO_AUTOFILL_ACTIVE__) return;
  window.__DIARK_SSO_AUTOFILL_ACTIVE__ = true;

  const ALLOWED_SSO_HOSTS = [
    "auth.uit.edu.vn",
    "sso.uit.edu.vn",
    "portal.uit.edu.vn",
    "courses.uit.edu.vn",
    "khmt.uit.edu.vn",
    "wecode.uit.edu.vn"
  ];
  const SAVED_USER = {user_json};
  const SAVED_PASS = {pass_json};
  const SYNC_TOKEN = {token_json};
  const AUTO_LOGIN = {auto_flag};
  const SAVE_ENDPOINT = "http://127.0.0.1:3030/api/v1/sync/sso-credentials";

  function isTrustedSsoHost(host) {{
    return ALLOWED_SSO_HOSTS.some((allowed) => host === allowed || host.endsWith("." + allowed));
  }}

  function saveCreds(u, p) {{
    if (!u || !p) return;
    try {{
      fetch(SAVE_ENDPOINT, {{
        method: "POST",
        headers: {{
          "Content-Type": "application/json",
          "X-Diark-Sync-Token": SYNC_TOKEN
        }},
        body: JSON.stringify({{ username: u, password: p }}),
        keepalive: true
      }}).catch(() => {{}});
    }} catch (_) {{}}
  }}

  function setInputValue(el, val) {{
    try {{
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event("input", {{ bubbles: true }}));
      el.dispatchEvent(new Event("change", {{ bubbles: true }}));
    }} catch (_) {{
      el.value = val;
    }}
  }}

  function runAutofill() {{
    const host = (window.location.hostname || "").toLowerCase();
    const path = (window.location.pathname || "").toLowerCase();
    if (!isTrustedSsoHost(host)) return;

    // 1. Moodle: tự bấm nút "UIT SSO" nếu đang ở trang login
    if (host.includes("courses.uit.edu.vn") && path.includes("/login")) {{
      const ssoLink = document.querySelector('a[href*="/auth/oauth2/login.php"]');
      if (ssoLink && AUTO_LOGIN && sessionStorage.getItem("__diark_moodle_sso_clicked") !== "1") {{
        sessionStorage.setItem("__diark_moodle_sso_clicked", "1");
        ssoLink.click();
      }}
      return;
    }}

    // 2. SSO / Wecode login form
    const passInput = document.querySelector('input[type="password"]#password, input[type="password"][name="password"], form input[type="password"]');
    if (!passInput) return;
    const form = passInput.closest("form");
    const userInput = (form && form.querySelector('input#username, input[name="username"], input[name="student_id"], input[type="text"]'))
      || document.querySelector('input#username, input[name="username"]');

    if (form && !form.__diarkBound) {{
      form.__diarkBound = true;
      form.addEventListener("submit", () => {{
        const u = (userInput?.value || "").trim();
        const p = passInput.value || "";
        if (u && p) saveCreds(u, p);
      }}, true);
    }}

    const hasError = Boolean(document.querySelector('.alert-error, .alert-danger, #input-error, .kc-feedback-text'));
    if (AUTO_LOGIN && SAVED_USER && SAVED_PASS && !hasError && sessionStorage.getItem("__diark_sso_attempted") !== "1") {{
      if (userInput) setInputValue(userInput, SAVED_USER);
      setInputValue(passInput, SAVED_PASS);
      sessionStorage.setItem("__diark_sso_attempted", "1");
      setTimeout(() => {{
        const submitBtn = form?.querySelector('#kc-login, button[type="submit"], input[type="submit"]');
        if (submitBtn) submitBtn.click();
        else if (form) form.submit();
      }}, 120);
    }}
  }}

  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", runAutofill);
  }} else {{
    runAutofill();
  }}
}})();"#,
    )
}

#[tauri::command]
pub fn get_sso_credentials_status(
    db: State<'_, SharedDb>,
) -> Result<SsoCredentialsStatus, String> {
    let (username, password, auto_login) = read_sso_settings(&db);
    Ok(SsoCredentialsStatus {
        username,
        has_password: !password.is_empty(),
        auto_login,
    })
}

#[tauri::command]
pub fn save_sso_credentials(
    db: State<'_, SharedDb>,
    username: String,
    password: Option<String>,
    auto_login: bool,
) -> Result<(), String> {
    let clean_user = username.trim().to_string();
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::set_setting(&conn, "sso_uit_username", &clean_user)
        .map_err(|e| format!("Lỗi lưu tài khoản SSO: {e}"))?;
    if let Some(pw) = password {
        if !pw.is_empty() {
            let encrypted_pw = crate::db::secret_store::encrypt_secret(&pw)
                .map_err(|e| format!("Lỗi mã hóa mật khẩu SSO: {e}"))?;
            crate::db::set_setting(&conn, "sso_uit_password", &encrypted_pw)
                .map_err(|e| format!("Lỗi lưu mật khẩu SSO: {e}"))?;
        }
    }
    crate::db::set_setting(
        &conn,
        "sso_uit_auto_login",
        if auto_login { "true" } else { "false" },
    )
    .map_err(|e| format!("Lỗi lưu cấu hình auto-login: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn clear_sso_credentials(db: State<'_, SharedDb>) -> Result<(), String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::set_setting(&conn, "sso_uit_username", "")
        .map_err(|e| format!("Lỗi xóa tài khoản SSO: {e}"))?;
    crate::db::set_setting(&conn, "sso_uit_password", "")
        .map_err(|e| format!("Lỗi xóa mật khẩu SSO: {e}"))?;
    crate::db::set_setting(&conn, "sso_uit_auto_login", "false")
        .map_err(|e| format!("Lỗi tắt auto-login SSO: {e}"))?;
    Ok(())
}

fn is_allowed_sso_verify_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    host == "uit.edu.vn" || host.ends_with(".uit.edu.vn")
}

pub fn parse_verify_callback_url(url_str: &str) -> Option<Result<(), String>> {
    if !url_str.starts_with("diark-sso://verify") {
        return None;
    }
    let query = url_str.split('?').nth(1).unwrap_or("");
    let mut status = "";
    let mut msg = String::new();
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        let k = kv.next().unwrap_or("");
        let v = kv.next().unwrap_or("");
        if k == "status" {
            status = v;
        } else if k == "msg" {
            msg = urlencoding::decode(v)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| v.to_string());
        }
    }
    if status == "ok" {
        Some(Ok(()))
    } else {
        let final_msg = if msg.trim().is_empty() {
            "Sai MSSV hoặc mật khẩu UIT SSO.".to_string()
        } else {
            msg
        };
        Some(Err(final_msg))
    }
}

pub fn build_sso_verify_script(username: &str, password: &str) -> String {
    let user_json = serde_json::to_string(username).unwrap_or_else(|_| "\"\"".to_string());
    let pass_json = serde_json::to_string(password).unwrap_or_else(|_| "\"\"".to_string());

    format!(
        r#"(() => {{
  if (window.__DIARK_SSO_VERIFY_ACTIVE__) return;
  window.__DIARK_SSO_VERIFY_ACTIVE__ = true;

  const VERIFY_USER = {user_json};
  const VERIFY_PASS = {pass_json};

  function sendVerify(status, msg) {{
    if (window.__DIARK_VERIFY_REPORTED__) return;
    window.__DIARK_VERIFY_REPORTED__ = true;
    const encoded = msg ? "&msg=" + encodeURIComponent(msg) : "";
    window.location.href = "diark-sso://verify?status=" + status + encoded;
  }}

  function normalizeSsoError(raw) {{
    const txt = (raw || "").trim();
    const low = txt.toLowerCase();
    if (!txt || low.includes("invalid username") || low.includes("invalid password") || low.includes("sai") || low.includes("incorrect")) {{
      return "Sai MSSV hoặc mật khẩu UIT SSO.";
    }}
    if (low.includes("disabled") || low.includes("locked")) {{
      return "Tài khoản UIT SSO đang bị khóa hoặc tạm vô hiệu hóa.";
    }}
    return txt;
  }}

  function setInputValue(el, val) {{
    try {{
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event("input", {{ bubbles: true }}));
      el.dispatchEvent(new Event("change", {{ bubbles: true }}));
    }} catch (_) {{
      el.value = val;
    }}
  }}

  function checkPageState() {{
    const host = (window.location.hostname || "").toLowerCase();
    const path = (window.location.pathname || "").toLowerCase();

    if (host.includes("portal.uit.edu.vn")) {{
      if (path.includes("/login") || path.includes("/user/login")) {{
        const ssoBtn = document.querySelector('a[href*="auth.uit.edu.vn"], a[href*="/cas"], a[href*="sso"]');
        if (ssoBtn) {{
          ssoBtn.click();
        }}
        return;
      }}
      const passOnPortal = document.querySelector('input[type="password"]');
      if (!passOnPortal) {{
        setTimeout(() => {{
          if (!(window.location.hostname || "").toLowerCase().includes("auth.uit.edu.vn")) {{
            sendVerify("ok", "");
          }}
        }}, 250);
      }}
      return;
    }}

    if (!host.includes("auth.uit.edu.vn") && !host.includes("sso.uit.edu.vn")) {{
      return;
    }}

    const captchaEl = document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, iframe[src*="turnstile"], .cf-turnstile');
    if (captchaEl) {{
      sendVerify("error", "Cổng UIT yêu cầu xác minh CAPTCHA. Hãy dùng nút Đồng bộ Portal để đăng nhập trực tiếp.");
      return;
    }}

    const errEl = document.querySelector('.alert-error, .alert-danger, #input-error, .kc-feedback-text, .pf-m-error, .feedback-error');
    if (errEl && errEl.textContent && errEl.textContent.trim().length > 0) {{
      sendVerify("error", normalizeSsoError(errEl.textContent));
      return;
    }}

    const otpInput = document.querySelector('input#otp, input[name="otp"], input[name="totp"], input[name="code"]');
    if (otpInput) {{
      sendVerify("error", "Tài khoản bật xác thực 2 bước (OTP). Hãy dùng nút Đồng bộ Portal để nhập mã xác thực.");
      return;
    }}

    if (sessionStorage.getItem("__diark_verify_submitted") === "1") {{
      setTimeout(() => {{
        const lateErr = document.querySelector('.alert-error, .alert-danger, #input-error, .kc-feedback-text, .pf-m-error');
        const msg = lateErr && lateErr.textContent ? normalizeSsoError(lateErr.textContent) : "Sai MSSV hoặc mật khẩu UIT SSO.";
        sendVerify("error", msg);
      }}, 700);
      return;
    }}

    const passInput = document.querySelector('input[type="password"]#password, input[type="password"][name="password"], form input[type="password"]');
    const form = passInput ? passInput.closest("form") : null;
    const userInput = (form && form.querySelector('input#username, input[name="username"], input[name="student_id"], input[type="text"]'))
      || document.querySelector('input#username, input[name="username"]');

    if (!passInput || !userInput) return;

    setInputValue(userInput, VERIFY_USER);
    setInputValue(passInput, VERIFY_PASS);
    sessionStorage.setItem("__diark_verify_submitted", "1");

    setTimeout(() => {{
      const submitBtn = form?.querySelector('#kc-login, button[type="submit"], input[type="submit"]');
      if (submitBtn) submitBtn.click();
      else if (form) form.submit();
    }}, 150);
  }}

  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", checkPageState);
  }} else {{
    checkPageState();
  }}
  setTimeout(checkPageState, 400);
}})();"#,
    )
}

#[tauri::command]
pub async fn verify_and_save_sso_credentials(
    app: AppHandle,
    db: State<'_, SharedDb>,
    username: String,
    password: Option<String>,
    auto_login: bool,
) -> Result<(), String> {
    let clean_user = username.trim().to_string();
    if clean_user.is_empty() {
        return Err("Vui lòng nhập MSSV / tài khoản SSO.".to_string());
    }

    let effective_password = match password {
        Some(pw) if !pw.is_empty() => pw,
        _ => {
            let (_, saved_pw, _) = read_sso_settings(&db);
            if saved_pw.is_empty() {
                return Err("Vui lòng nhập mật khẩu UIT SSO.".to_string());
            }
            saved_pw
        }
    };

    let verify_label = "uit-sso-verify";
    if let Some(existing) = app.get_webview_window(verify_label) {
        let _ = existing.destroy();
    }

    let auth_url = WebviewUrl::External(
        "https://portal.uit.edu.vn/sinh-vien/bang-diem"
            .parse()
            .map_err(|e| format!("URL xác thực không hợp lệ: {e}"))?,
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx_holder = Arc::new(StdMutex::new(Some(tx)));
    let tx_for_nav = Arc::clone(&tx_holder);
    let app_for_nav = app.clone();
    let verify_script = build_sso_verify_script(&clean_user, &effective_password);

    let build_res = WebviewWindowBuilder::new(&app, verify_label, auth_url)
        .title("Xác thực UIT SSO")
        .inner_size(800.0, 600.0)
        .visible(false)
        .incognito(true)
        .initialization_script(&verify_script)
        .on_navigation(move |url| {
            let url_str = url.as_str();
            if let Some(result) = parse_verify_callback_url(url_str) {
                if let Ok(mut guard) = tx_for_nav.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(result);
                    }
                }
                if let Some(win) = app_for_nav.get_webview_window(verify_label) {
                    let _ = win.destroy();
                }
                return false;
            }
            is_allowed_sso_verify_url(url)
        })
        .build();

    if let Err(e) = build_res {
        return Err(format!("Không thể khởi tạo phiên xác thực UIT SSO: {e}"));
    }

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(25), rx).await;

    if let Some(win) = app.get_webview_window(verify_label) {
        let _ = win.destroy();
    }

    match outcome {
        Ok(Ok(Ok(()))) => save_sso_credentials(db, clean_user, Some(effective_password), auto_login),
        Ok(Ok(Err(err_msg))) => Err(err_msg),
        Ok(Err(_)) => Err("Phiên xác thực UIT SSO đã bị hủy.".to_string()),
        Err(_) => Err("Hết thời gian xác thực với UIT SSO (25 giây). Vui lòng kiểm tra mạng hoặc dùng Đồng bộ Portal.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_verify_callback_url() {
        assert_eq!(parse_verify_callback_url("https://portal.uit.edu.vn/"), None);
        assert_eq!(parse_verify_callback_url("diark-sso://verify?status=ok"), Some(Ok(())));
        let err = parse_verify_callback_url(
            "diark-sso://verify?status=error&msg=Sai%20MSSV%20ho%E1%BA%B7c%20m%E1%BA%ADt%20kh%E1%BA%A9u",
        );
        assert_eq!(err, Some(Err("Sai MSSV hoặc mật khẩu".to_string())));
    }

    #[test]
    fn test_build_sso_verify_script_escapes_credentials() {
        let script = build_sso_verify_script("21520001", "pass\"with\\quote");
        assert!(script.contains("\"21520001\""));
        assert!(script.contains("pass\\\"with\\\\quote"));
        assert!(script.contains("diark-sso://verify?status="));
    }
}
