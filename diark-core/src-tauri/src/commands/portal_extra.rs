use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::exam::get_all_exam_schedules;
use crate::db::portal_extra::{
    delete_google_calendar, delete_oauth_calendars, delete_single_calendar_event,
    get_calendar_events_range, get_certificates, get_class_activities,
    get_google_calendar_by_id, get_moodle_grades as db_get_moodle_grades,
    get_moodle_notifications as db_get_moodle_notifications, get_registered_classes,
    get_timetable_range, get_tuition_records, list_google_calendars as db_list_google_calendars,
    replace_calendar_events, set_google_calendar_enabled, upsert_google_calendar,
    upsert_oauth_google_calendar, upsert_single_calendar_event, CalendarEventRecord,
    GoogleCalendarConfig, MoodleGradeRecord, MoodleNotificationRecord, PortalCertificateRecord,
    PortalClassActivityRecord, PortalRegisteredClassRecord, PortalTimetableRecord,
    PortalTuitionRecord,
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

fn read_sso_settings(db: &SharedDb) -> (String, String, bool) {
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
