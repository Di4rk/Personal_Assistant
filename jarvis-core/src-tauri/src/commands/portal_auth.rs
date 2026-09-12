use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio_util::sync::CancellationToken;
use urlencoding::decode;
use crate::db::SharedDb;

pub struct WatchdogRegistry(pub StdMutex<HashMap<String, CancellationToken>>);

impl WatchdogRegistry {
    pub fn new() -> Self {
        Self(StdMutex::new(HashMap::new()))
    }

    pub fn register(&self, label: &str) -> CancellationToken {
        let token = CancellationToken::new();
        if let Ok(mut map) = self.0.lock() {
            map.insert(label.to_string(), token.clone());
        }
        token
    }

    pub fn cancel(&self, label: &str) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(token) = map.remove(label) {
                token.cancel();
            }
        }
    }
}

fn spawn_watchdog(app: AppHandle, window_label: String, token: CancellationToken) {
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => {
                if let Some(win) = app.get_webview_window(&window_label) {
                    let _ = win.destroy();
                }
                let _ = app.emit_to(
                    "main",
                    "portal-sync-failed",
                    "Quá thời gian đăng nhập (Timeout 120s)",
                );
            }
            _ = token.cancelled() => {
                // Task hủy ngay lập tức khi nhận callback sớm
            }
        }
    });
}

const UNIVERSAL_GUARDIAN_SCRIPT: &str = r#"
(() => {
  if (window.__DIARK_ACTIVE_GUARDIAN__) return;
  window.__DIARK_ACTIVE_GUARDIAN__ = true;

  const emitToRust = (target, payload) => {
    window.location.href = 'diark-sso://callback#target=' + target + '&data=' + encodeURIComponent(JSON.stringify(payload));
  };

  const emitError = (reason) => {
    window.location.href = 'diark-sso://failed#reason=' + reason;
  };

  const origFetch = window.fetch;
  let fetchOverrideActive = false;

  try {
    window.fetch = async function(...args) {
      const response = await origFetch.apply(this, args);
      try {
        const clone = response.clone();
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (url.includes('/api/sinh-vien/') || url.includes('/api/academic/')) {
          clone.json().then(data => {
            if (url.includes('ho-so')) emitToRust('portal_profile', data);
            if (url.includes('bang-diem')) emitToRust('portal_transcript', data);
          }).catch(() => {});
        }
      } catch (e) {}
      return response;
    };
    fetchOverrideActive = (window.fetch !== origFetch);
  } catch (e) {
    fetchOverrideActive = false;
  }

  let harvested = false;

  const inspectDOM = () => {
    if (harvested) return;

    // 1. Kịch bản Portal UIT: Bắt label "Mã sinh viên"
    if (window.location.hostname.includes('portal.uit.edu.vn')) {
      const nodes = Array.from(document.querySelectorAll('div, span, td, p'));
      const idLabel = nodes.find(n => n.textContent?.trim().startsWith('Mã sinh viên'));
      if (idLabel) {
        const valNode = idLabel.nextElementSibling || idLabel.parentElement?.querySelector('.font-medium, .font-semibold');
        const studentId = valNode?.textContent?.trim() || '';
        if (/^\d{8}$/.test(studentId)) {
          harvested = true;
          const getText = (lbl) => {
            const target = nodes.find(n => n.textContent?.trim().startsWith(lbl));
            return target?.nextElementSibling?.textContent?.trim() || target?.parentElement?.querySelector('.font-medium, .font-semibold')?.textContent?.trim() || '';
          };
          emitToRust('portal_profile', {
            student_id: studentId,
            full_name: getText('Họ và tên'),
            faculty: getText('Khoa'),
            major_code: getText('Ngành'),
            specialization: getText('Chuyên ngành'),
            student_class: getText('Lớp sinh hoạt'),
            curriculum_code: getText('CTĐT cụ thể'),
            cohort: getText('Khóa')
          });
        }
      }
    }

    // 2. Kịch bản Wecode UIT: Đã đăng nhập và vào trang Assignments
    if (window.location.href.includes('/wecode25/it00x/')) {
      const isLogin = window.location.href.includes('/login');
      const profileLink = document.querySelector('#profile_link, a[href*="logout"]');

      if (profileLink && isLogin) {
        window.location.href = 'https://khmt.uit.edu.vn/wecode25/it00x/assignments';
        return;
      }
      if (profileLink && !window.location.href.includes('/assignments') && !window.location.href.includes('/submissions')) {
        window.location.href = 'https://khmt.uit.edu.vn/wecode25/it00x/assignments';
        return;
      }

      const rows = Array.from(document.querySelectorAll('#DataTables_Table_0 tbody tr, table tbody tr'));
      if (rows.length > 0 && rows[0].querySelector('td:nth-child(2)')) {
        harvested = true;
        const assignments = rows.map(tr => {
          const idStr = tr.getAttribute('data-id') || tr.querySelector('td:nth-child(1)')?.textContent?.trim() || '0';
          const className = tr.querySelector('td:nth-child(2)')?.textContent?.trim() || '';
          const title = tr.querySelector('td:nth-child(3) a')?.textContent?.trim() || '';
          const statsText = tr.querySelector('td:nth-child(4)')?.textContent?.trim() || '';
          const startTime = tr.querySelector('td:nth-child(5)')?.textContent?.trim() || '';
          const finishTime = tr.querySelector('td:nth-child(6)')?.textContent?.trim() || '';

          let totalSubmits = 0, totalProblems = 0;
          const subMatch = statsText.match(/(\d+)\s*sub/i);
          if (subMatch) totalSubmits = parseInt(subMatch[1], 10);
          const probMatch = statsText.match(/(\d+)\s*prob/i);
          if (probMatch) totalProblems = parseInt(probMatch[1], 10);

          return {
            id: parseInt(idStr, 10),
            class_name: className,
            title: title,
            author: null,
            total_problems: totalProblems,
            total_submits: totalSubmits,
            status_text: statsText,
            start_time: startTime,
            finish_time: finishTime,
            is_finished: statsText.toLowerCase().includes('finished')
          };
        }).filter(a => a.id > 0);

        emitToRust('wecode_assignments', assignments);
      }
    }
  };

  const domSnoopInterval = fetchOverrideActive ? 300 : 150;
  setInterval(inspectDOM, domSnoopInterval);
})();
"#;

const STAGE_AWAITING_PROFILE: u8 = 0;
const STAGE_AWAITING_TRANSCRIPT: u8 = 1;
const STAGE_DONE: u8 = 2;

const PROFILE_PAGE_MARKER: &str = "portal.uit.edu.vn/sinh-vien/ho-so";
const TRANSCRIPT_PAGE_MARKER: &str = "portal.uit.edu.vn/sinh-vien/bang-diem";
const TRANSCRIPT_URL: &str = "https://portal.uit.edu.vn/sinh-vien/bang-diem";
const CALLBACK_SCHEME: &str = "diark-sso://callback";
const CALLBACK_FAIL_SCHEME: &str = "diark-sso://failed";

const WECODE_LOGIN_URL: &str = "https://khmt.uit.edu.vn/wecode25/it00x/login";
#[allow(dead_code)]
const WECODE_ASSIGNMENTS_URL: &str = "https://khmt.uit.edu.vn/wecode25/it00x/assignments";
const WECODE_LOGIN_MARKER: &str = "/wecode25/it00x/login";
const WECODE_ASSIGNMENTS_MARKER: &str = "/wecode25/it00x/assignments";
const MAX_LOGIN_REDIRECT_ATTEMPTS: u8 = 2;

#[derive(Deserialize, Debug)]
struct PortalIngestionPayload {
    profile: crate::commands::academic::StudentProfilePayload,
    transcript: serde_json::Value,
    drl: serde_json::Value,
}

const RESILIENT_PORTAL_HARVEST_SCRIPT: &str = r#"
(async () => {
  const TIMEOUT_MS = 8000;

  const findLabelNode = (label) => {
    const nodes = Array.from(document.querySelectorAll('div, span, td, p'));
    return nodes.find((n) => n.textContent?.trim().startsWith(label));
  };

  const getValueForLabel = (label) => {
    const target = findLabelNode(label);
    if (!target) return '';
    const valNode =
      target.nextElementSibling ||
      target.parentElement?.querySelector('.font-medium, .font-semibold');
    return valNode?.textContent?.trim() || '';
  };

  const buildPayload = () => ({
    student_id: getValueForLabel('Mã sinh viên'),
    full_name: getValueForLabel('Họ và tên'),
    faculty: getValueForLabel('Khoa'),
    major_code: getValueForLabel('Ngành'),
    specialization: getValueForLabel('Chuyên ngành'),
    student_class: getValueForLabel('Lớp sinh hoạt'),
    curriculum_code: getValueForLabel('CTĐT cụ thể'),
    cohort: getValueForLabel('Khóa'),
  });

  const sendResult = (payload) => {
    window.location.href =
      'diark-sso://callback#target=portal_profile&data=' +
      encodeURIComponent(JSON.stringify(payload));
  };

  const sendFailure = (reason) => {
    window.location.href = 'diark-sso://failed#reason=' + reason;
  };

  if (findLabelNode('Mã sinh viên')) {
    const payload = buildPayload();
    if (payload.student_id) {
      sendResult(payload);
      return;
    }
  }

  let settled = false;
  const observer = new MutationObserver(() => {
    if (settled) return;
    if (findLabelNode('Mã sinh viên')) {
      const payload = buildPayload();
      if (payload.student_id) {
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutHandle);
        sendResult(payload);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  const timeoutHandle = setTimeout(() => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    sendFailure('profile_dom_timeout');
  }, TIMEOUT_MS);
})();
"#;

const PORTAL_TRANSCRIPT_HARVEST_SCRIPT: &str = r#"
(async () => {
  try {
    let transcriptData = null;
    let drlData = null;

    try {
      const [tRes, dRes] = await Promise.all([
        fetch('/api/sinh-vien/bang-diem', { credentials: 'same-origin' }),
        fetch('/api/sinh-vien/diem-ren-luyen', { credentials: 'same-origin' })
      ]);
      if (tRes.ok) transcriptData = await tRes.json();
      if (dRes.ok) drlData = await dRes.json();
    } catch (_) {}

    if (!transcriptData) {
      const semesterGroups = [];
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const title = table.closest('div')?.querySelector('h3, h4, .font-bold')?.textContent?.trim() || 'Học kỳ';
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        const courses = [];
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
          if (cells.length >= 5) {
            courses.push({
              course_code: cells[1] || cells[0],
              course_name: cells[2] || cells[1],
              credits: parseInt(cells[3] || '0', 10) || 0,
              total_score: parseFloat(cells[4] || '0') || null,
            });
          }
        }
        if (courses.length > 0) {
          semesterGroups.push({ semester_name: title, courses });
        }
      }
      transcriptData = { semester_groups: semesterGroups };
    }

    const payload = {
      transcript: transcriptData || { semester_groups: [] },
      drl: drlData || { drl: [] }
    };

    window.location.href = 'diark-sso://callback#target=portal_transcript&data=' + encodeURIComponent(JSON.stringify(payload));
  } catch (err) {
    window.location.href = 'diark-sso://failed#reason=transcript_dom_parse_error';
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

const WECODE_ASSIGNMENTS_HARVEST_SCRIPT: &str = r#"
(() => {
  try {
    const rows = Array.from(document.querySelectorAll('#DataTables_Table_0 tbody tr, table tbody tr'));
    const assignments = rows.map(tr => {
      const idStr = tr.getAttribute('data-id') || tr.querySelector('td:nth-child(1)')?.textContent?.trim() || '0';
      const className = tr.querySelector('td:nth-child(2)')?.textContent?.trim() || '';
      const titleEl = tr.querySelector('td:nth-child(3) a');
      const title = titleEl?.textContent?.trim() || '';
      const statsText = tr.querySelector('td:nth-child(4)')?.textContent?.trim() || '';
      const startTime = tr.querySelector('td:nth-child(5)')?.textContent?.trim() || '';
      const finishTime = tr.querySelector('td:nth-child(6)')?.textContent?.trim() || '';

      let totalSubmits = 0;
      let totalProblems = 0;
      const subMatch = statsText.match(/(\d+)\s*sub/i);
      if (subMatch) totalSubmits = parseInt(subMatch[1], 10);
      const probMatch = statsText.match(/(\d+)\s*prob/i);
      if (probMatch) totalProblems = parseInt(probMatch[1], 10);

      const isFinished = statsText.toLowerCase().includes('finished');

      return {
        id: parseInt(idStr, 10),
        class_name: className,
        title: title,
        author: null,
        total_problems: totalProblems,
        total_submits: totalSubmits,
        status_text: statsText,
        start_time: startTime,
        finish_time: finishTime,
        is_finished: isFinished
      };
    }).filter(a => a.id > 0);

    window.location.href = 'diark-sso://callback#target=wecode_assignments&data=' + encodeURIComponent(JSON.stringify(assignments));
  } catch (err) {
    window.location.href = 'diark-sso://failed#reason=wecode_assignments_parse_error';
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

    let token = if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.register("uit-sso-login")
    } else {
        CancellationToken::new()
    };
    spawn_watchdog(app.clone(), "uit-sso-login".to_string(), token);

    let stage = Arc::new(AtomicU8::new(STAGE_AWAITING_PROFILE));
    let stage_for_nav = stage.clone();
    let app_for_nav = app.clone();

    let window = WebviewWindowBuilder::new(&app, "uit-sso-login", auth_url)
        .title("Đăng nhập Cổng Thông Tin UIT")
        .inner_size(860.0, 720.0)
        .resizable(true)
        .always_on_top(true)
        .initialization_script(UNIVERSAL_GUARDIAN_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            if url_str.starts_with(CALLBACK_SCHEME) {
                if let Some(watchdog) = app_for_nav.try_state::<WatchdogRegistry>() {
                    watchdog.cancel("uit-sso-login");
                }
                if let Some(fragment) = url.fragment() {
                    if let Ok(decoded) = decode(fragment) {
                        let payload_str = decoded.into_owned();

                        if payload_str.starts_with("target=portal_profile&data=") {
                            let encoded_or_json = &payload_str["target=portal_profile&data=".len()..];
                            let json_str = if encoded_or_json.starts_with('%') {
                                decode(encoded_or_json).unwrap_or(std::borrow::Cow::Borrowed(encoded_or_json)).into_owned()
                            } else {
                                encoded_or_json.to_string()
                            };

                            if let Ok(profile) = serde_json::from_str::<crate::commands::academic::StudentProfilePayload>(&json_str) {
                                let state = app_for_nav.state::<SharedDb>();
                                let _ = crate::commands::academic::save_student_profile_internal(&app_for_nav, &state, profile);
                                let _ = app_for_nav.emit_to("main", "portal-profile-synced", ());
                            }

                            // Chuyển sang stage 1 và điều hướng sang trang bảng điểm
                            stage_for_nav.store(STAGE_AWAITING_TRANSCRIPT, Ordering::SeqCst);
                            if let Some(win) = app_for_nav.get_webview_window("uit-sso-login") {
                                if let Ok(t_url) = TRANSCRIPT_URL.parse() {
                                    let _ = win.navigate(t_url);
                                }
                            }
                            return false;
                        }

                        if payload_str.starts_with("target=portal_transcript&data=") {
                            let encoded_or_json = &payload_str["target=portal_transcript&data=".len()..];
                            let json_str = if encoded_or_json.starts_with('%') {
                                decode(encoded_or_json).unwrap_or(std::borrow::Cow::Borrowed(encoded_or_json)).into_owned()
                            } else {
                                encoded_or_json.to_string()
                            };

                            #[derive(serde::Deserialize)]
                            struct TranscriptData {
                                transcript: serde_json::Value,
                                drl: serde_json::Value,
                            }
                            if let Ok(data) = serde_json::from_str::<TranscriptData>(&json_str) {
                                let state = app_for_nav.state::<SharedDb>();
                                let _ = crate::commands::academic::ingest_full_academic_payload_internal(
                                    &app_for_nav,
                                    &state,
                                    data.transcript,
                                    data.drl,
                                );
                                let _ = app_for_nav.emit_to("main", "academic-data-synced", ());
                            }

                            stage_for_nav.store(STAGE_DONE, Ordering::SeqCst);
                            close_sso_window(&app_for_nav);
                            return false;
                        }

                        handle_sync_payload(&app_for_nav, payload_str);
                    }
                }
                close_sso_window(&app_for_nav);
                return false;
            }

            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                if let Some(watchdog) = app_for_nav.try_state::<WatchdogRegistry>() {
                    watchdog.cancel("uit-sso-login");
                }
                let reason = url.fragment().unwrap_or("unknown").to_string();
                let _ = app_for_nav.emit_to("main", "portal-sync-failed", reason);
                close_sso_window(&app_for_nav);
                return false;
            }

            let current_stage = stage_for_nav.load(Ordering::SeqCst);
            if current_stage == STAGE_AWAITING_PROFILE && url_str.contains(PROFILE_PAGE_MARKER) {
                if let Some(win) = app_for_nav.get_webview_window("uit-sso-login") {
                    let _ = win.eval(RESILIENT_PORTAL_HARVEST_SCRIPT);
                }
            } else if current_stage == STAGE_AWAITING_TRANSCRIPT && url_str.contains(TRANSCRIPT_PAGE_MARKER) {
                if let Some(win) = app_for_nav.get_webview_window("uit-sso-login") {
                    let _ = win.eval(PORTAL_TRANSCRIPT_HARVEST_SCRIPT);
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
        WECODE_LOGIN_URL
            .parse()
            .map_err(|e| format!("Invalid Wecode URL: {e}"))?,
    );

    let token = if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.register("wecode-sso-login")
    } else {
        CancellationToken::new()
    };
    spawn_watchdog(app.clone(), "wecode-sso-login".to_string(), token);

    let redirect_attempts = Arc::new(AtomicU8::new(0));
    let already_navigated_to_assignments = Arc::new(AtomicBool::new(false));

    let redirect_attempts_for_nav = redirect_attempts.clone();
    let already_nav_for_nav = already_navigated_to_assignments.clone();
    let app_for_nav = app.clone();

    let window = WebviewWindowBuilder::new(&app, "wecode-sso-login", auth_url)
        .title("Đồng bộ Wecode Submissions")
        .inner_size(900.0, 750.0)
        .resizable(true)
        .always_on_top(true)
        .initialization_script(UNIVERSAL_GUARDIAN_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            if url_str.starts_with(CALLBACK_SCHEME) {
                if let Some(watchdog) = app_for_nav.try_state::<WatchdogRegistry>() {
                    watchdog.cancel("wecode-sso-login");
                }
                if let Some(fragment) = url.fragment() {
                    if let Ok(decoded) = decode(fragment) {
                        handle_sync_payload(&app_for_nav, decoded.into_owned());
                    }
                }
                close_wecode_window(&app_for_nav);
                return false;
            }

            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                if let Some(watchdog) = app_for_nav.try_state::<WatchdogRegistry>() {
                    watchdog.cancel("wecode-sso-login");
                }
                let reason = url.fragment().unwrap_or("unknown").to_string();
                let _ = app_for_nav.emit_to("main", "wecode-sync-failed", reason);
                close_wecode_window(&app_for_nav);
                return false;
            }

            // Redirect-loop guard for login page
            if url_str.contains(WECODE_LOGIN_MARKER) {
                let attempts = redirect_attempts_for_nav.fetch_add(1, Ordering::SeqCst);
                if attempts >= MAX_LOGIN_REDIRECT_ATTEMPTS {
                    if let Some(watchdog) = app_for_nav.try_state::<WatchdogRegistry>() {
                        watchdog.cancel("wecode-sso-login");
                    }
                    let _ = app_for_nav.emit_to(
                        "main",
                        "wecode-sync-failed",
                        "Quá số lần chuyển hướng đăng nhập (phát hiện vòng lặp)".to_string(),
                    );
                    close_wecode_window(&app_for_nav);
                    return false;
                }
            }

            // On assignments page: trigger harvest
            if url_str.contains(WECODE_ASSIGNMENTS_MARKER) {
                if !already_nav_for_nav.swap(true, Ordering::SeqCst) {
                    if let Some(win) = app_for_nav.get_webview_window("wecode-sso-login") {
                        let _ = win.eval(WECODE_ASSIGNMENTS_HARVEST_SCRIPT);
                    }
                }
            }

            // Support submissions page harvest
            if url_str.contains("submissions") {
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
    if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.cancel("uit-sso-login");
    }
    if let Some(window) = app.get_webview_window("uit-sso-login") {
        let _ = window.destroy();
    }
}

fn close_wecode_window(app: &AppHandle) {
    if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.cancel("wecode-sso-login");
    }
    if let Some(window) = app.get_webview_window("wecode-sso-login") {
        let _ = window.destroy();
    }
}

fn handle_sync_payload(app: &AppHandle, raw_payload: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // 1. Wecode submissions
        if raw_payload.starts_with("target=wecode_submissions&data=") {
            let encoded_or_json = &raw_payload["target=wecode_submissions&data=".len()..];
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

        // 2. Wecode assignments
        if raw_payload.starts_with("target=wecode_assignments&data=") {
            let encoded_or_json = &raw_payload["target=wecode_assignments&data=".len()..];
            let json_str = if encoded_or_json.starts_with('%') {
                decode(encoded_or_json).unwrap_or(std::borrow::Cow::Borrowed(encoded_or_json)).into_owned()
            } else {
                encoded_or_json.to_string()
            };

            #[derive(serde::Deserialize, Debug)]
            struct AssignmentItem {
                id: i64,
                title: String,
            }

            let assignments: Vec<AssignmentItem> = match serde_json::from_str(&json_str) {
                Ok(a) => a,
                Err(e) => {
                    let _ = app.emit_to("main", "wecode-sync-failed", format!("parse_error: {e}"));
                    return;
                }
            };

            let state = app.state::<SharedDb>();
            if let Ok(conn) = state.lock() {
                for a in &assignments {
                    let _ = conn.execute(
                        "INSERT INTO wecode_assignments (id, name) VALUES (?1, ?2)
                         ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                        rusqlite::params![a.id, a.title],
                    );
                }
            }

            let _ = app.emit_to("main", "wecode-assignments-synced", ());
            return;
        }

        // 3. Portal Profile only
        if raw_payload.starts_with("target=portal_profile&data=") {
            let encoded_or_json = &raw_payload["target=portal_profile&data=".len()..];
            let json_str = if encoded_or_json.starts_with('%') {
                decode(encoded_or_json).unwrap_or(std::borrow::Cow::Borrowed(encoded_or_json)).into_owned()
            } else {
                encoded_or_json.to_string()
            };

            let profile: crate::commands::academic::StudentProfilePayload = match serde_json::from_str(&json_str) {
                Ok(p) => p,
                Err(e) => {
                    let _ = app.emit_to("main", "portal-sync-failed", format!("parse_error: {e}"));
                    return;
                }
            };

            let state = app.state::<SharedDb>();
            if let Err(e) = crate::commands::academic::save_student_profile_internal(&app, &state, profile) {
                let _ = app.emit_to("main", "portal-sync-failed", e);
                return;
            }

            let _ = app.emit_to("main", "portal-profile-synced", ());
            return;
        }

        // 4. Portal Transcript only
        if raw_payload.starts_with("target=portal_transcript&data=") {
            let encoded_or_json = &raw_payload["target=portal_transcript&data=".len()..];
            let json_str = if encoded_or_json.starts_with('%') {
                decode(encoded_or_json).unwrap_or(std::borrow::Cow::Borrowed(encoded_or_json)).into_owned()
            } else {
                encoded_or_json.to_string()
            };

            #[derive(serde::Deserialize)]
            struct TranscriptPayload {
                transcript: serde_json::Value,
                drl: serde_json::Value,
            }

            let data: TranscriptPayload = match serde_json::from_str(&json_str) {
                Ok(d) => d,
                Err(e) => {
                    let _ = app.emit_to("main", "portal-sync-failed", format!("parse_error: {e}"));
                    return;
                }
            };

            let state = app.state::<SharedDb>();
            if let Err(e) = crate::commands::academic::ingest_full_academic_payload_internal(
                &app,
                &state,
                data.transcript,
                data.drl,
            ) {
                let _ = app.emit_to("main", "portal-sync-failed", e);
                return;
            }

            let _ = app.emit_to("main", "academic-data-synced", ());
            return;
        }

        // 5. Combined payload fallback
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
    fn test_portal_profile_callback_decoding() {
        let profile_raw = json!({
            "student_id": "23520123",
            "full_name": "Lê Văn C",
            "faculty": "Khoa Khoa học máy tính",
            "major_code": "7480101",
            "specialization": "Khoa học máy tính",
            "student_class": "KHMT2023.1",
            "curriculum_code": "CQ2023",
            "cohort": "2023"
        });

        let json_str = serde_json::to_string(&profile_raw).unwrap();
        let encoded_data = urlencoding::encode(&json_str);
        let fragment = format!("target=portal_profile&data={encoded_data}");
        let callback_url = format!("diark-sso://callback#{fragment}");

        assert!(callback_url.starts_with(CALLBACK_SCHEME));
        let extracted_fragment = callback_url.split('#').nth(1).unwrap();
        let decoded = decode(extracted_fragment).unwrap();
        assert!(decoded.starts_with("target=portal_profile&data="));

        let data_part = &decoded["target=portal_profile&data=".len()..];
        let p: Result<crate::commands::academic::StudentProfilePayload, _> = serde_json::from_str(data_part);
        assert!(p.is_ok());
        assert_eq!(p.unwrap().student_id, "23520123");
    }

    #[test]
    fn test_portal_transcript_callback_decoding() {
        let transcript_raw = json!({
            "transcript": {
                "semester_groups": [
                    {
                        "semester_name": "Học kỳ 1 Năm học 2023-2024",
                        "courses": [
                            {
                                "course_code": "IT001",
                                "course_name": "Nhập môn lập trình",
                                "credits": 4,
                                "total_score": 9.5
                            }
                        ]
                    }
                ]
            },
            "drl": {
                "drl": []
            }
        });

        let json_str = serde_json::to_string(&transcript_raw).unwrap();
        let encoded_data = urlencoding::encode(&json_str);
        let fragment = format!("target=portal_transcript&data={encoded_data}");
        let callback_url = format!("diark-sso://callback#{fragment}");

        assert!(callback_url.starts_with(CALLBACK_SCHEME));
        let extracted_fragment = callback_url.split('#').nth(1).unwrap();
        let decoded = decode(extracted_fragment).unwrap();
        assert!(decoded.starts_with("target=portal_transcript&data="));
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

    #[test]
    fn test_wecode_assignments_callback_decoding() {
        let raw_assignments = json!([
            {
                "id": 101,
                "class_name": "IT001.N11",
                "title": "Thực hành tuần 1 - Cấu trúc dữ liệu",
                "author": null,
                "total_problems": 5,
                "total_submits": 12,
                "status_text": "Finished - 5/5 prob",
                "start_time": "2026-09-01 08:00:00",
                "finish_time": "2026-09-07 23:59:59",
                "is_finished": true
            }
        ]);
        let json_str = serde_json::to_string(&raw_assignments).unwrap();
        let encoded_data = urlencoding::encode(&json_str);
        let fragment = format!("target=wecode_assignments&data={encoded_data}");
        let callback_url = format!("diark-sso://callback#{fragment}");

        assert!(callback_url.starts_with(CALLBACK_SCHEME));
        let extracted_fragment = callback_url.split('#').nth(1).unwrap();
        let decoded = decode(extracted_fragment).unwrap();
        assert!(decoded.starts_with("target=wecode_assignments&data="));
    }

    #[test]
    fn test_watchdog_registry_cancel() {
        let registry = WatchdogRegistry::new();
        let token = registry.register("test-window");
        assert!(!token.is_cancelled());
        registry.cancel("test-window");
        assert!(token.is_cancelled());
    }

    #[test]
    fn test_watchdog_registry_cancel_nonexistent() {
        let registry = WatchdogRegistry::new();
        registry.cancel("nonexistent-window");
    }
}
