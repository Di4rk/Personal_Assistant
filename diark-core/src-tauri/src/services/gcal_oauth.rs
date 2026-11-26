use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::db::exam::AcademicExamRecord;
use crate::db::portal_extra::{CalendarEventRecord, PortalTimetableRecord};
use crate::db::secret_store::{decrypt_secret, encrypt_secret};
use crate::db::{get_setting, set_setting, SharedDb};
use crate::services::gcal_ics::uit_period_time_bounds_public;

const EMBEDDED_GOOGLE_CLIENT_ID: Option<&str> = option_env!("DIARK_GOOGLE_OAUTH_CLIENT_ID");
const EMBEDDED_GOOGLE_CLIENT_SECRET: Option<&str> = option_env!("DIARK_GOOGLE_OAUTH_CLIENT_SECRET");

const SETTING_CLIENT_ID: &str = "gcal_oauth_client_id";
const SETTING_CLIENT_SECRET: &str = "gcal_oauth_client_secret";
const SETTING_ACCESS_TOKEN: &str = "gcal_oauth_access_token";
const SETTING_REFRESH_TOKEN: &str = "gcal_oauth_refresh_token";
const SETTING_EXPIRES_AT: &str = "gcal_oauth_expires_at";
const SETTING_EMAIL: &str = "gcal_oauth_email";
const SETTING_UIT_CAL_ID: &str = "gcal_uit_calendar_id";

const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const GOOGLE_OAUTH_SCOPES: &str =
    "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email";
const UIT_GOOGLE_CALENDAR_NAME: &str = "UIT Schedule (Diark OS)";

#[derive(Debug, Clone)]
pub struct OAuthClientConfig {
    pub client_id: String,
    pub client_secret: String,
    pub is_embedded: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoogleOAuthStatus {
    pub connected: bool,
    pub email: String,
    pub is_configured: bool,
    pub is_embedded_config: bool,
    pub has_custom_config: bool,
}

#[derive(Debug, Clone)]
pub struct OAuthTokenBundle {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub email: String,
}

#[derive(Debug, Clone)]
pub struct RemoteGoogleCalendar {
    pub id: String,
    pub summary: String,
    pub color: String,
    pub can_write: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateGoogleEventInput {
    pub calendar_id: String,
    pub summary: String,
    pub date: String,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub start_time: String,
    #[serde(default)]
    pub end_time: String,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushUitScheduleSummary {
    pub calendar_id: String,
    pub calendar_name: String,
    pub pushed_classes: usize,
    pub pushed_exams: usize,
    pub errors: Vec<String>,
}

fn encode_base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };

        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        }
        if i + 2 < bytes.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        }
        i += 3;
    }
    out
}

pub fn generate_pkce_pair() -> (String, String) {
    let mut random_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random_bytes);
    let verifier = encode_base64url(&random_bytes);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = encode_base64url(&digest);
    (verifier, challenge)
}

pub fn generate_oauth_state() -> String {
    let mut random_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut random_bytes);
    encode_base64url(&random_bytes)
}

pub fn has_embedded_oauth_config() -> bool {
    EMBEDDED_GOOGLE_CLIENT_ID
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

pub fn resolve_oauth_client_config(db: &SharedDb) -> Option<OAuthClientConfig> {
    if let Some(id) = EMBEDDED_GOOGLE_CLIENT_ID.map(str::trim).filter(|s| !s.is_empty()) {
        let secret = EMBEDDED_GOOGLE_CLIENT_SECRET
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        return Some(OAuthClientConfig {
            client_id: id.to_string(),
            client_secret: secret,
            is_embedded: true,
        });
    }

    if let Ok(id) = std::env::var("DIARK_GOOGLE_OAUTH_CLIENT_ID") {
        let trimmed = id.trim().to_string();
        if !trimmed.is_empty() {
            let secret = std::env::var("DIARK_GOOGLE_OAUTH_CLIENT_SECRET")
                .unwrap_or_default()
                .trim()
                .to_string();
            return Some(OAuthClientConfig {
                client_id: trimmed,
                client_secret: secret,
                is_embedded: true,
            });
        }
    }

    let Ok(conn) = db.lock() else {
        return None;
    };
    let client_id = get_setting(&conn, SETTING_CLIENT_ID)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let stored_secret = get_setting(&conn, SETTING_CLIENT_SECRET)
        .ok()
        .flatten()
        .unwrap_or_default();
    let client_secret = decrypt_secret(&stored_secret).unwrap_or_default();

    Some(OAuthClientConfig {
        client_id,
        client_secret,
        is_embedded: false,
    })
}

pub fn save_custom_oauth_client_config(
    db: &SharedDb,
    client_id: &str,
    client_secret: &str,
) -> Result<(), String> {
    let clean_id = client_id.trim();
    if clean_id.is_empty() {
        return Err("Client ID không được để trống".to_string());
    }
    let encrypted_secret = encrypt_secret(client_secret.trim())
        .map_err(|e| format!("Lỗi mã hóa Client Secret: {e}"))?;

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    set_setting(&conn, SETTING_CLIENT_ID, clean_id)
        .map_err(|e| format!("Lỗi lưu Client ID: {e}"))?;
    set_setting(&conn, SETTING_CLIENT_SECRET, &encrypted_secret)
        .map_err(|e| format!("Lỗi lưu Client Secret: {e}"))?;
    Ok(())
}

pub fn get_oauth_status(db: &SharedDb) -> GoogleOAuthStatus {
    let resolved = resolve_oauth_client_config(db);
    let is_embedded = has_embedded_oauth_config();
    let (connected, email, has_custom_config) = match db.lock() {
        Ok(conn) => {
            let stored_refresh = get_setting(&conn, SETTING_REFRESH_TOKEN)
                .ok()
                .flatten()
                .unwrap_or_default();
            let stored_access = get_setting(&conn, SETTING_ACCESS_TOKEN)
                .ok()
                .flatten()
                .unwrap_or_default();
            let mail = get_setting(&conn, SETTING_EMAIL)
                .ok()
                .flatten()
                .unwrap_or_default();
            let custom_id = get_setting(&conn, SETTING_CLIENT_ID)
                .ok()
                .flatten()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            let has_token = !stored_refresh.is_empty() || !stored_access.is_empty();
            (has_token, mail, custom_id)
        }
        Err(_) => (false, String::new(), false),
    };

    GoogleOAuthStatus {
        connected,
        email,
        is_configured: resolved.is_some(),
        is_embedded_config: is_embedded,
        has_custom_config,
    }
}

pub fn save_oauth_tokens(db: &SharedDb, bundle: &OAuthTokenBundle) -> Result<(), String> {
    let enc_access = encrypt_secret(&bundle.access_token)
        .map_err(|e| format!("Lỗi mã hóa access token: {e}"))?;
    let enc_refresh = match bundle.refresh_token.as_deref() {
        Some(rt) if !rt.is_empty() => {
            Some(encrypt_secret(rt).map_err(|e| format!("Lỗi mã hóa refresh token: {e}"))?)
        }
        _ => None,
    };

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    set_setting(&conn, SETTING_ACCESS_TOKEN, &enc_access)
        .map_err(|e| format!("Lỗi lưu access token: {e}"))?;
    if let Some(rt) = enc_refresh {
        set_setting(&conn, SETTING_REFRESH_TOKEN, &rt)
            .map_err(|e| format!("Lỗi lưu refresh token: {e}"))?;
    }
    set_setting(&conn, SETTING_EXPIRES_AT, &bundle.expires_at.to_string())
        .map_err(|e| format!("Lỗi lưu hạn token: {e}"))?;
    if !bundle.email.trim().is_empty() {
        set_setting(&conn, SETTING_EMAIL, bundle.email.trim())
            .map_err(|e| format!("Lỗi lưu email Google: {e}"))?;
    }
    Ok(())
}

pub fn clear_oauth_tokens(db: &SharedDb) -> Result<(), String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    for key in [
        SETTING_ACCESS_TOKEN,
        SETTING_REFRESH_TOKEN,
        SETTING_EXPIRES_AT,
        SETTING_EMAIL,
        SETTING_UIT_CAL_ID,
    ] {
        set_setting(&conn, key, "").map_err(|e| format!("Lỗi xóa khóa OAuth {key}: {e}"))?;
    }
    Ok(())
}

pub fn parse_callback_query(
    request_line: &str,
) -> Result<(Option<String>, Option<String>, Option<String>), String> {
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "Request callback không hợp lệ".to_string())?;
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");

    let mut code = None;
    let mut state = None;
    let mut error = None;

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (raw_k, raw_v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = urlencoding::decode(raw_k).map(|s| s.into_owned()).unwrap_or_else(|_| raw_k.to_string());
        let val = urlencoding::decode(raw_v).map(|s| s.into_owned()).unwrap_or_else(|_| raw_v.to_string());
        match key.as_str() {
            "code" => code = Some(val),
            "state" => state = Some(val),
            "error" => error = Some(val),
            _ => {}
        }
    }

    Ok((code, state, error))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn build_loopback_html_response(ok: bool, message: &str) -> Vec<u8> {
    let status_line = if ok {
        "200 OK"
    } else {
        "400 Bad Request"
    };
    let accent = if ok { "#10b981" } else { "#f43f5e" };
    let title = if ok {
        "Kết nối Google Calendar thành công"
    } else {
        "Không thể kết nối Google Calendar"
    };
    let escaped_msg = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    let body = format!(
        "<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{margin:0;background:#09090b;color:#f4f4f5;font-family:system-ui,-apple-system,sans-serif;\
         display:flex;align-items:center;justify-content:center;min-height:100vh;}}\
         .card{{max-width:420px;border:1px solid #27272a;background:#18181b;border-radius:10px;padding:24px;}}\
         h1{{margin:0 0 8px;font-size:16px;color:{accent};}}p{{margin:0;font-size:13px;color:#a1a1aa;line-height:1.5;}}</style>\
         </head><body><div class=\"card\"><h1>{title}</h1><p>{escaped_msg}</p></div></body></html>"
    );

    format!(
        "HTTP/1.1 {status_line}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Không khởi tạo được HTTP client: {e}"))
}

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GoogleUserInfoResponse {
    #[serde(default)]
    email: String,
}

pub async fn run_oauth_loopback_flow(cfg: &OAuthClientConfig) -> Result<OAuthTokenBundle, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Không mở được cổng callback cục bộ: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Không đọc được địa chỉ callback: {e}"))?
        .port();

    let redirect_uri = format!("http://127.0.0.1:{port}/oauth2/callback");
    let (code_verifier, code_challenge) = generate_pkce_pair();
    let expected_state = generate_oauth_state();

    let auth_url = format!(
        "{GOOGLE_AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256&state={}",
        urlencoding::encode(&cfg.client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(GOOGLE_OAUTH_SCOPES),
        urlencoding::encode(&code_challenge),
        urlencoding::encode(&expected_state),
    );

    open::that(&auth_url).map_err(|e| format!("Không thể mở trình duyệt đăng nhập Google: {e}"))?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let auth_code = loop {
        let accept_res = tokio::time::timeout_at(deadline, listener.accept())
            .await
            .map_err(|_| "Hết thời gian chờ xác nhận đăng nhập Google (180 giây).".to_string())?;
        let (mut socket, _) =
            accept_res.map_err(|e| format!("Lỗi nhận callback từ trình duyệt: {e}"))?;

        let mut buf = [0u8; 4096];
        let n = socket
            .read(&mut buf)
            .await
            .map_err(|e| format!("Lỗi đọc dữ liệu callback: {e}"))?;
        let raw_req = String::from_utf8_lossy(&buf[..n]);
        let first_line = raw_req.lines().next().unwrap_or("");
        let target = first_line.split_whitespace().nth(1).unwrap_or("");

        if !target.starts_with("/oauth2/callback") {
            let empty_resp = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(empty_resp).await;
            continue;
        }

        let (code_opt, state_opt, err_opt) = parse_callback_query(first_line)?;
        if let Some(err_str) = err_opt {
            let html = build_loopback_html_response(
                false,
                &format!("Bạn đã hủy hoặc Google từ chối cấp quyền ({err_str}). Có thể đóng tab này."),
            );
            let _ = socket.write_all(&html).await;
            return Err(format!("Đăng nhập Google bị từ chối: {err_str}"));
        }

        let Some(got_state) = state_opt else {
            let html = build_loopback_html_response(false, "Thiếu tham số bảo mật state.");
            let _ = socket.write_all(&html).await;
            return Err("Callback Google thiếu state".to_string());
        };

        if !constant_time_eq(got_state.as_bytes(), expected_state.as_bytes()) {
            let html = build_loopback_html_response(false, "Tham số bảo mật state không khớp.");
            let _ = socket.write_all(&html).await;
            return Err("State OAuth không khớp".to_string());
        }

        let Some(code) = code_opt.filter(|c| !c.trim().is_empty()) else {
            let html = build_loopback_html_response(false, "Không nhận được mã xác thực từ Google.");
            let _ = socket.write_all(&html).await;
            return Err("Callback Google thiếu authorization code".to_string());
        };

        let html = build_loopback_html_response(
            true,
            "DIARK OS đang đồng bộ lịch của bạn. Bạn có thể đóng tab trình duyệt này.",
        );
        let _ = socket.write_all(&html).await;
        break code;
    };

    let client = build_http_client()?;
    let mut form: Vec<(&str, &str)> = vec![
        ("code", auth_code.as_str()),
        ("client_id", cfg.client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", code_verifier.as_str()),
    ];
    if !cfg.client_secret.trim().is_empty() {
        form.push(("client_secret", cfg.client_secret.as_str()));
    }

    let token_resp = client
        .post(GOOGLE_TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Lỗi đổi token Google: {e}"))?;

    if !token_resp.status().is_success() {
        let status = token_resp.status().as_u16();
        let body = token_resp.text().await.unwrap_or_default();
        return Err(format!("Google trả về lỗi HTTP {status} khi cấp token: {body}"));
    }

    let parsed_token: GoogleTokenResponse = token_resp
        .json()
        .await
        .map_err(|e| format!("Không parse được token Google: {e}"))?;

    let email = match client
        .get(GOOGLE_USERINFO_ENDPOINT)
        .bearer_auth(&parsed_token.access_token)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp
            .json::<GoogleUserInfoResponse>()
            .await
            .map(|u| u.email)
            .unwrap_or_default(),
        _ => String::new(),
    };

    let expires_at = Utc::now().timestamp() + parsed_token.expires_in.unwrap_or(3600).max(60);

    Ok(OAuthTokenBundle {
        access_token: parsed_token.access_token,
        refresh_token: parsed_token.refresh_token,
        expires_at,
        email,
    })
}

pub async fn get_valid_access_token(db: &SharedDb) -> Result<String, String> {
    let (access_token, refresh_token, expires_at, email) = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        let raw_access = get_setting(&conn, SETTING_ACCESS_TOKEN)
            .ok()
            .flatten()
            .unwrap_or_default();
        let raw_refresh = get_setting(&conn, SETTING_REFRESH_TOKEN)
            .ok()
            .flatten()
            .unwrap_or_default();
        let exp: i64 = get_setting(&conn, SETTING_EXPIRES_AT)
            .ok()
            .flatten()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let mail = get_setting(&conn, SETTING_EMAIL)
            .ok()
            .flatten()
            .unwrap_or_default();
        (
            decrypt_secret(&raw_access).unwrap_or_default(),
            decrypt_secret(&raw_refresh).unwrap_or_default(),
            exp,
            mail,
        )
    };

    let now = Utc::now().timestamp();
    if !access_token.is_empty() && now + 60 < expires_at {
        return Ok(access_token);
    }

    if refresh_token.is_empty() {
        return Err("Phiên Google Calendar đã hết hạn. Vui lòng đăng nhập lại.".to_string());
    }

    let cfg = resolve_oauth_client_config(db).ok_or_else(|| {
        "Thiếu cấu hình OAuth Client Google để làm mới phiên đăng nhập.".to_string()
    })?;

    let client = build_http_client()?;
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", cfg.client_id.as_str()),
        ("refresh_token", refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    if !cfg.client_secret.trim().is_empty() {
        form.push(("client_secret", cfg.client_secret.as_str()));
    }

    let resp = client
        .post(GOOGLE_TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Lỗi làm mới token Google: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Không làm mới được phiên Google (HTTP {status}): {body}"));
    }

    let refreshed: GoogleTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Không đọc được token mới từ Google: {e}"))?;

    let new_bundle = OAuthTokenBundle {
        access_token: refreshed.access_token.clone(),
        refresh_token: refreshed.refresh_token.or(Some(refresh_token)),
        expires_at: Utc::now().timestamp() + refreshed.expires_in.unwrap_or(3600).max(60),
        email,
    };
    save_oauth_tokens(db, &new_bundle)?;

    Ok(refreshed.access_token)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCalendarListResponse {
    #[serde(default)]
    items: Vec<GoogleCalendarListItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleCalendarListItem {
    id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    background_color: Option<String>,
    #[serde(default)]
    access_role: String,
    #[serde(default)]
    primary: Option<bool>,
}

pub async fn fetch_remote_calendars(access_token: &str) -> Result<Vec<RemoteGoogleCalendar>, String> {
    let client = build_http_client()?;
    let url = format!("{GOOGLE_CALENDAR_API_BASE}/users/me/calendarList");
    let resp = client
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Lỗi tải danh sách lịch Google: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(format!("Google CalendarList trả về HTTP {status}"));
    }

    let parsed: GoogleCalendarListResponse = resp
        .json()
        .await
        .map_err(|e| format!("Lỗi đọc danh sách lịch Google: {e}"))?;

    Ok(parsed
        .items
        .into_iter()
        .filter(|item| !item.id.trim().is_empty())
        .map(|item| {
            let can_write = matches!(item.access_role.as_str(), "owner" | "writer");
            let name = if item.summary.trim().is_empty() {
                item.id.clone()
            } else {
                item.summary
            };
            RemoteGoogleCalendar {
                id: item.id,
                summary: name,
                color: item
                    .background_color
                    .filter(|c| !c.trim().is_empty())
                    .unwrap_or_else(|| "#38bdf8".to_string()),
                can_write,
                primary: item.primary.unwrap_or(false),
            }
        })
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventsListResponse {
    #[serde(default)]
    items: Vec<GoogleEventJson>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventJson {
    #[serde(default)]
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    start: Option<GoogleEventTimeJson>,
    #[serde(default)]
    end: Option<GoogleEventTimeJson>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventTimeJson {
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    date_time: Option<String>,
}

fn parse_google_event_time(time_obj: &GoogleEventTimeJson) -> Option<(i64, bool)> {
    if let Some(ref dt_str) = time_obj.date_time {
        if let Ok(dt) = DateTime::parse_from_rfc3339(dt_str.trim()) {
            return Some((dt.timestamp(), false));
        }
    }
    if let Some(ref d_str) = time_obj.date {
        let date = NaiveDate::parse_from_str(d_str.trim(), "%Y-%m-%d").ok()?;
        let dt = NaiveDateTime::new(date, NaiveTime::from_hms_opt(0, 0, 0)?);
        let offset = FixedOffset::east_opt(7 * 3600)?;
        let ts = offset
            .from_local_datetime(&dt)
            .single()
            .map(|d| d.timestamp())
            .unwrap_or_else(|| dt.and_utc().timestamp() - 7 * 3600);
        return Some((ts, true));
    }
    None
}

fn map_google_event_json(
    local_calendar_id: &str,
    ev: GoogleEventJson,
    now_ts: i64,
) -> Option<CalendarEventRecord> {
    if ev.status == "cancelled" || ev.id.trim().is_empty() {
        return None;
    }
    let start_obj = ev.start.as_ref()?;
    let (start_ts, all_day) = parse_google_event_time(start_obj)?;
    let end_ts = ev
        .end
        .as_ref()
        .and_then(parse_google_event_time)
        .map(|(ts, _)| ts)
        .unwrap_or_else(|| if all_day { start_ts + 86400 } else { start_ts + 3600 });

    let summary = ev
        .summary
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(Không tiêu đề)".to_string());

    Some(CalendarEventRecord {
        uid: ev.id,
        calendar_id: local_calendar_id.to_string(),
        summary,
        description: ev.description.unwrap_or_default().trim().to_string(),
        location: ev.location.unwrap_or_default().trim().to_string(),
        start_ts,
        end_ts: end_ts.max(start_ts),
        all_day,
        updated_at: now_ts,
    })
}

pub async fn fetch_remote_events(
    access_token: &str,
    local_calendar_id: &str,
    google_calendar_id: &str,
) -> Result<Vec<CalendarEventRecord>, String> {
    let client = build_http_client()?;
    let now = Utc::now();
    let time_min = (now - ChronoDuration::days(90)).to_rfc3339();
    let time_max = (now + ChronoDuration::days(365)).to_rfc3339();
    let encoded_cal = urlencoding::encode(google_calendar_id);
    let now_ts = now.timestamp();

    let mut events = Vec::new();
    let mut page_token: Option<String> = None;

    for _ in 0..5 {
        let mut url = format!(
            "{GOOGLE_CALENDAR_API_BASE}/calendars/{encoded_cal}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin={}&timeMax={}",
            urlencoding::encode(&time_min),
            urlencoding::encode(&time_max),
        );
        if let Some(ref pt) = page_token {
            url.push_str(&format!("&pageToken={}", urlencoding::encode(pt)));
        }

        let resp = client
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| format!("Lỗi tải sự kiện Google: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            return Err(format!("Google Events trả về HTTP {status}"));
        }

        let parsed: GoogleEventsListResponse = resp
            .json()
            .await
            .map_err(|e| format!("Lỗi đọc JSON sự kiện Google: {e}"))?;

        for item in parsed.items {
            if let Some(record) = map_google_event_json(local_calendar_id, item, now_ts) {
                events.push(record);
            }
        }

        match parsed.next_page_token {
            Some(pt) if !pt.is_empty() => page_token = Some(pt),
            _ => break,
        }
    }

    Ok(events)
}

fn build_vn_rfc3339(date_str: &str, hm_str: &str) -> Result<String, String> {
    let date = NaiveDate::parse_from_str(date_str.trim(), "%Y-%m-%d")
        .map_err(|_| "Ngày sự kiện không đúng định dạng YYYY-MM-DD".to_string())?;
    let time = NaiveTime::parse_from_str(hm_str.trim(), "%H:%M")
        .map_err(|_| "Giờ sự kiện không đúng định dạng HH:MM".to_string())?;
    let dt = NaiveDateTime::new(date, time);
    let offset = FixedOffset::east_opt(7 * 3600)
        .ok_or_else(|| "Không tạo được múi giờ +07:00".to_string())?;
    let local_dt = offset
        .from_local_datetime(&dt)
        .single()
        .ok_or_else(|| "Không quy đổi được thời gian địa phương".to_string())?;
    Ok(local_dt.to_rfc3339())
}

pub async fn create_remote_event(
    access_token: &str,
    local_calendar_id: &str,
    google_calendar_id: &str,
    input: &CreateGoogleEventInput,
) -> Result<CalendarEventRecord, String> {
    let summary = input.summary.trim();
    if summary.is_empty() {
        return Err("Tiêu đề sự kiện không được để trống".to_string());
    }

    let (start_val, end_val) = if input.all_day {
        let start_date = NaiveDate::parse_from_str(input.date.trim(), "%Y-%m-%d")
            .map_err(|_| "Ngày bắt đầu không hợp lệ".to_string())?;
        let inclusive_end = input
            .end_date
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .unwrap_or(start_date)
            .max(start_date);
        // RFC 5545 & Google Calendar API: ngày kết thúc của all-day là exclusive (+1 ngày)
        let exclusive_end = inclusive_end + ChronoDuration::days(1);
        (
            serde_json::json!({ "date": start_date.format("%Y-%m-%d").to_string() }),
            serde_json::json!({ "date": exclusive_end.format("%Y-%m-%d").to_string() }),
        )
    } else {
        let start_rfc = build_vn_rfc3339(&input.date, &input.start_time)?;
        let end_date_str = input
            .end_date
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&input.date);
        let end_hm = if input.end_time.trim().is_empty() {
            &input.start_time
        } else {
            &input.end_time
        };
        let end_rfc = build_vn_rfc3339(end_date_str, end_hm)?;
        (
            serde_json::json!({ "dateTime": start_rfc, "timeZone": "Asia/Ho_Chi_Minh" }),
            serde_json::json!({ "dateTime": end_rfc, "timeZone": "Asia/Ho_Chi_Minh" }),
        )
    };

    let payload = serde_json::json!({
        "summary": summary,
        "location": input.location.trim(),
        "description": input.description.trim(),
        "start": start_val,
        "end": end_val,
    });

    let client = build_http_client()?;
    let url = format!(
        "{GOOGLE_CALENDAR_API_BASE}/calendars/{}/events",
        urlencoding::encode(google_calendar_id)
    );
    let resp = client
        .post(url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Lỗi tạo sự kiện trên Google Calendar: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Google Calendar từ chối tạo sự kiện (HTTP {status}): {body}"));
    }

    let created: GoogleEventJson = resp
        .json()
        .await
        .map_err(|e| format!("Lỗi đọc phản hồi sự kiện từ Google: {e}"))?;

    let now_ts = Utc::now().timestamp();
    map_google_event_json(local_calendar_id, created, now_ts)
        .ok_or_else(|| "Google trả về sự kiện thiếu thời gian hợp lệ".to_string())
}

pub async fn delete_remote_event(
    access_token: &str,
    google_calendar_id: &str,
    event_uid: &str,
) -> Result<(), String> {
    let client = build_http_client()?;
    let url = format!(
        "{GOOGLE_CALENDAR_API_BASE}/calendars/{}/events/{}",
        urlencoding::encode(google_calendar_id),
        urlencoding::encode(event_uid),
    );
    let resp = client
        .delete(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Lỗi xóa sự kiện trên Google Calendar: {e}"))?;

    let status = resp.status().as_u16();
    if resp.status().is_success() || status == 404 || status == 410 {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    Err(format!("Không xóa được sự kiện trên Google (HTTP {status}): {body}"))
}

#[derive(Debug, Deserialize)]
struct CreatedGoogleCalendarJson {
    id: String,
    #[serde(default)]
    summary: String,
}

pub async fn ensure_uit_google_calendar(
    db: &SharedDb,
    access_token: &str,
) -> Result<(String, String), String> {
    let saved_id = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        get_setting(&conn, SETTING_UIT_CAL_ID)
            .ok()
            .flatten()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    let calendars = fetch_remote_calendars(access_token).await?;
    if let Some(ref id) = saved_id {
        if let Some(found) = calendars.iter().find(|c| &c.id == id && c.can_write) {
            return Ok((found.id.clone(), found.summary.clone()));
        }
    }

    if let Some(found) = calendars
        .iter()
        .find(|c| c.summary.trim() == UIT_GOOGLE_CALENDAR_NAME && c.can_write)
    {
        if let Ok(conn) = db.lock() {
            let _ = set_setting(&conn, SETTING_UIT_CAL_ID, &found.id);
        }
        return Ok((found.id.clone(), found.summary.clone()));
    }

    let client = build_http_client()?;
    let resp = client
        .post(format!("{GOOGLE_CALENDAR_API_BASE}/calendars"))
        .bearer_auth(access_token)
        .json(&serde_json::json!({
            "summary": UIT_GOOGLE_CALENDAR_NAME,
            "description": "Thời khóa biểu và Lịch thi UIT đồng bộ tự động từ DIARK OS",
            "timeZone": "Asia/Ho_Chi_Minh"
        }))
        .send()
        .await
        .map_err(|e| format!("Lỗi tạo lịch UIT trên Google Calendar: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Không tạo được lịch UIT trên Google (HTTP {status}): {body}"));
    }

    let created: CreatedGoogleCalendarJson = resp
        .json()
        .await
        .map_err(|e| format!("Lỗi đọc thông tin lịch UIT vừa tạo: {e}"))?;

    if let Ok(conn) = db.lock() {
        let _ = set_setting(&conn, SETTING_UIT_CAL_ID, &created.id);
    }
    let summary = if created.summary.trim().is_empty() {
        UIT_GOOGLE_CALENDAR_NAME.to_string()
    } else {
        created.summary
    };
    Ok((created.id, summary))
}

pub fn deterministic_google_event_id(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    format!("diark{}", &hex[..24])
}

async fn upsert_remote_event_with_id(
    client: &reqwest::Client,
    access_token: &str,
    google_calendar_id: &str,
    event_id: &str,
    body: &serde_json::Value,
) -> Result<(), String> {
    let encoded_cal = urlencoding::encode(google_calendar_id);
    let mut payload = body.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("id".to_string(), serde_json::Value::String(event_id.to_string()));
    }

    let post_url = format!("{GOOGLE_CALENDAR_API_BASE}/calendars/{encoded_cal}/events");
    let resp = client
        .post(&post_url)
        .bearer_auth(access_token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Lỗi gửi sự kiện lên Google: {e}"))?;

    if resp.status().is_success() {
        return Ok(());
    }

    if resp.status().as_u16() == 409 {
        let put_url = format!(
            "{GOOGLE_CALENDAR_API_BASE}/calendars/{encoded_cal}/events/{}",
            urlencoding::encode(event_id)
        );
        let put_resp = client
            .put(&put_url)
            .bearer_auth(access_token)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Lỗi cập nhật sự kiện trên Google: {e}"))?;
        if put_resp.status().is_success() {
            return Ok(());
        }
        let status = put_resp.status().as_u16();
        let err_body = put_resp.text().await.unwrap_or_default();
        return Err(format!("Cập nhật sự kiện thất bại (HTTP {status}): {err_body}"));
    }

    let status = resp.status().as_u16();
    let err_body = resp.text().await.unwrap_or_default();
    Err(format!("Google trả về HTTP {status}: {err_body}"))
}

pub async fn push_uit_schedule_to_google(
    db: &SharedDb,
    access_token: &str,
    timetable: &[PortalTimetableRecord],
    exams: &[AcademicExamRecord],
) -> Result<PushUitScheduleSummary, String> {
    let (cal_id, cal_name) = ensure_uit_google_calendar(db, access_token).await?;
    let client = build_http_client()?;

    let today_vn = (Utc::now() + ChronoDuration::hours(7)).date_naive();
    let min_date = today_vn - ChronoDuration::days(7);
    let max_date = today_vn + ChronoDuration::days(180);

    let mut pushed_classes = 0usize;
    let mut pushed_exams = 0usize;
    let mut errors = Vec::new();
    let mut total_sent = 0usize;
    const MAX_PUSH_BATCH: usize = 200;

    for t in timetable {
        if total_sent >= MAX_PUSH_BATCH {
            break;
        }
        let Ok(date) = NaiveDate::parse_from_str(t.ngay.trim(), "%Y-%m-%d") else {
            continue;
        };
        if date < min_date || date > max_date {
            continue;
        }
        let ((sh, sm), (eh, em)) = uit_period_time_bounds_public(t.tiet_bat_dau, t.tiet_ket_thuc);
        let date_iso = date.format("%Y-%m-%d").to_string();
        let start_hm = format!("{sh:02}:{sm:02}");
        let end_hm = format!("{eh:02}:{em:02}");
        let (Ok(start_rfc), Ok(end_rfc)) = (
            build_vn_rfc3339(&date_iso, &start_hm),
            build_vn_rfc3339(&date_iso, &end_hm),
        ) else {
            continue;
        };

        let event_id = deterministic_google_event_id(&format!("tkb:{}", t.id));
        let summary = format!("{} ({})", t.ten_mon_hoc, t.ma_lop);
        let desc = format!(
            "Hình thức: {} | Giảng viên: {} {} | Tiết {}-{}",
            t.hinh_thuc, t.lecturer_title, t.ten_giang_vien, t.tiet_bat_dau, t.tiet_ket_thuc
        );
        let body = serde_json::json!({
            "summary": summary,
            "location": t.phong.trim(),
            "description": desc.trim(),
            "start": { "dateTime": start_rfc, "timeZone": "Asia/Ho_Chi_Minh" },
            "end": { "dateTime": end_rfc, "timeZone": "Asia/Ho_Chi_Minh" }
        });

        total_sent += 1;
        match upsert_remote_event_with_id(&client, access_token, &cal_id, &event_id, &body).await {
            Ok(()) => pushed_classes += 1,
            Err(e) => {
                if errors.len() < 5 {
                    errors.push(format!("{}: {e}", t.ten_mon_hoc));
                }
            }
        }
    }

    for ex in exams {
        if total_sent >= MAX_PUSH_BATCH {
            break;
        }
        let date_opt = NaiveDate::parse_from_str(ex.date_str.trim(), "%d/%m/%Y")
            .or_else(|_| NaiveDate::parse_from_str(ex.date_str.trim(), "%Y-%m-%d"))
            .ok();
        let Some(date) = date_opt else {
            continue;
        };
        if date < min_date || date > max_date {
            continue;
        }

        let date_iso = date.format("%Y-%m-%d").to_string();
        let start_hm = if ex.start_time.trim().is_empty() {
            "07:30".to_string()
        } else {
            ex.start_time.trim().to_string()
        };
        let end_hm = if ex.end_time.trim().is_empty() {
            start_hm.clone()
        } else {
            ex.end_time.trim().to_string()
        };
        let (Ok(start_rfc), Ok(end_rfc)) = (
            build_vn_rfc3339(&date_iso, &start_hm),
            build_vn_rfc3339(&date_iso, &end_hm),
        ) else {
            continue;
        };

        let kind = if ex.examination == "midterm" {
            "Giữa kỳ"
        } else {
            "Cuối kỳ"
        };
        let event_id = deterministic_google_event_id(&format!(
            "exam:{}:{}:{}:{}",
            ex.subject_code, ex.examination, date_iso, ex.start_time
        ));
        let summary = format!("[THI {}] {} - {}", kind, ex.subject_code, ex.subject_name);
        let desc = format!(
            "Lớp: {} | Ca: {} | Hình thức: {} | Ghi chú: {}",
            ex.section_class_code, ex.shift, ex.format, ex.note
        );
        let body = serde_json::json!({
            "summary": summary,
            "location": ex.room.trim(),
            "description": desc.trim(),
            "start": { "dateTime": start_rfc, "timeZone": "Asia/Ho_Chi_Minh" },
            "end": { "dateTime": end_rfc, "timeZone": "Asia/Ho_Chi_Minh" }
        });

        total_sent += 1;
        match upsert_remote_event_with_id(&client, access_token, &cal_id, &event_id, &body).await {
            Ok(()) => pushed_exams += 1,
            Err(e) => {
                if errors.len() < 5 {
                    errors.push(format!("{}: {e}", ex.subject_code));
                }
            }
        }
    }

    Ok(PushUitScheduleSummary {
        calendar_id: cal_id,
        calendar_name: cal_name,
        pushed_classes,
        pushed_exams,
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pkce_pair_format_and_length() {
        let (verifier, challenge) = generate_pkce_pair();
        assert!(!verifier.contains('='));
        assert!(!challenge.contains('='));
        assert!(verifier.len() >= 43);
        assert_eq!(challenge.len(), 43);
        let digest = Sha256::digest(verifier.as_bytes());
        assert_eq!(challenge, encode_base64url(&digest));
    }

    #[test]
    fn test_parse_callback_query_extracts_params() {
        let req = "GET /oauth2/callback?state=abc_123&code=4%2F0AfJohX HTTP/1.1";
        let (code, state, err) = parse_callback_query(req).unwrap();
        assert_eq!(code.as_deref(), Some("4/0AfJohX"));
        assert_eq!(state.as_deref(), Some("abc_123"));
        assert!(err.is_none());

        let denied = "GET /oauth2/callback?error=access_denied&state=abc_123 HTTP/1.1";
        let (code2, _, err2) = parse_callback_query(denied).unwrap();
        assert!(code2.is_none());
        assert_eq!(err2.as_deref(), Some("access_denied"));
    }

    #[test]
    fn test_map_google_event_json_timed_and_all_day() {
        let timed_json = serde_json::json!({
            "id": "evt_1",
            "status": "confirmed",
            "summary": "Họp nhóm",
            "location": "Phòng B1.14",
            "start": { "dateTime": "2026-11-27T09:00:00+07:00" },
            "end": { "dateTime": "2026-11-27T10:30:00+07:00" }
        });
        let parsed: GoogleEventJson = serde_json::from_value(timed_json).unwrap();
        let rec = map_google_event_json("oauth:primary", parsed, 100).unwrap();
        assert_eq!(rec.uid, "evt_1");
        assert!(!rec.all_day);
        assert_eq!(rec.end_ts - rec.start_ts, 5400);

        let all_day_json = serde_json::json!({
            "id": "evt_2",
            "status": "confirmed",
            "summary": "Nghỉ lễ",
            "start": { "date": "2026-11-28" },
            "end": { "date": "2026-11-29" }
        });
        let parsed_ad: GoogleEventJson = serde_json::from_value(all_day_json).unwrap();
        let rec_ad = map_google_event_json("oauth:primary", parsed_ad, 100).unwrap();
        assert!(rec_ad.all_day);
        assert_eq!(rec_ad.end_ts - rec_ad.start_ts, 86400);
    }

    #[test]
    fn test_deterministic_google_event_id_valid_charset() {
        let id1 = deterministic_google_event_id("tkb:12345");
        let id2 = deterministic_google_event_id("tkb:12345");
        assert_eq!(id1, id2);
        assert!(id1.len() >= 10 && id1.len() <= 1024);
        assert!(id1.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == 'i' || c == 'r' || c == 'k'));
    }
}
