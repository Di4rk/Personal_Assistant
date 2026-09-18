use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio_util::sync::CancellationToken;
use urlencoding::decode;
use crate::db::SharedDb;

#[derive(Clone)]
pub struct WatchdogRegistry(pub Arc<StdMutex<HashMap<String, CancellationToken>>>);

impl WatchdogRegistry {
    pub fn new() -> Self {
        Self(Arc::new(StdMutex::new(HashMap::new())))
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

#[derive(Default, Clone, Debug)]
pub struct PartialAcademicState {
    pub profile: Option<serde_json::Value>,
    pub courses: Option<Vec<serde_json::Value>>,
    pub drl: Option<Vec<serde_json::Value>>,
}

#[derive(Default, Clone)]
pub struct PartialStateRegistry {
    pub states: Arc<StdMutex<HashMap<String, PartialAcademicState>>>,
}

fn spawn_watchdog(app: AppHandle, window_label: String, token: CancellationToken) {
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => {
                if let Some(win) = app.get_webview_window(&window_label) {
                    let _ = win.destroy();
                }
                let _ = app.emit(
                    "sso-callback-failed",
                    "Quá thời gian đăng nhập (Timeout 120s)",
                );
                let _ = app.emit_to(
                    "main",
                    "portal-sync-failed",
                    "Quá thời gian đăng nhập (Timeout 120s)",
                );
                let _ = app.emit_to(
                    "main",
                    "wecode-sync-failed",
                    "Quá thời gian đăng nhập (Timeout 120s)",
                );
            }
            _ = token.cancelled() => {
                // Task hủy ngay lập tức khi nhận callback sớm
            }
        }
    });
}

pub const INJECTED_PORTAL_SCRIPT: &str = include_str!("../../../injected_portal_script.js");
pub const PORTAL_HARVESTER_SCRIPT: &str = include_str!("../../../scripts/portal_harvester.js");
pub const WECODE_HARVESTER_SCRIPT: &str = include_str!("../../../scripts/wecode_harvester.js");
pub const MOODLE_HARVESTER_SCRIPT: &str = include_str!("../../../scripts/moodle_harvester.js");
pub const MOODLE_LOGIN_URL: &str = "https://courses.uit.edu.vn/login/index.php";
pub const MOODLE_MY_URL: &str = "https://courses.uit.edu.vn/my/";

pub const UNIVERSAL_GUARDIAN_SCRIPT: &str = r#"
(() => {
  if (window.__DIARK_ACTIVE_GUARDIAN__) return;
  window.__DIARK_ACTIVE_GUARDIAN__ = true;

  // 1. Hidden Iframe Scheme Dispatcher (Khử Race Condition khi Trigger Scheme)
  function dispatchCustomScheme(uri) {
    try {
      let iframe = document.getElementById('__diark_dispatch_frame');
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = '__diark_dispatch_frame';
        iframe.style.display = 'none';
        document.documentElement.appendChild(iframe);
      }
      iframe.src = uri;
    } catch (e) {
      window.location.href = uri;
    }
  }

  // Bypass BeforeUnload Hooks & Robust Navigation
  function forceNavigate(path, retries = 3) {
    const before = window.location.pathname;
    window.location.href = path;
    setTimeout(() => {
      if (window.location.pathname === before && retries > 0) {
        forceNavigate(path, retries - 1);
      }
    }, 1500);
  }

  window.__diark_touch_network = function() {};

  // --- 1. PROXY FETCH & XHR ---
  const origFetch = window.fetch;
  try {
    window.fetch = async function(...args) {
      try { window.__diark_touch_network?.(); } catch (_) {}
      const response = await origFetch.apply(this, args);
      try {
        window.__diark_touch_network?.();
        const clone = response.clone();
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes('/api/sinh-vien/') || lowerUrl.includes('/api/academic/') || lowerUrl.includes('diem-ren-luyen') || lowerUrl.includes('drl') || lowerUrl.includes('ren-luyen')) {
          clone.json().then(data => {
            try { window.__diark_touch_network?.(); } catch (_) {}
            const cache = JSON.parse(sessionStorage.getItem('__diark_cache') || '{}');
            if (lowerUrl.includes('ho-so')) {
              cache.profile = data;
              sessionStorage.setItem('__diark_cache', JSON.stringify(cache));
              dispatchCustomScheme('diark-sso://partial#target=academic&stage=profile&data=' + encodeURIComponent(JSON.stringify(cache)));
            }
            if (lowerUrl.includes('bang-diem')) {
              cache.courses = Array.isArray(data) ? data : (data.courses || data.semester_groups || []);
              sessionStorage.setItem('__diark_cache', JSON.stringify(cache));
              dispatchCustomScheme('diark-sso://partial#target=academic&stage=courses&data=' + encodeURIComponent(JSON.stringify(cache)));
            }
            if (lowerUrl.includes('diem-ren-luyen') || lowerUrl.includes('drl') || lowerUrl.includes('ren-luyen')) {
              cache.drl = Array.isArray(data) ? data : (data.drl || data.data || []);
              sessionStorage.setItem('__diark_cache', JSON.stringify(cache));
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return response;
    };
  } catch (e) {}

  try {
    const origXHR = window.XMLHttpRequest;
    function ProxiedXHR() {
      const xhr = new origXHR();
      const origSend = xhr.send;
      xhr.send = function(...sArgs) {
        try { window.__diark_touch_network?.(); } catch (_) {}
        return origSend.apply(this, sArgs);
      };
      xhr.addEventListener('load', function() {
        try {
          window.__diark_touch_network?.();
          const url = xhr.responseURL || '';
          const lowerUrl = url.toLowerCase();
          if (lowerUrl.includes('/api/sinh-vien/') || lowerUrl.includes('/api/academic/') || lowerUrl.includes('diem-ren-luyen') || lowerUrl.includes('drl') || lowerUrl.includes('ren-luyen')) {
            const data = JSON.parse(xhr.responseText);
            const cache = JSON.parse(sessionStorage.getItem('__diark_cache') || '{}');
            if (lowerUrl.includes('ho-so')) {
              cache.profile = data;
              sessionStorage.setItem('__diark_cache', JSON.stringify(cache));
              dispatchCustomScheme('diark-sso://partial#target=academic&stage=profile&data=' + encodeURIComponent(JSON.stringify(cache)));
            }
            if (lowerUrl.includes('bang-diem')) {
              cache.courses = Array.isArray(data) ? data : (data.courses || data.semester_groups || []);
              sessionStorage.setItem('__diark_cache', JSON.stringify(cache));
              dispatchCustomScheme('diark-sso://partial#target=academic&stage=courses&data=' + encodeURIComponent(JSON.stringify(cache)));
            }
            if (lowerUrl.includes('diem-ren-luyen') || lowerUrl.includes('drl') || lowerUrl.includes('ren-luyen')) {
              cache.drl = Array.isArray(data) ? data : (data.drl || data.data || []);
              sessionStorage.setItem('__diark_cache', JSON.stringify(cache));
            }
          }
        } catch (_) {}
      });
      return xhr;
    }
    window.XMLHttpRequest = ProxiedXHR;
  } catch (e) {}

  // --- 2. ACADEMIC HARVESTER (3-TIER NEXT.JS FLIGHT WATCHER + STATE MACHINE) ---
  if (window.location.hostname.includes('portal.uit.edu.vn')) {
    let identityResolved = false;

    function onIdentityResolved(identity) {
      if (identityResolved) return;
      identityResolved = true;

      const cache = JSON.parse(sessionStorage.getItem('__diark_cache') || '{}');
      cache.profile = identity;
      sessionStorage.setItem('__diark_cache', JSON.stringify(cache));

      dispatchCustomScheme('diark-sso://partial#target=academic&stage=profile&data='
        + encodeURIComponent(JSON.stringify(cache)));

      const path = window.location.pathname;
      if (/\/(trang-chu|sinh-vien|ho-so)$/.test(path) || path === '/' || path.endsWith('/ho-so')) {
        setTimeout(() => { forceNavigate('/sinh-vien/bang-diem'); }, 100);
      }
    }

    function setupFlightWatcher() {
      window.__next_f = window.__next_f || [];
      const originalPush = window.__next_f.push.bind(window.__next_f);

      window.__next_f.push = function (...chunks) {
        const result = originalPush(...chunks);
        if (!identityResolved) tryExtractAndDispatch();
        return result;
      };

      let pollCount = 0;
      const pollInterval = setInterval(() => {
        pollCount++;
        if (identityResolved || pollCount > 40) { // 40 x 250ms = 10s
          clearInterval(pollInterval);
          return;
        }
        if (!window.__next_f.push || !window.__next_f.push.__diark_wrapped) {
          setupFlightWatcher();
        }
        tryExtractAndDispatch();
      }, 250);

      function extractStudentIdentity() {
        let profile = {};
        if (Array.isArray(window.__next_f)) {
          for (const chunk of window.__next_f) {
            if (Array.isArray(chunk) && typeof chunk[1] === 'string') {
              const match = chunk[1].match(/"user":\{"sub":"[^"]*","id":null,"username":"(\d{8})","displayName":"([^"]+)","email":"([^"]+)"/);
              if (match) {
                profile.student_id = match[1];
                profile.full_name = match[2];
                profile.email = match[3];
                break;
              }
            }
          }
        }
        if (!profile.student_id) {
          const idElem = document.querySelector('header button span.text-xs.text-muted-foreground');
          const nameElem = document.querySelector('header button span.text-sm.font-medium');
          if (idElem && nameElem) {
            const mssv = idElem.textContent.trim();
            if (/^\d{8}$/.test(mssv)) {
              profile.student_id = mssv;
              profile.full_name = nameElem.textContent.trim();
              profile.email = mssv + '@gm.uit.edu.vn';
            }
          }
        }
        // DOM label inspection fallback & enrichment
        const nodes = Array.from(document.querySelectorAll('div, span, td, p, dt, dd'));
        const findVal = (label) => {
          const l = label.toLowerCase();
          const node = nodes.find(n => n.textContent?.trim().toLowerCase().startsWith(l) || n.textContent?.trim().toLowerCase().includes(l));
          if (!node) return '';
          const valNode = node.nextElementSibling || node.parentElement?.querySelector('.font-medium, .font-semibold, dd') || node.parentElement?.children[1];
          return valNode?.textContent?.trim() || '';
        };

        if (!profile.student_id) {
          const mssv = findVal('mã sinh viên') || findVal('mssv');
          if (/^\d{8}$/.test(mssv)) {
            profile.student_id = mssv;
            profile.full_name = findVal('họ và tên') || findVal('họ tên');
            profile.email = mssv + '@gm.uit.edu.vn';
          }
        }

        profile.faculty = findVal('khoa') || '';
        profile.specialization = findVal('chuyên ngành') || findVal('ngành') || '';
        profile.student_class = findVal('lớp sinh hoạt') || findVal('lớp') || '';
        profile.curriculum_code = findVal('khung ctdt') || findVal('ctđt') || findVal('khóa học') || '';
        profile.cohort = findVal('niên khóa') || findVal('khóa') || '';

        return profile.student_id ? profile : null;
      }

      function tryExtractAndDispatch() {
        const identity = extractStudentIdentity();
        if (identity && !identityResolved) {
          clearInterval(pollInterval);
          onIdentityResolved(identity);
        }
      }
      window.__next_f.push.__diark_wrapped = true;
    }

    // Stage 2: /sinh-vien/bang-diem
    function runStageCourses() {
      let attempts = 0;
      const maxAttempts = 40;
      let settled = false;

      const isCourseCode = (s) => /^[A-Z]{2,5}\d{2,4}(\.[A-Z0-9]+)?$/i.test((s || '').trim());

      const extractSummaryDRL = () => {
        const summaryRecords = [];
        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
          const ths = Array.from(table.querySelectorAll('th, thead td')).map(t => t.textContent.trim().toLowerCase());
          const drlColIdx = ths.findIndex(t => t.includes('rèn luyện') || t.includes('đrl'));
          const semColIdx = ths.findIndex(t => t.includes('kỳ') || t.includes('học kỳ'));
          const rankColIdx = ths.findIndex(t => t.includes('xếp loại') || t.includes('loại'));

          const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
            if (cells.length < 3) continue;

            let semText = '';
            let scoreVal = null;
            let rankText = '';

            if (drlColIdx >= 0 && cells[drlColIdx]) {
              const sm = cells[drlColIdx].match(/\b([0-9]{1,2}|100)\b/);
              if (sm) scoreVal = parseInt(sm[1], 10);
            }
            if (semColIdx >= 0 && cells[semColIdx]) {
              semText = cells[semColIdx];
            }
            if (rankColIdx >= 0 && cells[rankColIdx]) {
              rankText = cells[rankColIdx];
            }

            if (!semText) {
              const sCell = cells.find(c => /Học kỳ|HK|Hè/i.test(c));
              if (sCell) semText = sCell;
            }
            if (scoreVal === null && semText) {
              for (let i = cells.length - 1; i >= 1; i--) {
                const sm = cells[i].match(/^\s*([0-9]{1,2}|100)\s*$/);
                if (sm) {
                  const val = parseInt(sm[1], 10);
                  if (val >= 0 && val <= 100) {
                    scoreVal = val;
                    break;
                  }
                }
              }
            }

            if (semText && /Học kỳ|HK|Hè/i.test(semText) && scoreVal !== null) {
              summaryRecords.push({
                semester: semText.replace(/\s+/g, ' '),
                score: scoreVal,
                grade_text: rankText
              });
            }
          }
        }
        return summaryRecords;
      };

      const checkCourses = () => {
        if (settled) return;
        attempts++;

        const isPulse = document.querySelector('.animate-pulse, .loading-spinner, .ant-spin, [aria-busy="true"], .spinner');
        if (isPulse && attempts < maxAttempts) {
          setTimeout(checkCourses, 250);
          return;
        }

        // 1. Quét DRL từ bảng tổng kết (nếu có) để dự phòng
        const summaryDRL = extractSummaryDRL();
        if (summaryDRL.length > 0) {
          try {
            const cache = JSON.parse(sessionStorage.getItem('__diark_cache') || '{}');
            if (!cache.drl || cache.drl.length === 0) {
              cache.drl = summaryDRL;
              sessionStorage.setItem('__diark_cache', JSON.stringify(cache));
            }
          } catch (_) {}
        }

        // 2. Chuyển sang tab "Chi tiết môn học"
        const tabs = Array.from(document.querySelectorAll('button[role="tab"], [role="tablist"] button, nav button, button'));
        const detailTab = tabs.find(b => {
          const text = (b.textContent || '').trim().toLowerCase();
          return (text.includes('chi tiết') || text.includes('môn học') || text.includes('bảng điểm chi tiết')) && !text.includes('tổng kết');
        });

        if (detailTab && detailTab.getAttribute('aria-selected') !== 'true') {
          detailTab.click();
          setTimeout(checkCourses, 300);
          return;
        }

        // 3. Quét bảng môn học theo mã môn
        const tables = Array.from(document.querySelectorAll('table'));
        const courses = [];
        const semesterGroups = [];

        for (const table of tables) {
          let heading = '';
          let prev = table.previousElementSibling;
          while (prev && !heading) {
            if (/Học kỳ|Năm học|HK/i.test(prev.textContent || '')) {
              heading = prev.textContent.trim();
              break;
            }
            prev = prev.previousElementSibling;
          }
          if (!heading) {
            heading = table.closest('div')?.querySelector('h2, h3, h4, h5, .font-bold, .font-semibold')?.textContent?.trim() || 'Học kỳ';
          }

          const rows = Array.from(table.querySelectorAll('tbody tr, tr'));
          const grpCourses = [];

          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() || '');
            if (cells.length < 3) continue;

            let codeIdx = -1;
            if (isCourseCode(cells[0])) codeIdx = 0;
            else if (isCourseCode(cells[1])) codeIdx = 1;
            else if (isCourseCode(cells[2])) codeIdx = 2;

            if (codeIdx >= 0) {
              const code = cells[codeIdx];
              const name = cells[codeIdx + 1] || '';

              let cred = 0;
              for (let c = codeIdx + 2; c < Math.min(cells.length, codeIdx + 5); c++) {
                const credVal = parseInt(cells[c], 10);
                if (!isNaN(credVal) && credVal >= 1 && credVal <= 15 && /^\d+$/.test(cells[c])) {
                  cred = credVal;
                  break;
                }
              }

              let score = null;
              for (let s = cells.length - 1; s > codeIdx + 1; s--) {
                const parsed = parseFloat(cells[s]);
                if (!isNaN(parsed) && parsed >= 0.0 && parsed <= 10.0 && /^\d+(\.\d+)?$/.test(cells[s])) {
                  score = parsed;
                  break;
                }
              }

              const c = {
                course_code: code,
                course_name: name,
                credits: cred,
                total_score: score,
                semester_id: heading
              };
              courses.push(c);
              grpCourses.push(c);
            }
          }

          if (grpCourses.length > 0) {
            semesterGroups.push({ semester_name: heading, courses: grpCourses });
          }
        }

        if (courses.length > 0 || attempts >= maxAttempts) {
          settled = true;
          const cache = JSON.parse(sessionStorage.getItem('__diark_cache') || '{}');
          cache.courses = courses;
          if (semesterGroups.length > 0) {
            cache.transcript = { semester_groups: semesterGroups };
          }
          sessionStorage.setItem('__diark_cache', JSON.stringify(cache));

          dispatchCustomScheme('diark-sso://partial#target=academic&stage=courses&data='
            + encodeURIComponent(JSON.stringify(cache)));

          setTimeout(() => { forceNavigate('/sinh-vien/diem-ren-luyen'); }, 100);
          return;
        }

        setTimeout(checkCourses, 250);
      };

      checkCourses();
    }

    // Stage 3: /sinh-vien/diem-ren-luyen với Dynamic Header Scraper & Quiet-Period Guard
    function extractDRLFromDOM() {
      // 1. Chỉ hoãn khi container bảng thực sự đang hiển thị hiệu ứng loading/skeleton
      const table = document.querySelector('table, div[role="table"], div[role="rowgroup"]');
      if (table && table.querySelector('.animate-pulse, .loading-spinner, .ant-spin')) {
        const rowCount = table.querySelectorAll('tbody tr, div[role="row"]').length;
        if (rowCount === 0) return null;
      }

      const results = [];
      
      // 2. Định vị bảng dữ liệu và quét header nếu có
      const allRows = Array.from(document.querySelectorAll('table tbody tr, table tr, div[role="row"]'));
      // Lọc bỏ header rows
      const dataRows = allRows.filter(r => !r.querySelector('th') && r.querySelectorAll('td, div[role="cell"], div.grid > div').length >= 2);

      let headerSemIdx = -1;
      let headerScoreIdx = -1;
      let headerGradeIdx = -1;

      if (table) {
        const ths = Array.from(table.querySelectorAll('th, thead td'));
        ths.forEach((th, idx) => {
          const t = th.textContent.trim().toLowerCase();
          if (t.includes('học kỳ') || t.includes('kỳ')) headerSemIdx = idx;
          else if (t.includes('điểm') || t.includes('đrl')) headerScoreIdx = idx;
          else if (t.includes('xếp loại') || t.includes('loại')) headerGradeIdx = idx;
        });
      }

      if (dataRows.length > 0) {
        dataRows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td, div[role="cell"], div.grid > div'));
          if (cells.length < 2) return;

          let semText = '';
          let scoreVal = null;
          let gradeText = '';

          if (headerSemIdx >= 0 && headerScoreIdx >= 0 && cells[headerSemIdx] && cells[headerScoreIdx]) {
            semText = cells[headerSemIdx].textContent.trim();
            const scoreMatch = cells[headerScoreIdx].textContent.trim().match(/\b([0-9]{1,2}|100)\b/);
            if (scoreMatch) scoreVal = parseInt(scoreMatch[1], 10);
            if (headerGradeIdx >= 0 && cells[headerGradeIdx]) {
              gradeText = cells[headerGradeIdx].textContent.trim();
            }
          } else {
            // Flexible cell scanning
            for (let i = 0; i < cells.length; i++) {
              const txt = cells[i].textContent.trim();
              if (/Học kỳ|Hè/i.test(txt) && !semText) {
                semText = txt;
                continue;
              }
              if (scoreVal === null) {
                const sm = txt.match(/^\s*([0-9]{1,2}|100)\s*$/);
                if (sm) {
                  scoreVal = parseInt(sm[1], 10);
                  if (cells[i + 1]) {
                    gradeText = cells[i + 1].textContent.trim();
                  }
                }
              }
            }
          }

          if (semText && /Học kỳ|Hè/i.test(semText) && scoreVal !== null) {
            let normalizedGrade = '';
            if (/Xuất sắc/i.test(gradeText)) normalizedGrade = 'Xuất sắc';
            else if (/Tốt/i.test(gradeText)) normalizedGrade = 'Tốt';
            else if (/Khá/i.test(gradeText)) normalizedGrade = 'Khá';
            else if (/Trung bình/i.test(gradeText)) normalizedGrade = 'Trung bình';
            else if (/Yếu/i.test(gradeText)) normalizedGrade = 'Yếu';
            else normalizedGrade = gradeText || 'Chưa xếp loại';

            results.push({
              semester: semText.replace(/\s+/g, ' '),
              score: scoreVal,
              grade_text: normalizedGrade
            });
          }
        });
      }

      // 3. Fallback Quét Cấu Trúc Khối (nếu Next.js render layout dạng Div Flexbox)
      if (results.length === 0) {
        const textNodes = Array.from(document.querySelectorAll('div, p, span'));
        const termNodes = textNodes.filter(n => 
          n.children.length === 0 && /(Học kỳ\s+[123]|Hè)(\s+Năm học\s+\d{4}[–-]\d{4})?/i.test(n.textContent)
        );

        termNodes.forEach(termNode => {
          const parentRow = termNode.closest('div.flex, div.grid, tr') || termNode.parentElement;
          if (parentRow) {
            const text = parentRow.textContent || '';
            const scoreMatch = text.match(/(?:Điểm|STT)?.*?(\b[0-9]{1,2}|100\b)/);
            if (scoreMatch) {
              let grade = 'Chưa xếp loại';
              if (/Xuất sắc/i.test(text)) grade = 'Xuất sắc';
              else if (/Tốt/i.test(text)) grade = 'Tốt';
              else if (/Khá/i.test(text)) grade = 'Khá';

              results.push({
                semester: termNode.textContent.trim().replace(/\s+/g, ' '),
                score: parseInt(scoreMatch[1], 10),
                grade_text: grade
              });
            }
          }
        });
      }

      return results.length > 0 ? results : null;
    }

    function finalizeCallback(drl, status) {
      try {
        const cache = JSON.parse(sessionStorage.getItem('__diark_cache') || '{}');
        const existingDrl = Array.isArray(cache.drl) ? cache.drl : [];
        const finalDrl = (Array.isArray(drl) && drl.length > 0) ? drl : existingDrl;
        const finalStatus = finalDrl.length > 0 ? 'confirmed' : status;

        cache.drl = finalDrl;
        cache.drl_sync_status = finalStatus;

        // Payload tinh gọn, tránh vượt quá giới hạn độ dài URI trên Windows WebView2
        const payload = {
          profile: cache.profile || null,
          courses: cache.courses || [],
          drl: finalDrl,
          drl_sync_status: finalStatus
        };

        const uri = 'diark-sso://callback#target=academic&data=' + encodeURIComponent(JSON.stringify(payload));
        dispatchCustomScheme(uri);

        // Fallback sau 250ms phòng trường hợp iframe scheme bị chặn
        setTimeout(() => {
          try { window.location.href = uri; } catch (_) {}
        }, 250);
      } catch (err) {
        const fallbackUri = 'diark-sso://callback#target=academic&data=' + encodeURIComponent(JSON.stringify({
          drl: drl || [],
          drl_sync_status: status
        }));
        dispatchCustomScheme(fallbackUri);
      }
    }

    let drlHarvestStarted = false;
    function harvestDRLWithGuard() {
      if (drlHarvestStarted) return;
      drlHarvestStarted = true;

      const startTime = performance.now();
      let lastNetworkActivity = startTime;
      let resolved = false;
      const HARD_CAP_MS = 6000;     // Trần tối đa 6s
      const QUIET_PERIOD_MS = 2500; // 2.5s không phát sinh network mới sau khi DOM complete

      window.__diark_touch_network = function() {
        lastNetworkActivity = performance.now();
      };

      function attemptFinalize() {
        if (resolved) return;
        try {
          let drlData = extractDRLFromDOM();
          if (!drlData) {
            try {
              const cache = JSON.parse(sessionStorage.getItem('__diark_cache') || '{}');
              if (Array.isArray(cache.drl) && cache.drl.length > 0) {
                drlData = cache.drl;
              }
            } catch (_) {}
          }
          const elapsed = performance.now() - startTime;
          const sinceLastActivity = performance.now() - lastNetworkActivity;

          // Case 1: Đã bóc tách được dữ liệu DRL hợp lệ (>= 1 bản ghi) -> chốt ngay lập tức
          if (drlData !== null && drlData.length > 0) {
            resolved = true;
            finalizeCallback(drlData, 'confirmed');
            return;
          }

          // Case 2: Đạt trần thời gian 6s
          if (elapsed >= HARD_CAP_MS) {
            resolved = true;
            finalizeCallback(drlData, drlData === null ? 'timeout_unknown' : 'confirmed');
            return;
          }

          // Case 3: Trang đã load xong và yên ắng trong quiet period
          if (sinceLastActivity >= QUIET_PERIOD_MS && document.readyState === 'complete') {
            resolved = true;
            finalizeCallback(drlData, drlData === null ? 'timeout_unknown' : 'confirmed');
            return;
          }
        } catch (err) {
          resolved = true;
          finalizeCallback(null, 'timeout_unknown');
        }
      }

      const checkInterval = setInterval(() => {
        attemptFinalize();
        if (resolved) clearInterval(checkInterval);
      }, 200);
    }

    // Route inspection & dispatcher
    const routeDispatcher = () => {
      const path = window.location.pathname;
      if (path.includes('/sinh-vien/diem-ren-luyen')) {
        harvestDRLWithGuard();
      } else if (path.includes('/sinh-vien/bang-diem')) {
        runStageCourses();
      } else {
        setupFlightWatcher();
      }
    };

    routeDispatcher();

    // Hook SPA History transitions
    try {
      const origPush = history.pushState;
      history.pushState = function(...args) {
        const ret = origPush.apply(this, args);
        routeDispatcher();
        return ret;
      };
      const origReplace = history.replaceState;
      history.replaceState = function(...args) {
        const ret = origReplace.apply(this, args);
        routeDispatcher();
        return ret;
      };
      window.addEventListener('popstate', routeDispatcher);
    } catch (_) {}
  }

  // --- 3. WECODE SCRAPING WITH STATUS ENUM ---
  const parseAssignmentRows = (rows) => {
    return rows.map(tr => {
      const idStr = tr.getAttribute('data-id') || tr.querySelector('td:nth-child(1)')?.textContent?.trim() || '0';
      const className = tr.querySelector('td:nth-child(2)')?.textContent?.trim() || '';
      const titleEl = tr.querySelector('td:nth-child(3) a') || tr.querySelector('td:nth-child(3)');
      const title = titleEl?.textContent?.trim() || '';
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
  };

  let harvestedWecode = false;
  let wecodePollingStarted = false;

  const waitForAssignmentTableReady = () => {
    if (wecodePollingStarted) return;
    wecodePollingStarted = true;

    let attempts = 0;
    const maxAttempts = 40;
    let emptyRetries = 0;
    const maxEmptyRetries = 10;

    const checkTable = () => {
      if (harvestedWecode) return;
      attempts++;

      // Check loading indicators
      const isSpinning = document.querySelector('.loading-spinner, .ant-spin, [aria-busy="true"], .spinner-border, .spinner');
      if (isSpinning && attempts < maxAttempts) {
        setTimeout(checkTable, 250);
        return;
      }

      // Check table rows
      const rows = Array.from(document.querySelectorAll('#DataTables_Table_0 tbody tr, table tbody tr'));
      const realRows = rows.filter(r => !r.classList.contains('dataTables_empty') && !r.querySelector('.dataTables_empty') && r.querySelectorAll('td').length > 1);

      if (realRows.length > 0) {
        harvestedWecode = true;
        const assignments = parseAssignmentRows(realRows);
        const result = { status: 'has_data', rows: assignments };
        window.location.href = 'diark-sso://callback#target=wecode&data=' + encodeURIComponent(JSON.stringify(result));
        return;
      }

      // Check empty markers
      const hasEmptyMarker = document.querySelector('.empty-state, .ant-empty, .no-data, .dataTables_empty');
      if (hasEmptyMarker) {
        harvestedWecode = true;
        const result = { status: 'empty_confirmed', rows: [] };
        window.location.href = 'diark-sso://callback#target=wecode&data=' + encodeURIComponent(JSON.stringify(result));
        return;
      }

      // Table exists but no rows & no empty indicator
      const table = document.querySelector('#DataTables_Table_0, table');
      if (table && emptyRetries < maxEmptyRetries) {
        emptyRetries++;
        setTimeout(checkTable, 300);
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(checkTable, 250);
        return;
      }

      // Final fallback
      harvestedWecode = true;
      const result = { status: 'empty_unconfirmed', rows: [] };
      window.location.href = 'diark-sso://callback#target=wecode&data=' + encodeURIComponent(JSON.stringify(result));
    };

    checkTable();
  };

  const inspectWecode = () => {
    if (harvestedWecode) return;
    if (!window.location.href.includes('/wecode25/it00x/')) return;

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

    if (window.location.href.includes('/assignments')) {
      waitForAssignmentTableReady();
    }
  };

  if (window.location.href.includes('/wecode25/it00x/')) {
    setInterval(() => {
      inspectWecode();
    }, 250);
  }
})();
"#;

const CALLBACK_SCHEME: &str = "diark-sso://callback";
const CALLBACK_FAIL_SCHEME: &str = "diark-sso://failed";

const WECODE_LOGIN_URL: &str = "https://khmt.uit.edu.vn/wecode25/it00x/home";
#[allow(dead_code)]
const WECODE_ASSIGNMENTS_URL: &str = "https://khmt.uit.edu.vn/wecode25/it00x/assignments";
const WECODE_LOGIN_MARKER: &str = "/wecode25/it00x/login";
const MAX_LOGIN_REDIRECT_ATTEMPTS: u8 = 50;

#[allow(dead_code)]
#[derive(Deserialize, Debug)]
struct PortalIngestionPayload {
    profile: crate::commands::academic::StudentProfilePayload,
    transcript: serde_json::Value,
    drl: serde_json::Value,
}

pub fn parse_callback_fragment(fragment: &str) -> Result<(String, String), String> {
    let decoded = decode(fragment)
        .map_err(|e| format!("URL decode error: {e}"))?
        .into_owned();

    let target = if let Some(idx) = decoded.find("target=") {
        let after_target = &decoded[idx + "target=".len()..];
        let end_idx = after_target.find('&').unwrap_or(after_target.len());
        after_target[..end_idx].to_string()
    } else {
        "unknown".to_string()
    };

    let data_str = if let Some(idx) = decoded.find("data=") {
        let after_data = &decoded[idx + "data=".len()..];
        if after_data.starts_with('%') {
            decode(after_data)
                .unwrap_or(std::borrow::Cow::Borrowed(after_data))
                .into_owned()
        } else {
            after_data.to_string()
        }
    } else {
        String::new()
    };

    Ok((target, data_str))
}

pub fn extract_query_param(url_str: &str, param_name: &str) -> String {
    let search_key = format!("{param_name}=");
    if let Some(pos) = url_str.find(&search_key) {
        let remainder = &url_str[pos + search_key.len()..];
        let end = remainder.find('&').unwrap_or(remainder.len());
        decode(&remainder[..end])
            .unwrap_or(std::borrow::Cow::Borrowed(&remainder[..end]))
            .into_owned()
    } else {
        "unknown".to_string()
    }
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct WecodeScrapeResultDto {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub rows: Vec<AssignmentItem>,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct AssignmentItem {
    pub id: i64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub class_name: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct TranscriptDataPayload {
    #[serde(default)]
    pub transcript: serde_json::Value,
    #[serde(default)]
    pub drl: serde_json::Value,
}

pub fn get_portal_harvester_registry_static() -> crate::services::portal_harvester::PortalHarvesterRegistry {
    static REGISTRY: std::sync::OnceLock<crate::services::portal_harvester::PortalHarvesterRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(crate::services::portal_harvester::PortalHarvesterRegistry::new).clone()
}

pub fn get_wecode_harvester_registry_static() -> crate::services::wecode_harvester::WecodeHarvesterRegistry {
    static REGISTRY: std::sync::OnceLock<crate::services::wecode_harvester::WecodeHarvesterRegistry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(crate::services::wecode_harvester::WecodeHarvesterRegistry::new).clone()
}

pub fn handle_partial_checkpoint_sync(
    registry: &PartialStateRegistry,
    window_label: &str,
    fragment: &str,
) -> Result<(), String> {
    let target = extract_query_param(fragment, "target");
    let stage = extract_query_param(fragment, "stage");
    let data_str = if let Some(idx) = fragment.find("data=") {
        let raw = &fragment[idx + "data=".len()..];
        decode(raw).unwrap_or(std::borrow::Cow::Borrowed(raw)).into_owned()
    } else {
        String::new()
    };

    let parsed_data: serde_json::Value = if !data_str.is_empty() && data_str != "unknown" {
        serde_json::from_str(&data_str).map_err(|e| format!("JSON parse error in partial data: {e}"))?
    } else {
        serde_json::Value::Null
    };

    // Support Portal Harvester v2.1 (Chunked Scheme Protocol)
    if target == "portal_meta" {
        match serde_json::from_value::<crate::services::portal_harvester::PortalMetaPayload>(parsed_data.clone()) {
            Ok(meta) => {
                let harvester_reg = get_portal_harvester_registry_static();
                let _ = harvester_reg.handle_meta(window_label, meta);
                println!("[SSO Checkpoint] Portal meta received for window: {window_label}");
            }
            Err(e) => {
                eprintln!("[SSO Checkpoint] Failed to parse portal meta payload: {e}");
            }
        }
    } else if target == "portal_courses" {
        let batch_idx: usize = extract_query_param(fragment, "batch_idx").parse().unwrap_or(0);
        match serde_json::from_value::<Vec<crate::services::portal_harvester::AcademicCourseItem>>(parsed_data.clone()) {
            Ok(chunk) => {
                let harvester_reg = get_portal_harvester_registry_static();
                let chunk_len = chunk.len();
                let _ = harvester_reg.handle_course_batch(window_label, batch_idx, chunk);
                println!("[SSO Checkpoint] Portal course batch {batch_idx} ({chunk_len} courses) received for window: {window_label}");
            }
            Err(e) => {
                eprintln!("[SSO Checkpoint] Failed to parse portal courses batch {batch_idx}: {e}");
            }
        }
    } else if target == "wecode_submissions" {
        let batch_idx: usize = extract_query_param(fragment, "batch_idx").parse().unwrap_or(0);
        let total_batches: usize = extract_query_param(fragment, "total_batches").parse().unwrap_or(0);
        match serde_json::from_value::<Vec<crate::commands::wecode::WecodeSubmissionDto>>(parsed_data.clone()) {
            Ok(chunk) => {
                let wecode_reg = get_wecode_harvester_registry_static();
                let chunk_len = chunk.len();
                let _ = wecode_reg.handle_batch(window_label, batch_idx, total_batches, chunk);
                println!("[SSO Checkpoint] Wecode submission batch {batch_idx} ({chunk_len} subs) received for window: {window_label}");
            }
            Err(e) => {
                eprintln!("[SSO Checkpoint] Failed to parse wecode submissions batch {batch_idx}: {e}");
            }
        }
    }

    if let Ok(mut guard) = registry.states.lock() {
        let entry = guard.entry(window_label.to_string()).or_default();

        match stage.as_str() {
            "profile" => {
                if let Some(p) = parsed_data.get("profile") {
                    entry.profile = Some(p.clone());
                } else if parsed_data.get("student_id").is_some() {
                    entry.profile = Some(parsed_data.clone());
                }
            }
            "courses" => {
                if let Some(c) = parsed_data.get("courses").and_then(|v| v.as_array()) {
                    entry.courses = Some(c.clone());
                } else if let Some(arr) = parsed_data.as_array() {
                    entry.courses = Some(arr.clone());
                }
            }
            "drl" => {
                if let Some(d) = parsed_data.get("drl").and_then(|v| v.as_array()) {
                    entry.drl = Some(d.clone());
                } else if let Some(arr) = parsed_data.as_array() {
                    entry.drl = Some(arr.clone());
                }
            }
            _ => {
                if let Some(p) = parsed_data.get("profile") {
                    entry.profile = Some(p.clone());
                }
                if let Some(c) = parsed_data.get("courses").and_then(|v| v.as_array()) {
                    entry.courses = Some(c.clone());
                }
                if let Some(d) = parsed_data.get("drl").and_then(|v| v.as_array()) {
                    entry.drl = Some(d.clone());
                }
            }
        }
    }

    Ok(())
}

pub fn merge_with_partial_state(
    registry: &PartialStateRegistry,
    window_label: &str,
    data_str: &str,
) -> serde_json::Value {
    let mut payload: serde_json::Value = serde_json::from_str(data_str)
        .unwrap_or_else(|_| serde_json::json!({}));

    if let Ok(guard) = registry.states.lock() {
        if let Some(partial) = guard.get(window_label) {
            if let Some(obj) = payload.as_object_mut() {
                if (!obj.contains_key("profile") || obj["profile"].is_null()) && partial.profile.is_some() {
                    if let Some(ref p) = partial.profile {
                        obj.insert("profile".to_string(), p.clone());
                    }
                }
                if (!obj.contains_key("courses") || obj["courses"].as_array().map(|a| a.is_empty()).unwrap_or(true))
                    && partial.courses.is_some()
                {
                    if let Some(ref c) = partial.courses {
                        obj.insert("courses".to_string(), serde_json::Value::Array(c.clone()));
                    }
                }
                if (!obj.contains_key("drl") || obj["drl"].is_null() || obj["drl"].as_array().map(|a| a.is_empty()).unwrap_or(true))
                    && partial.drl.is_some()
                {
                    if let Some(ref d) = partial.drl {
                        obj.insert("drl".to_string(), serde_json::Value::Array(d.clone()));
                    }
                }
            }
        }
    }

    payload
}

pub fn cleanup_window_session(
    partial_registry: &PartialStateRegistry,
    watchdog_registry: &WatchdogRegistry,
    app_handle: &AppHandle,
    window_label: &str,
) {
    if let Ok(mut states) = partial_registry.states.lock() {
        states.remove(window_label);
    }
    let harvester_reg = get_portal_harvester_registry_static();
    if let Ok(mut sessions) = harvester_reg.sessions.lock() {
        sessions.remove(window_label);
    }
    let wecode_reg = get_wecode_harvester_registry_static();
    if let Ok(mut sessions) = wecode_reg.sessions.lock() {
        sessions.remove(window_label);
    }
    watchdog_registry.cancel(window_label);
    if let Some(w) = app_handle.get_webview_window(window_label) {
        let _ = w.destroy();
    }
}

pub fn handle_callback_payload_sync(
    app: &AppHandle,
    target: &str,
    data_str: &str,
) -> Result<serde_json::Value, String> {
    match target {
        "portal_profile" => {
            let profile: crate::commands::academic::StudentProfilePayload =
                serde_json::from_str(data_str).map_err(|e| format!("Parse profile error: {e}"))?;
            let state = app.state::<SharedDb>();
            crate::commands::academic::save_student_profile_internal(app, &state, profile.clone())?;
            let _ = app.emit_to("main", "portal-profile-synced", ());
            serde_json::to_value(&profile).map_err(|e| e.to_string())
        }
        "portal_transcript" => {
            let data: TranscriptDataPayload =
                serde_json::from_str(data_str).map_err(|e| format!("Parse transcript error: {e}"))?;
            let state = app.state::<SharedDb>();
            crate::commands::academic::ingest_full_academic_payload_internal(
                app,
                &state,
                data.transcript.clone(),
                data.drl.clone(),
            )?;
            let _ = app.emit_to("main", "academic-data-synced", ());
            serde_json::to_value(&data).map_err(|e| e.to_string())
        }
        "academic" => {
            let raw_val: serde_json::Value =
                serde_json::from_str(data_str).map_err(|e| format!("Parse academic error: {e}"))?;
            crate::commands::academic::ingest_full_academic_payload_sync(app, raw_val.clone())?;
            let _ = app.emit_to("main", "academic-data-synced", ());
            Ok(raw_val)
        }
        "wecode" | "wecode_assignments" => {
            let mut assignments_to_save: Vec<AssignmentItem> = Vec::new();
            let mut result_val = serde_json::json!({ "status": "ok" });

            if let Ok(envelope) = serde_json::from_str::<WecodeScrapeResultDto>(data_str) {
                result_val = serde_json::to_value(&envelope).unwrap_or(result_val);
                assignments_to_save = envelope.rows;
            } else if let Ok(list) = serde_json::from_str::<Vec<AssignmentItem>>(data_str) {
                result_val = serde_json::to_value(&list).unwrap_or(result_val);
                assignments_to_save = list;
            }

            let state = app.state::<SharedDb>();
            if let Ok(conn) = state.lock() {
                for a in &assignments_to_save {
                    let _ = conn.execute(
                        "INSERT INTO wecode_assignments (id, name) VALUES (?1, ?2)
                         ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                        rusqlite::params![a.id, a.title],
                    );
                }
            }

            let _ = app.emit_to("main", "wecode-assignments-synced", ());
            Ok(result_val)
        }
        "wecode_submissions" => {
            let submissions: Vec<crate::commands::wecode::WecodeSubmissionDto> =
                serde_json::from_str(data_str).map_err(|e| format!("Parse wecode submissions error: {e}"))?;
            let state = app.state::<crate::AppState>();
            crate::commands::wecode::ingest_wecode_submissions_internal(app, &state, submissions.clone())?;
            let _ = app.emit_to("main", "wecode-submissions-synced", ());
            serde_json::to_value(&submissions).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown callback target: {target}")),
    }
}

#[tauri::command]
pub async fn launch_portal_sso_sync(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("uit-sso-login") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let auth_url = WebviewUrl::External(
        "https://portal.uit.edu.vn/sinh-vien/bang-diem"
            .parse()
            .map_err(|e| format!("Invalid auth URL: {e}"))?,
    );

    let watchdog_registry = if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.inner().clone()
    } else {
        WatchdogRegistry::new()
    };
    let token = watchdog_registry.register("uit-sso-login");
    spawn_watchdog(app.clone(), "uit-sso-login".to_string(), token);

    let partial_state_registry = if let Some(reg) = app.try_state::<PartialStateRegistry>() {
        reg.inner().clone()
    } else {
        PartialStateRegistry::default()
    };

    let app_handle = app.clone();
    let window_label = "uit-sso-login".to_string();
    let partial_for_nav = partial_state_registry.clone();
    let watchdog_for_nav = watchdog_registry.clone();

    let window = WebviewWindowBuilder::new(&app, &window_label, auth_url)
        .title("Đăng nhập Cổng Thông Tin UIT")
        .inner_size(960.0, 720.0)
        .resizable(true)
        .always_on_top(true)
        .initialization_script(PORTAL_HARVESTER_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            // 1. Intercept Final Callback (Atomic Persist)
            if url_str.starts_with("diark-sso://callback") {
                let callback_fragment = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://callback#"));
                if let Some(fragment) = callback_fragment {
                    match parse_callback_fragment(fragment) {
                        Ok((target, data_str)) => {
                            if target == "portal" {
                                let status = extract_query_param(fragment, "status");
                                if status == "success" {
                                    println!("[SSO Final] Portal auto-sync completed via background API engine!");
                                    let _ = app_handle.emit("academic-data-synced", ());
                                    let _ = app_handle.emit("sso-callback-success", "portal");
                                } else {
                                    let harvester_reg = get_portal_harvester_registry_static();
                                    let db_state = app_handle.state::<SharedDb>();
                                    let db_arc = db_state.inner().clone();
                                    match harvester_reg.commit_session(&window_label, db_arc) {
                                        Ok(total_courses) => {
                                            println!("[SSO Final] Portal Harvester committed {total_courses} courses successfully!");
                                            let _ = app_handle.emit("academic-data-synced", ());
                                            let _ = app_handle.emit("sso-callback-success", "portal");
                                        }
                                        Err(err) => {
                                            eprintln!("[SSO Final] ERROR in Portal Harvester commit: {err}");
                                            let _ = app_handle.emit("sso-callback-error", err.to_string());
                                            let _ = app_handle.emit_to("main", "portal-sync-failed", err.to_string());
                                        }
                                    }
                                }
                            } else {
                                let final_payload = merge_with_partial_state(&partial_for_nav, &window_label, &data_str);
                                let course_count = final_payload.get("courses").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
                                let drl_count = final_payload.get("drl").and_then(|d| d.as_array()).map(|a| a.len()).unwrap_or(0);
                                let has_profile = final_payload.get("profile").is_some() || final_payload.get("student_id").is_some();
                                println!("[SSO Final] Ingesting academic payload: profile={has_profile}, courses={course_count}, drl={drl_count}");

                                match crate::commands::academic::ingest_full_academic_payload_sync(&app_handle, final_payload) {
                                    Ok(_) => {
                                        println!("[SSO Final] Academic sync successfully committed to SQLite!");
                                        let _ = app_handle.emit("academic-data-synced", ());
                                        let _ = app_handle.emit("sso-callback-success", "academic");
                                    }
                                    Err(err) => {
                                        eprintln!("[SSO Final] ERROR ingesting academic payload: {err}");
                                        let _ = app_handle.emit("sso-callback-error", err.to_string());
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            eprintln!("[SSO Final] ERROR parsing callback fragment: {err}");
                            let _ = app_handle.emit("sso-callback-error", err.to_string());
                        }
                    }
                }

                // Dọn dẹp in-memory registry và hủy cửa sổ
                cleanup_window_session(&partial_for_nav, &watchdog_for_nav, &app_handle, &window_label);
                return false;
            }

            // 2. Intercept Partial Checkpoints (TUYỆT ĐỐI KHÔNG GHI PRODUCTION SQLITE, KHÔNG DESTROY)
            if url_str.starts_with("diark-sso://partial") {
                let partial_fragment = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://partial#"));
                if let Some(fragment) = partial_fragment {
                    let _ = handle_partial_checkpoint_sync(&partial_for_nav, &window_label, fragment);
                }
                return false; // Chặn iframe navigation thật
            }

            // 3. Intercept Failure
            if url_str.starts_with("diark-sso://failed") {
                let reason = extract_query_param(url_str, "reason");
                let _ = app_handle.emit("sso-callback-failed", &reason);
                let _ = app_handle.emit_to("main", "portal-sync-failed", &reason);
                cleanup_window_session(&partial_for_nav, &watchdog_for_nav, &app_handle, &window_label);
                return false;
            }

            // 4. Chặn bất kỳ scheme nội bộ diark-sso:// nào khác không bị rò rỉ ra WebView
            if url_str.starts_with("diark-sso://") {
                return false;
            }

            // 5. Pass-through các trang nội bộ cần scrape
            if url_str.contains("/sinh-vien/") || url_str.contains("/trang-chu") || url_str.contains("/home") {
                return true;
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
    let redirect_attempts_for_nav = redirect_attempts.clone();
    let app_for_nav = app.clone();

    let partial_state_registry = if let Some(reg) = app.try_state::<PartialStateRegistry>() {
        reg.inner().clone()
    } else {
        PartialStateRegistry::default()
    };
    let partial_for_nav = partial_state_registry.clone();

    let window = WebviewWindowBuilder::new(&app, "wecode-sso-login", auth_url)
        .title("Đồng bộ Wecode Submissions")
        .inner_size(900.0, 750.0)
        .resizable(true)
        .always_on_top(true)
        .initialization_script(WECODE_HARVESTER_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            // 1. Intercept Partial Submissions Checkpoint (TUYỆT ĐỐI KHÔNG GHI DIRECT TRÁNH RỜI RẠC)
            if url_str.starts_with("diark-sso://partial") {
                let partial_fragment = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://partial#"));
                if let Some(fragment) = partial_fragment {
                    let _ = handle_partial_checkpoint_sync(&partial_for_nav, "wecode-sso-login", fragment);
                }
                return false; // Chặn navigation, giữ nguyên DOM & context cho các batch tiếp theo trong queue
            }

            // 2. Intercept Callback (Atomic Commit)
            if url_str.starts_with(CALLBACK_SCHEME) {
                let fragment_opt = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://callback#"));
                if let Some(fragment) = fragment_opt {
                    let target = extract_query_param(fragment, "target");
                    if target == "wecode" {
                        let status = extract_query_param(fragment, "status");
                        if status == "success" {
                            println!("[SSO Final] Wecode auto-sync completed via background API engine!");
                            let _ = app_for_nav.emit("wecode-submissions-synced", ());
                            let _ = app_for_nav.emit("sso-callback-success", "wecode");
                        } else {
                            let wecode_reg = get_wecode_harvester_registry_static();
                            let db_state = app_for_nav.state::<SharedDb>();
                            let db_arc = db_state.inner().clone();
                            match wecode_reg.commit_session("wecode-sso-login", db_arc) {
                                Ok(count) => {
                                    println!("[SSO Final] Wecode Harvester committed {count} submissions successfully!");
                                    let _ = app_for_nav.emit("wecode-submissions-synced", ());
                                    let _ = app_for_nav.emit("sso-callback-success", "wecode");
                                }
                                Err(err) => {
                                    eprintln!("[SSO Final] ERROR in Wecode Harvester commit: {err}");
                                    let _ = app_for_nav.emit("sso-callback-error", err.to_string());
                                    let _ = app_for_nav.emit_to("main", "wecode-sync-failed", err.to_string());
                                }
                            }
                        }
                    } else {
                        // Legacy callback handling
                        if let Ok((t, data_str)) = parse_callback_fragment(fragment) {
                            let _ = handle_callback_payload_sync(&app_for_nav, &t, &data_str);
                        }
                    }
                }
                close_wecode_window(&app_for_nav);
                return false;
            }

            // 3. Intercept Callback Failed
            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                let reason = extract_query_param(url_str, "reason");
                let _ = app_for_nav.emit("sso-callback-failed", &reason);
                let _ = app_for_nav.emit_to("main", "wecode-sync-failed", &reason);
                close_wecode_window(&app_for_nav);
                return false;
            }

            // 4. Chặn rò rỉ bất kỳ diark-sso scheme nào
            if url_str.starts_with("diark-sso://") {
                return false;
            }

            // 5. Redirect-loop guard cho trang login
            if url_str.contains(WECODE_LOGIN_MARKER) {
                let attempts = redirect_attempts_for_nav.fetch_add(1, Ordering::SeqCst);
                if attempts >= MAX_LOGIN_REDIRECT_ATTEMPTS {
                    let _ = app_for_nav.emit("sso-callback-failed", "Quá số lần chuyển hướng đăng nhập (phát hiện vòng lặp)");
                    let _ = app_for_nav.emit_to(
                        "main",
                        "wecode-sync-failed",
                        "Quá số lần chuyển hướng đăng nhập (phát hiện vòng lặp)".to_string(),
                    );
                    close_wecode_window(&app_for_nav);
                    return false;
                }
            }

            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    let _ = window.show();
    Ok(())
}


fn close_silent_window(
    app: &AppHandle,
    window_label: &str,
    partial_registry: &PartialStateRegistry,
) {
    let harvester_reg = get_portal_harvester_registry_static();
    if let Ok(mut sessions) = harvester_reg.sessions.lock() {
        sessions.remove(window_label);
    }
    let wecode_reg = get_wecode_harvester_registry_static();
    if let Ok(mut sessions) = wecode_reg.sessions.lock() {
        sessions.remove(window_label);
    }
    if let Ok(mut states) = partial_registry.states.lock() {
        states.remove(window_label);
    }
    if let Some(window) = app.get_webview_window(window_label) {
        let _ = window.destroy();
    }
}

fn close_wecode_window(app: &AppHandle) {
    let partial_state_registry = if let Some(reg) = app.try_state::<PartialStateRegistry>() {
        reg.inner().clone()
    } else {
        PartialStateRegistry::default()
    };
    if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.cancel("wecode-sso-login");
    }
    close_silent_window(app, "wecode-sso-login", &partial_state_registry);
}

#[tauri::command]
pub async fn launch_portal_silent_sync(app: AppHandle) -> Result<(), String> {
    let window_label = "portal-silent-sync".to_string();

    let partial_state_registry = if let Some(reg) = app.try_state::<PartialStateRegistry>() {
        reg.inner().clone()
    } else {
        PartialStateRegistry::default()
    };

    close_silent_window(&app, &window_label, &partial_state_registry);

    let auth_url = WebviewUrl::External(
        "https://portal.uit.edu.vn/sinh-vien/bang-diem"
            .parse()
            .map_err(|e| format!("Invalid auth URL: {e}"))?,
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx_arc = Arc::new(StdMutex::new(Some(tx)));

    // 120s Watchdog
    let tx_watchdog = tx_arc.clone();
    let app_watchdog = app.clone();
    let label_watchdog = window_label.clone();
    let partial_watchdog = partial_state_registry.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        if let Ok(mut lock) = tx_watchdog.lock() {
            if let Some(sender) = lock.take() {
                close_silent_window(&app_watchdog, &label_watchdog, &partial_watchdog);
                let _ = sender.send(Err("TIMEOUT".to_string()));
            }
        }
    });

    let tx_nav = tx_arc.clone();
    let app_nav = app.clone();
    let label_nav = window_label.clone();
    let partial_for_nav = partial_state_registry.clone();

    let window = WebviewWindowBuilder::new(&app, &window_label, auth_url)
        .title("Diark Portal Silent Sync")
        .visible(false)
        .initialization_script(PORTAL_HARVESTER_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            // Detect expired auth / login redirect
            if url_str.contains("login.microsoftonline.com")
                || url_str.contains("/login")
                || url_str.contains("/dang-nhap")
                || (url_str.contains("microsoft") && !url_str.contains("diark-sso"))
            {
                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(Err("AUTH_EXPIRED".to_string()));
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            // 1. Intercept Final Callback (Atomic Persist)
            if url_str.starts_with("diark-sso://callback") {
                let callback_fragment = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://callback#"));
                let mut outcome = Ok(());
                if let Some(fragment) = callback_fragment {
                    match parse_callback_fragment(fragment) {
                        Ok((target, data_str)) => {
                            if target == "portal" {
                                let status = extract_query_param(fragment, "status");
                                if status == "success" {
                                    println!("[Portal Silent] Portal auto-sync completed via background API engine!");
                                    let _ = app_nav.emit("academic-data-synced", ());
                                } else {
                                    let harvester_reg = get_portal_harvester_registry_static();
                                    let db_state = app_nav.state::<SharedDb>();
                                    let db_arc = db_state.inner().clone();
                                    match harvester_reg.commit_session(&label_nav, db_arc) {
                                        Ok(total_courses) => {
                                            println!("[Portal Silent] Portal Harvester committed {total_courses} courses successfully!");
                                            let _ = app_nav.emit("academic-data-synced", ());
                                        }
                                        Err(err) => {
                                            eprintln!("[Portal Silent] ERROR in Portal Harvester commit: {err}");
                                            outcome = Err(format!("SERVER_ERROR: {err}"));
                                        }
                                    }
                                }
                            } else {
                                let final_payload = merge_with_partial_state(&partial_for_nav, &label_nav, &data_str);
                                match crate::commands::academic::ingest_full_academic_payload_sync(&app_nav, final_payload) {
                                    Ok(_) => {
                                        println!("[Portal Silent] Academic sync successfully committed to SQLite!");
                                        let _ = app_nav.emit("academic-data-synced", ());
                                    }
                                    Err(err) => {
                                        eprintln!("[Portal Silent] ERROR ingesting academic payload: {err}");
                                        outcome = Err(format!("SERVER_ERROR: {err}"));
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            eprintln!("[Portal Silent] ERROR parsing callback fragment: {err}");
                            outcome = Err(format!("SERVER_ERROR: {err}"));
                        }
                    }
                }

                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(outcome);
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            // 2. Intercept Partial Checkpoints
            if url_str.starts_with("diark-sso://partial") {
                let partial_fragment = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://partial#"));
                if let Some(fragment) = partial_fragment {
                    let _ = handle_partial_checkpoint_sync(&partial_for_nav, &label_nav, fragment);
                }
                return false;
            }

            // 3. Intercept Failure
            if url_str.starts_with("diark-sso://failed") {
                let reason = extract_query_param(url_str, "reason");
                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(Err(format!("SERVER_ERROR: {reason}")));
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            if url_str.starts_with("diark-sso://") {
                return false;
            }

            true
        })
        .build();

    if let Err(e) = window {
        return Err(format!("Failed to build silent portal webview: {e}"));
    }

    match rx.await {
        Ok(result) => result,
        Err(_) => Err("CANCELLED".to_string()),
    }
}

#[tauri::command]
pub async fn launch_wecode_silent_sync(app: AppHandle) -> Result<(), String> {
    let window_label = "wecode-silent-sync".to_string();

    let partial_state_registry = if let Some(reg) = app.try_state::<PartialStateRegistry>() {
        reg.inner().clone()
    } else {
        PartialStateRegistry::default()
    };

    close_silent_window(&app, &window_label, &partial_state_registry);

    let auth_url = WebviewUrl::External(
        WECODE_LOGIN_URL
            .parse()
            .map_err(|e| format!("Invalid Wecode URL: {e}"))?,
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx_arc = Arc::new(StdMutex::new(Some(tx)));

    // 120s Watchdog
    let tx_watchdog = tx_arc.clone();
    let app_watchdog = app.clone();
    let label_watchdog = window_label.clone();
    let partial_watchdog = partial_state_registry.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        if let Ok(mut lock) = tx_watchdog.lock() {
            if let Some(sender) = lock.take() {
                close_silent_window(&app_watchdog, &label_watchdog, &partial_watchdog);
                let _ = sender.send(Err("TIMEOUT".to_string()));
            }
        }
    });

    let tx_nav = tx_arc.clone();
    let app_nav = app.clone();
    let label_nav = window_label.clone();
    let partial_for_nav = partial_state_registry.clone();

    let window = WebviewWindowBuilder::new(&app, &window_label, auth_url)
        .title("Diark Wecode Silent Sync")
        .visible(false)
        .initialization_script(WECODE_HARVESTER_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            // Detect expired auth: redirecting to login page
            if url_str.contains(WECODE_LOGIN_MARKER) || (url_str.contains("/login") && !url_str.contains("diark-sso")) {
                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(Err("AUTH_EXPIRED".to_string()));
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            // Intercept Partial Submissions Checkpoint
            if url_str.starts_with("diark-sso://partial") {
                let partial_fragment = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://partial#"));
                if let Some(fragment) = partial_fragment {
                    let _ = handle_partial_checkpoint_sync(&partial_for_nav, &label_nav, fragment);
                }
                return false;
            }

            // Intercept Callback (Atomic Commit)
            if url_str.starts_with(CALLBACK_SCHEME) {
                let fragment_opt = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://callback#"));
                let mut outcome = Ok(());
                if let Some(fragment) = fragment_opt {
                    let target = extract_query_param(fragment, "target");
                    if target == "wecode" {
                        let status = extract_query_param(fragment, "status");
                        if status == "success" {
                            println!("[Wecode Silent] Wecode auto-sync completed via background API engine!");
                            let _ = app_nav.emit("wecode-submissions-synced", ());
                        } else {
                            let wecode_reg = get_wecode_harvester_registry_static();
                            let db_state = app_nav.state::<SharedDb>();
                            let db_arc = db_state.inner().clone();
                            match wecode_reg.commit_session(&label_nav, db_arc) {
                                Ok(count) => {
                                    println!("[Wecode Silent] Wecode Harvester committed {count} submissions successfully!");
                                    let _ = app_nav.emit("wecode-submissions-synced", ());
                                }
                                Err(err) => {
                                    eprintln!("[Wecode Silent] ERROR in Wecode Harvester commit: {err}");
                                    outcome = Err(format!("SERVER_ERROR: {err}"));
                                }
                            }
                        }
                    } else {
                        if let Ok((t, data_str)) = parse_callback_fragment(fragment) {
                            let _ = handle_callback_payload_sync(&app_nav, &t, &data_str);
                        }
                    }
                }

                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(outcome);
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            // Intercept Callback Failed
            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                let reason = extract_query_param(url_str, "reason");
                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(Err(format!("SERVER_ERROR: {reason}")));
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            // Prevent custom scheme leaks
            if url_str.starts_with("diark-sso://") {
                return false;
            }

            true
        })
        .build();

    if let Err(e) = window {
        return Err(format!("Failed to build silent wecode webview: {e}"));
    }

    match rx.await {
        Ok(result) => result,
        Err(_) => Err("CANCELLED".to_string()),
    }
}

fn close_moodle_window(app: &AppHandle) {
    let partial_state_registry = if let Some(reg) = app.try_state::<PartialStateRegistry>() {
        reg.inner().clone()
    } else {
        PartialStateRegistry::default()
    };
    if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.cancel("moodle-sso-login");
    }
    close_silent_window(app, "moodle-sso-login", &partial_state_registry);
}

#[tauri::command]
pub async fn launch_moodle_silent_sync(app: AppHandle) -> Result<(), String> {
    let window_label = "moodle-silent-sync".to_string();

    let partial_state_registry = if let Some(reg) = app.try_state::<PartialStateRegistry>() {
        reg.inner().clone()
    } else {
        PartialStateRegistry::default()
    };

    close_silent_window(&app, &window_label, &partial_state_registry);

    let auth_url = WebviewUrl::External(
        MOODLE_MY_URL
            .parse()
            .map_err(|e| format!("Invalid Moodle URL: {e}"))?,
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx_arc = Arc::new(StdMutex::new(Some(tx)));

    // 120s Watchdog Invariant
    let tx_watchdog = tx_arc.clone();
    let app_watchdog = app.clone();
    let label_watchdog = window_label.clone();
    let partial_watchdog = partial_state_registry.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        if let Ok(mut lock) = tx_watchdog.lock() {
            if let Some(sender) = lock.take() {
                close_silent_window(&app_watchdog, &label_watchdog, &partial_watchdog);
                let _ = sender.send(Err("TIMEOUT".to_string()));
            }
        }
    });

    let tx_nav = tx_arc.clone();
    let app_nav = app.clone();
    let label_nav = window_label.clone();
    let partial_for_nav = partial_state_registry.clone();

    let window = WebviewWindowBuilder::new(&app, &window_label, auth_url)
        .title("Diark Moodle Silent Sync")
        .visible(false)
        .initialization_script(MOODLE_HARVESTER_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            // Detect expired auth: redirected to login
            if url_str.contains("login.microsoftonline.com")
                || (url_str.contains("/login") && !url_str.contains("diark-sso"))
                || url_str.contains("/dang-nhap")
            {
                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(Err("AUTH_EXPIRED".to_string()));
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            // Intercept Callback (Atomic Commit)
            if url_str.starts_with(CALLBACK_SCHEME) {
                let fragment_opt = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://callback#"));
                if let Some(fragment) = fragment_opt {
                    let target = extract_query_param(fragment, "target");
                    if target == "moodle" {
                        println!("[Moodle Silent] Moodle sync completed via background API engine!");
                        let total_courses: usize = extract_query_param(fragment, "total_courses")
                            .parse()
                            .unwrap_or(0);
                        let _ = app_nav.emit("moodle-data-synced", total_courses);
                        let _ = app_nav.emit("sso-callback-success", "moodle");
                    }
                }

                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(Ok(()));
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            // Intercept Callback Failed
            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                let reason = extract_query_param(url_str, "reason");
                if let Ok(mut lock) = tx_nav.lock() {
                    if let Some(sender) = lock.take() {
                        let _ = sender.send(Err(format!("SERVER_ERROR: {reason}")));
                    }
                }
                close_silent_window(&app_nav, &label_nav, &partial_for_nav);
                return false;
            }

            if url_str.starts_with("diark-sso://") {
                return false;
            }

            true
        })
        .build();

    if let Err(e) = window {
        return Err(format!("Failed to build silent moodle webview: {e}"));
    }

    match rx.await {
        Ok(result) => result,
        Err(_) => Err("CANCELLED".to_string()),
    }
}

#[tauri::command]
pub async fn launch_moodle_sso_sync(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("moodle-sso-login") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let auth_url = WebviewUrl::External(
        MOODLE_MY_URL
            .parse()
            .map_err(|e| format!("Invalid Moodle URL: {e}"))?,
    );

    let token = if let Some(watchdog) = app.try_state::<WatchdogRegistry>() {
        watchdog.register("moodle-sso-login")
    } else {
        CancellationToken::new()
    };
    spawn_watchdog(app.clone(), "moodle-sso-login".to_string(), token);

    let app_for_nav = app.clone();

    let window = WebviewWindowBuilder::new(&app, "moodle-sso-login", auth_url)
        .title("Đồng bộ Courses UIT (Moodle)")
        .inner_size(900.0, 750.0)
        .resizable(true)
        .always_on_top(true)
        .initialization_script(MOODLE_HARVESTER_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            if url_str.starts_with(CALLBACK_SCHEME) {
                let fragment_opt = url.fragment().or_else(|| url_str.strip_prefix("diark-sso://callback#"));
                if let Some(fragment) = fragment_opt {
                    let target = extract_query_param(fragment, "target");
                    if target == "moodle" {
                        println!("[SSO Moodle] Moodle sync completed via interactive window!");
                        let total_courses: usize = extract_query_param(fragment, "total_courses")
                            .parse()
                            .unwrap_or(0);
                        let _ = app_for_nav.emit("moodle-data-synced", total_courses);
                        let _ = app_for_nav.emit(
                            "moodle-sync-progress",
                            serde_json::json!({
                                "current": total_courses,
                                "total": total_courses,
                                "course_name": "Hoàn tất đồng bộ",
                                "percent": 100.0,
                                "is_final": true
                            }),
                        );
                        let _ = app_for_nav.emit("sso-callback-success", "moodle");
                    }
                }
                close_moodle_window(&app_for_nav);
                return false;
            }

            if url_str.starts_with(CALLBACK_FAIL_SCHEME) {
                let reason = extract_query_param(url_str, "reason");
                let _ = app_for_nav.emit("sso-callback-error", reason.to_string());
                close_moodle_window(&app_for_nav);
                return false;
            }

            if url_str.starts_with("diark-sso://") {
                return false;
            }

            true
        })
        .build();

    if let Err(e) = window {
        return Err(format!("Failed to build moodle SSO webview: {e}"));
    }

    Ok(())
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
        let reason = extract_query_param(fail_url, "reason");
        assert_eq!(reason, "session_expired");
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
    fn test_wecode_scrape_envelope_status_enum() {
        let raw_envelope = json!({
            "status": "has_data",
            "rows": [
                {
                    "id": 201,
                    "class_name": "IT002.O21",
                    "title": "Assignment 2 - OOP"
                }
            ]
        });
        let json_str = serde_json::to_string(&raw_envelope).unwrap();
        let encoded_data = urlencoding::encode(&json_str);
        let fragment = format!("target=wecode&data={encoded_data}");

        let (target, data_str) = parse_callback_fragment(&fragment).unwrap();
        assert_eq!(target, "wecode");

        let parsed: Result<WecodeScrapeResultDto, _> = serde_json::from_str(&data_str);
        assert!(parsed.is_ok());
        let dto = parsed.unwrap();
        assert_eq!(dto.status, "has_data");
        assert_eq!(dto.rows.len(), 1);
        assert_eq!(dto.rows[0].id, 201);
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

    #[test]
    fn test_partial_checkpoint_sync_and_merge() {
        let registry = PartialStateRegistry::default();
        let label = "test-sso-window";

        // Step 1: Stage profile
        let profile_json = json!({
            "profile": {
                "student_id": "21520001",
                "full_name": "Nguyen Van B",
                "email": "21520001@gm.uit.edu.vn"
            }
        });
        let fragment_profile = format!("target=academic&stage=profile&data={}", urlencoding::encode(&profile_json.to_string()));
        let res = handle_partial_checkpoint_sync(&registry, label, &fragment_profile);
        assert!(res.is_ok());

        // Verify partial state recorded in-memory
        {
            let guard = registry.states.lock().unwrap();
            let state = guard.get(label).unwrap();
            assert!(state.profile.is_some());
            assert_eq!(state.profile.as_ref().unwrap()["student_id"], "21520001");
            assert!(state.courses.is_none());
        }

        // Step 2: Stage courses
        let courses_json = json!({
            "courses": [
                {
                    "course_code": "CS001",
                    "course_name": "CS Intro",
                    "credits": 4,
                    "total_score": 9.0
                }
            ]
        });
        let fragment_courses = format!("target=academic&stage=courses&data={}", urlencoding::encode(&courses_json.to_string()));
        let res = handle_partial_checkpoint_sync(&registry, label, &fragment_courses);
        assert!(res.is_ok());

        // Step 3: Final callback with only DRL data
        let final_drl = json!({
            "drl": [
                {
                    "semester": "2025-2026.1",
                    "score": 95
                }
            ]
        });
        let merged = merge_with_partial_state(&registry, label, &final_drl.to_string());

        assert_eq!(merged["profile"]["student_id"], "21520001");
        assert_eq!(merged["courses"][0]["course_code"], "CS001");
        assert_eq!(merged["drl"][0]["score"], 95);
    }

    #[test]
    fn test_academic_callback_scheme_parsing_and_isolation() {
        let payload = json!({
            "drl": [
                {
                    "semester": "2024-2025.2",
                    "score": 88,
                    "grade_text": "Tốt"
                }
            ],
            "drl_sync_status": "confirmed"
        });
        let payload_str = payload.to_string();
        let encoded_payload = urlencoding::encode(&payload_str);
        let uri = format!("diark-sso://callback#target=academic&data={encoded_payload}");

        assert!(uri.starts_with("diark-sso://callback"));
        assert!(!uri.starts_with("diark-sso://partial"));

        let fragment = uri.strip_prefix("diark-sso://callback#").unwrap();
        let (target, data_str) = parse_callback_fragment(fragment).unwrap();
        assert_eq!(target, "academic");

        let parsed: serde_json::Value = serde_json::from_str(&data_str).unwrap();
        assert_eq!(parsed["drl_sync_status"], "confirmed");
        assert_eq!(parsed["drl"][0]["score"], 88);
    }
}

