use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Emitter};
use urlencoding::decode;
use crate::db::SharedDb;

const PROFILE_PAGE_MARKER: &str = "portal.uit.edu.vn/sinh-vien/ho-so";
const CALLBACK_SCHEME: &str = "diark-sso://callback";
const CALLBACK_FAIL_SCHEME: &str = "diark-sso://failed";

#[derive(Deserialize, Debug)]
struct PortalIngestionPayload {
    profile: crate::commands::academic::StudentProfilePayload,
    transcript: serde_json::Value,
    drl: serde_json::Value,
}

const HARVEST_SCRIPT: &str = r#"
(async () => {
  try {
    const [profileRes, transcriptRes, drlRes] = await Promise.all([
      fetch('/api/sinh-vien/ho-so', { credentials: 'same-origin' }),
      fetch('/api/sinh-vien/bang-diem', { credentials: 'same-origin' }),
      fetch('/api/sinh-vien/diem-ren-luyen', { credentials: 'same-origin' }),
    ]);

    if (profileRes.status === 401 || transcriptRes.status === 401 || drlRes.status === 401) {
      window.location.href = 'diark-sso://failed#reason=session_expired';
      return;
    }
    if (!profileRes.ok || !transcriptRes.ok || !drlRes.ok) {
      window.location.href = 'diark-sso://failed#reason=api_error';
      return;
    }

    const payload = {
      profile: await profileRes.json(),
      transcript: await transcriptRes.json(),
      drl: await drlRes.json(),
    };

    window.location.href = 'diark-sso://callback#' + encodeURIComponent(JSON.stringify(payload));
  } catch (e) {
    window.location.href = 'diark-sso://failed#reason=network_error';
  }
})();
"#;

#[tauri::command]
pub async fn launch_portal_sso_sync(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("uit-sso-login") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let auth_url = WebviewUrl::External(
        "https://portal.uit.edu.vn/sinh-vien/ho-so"
            .parse()
            .map_err(|e| format!("Invalid auth URL: {e}"))?,
    );

    let app_for_nav = app.clone();

    let window = WebviewWindowBuilder::new(&app, "uit-sso-login", auth_url)
        .title("Đăng nhập Cổng Thông Tin UIT")
        .inner_size(860.0, 720.0)
        .resizable(true)
        .always_on_top(true)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            if url_str.starts_with(CALLBACK_SCHEME) {
                if let Some(fragment) = url.fragment() {
                    if let Ok(decoded) = decode(fragment) {
                        handle_sync_payload(&app_for_nav, decoded.into_owned());
                    }
                }
                close_sso_window(&app_for_nav);
                return false;
            }

            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                let reason = url.fragment().unwrap_or("unknown").to_string();
                let _ = app_for_nav.emit_to("main", "portal-sync-failed", reason);
                close_sso_window(&app_for_nav);
                return false;
            }

            if url_str.contains(PROFILE_PAGE_MARKER) {
                if let Some(win) = app_for_nav.get_webview_window("uit-sso-login") {
                    let _ = win.eval(HARVEST_SCRIPT);
                }
            }

            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.show();
    Ok(())
}

fn close_sso_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("uit-sso-login") {
        let _ = window.destroy();
    }
}

fn handle_sync_payload(app: &AppHandle, raw_json: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let payload: PortalIngestionPayload = match serde_json::from_str(&raw_json) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit_to("main", "portal-sync-failed", format!("parse_error: {e}"));
                return;
            }
        };

        let state = app.state::<SharedDb>();

        if let Err(e) = crate::commands::academic::save_student_profile_internal(
            &app,
            &state,
            payload.profile,
        ) {
            let _ = app.emit_to("main", "portal-sync-failed", e);
            return;
        }

        if let Err(e) = crate::commands::academic::ingest_full_academic_payload_internal(
            &app,
            &state,
            payload.transcript,
            payload.drl,
        ) {
            let _ = app.emit_to("main", "portal-sync-failed", e);
            return;
        }

        let _ = app.emit_to("main", "academic-data-synced", ());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_portal_ingestion_payload_deserialization() {
        let raw = json!({
            "profile": {
                "student_id": "21520000",
                "full_name": "Nguyễn Văn A",
                "faculty": "Khoa Khoa học máy tính",
                "major_code": "7480101",
                "specialization": "Khoa học máy tính",
                "student_class": "KHMT2021.1",
                "curriculum_code": "CQ2021",
                "cohort": "2021"
            },
            "transcript": {
                "semester_groups": []
            },
            "drl": {
                "drl": []
            }
        });

        let json_str = serde_json::to_string(&raw).unwrap();
        let payload: Result<PortalIngestionPayload, _> = serde_json::from_str(&json_str);
        assert!(payload.is_ok());
        let p = payload.unwrap();
        assert_eq!(p.profile.student_id, "21520000");
        assert_eq!(p.profile.full_name, "Nguyễn Văn A");
    }

    #[test]
    fn test_url_fragment_decoding() {
        let raw = json!({
            "profile": {
                "student_id": "22521111",
                "full_name": "Trần Thị B",
                "faculty": "Khoa Kỹ thuật Phần mềm",
                "major_code": "7480103",
                "specialization": "Kỹ thuật phần mềm",
                "student_class": "KTPM2022.1",
                "curriculum_code": "CQ2022",
                "cohort": "2022"
            },
            "transcript": [],
            "drl": {}
        });
        let json_str = serde_json::to_string(&raw).unwrap();
        let encoded = urlencoding::encode(&json_str);
        let callback_url = format!("diark-sso://callback#{encoded}");

        assert!(callback_url.starts_with(CALLBACK_SCHEME));
        let fragment = callback_url.split('#').nth(1).unwrap();
        let decoded = decode(fragment).unwrap();
        let payload: Result<PortalIngestionPayload, _> = serde_json::from_str(&decoded);
        assert!(payload.is_ok());
        assert_eq!(payload.unwrap().profile.student_id, "22521111");
    }

    #[test]
    fn test_failed_callback_scheme_detection() {
        let fail_url = "diark-sso://failed#reason=session_expired";
        assert!(fail_url.starts_with(CALLBACK_FAIL_SCHEME));
        let reason = fail_url.split('#').nth(1).unwrap();
        assert_eq!(reason, "reason=session_expired");
    }
}

