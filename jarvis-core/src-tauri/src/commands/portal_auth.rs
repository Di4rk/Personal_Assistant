use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Emitter};
use urlencoding::decode;
use crate::db::SharedDb;

const PROFILE_PAGE_MARKER: &str = "portal.uit.edu.vn/sinh-vien/ho-so";
const WECODE_PAGE_MARKER: &str = "wecode.uit.edu.vn/submissions";
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

const WECODE_SUBMISSION_HARVEST_SCRIPT: &str = r#"
(() => {
  try {
    const rows = Array.from(document.querySelectorAll('table tbody tr[data-id]'));
    const submissions = rows.map(tr => {
      const subId = parseInt(tr.getAttribute('data-id') || '0', 10);
      const assignId = parseInt(tr.getAttribute('data-a') || '0', 10);
      const probId = parseInt(tr.getAttribute('data-p') || '0', 10);

      const isFinal = tr.querySelector('.set_final')?.classList.contains('bi-check-circle') || false;
      const problemName = tr.querySelector('td:nth-child(3) a')?.textContent?.trim() || '';
      const timeText = tr.querySelector('td:nth-child(4) .small')?.textContent?.trim() || '';
      const verdict = tr.querySelector('td.js-verdict div')?.textContent?.trim() || '';
      const execTime = parseFloat(tr.querySelector('td.js-time')?.textContent?.trim() || '0');
      const memKib = parseInt(tr.querySelector('td.js-mem')?.textContent?.trim() || '0', 10);
      const score = parseInt(tr.querySelector('td.js-score span')?.textContent?.trim() || '0', 10);
      const lang = tr.querySelector('td div[data-type="code"]')?.textContent?.trim() || 'C++';

      return {
        submission_id: subId,
        assignment_id: assignId,
        problem_id: probId,
        problem_name: problemName,
        submit_time_str: timeText,
        verdict: verdict,
        score: score,
        execution_time: execTime,
        memory_kib: memKib,
        language: lang,
        is_final: isFinal
      };
    });

    window.location.href = 'diark-sso://callback#target=wecode_submissions&data=' + encodeURIComponent(JSON.stringify(submissions));
  } catch (err) {
    window.location.href = 'diark-sso://failed#reason=wecode_sub_parse_error';
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

            if url_str.contains(WECODE_PAGE_MARKER) {
                if let Some(win) = app_for_nav.get_webview_window("uit-sso-login") {
                    let _ = win.eval(WECODE_SUBMISSION_HARVEST_SCRIPT);
                }
            }

            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.show();
    Ok(())
}

#[tauri::command]
pub async fn launch_wecode_sso_sync(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("wecode-sso-login") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let auth_url = WebviewUrl::External(
        "https://wecode.uit.edu.vn/submissions"
            .parse()
            .map_err(|e| format!("Invalid Wecode URL: {e}"))?,
    );

    let app_for_nav = app.clone();

    let window = WebviewWindowBuilder::new(&app, "wecode-sso-login", auth_url)
        .title("Đồng bộ Wecode Submissions")
        .inner_size(900.0, 750.0)
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
                close_wecode_window(&app_for_nav);
                return false;
            }

            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                let reason = url.fragment().unwrap_or("unknown").to_string();
                let _ = app_for_nav.emit_to("main", "wecode-sync-failed", reason);
                close_wecode_window(&app_for_nav);
                return false;
            }

            if url_str.contains(WECODE_PAGE_MARKER) {
                if let Some(win) = app_for_nav.get_webview_window("wecode-sso-login") {
                    let _ = win.eval(WECODE_SUBMISSION_HARVEST_SCRIPT);
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

fn close_wecode_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("wecode-sso-login") {
        let _ = window.destroy();
    }
}

fn handle_sync_payload(app: &AppHandle, raw_payload: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Check if payload is from wecode submissions
        if raw_payload.starts_with("target=wecode_submissions&data=") {
            let encoded_or_json = &raw_payload["target=wecode_submissions&data=".len()..];
            // Decode in case it is still URL-encoded, or parse directly if decoded
            let json_str = if encoded_or_json.starts_with('%') {
                decode(encoded_or_json).unwrap_or(std::borrow::Cow::Borrowed(encoded_or_json)).into_owned()
            } else {
                encoded_or_json.to_string()
            };

            let submissions: Vec<crate::commands::wecode::WecodeSubmissionDto> = match serde_json::from_str(&json_str) {
                Ok(s) => s,
                Err(e) => {
                    let _ = app.emit_to("main", "wecode-sync-failed", format!("parse_error: {e}"));
                    return;
                }
            };

            let state = app.state::<crate::AppState>();
            if let Err(e) = crate::commands::wecode::ingest_wecode_submissions_internal(&app, &state, submissions) {
                let _ = app.emit_to("main", "wecode-sync-failed", e);
            }
            return;
        }

        let payload: PortalIngestionPayload = match serde_json::from_str(&raw_payload) {
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

    #[test]
    fn test_wecode_callback_url_decoding() {
        let raw_submissions = json!([
            {
                "submission_id": 999123,
                "assignment_id": 42,
                "problem_id": 105,
                "problem_name": "Two Sum Fast",
                "submit_time_str": "Fri, 17 Jul 2026 01:50:46",
                "verdict": "CORRECT ANSWER",
                "score": 100,
                "execution_time": 0.05,
                "memory_kib": 1024,
                "language": "C++",
                "is_final": true
            }
        ]);
        let json_str = serde_json::to_string(&raw_submissions).unwrap();
        let encoded_data = urlencoding::encode(&json_str);
        let fragment = format!("target=wecode_submissions&data={encoded_data}");
        let callback_url = format!("diark-sso://callback#{fragment}");

        assert!(callback_url.starts_with(CALLBACK_SCHEME));
        let extracted_fragment = callback_url.split('#').nth(1).unwrap();
        let decoded = decode(extracted_fragment).unwrap();
        assert!(decoded.starts_with("target=wecode_submissions&data="));

        let data_part = &decoded["target=wecode_submissions&data=".len()..];
        let subs: Result<Vec<crate::commands::wecode::WecodeSubmissionDto>, _> = serde_json::from_str(data_part);
        assert!(subs.is_ok());
        let list = subs.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].submission_id, 999123);
        assert_eq!(list[0].score, 100);
    }
}

