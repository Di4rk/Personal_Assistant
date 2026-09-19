//! IPC Commands — Academic Radar
//!
//! Tất cả commands ở đây đều map lỗi về `String` tại ranh giới IPC theo đúng
//! pattern của codebase (xem commands/mod.rs). Không dùng AppError trực tiếp
//! trong return type của #[tauri::command] vì Tauri cần type implement Serialize,
//! và String là cách đơn giản nhất đảm bảo điều đó.

use crate::db::{
    get_all_semesters_with_stats, get_courses_by_semester, upsert_courses, upsert_semester,
    AcademicCourseRecord, SemesterOverview, SharedDb, UpsertCourseDto, UpsertSemesterDto,
};
use crate::services::uit_portal::{ingest_portal_transcript, RawPortalSemester};
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub type AcademicOverviewDto = SemesterOverview;

/// Trả về toàn bộ học kỳ kèm chỉ số GPA/DRL tính LIVE từ SQL aggregate.
///
/// Frontend gọi 1 lần duy nhất để render overview table. Không cache ở Rust —
/// SQLite đủ nhanh cho dataset cá nhân (< vài trăm môn học).
#[tauri::command]
pub fn get_academic_overview(db: tauri::State<'_, SharedDb>) -> Result<Vec<SemesterOverview>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_all_semesters_with_stats(&conn).map_err(|e| format!("Lỗi get_academic_overview: {e}"))
}

/// Trả về danh sách môn học của 1 học kỳ cụ thể.
#[tauri::command]
pub fn get_semester_courses(
    db: tauri::State<'_, SharedDb>,
    semester_id: String,
) -> Result<Vec<AcademicCourseRecord>, String> {
    if semester_id.trim().is_empty() {
        return Err("semester_id không được để trống".to_string());
    }
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    get_courses_by_semester(&conn, &semester_id)
        .map_err(|e| format!("Lỗi get_semester_courses: {e}"))
}

/// Upsert batch nhiều môn học trong 1 transaction.
///
/// Frontend gọi sau khi user nhập bảng điểm. Backend tự động:
/// 1. Tính `summary_score_10` từ midterm/final nếu chưa có.
/// 2. Quy đổi sang hệ 4 và grade char theo quy chế ĐHQG-HCM.
/// 3. Dedup theo `(semester_id, course_code)` qua ON CONFLICT.
#[tauri::command]
pub fn upsert_academic_courses(
    db: tauri::State<'_, SharedDb>,
    courses: Vec<UpsertCourseDto>,
) -> Result<(), String> {
    if courses.is_empty() {
        return Ok(());
    }
    // Validate trước khi lock DB — fail nhanh không tốn lock time.
    for c in &courses {
        if c.semester_id.trim().is_empty() {
            return Err(format!(
                "course '{}': semester_id không được trống",
                c.course_code
            ));
        }
        if c.course_code.trim().is_empty() {
            return Err("course_code không được trống".to_string());
        }
        if c.credits < 1 {
            return Err(format!(
                "course '{}': credits phải >= 1, got {}",
                c.course_code, c.credits
            ));
        }
    }

    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    upsert_courses(&mut conn, &courses)
        .map_err(|e| format!("Lỗi upsert_academic_courses: {e}"))
}

/// Tạo hoặc cập nhật metadata học kỳ (chỉ tiêu, trạng thái hoàn thành).
/// Không ảnh hưởng đến dữ liệu điểm hay DRL.
#[tauri::command]
pub fn upsert_academic_semester(
    db: tauri::State<'_, SharedDb>,
    semester: UpsertSemesterDto,
) -> Result<(), String> {
    if semester.id.trim().is_empty() {
        return Err("semester id không được trống".to_string());
    }
    if semester.academic_year.trim().is_empty() {
        return Err("academic_year không được trống".to_string());
    }
    if !(1..=3).contains(&semester.semester_term) {
        return Err(format!(
            "semester_term phải là 1, 2, hoặc 3 — got {}",
            semester.semester_term
        ));
    }

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    upsert_semester(&conn, &semester)
        .map_err(|e| format!("Lỗi upsert_academic_semester: {e}"))
}

const PORTAL_BANG_DIEM_URL: &str = "https://portal.uit.edu.vn/sinh-vien/bang-diem";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", content = "message")]
pub enum UitSyncState {
    Opening,
    Authenticating,
    Extracting,
    Parsing,
    Persisting,
    Completed,
    Failed(String),
}

/// Rust-Owned Lifecycle Controller: Mở cửa sổ SSO độc lập (không cấp quyền IPC cho remote webview),
/// tự động trích xuất bảng điểm Next.js đã hydrate qua eval DOM và đồng bộ vào SQLite.
#[tauri::command]
pub async fn sync_uit_portal(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<AcademicOverviewDto, String> {
    // 1. Emit State: Opening
    let _ = app.emit("academic://sync-state", UitSyncState::Opening);

    let window_label = "uit-sso-auth";
    if let Some(existing) = app.get_webview_window(window_label) {
        let _ = existing.close();
    }

    let url_parsed = PORTAL_BANG_DIEM_URL
        .parse()
        .map_err(|e| format!("URL không hợp lệ: {e}"))?;

    // Remote webview KHÔNG được cấp bất kỳ capability nào để gọi IPC commands (P0 Zero-Trust)
    let sso_window = WebviewWindowBuilder::new(&app, window_label, WebviewUrl::External(url_parsed))
        .title("Cổng thông tin UIT - Xác thực Sinh viên")
        .inner_size(950.0, 700.0)
        .center()
        .build()
        .map_err(|e| format!("Failed to create SSO window: {e}"))?;

    let _ = app.emit("academic://sync-state", UitSyncState::Authenticating);

    // Reset store HTML tạm thời
    let html_store = crate::server::get_extracted_html_store();
    if let Ok(mut guard) = html_store.lock() {
        *guard = None;
    }

    // 2. Poll kiểm tra xem DOM bảng điểm đã load xong chưa bằng Rust eval (timeout 120s)
    let extraction_script = r#"
        (async function() {
            try {
                const sleep = ms => new Promise(r => setTimeout(r, ms));
                const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
                const summaryBtn = tabs.find(t => t.innerText && t.innerText.includes('Tổng kết theo kỳ'));
                const semesterBtn = tabs.find(t => t.innerText && t.innerText.includes('Chi tiết môn học'));
                const ctdtBtn = tabs.find(t => t.innerText && t.innerText.includes('Theo CTĐT'));

                if (summaryBtn && semesterBtn && ctdtBtn) {
                    // 1. Lấy Tab Summary
                    summaryBtn.click();
                    await sleep(250);
                    const summaryPanel = document.querySelector('div#radix-\\3a r0\\3a-content-summary') || document.querySelector('div[role="tabpanel"][data-state="active"]');
                    const summaryHtml = summaryPanel ? (summaryPanel.outerHTML || summaryPanel.innerHTML) : '';

                    // 2. Lấy Tab By-Semester
                    semesterBtn.click();
                    await sleep(350);
                    const semesterPanel = document.querySelector('div#radix-\\3a r0\\3a-content-by-semester') || document.querySelector('div[role="tabpanel"][data-state="active"]');
                    const semesterHtml = semesterPanel ? (semesterPanel.outerHTML || semesterPanel.innerHTML) : '';

                    // 3. Lấy Tab By-CTDT
                    ctdtBtn.click();
                    await sleep(350);
                    const ctdtPanel = document.querySelector('div#radix-\\3a r0\\3a-content-by-ctdt') || document.querySelector('div[role="tabpanel"][data-state="active"]');
                    const ctdtHtml = ctdtPanel ? (ctdtPanel.outerHTML || ctdtPanel.innerHTML) : '';

                    if (summaryHtml && semesterHtml && ctdtHtml) {
                        const payload = JSON.stringify({
                            summary: summaryHtml,
                            by_semester: semesterHtml,
                            by_ctdt: ctdtHtml
                        });
                        fetch('http://127.0.0.1:3030/api/v1/academic/transcript', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ html: payload })
                        }).catch(() => {});
                        return true;
                    }
                }

                // Fallback: nếu trang đang ở chế độ xem một bảng điểm đơn lẻ
                const table = document.querySelector('div.bang-diem-print-root') || document.querySelector('main') || document.querySelector('table');
                if (table && document.body.innerText.includes('Mã môn') && (document.body.innerText.includes('Điểm TB') || document.body.innerText.includes('Điểm HP') || document.body.innerText.includes('Tín chỉ'))) {
                    fetch('http://127.0.0.1:3030/api/v1/academic/transcript', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ html: table.outerHTML || table.innerHTML })
                    }).catch(() => {});
                    return true;
                }
            } catch(e) {}
            return false;
        })();
    "#;

    let mut extracted_html: Option<String> = None;
    let start_time = std::time::Instant::now();

    while start_time.elapsed().as_secs() < 120 {
        tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

        // Nếu user tắt cửa sổ giữa chừng -> Abort
        if app.get_webview_window(window_label).is_none() {
            let _ = app.emit(
                "academic://sync-state",
                UitSyncState::Failed("User closed window".into()),
            );
            return Err("Quá trình đăng nhập bị hủy bởi người dùng".into());
        }

        // Kiểm tra xem đã nhận được chuỗi HTML qua local bridge chưa
        if let Ok(mut guard) = html_store.lock() {
            if let Some(html) = guard.take() {
                extracted_html = Some(html);
                break;
            }
        }

        // Rust chủ động execute JS trên window và hứng kết quả (tránh remote IPC)
        let _ = sso_window.eval(extraction_script);
        let _ = app.emit("academic://sync-state", UitSyncState::Extracting);
    }

    // 3. Parsing Phase (KHÔNG LOCK DB)
    let _ = app.emit("academic://sync-state", UitSyncState::Parsing);
    let raw_html = extracted_html.ok_or_else(|| {
        let _ = app.emit(
            "academic://sync-state",
            UitSyncState::Failed("Hết thời gian chờ đăng nhập/bảng điểm (120s)".into()),
        );
        "Hết thời gian chờ đăng nhập/bảng điểm (120s)".to_string()
    })?;

    let unified_data = crate::modules::academic::parser::parse_unified_portal_payload(&raw_html)?;

    // 4. Persistence Phase (Lock DB ngắn hạn trong 1 transaction duy nhất)
    let _ = app.emit("academic://sync-state", UitSyncState::Persisting);
    {
        let mut conn = db.lock().map_err(|_| "Database lock poisoned".to_string())?;
        crate::db::academic::persist_unified_academic_sync(&mut conn, &unified_data)
            .map_err(|e| format!("Database persist error: {e}"))?;
    }

    // 5. Bước bổ sung: Cào trang ĐRL và cập nhật `drl` vào macro_metrics
    //    Bước này NON-FATAL: nếu thất bại chỉ emit warning, không abort sync.
    let _ = app.emit("academic://sync-state", UitSyncState::Extracting);

    const PORTAL_DRL_URL: &str = "https://portal.uit.edu.vn/sinh-vien/diem-ren-luyen";

    'drl_phase: {
        let Ok(drl_url) = tauri::Url::parse(PORTAL_DRL_URL) else {
            let _ = app.emit("academic://sync-warning", "URL trang ĐRL không hợp lệ");
            break 'drl_phase;
        };

        // Navigate webview hiện tại sang trang DRL (navigate nhận url::Url)
        if let Err(e) = sso_window.navigate(drl_url) {
            let _ = app.emit("academic://sync-warning", format!("Navigate DRL thất bại: {e}"));
            break 'drl_phase;
        }

        // Reset DRL store trước khi bắt đầu poll
        let drl_store = crate::server::get_extracted_drl_html_store();
        if let Ok(mut guard) = drl_store.lock() {
            *guard = None;
        }

        // JS script: chờ trang hydrate xong rồi POST outerHTML qua local bridge.
        // Dùng fetch (fire-and-forget) vì eval() không trả giá trị trong Tauri v2.
        let drl_extraction_script = r#"
            (async function() {
                try {
                    const sleep = ms => new Promise(r => setTimeout(r, ms));
                    const main = document.querySelector('main#main-content, main, div[role="main"]');
                    if (main && main.innerText && main.innerText.includes('r\u1ecdn luy\u1ec7n')) {
                        fetch('http://127.0.0.1:3030/api/v1/academic/drl', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ html: main.outerHTML })
                        }).catch(() => {});
                    }
                } catch(e) {}
            })();
        "#;

        // Poll store tối đa 20s (1.5s/lần)
        let mut extracted_drl_html: Option<String> = None;
        let drl_start = std::time::Instant::now();

        while drl_start.elapsed().as_secs() < 20 {
            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

            // Nếu user tắt cửa sổ → abort
            if app.get_webview_window(window_label).is_none() {
                break;
            }

            // Kiểm tra store
            if let Ok(mut guard) = drl_store.lock() {
                if let Some(html) = guard.take() {
                    extracted_drl_html = Some(html);
                    break;
                }
            }

            // Fire JS eval (không lấy return value)
            let _ = sso_window.eval(drl_extraction_script);
        }

        let Some(html) = extracted_drl_html else {
            let _ = app.emit("academic://sync-warning", "Hết thời gian chờ trang ĐRL (20s) — bỏ qua");
            break 'drl_phase;
        };

        match crate::modules::academic::parser::parse_portal_drl(&html) {
            Ok(drl_data) => {
                let mut conn = db.lock().map_err(|_| "Database lock poisoned".to_string())?;
                match crate::db::academic::update_drl_from_portal(&mut conn, &drl_data) {
                    Ok(n) => {
                        let _ = app.emit("academic://sync-state", UitSyncState::Persisting);
                        let _ = app.emit(
                            "academic://drl-updated",
                            format!("Đã cập nhật DRL cho {n} học kỳ (điểm TB toàn khóa: {})", drl_data.cumulative_drl),
                        );
                    }
                    Err(e) => {
                        let _ = app.emit("academic://sync-warning", format!("Ghi DRL thất bại: {e}"));
                    }
                }
            }
            Err(e) => {
                let _ = app.emit("academic://sync-warning", format!("Parse DRL thất bại: {e}"));
            }
        }
    }

    // 6. Cleanup & Emit Complete
    if let Some(win) = app.get_webview_window(window_label) {
        let _ = win.close();
    }

    let _ = app.emit("academic://sync-state", UitSyncState::Completed);
    let _ = app.emit("academic://sync-complete", ());

    // Return latest overview
    let conn = db.lock().map_err(|_| "Database lock poisoned".to_string())?;
    let overviews = crate::modules::academic::db::calculate_academic_overview(&conn)
        .map_err(|e| e.to_string())?;

    overviews
        .first()
        .cloned()
        .ok_or_else(|| "Không tìm thấy dữ liệu học kỳ sau khi nạp".to_string())
}

/// Alias đồng bộ tương thích ngược với Sprint V0.3.1 trước đó
#[tauri::command]
pub async fn sync_portal_uit_data(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<AcademicOverviewDto, String> {
    sync_uit_portal(app, db).await
}

/// Ingest trực tiếp payload bảng điểm (từ fallback parser / paste).
#[tauri::command]
pub async fn submit_portal_transcript(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
    semesters: Vec<RawPortalSemester>,
) -> Result<AcademicOverviewDto, String> {
    if semesters.is_empty() {
        return Err("Payload bảng điểm học kỳ không có dữ liệu".to_string());
    }

    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let overview = ingest_portal_transcript(&mut conn, &semesters)
        .map_err(|e| format!("Lỗi nạp bảng điểm UIT: {e}"))?;

    // Đóng popup SSO nếu đang mở
    if let Some(w) = app.get_webview_window("uit-sso-auth") {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window("sso-login") {
        let _ = w.close();
    }

    // Trigger event academic://sync-complete
    let _ = app.emit("academic://sync-complete", &overview);

    Ok(overview)
}

/// Lấy toàn bộ macro metrics chính thức đối soát từ Cổng UIT
#[tauri::command]
pub fn get_academic_macro_metrics(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<crate::modules::academic::parser::MacroMetricRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::academic::get_all_macro_metrics(&conn)
        .map_err(|e| format!("Lỗi get_academic_macro_metrics: {e}"))
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicRadarMetrics {
    pub semester_id: String,
    pub term_gpa: f64,
    pub cumulative_gpa: f64,
    pub classification: String,
    pub term_credits: i64,
    pub cumulative_credits: i64,
    pub drl: Option<i64>,
}

/// Lấy toàn bộ radar metrics (hỗ trợ hiển thị và đối soát ĐRL với Option<i64> chuẩn xác).
#[tauri::command]
pub fn get_academic_radar_metrics(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<AcademicRadarMetrics>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl
             FROM academic_macro_metrics
             ORDER BY semester_id ASC",
        )
        .map_err(|e| format!("Lỗi prepare query: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(AcademicRadarMetrics {
                semester_id: row.get(0)?,
                term_gpa: row.get(1)?,
                cumulative_gpa: row.get(2)?,
                classification: row.get(3)?,
                term_credits: row.get(4)?,
                cumulative_credits: row.get(5)?,
                drl: row.get::<_, Option<i64>>(6)?,
            })
        })
        .map_err(|e| format!("Lỗi query: {e}"))?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| e.to_string())?);
    }
    Ok(list)
}

pub fn ingest_drl_records(tx: &rusqlite::Transaction, drl_list: &[serde_json::Value]) -> Result<(), String> {
    for entry in drl_list {
        let semester = match entry.get("semester").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.trim(),
            _ => continue,
        };
        let score = match entry.get("score").and_then(|v| {
            if let Some(i) = v.as_i64() {
                Some(i)
            } else if let Some(s) = v.as_str() {
                s.trim().parse::<i64>().ok()
            } else if let Some(f) = v.as_f64() {
                Some(f as i64)
            } else {
                None
            }
        }) {
            Some(s) => s,
            None => continue,
        };
        let grade_text = entry.get("grade_text")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        tx.execute(
            "INSERT INTO academic_drl (semester, score, grade_text, updated_at)
             VALUES (?1, ?2, ?3, strftime('%s','now'))
             ON CONFLICT(semester) DO UPDATE SET
               score = excluded.score,
               grade_text = excluded.grade_text,
               updated_at = excluded.updated_at",
            rusqlite::params![semester, score, grade_text],
        ).map_err(|e| format!("Insert DRL for '{semester}' failed: {e}"))?;
    }
    Ok(())
}

/// Ghi đồng bộ dữ liệu học vụ vào SQLite trong 1 transaction duy nhất (Atomic Ingestion).
/// Tuyệt đối không ghi partial data trước đó; xử lý DRL Option<i64> (lưu NULL nếu vắng mặt, không ép về 0).
pub fn ingest_full_academic_payload_sync(
    app: &tauri::AppHandle,
    final_payload: serde_json::Value,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;

    let state = app.state::<SharedDb>();
    let mut conn = state.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    let tx = conn.transaction().map_err(|e| format!("Transaction error: {e}"))?;

    // 0. Đảm bảo bảng academic_drl tồn tại và có cột grade_text
    tx.execute(
        "CREATE TABLE IF NOT EXISTS academic_drl (
            semester TEXT PRIMARY KEY,
            score INTEGER NOT NULL,
            grade_text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        )",
        [],
    ).map_err(|e| format!("Lỗi tạo bảng academic_drl: {e}"))?;
    let _ = tx.execute("ALTER TABLE academic_drl ADD COLUMN grade_text TEXT NOT NULL DEFAULT ''", []);

    // 1. Lưu student_profile nếu có dữ liệu hồ sơ
    let profile_opt: Option<StudentProfilePayload> = if let Some(p_val) = final_payload.get("profile") {
        serde_json::from_value(p_val.clone()).ok()
    } else if final_payload.get("student_id").is_some() {
        serde_json::from_value(final_payload.clone()).ok()
    } else {
        None
    };

    if let Some(ref profile) = profile_opt {
        let upsert_setting = |key: &str, value: &str, t: &rusqlite::Transaction| -> Result<(), String> {
            t.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![key, value],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        };

        if !profile.student_id.trim().is_empty() {
            upsert_setting("student_id", profile.student_id.trim(), &tx)?;
        }
        if !profile.full_name.trim().is_empty() {
            upsert_setting("student_name", profile.full_name.trim(), &tx)?;
        }
        if !profile.faculty.is_empty() {
            upsert_setting("faculty", &profile.faculty, &tx)?;
        }
        if !profile.major_code.is_empty() {
            upsert_setting("major_code", &profile.major_code, &tx)?;
        }
        if !profile.specialization.is_empty() {
            upsert_setting("specialization", &profile.specialization, &tx)?;
        }
        if !profile.student_class.is_empty() {
            upsert_setting("student_class", &profile.student_class, &tx)?;
        }
        if !profile.curriculum_code.is_empty() {
            upsert_setting("curriculum_code", &profile.curriculum_code, &tx)?;
        }
        if !profile.cohort.is_empty() {
            upsert_setting("admission_year", &profile.cohort, &tx)?;
        }

        let current_major: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = 'user_major'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let should_upgrade_major = match current_major.as_deref() {
            None => true,
            Some(v) => v == DEFAULT_MAJOR_SENTINEL,
        };

        if should_upgrade_major && !profile.specialization.trim().is_empty() {
            upsert_setting("user_major", &profile.specialization, &tx)?;
        }

        if let Ok(res) = crate::modules::academic::curriculum_resolver::resolve_curriculum(
            &tx,
            &profile.curriculum_code,
            Some(&profile.major_code),
        ) {
            let _ = tx.execute(
                "INSERT INTO academic_program_summary (id, total_degree_credits, updated_at)
                 VALUES ('MAIN', ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET total_degree_credits = excluded.total_degree_credits",
                rusqlite::params![res.total_credits, chrono::Utc::now().timestamp()],
            );
        }
    }

    // 2. Lưu danh sách môn học vào academic_courses
    let now = chrono::Utc::now().timestamp();
    let mut term_credits_sum: i64 = 0;
    let mut gpa_numerator: f64 = 0.0;
    let mut gpa_credits: i64 = 0;
    let mut semester_id_resolved = "2025-2026.1".to_string();

    let mut courses_to_insert: Vec<(String, String, String, i64, Option<f64>)> = Vec::new();

    if let Some(courses_arr) = final_payload.get("courses").and_then(|v| v.as_array()) {
        for c_val in courses_arr {
            let code = c_val.get("course_code").or_else(|| c_val.get("subject_code")).and_then(|v| v.as_str()).unwrap_or("");
            let name = c_val.get("course_name").or_else(|| c_val.get("subject_name")).and_then(|v| v.as_str()).unwrap_or("");
            let credits = c_val.get("credits").or_else(|| c_val.get("number_of_credit")).and_then(|v| v.as_i64()).unwrap_or(0);
            let sem_id = c_val.get("semester_id").and_then(|v| v.as_str()).unwrap_or("2025-2026.1");
            let score = c_val.get("total_score").or_else(|| c_val.get("final_score")).or_else(|| c_val.get("course_point"))
                .and_then(|v| if let Some(n) = v.as_f64() { Some(n) } else if let Some(s) = v.as_str() { s.trim().parse::<f64>().ok() } else { None });

            if !code.is_empty() {
                courses_to_insert.push((sem_id.to_string(), code.to_string(), name.to_string(), credits, score));
            }
        }
    }

    if courses_to_insert.is_empty() {
        if let Some(t_obj) = final_payload.get("transcript").or_else(|| final_payload.get("semester_groups")) {
            let groups = if let Some(arr) = t_obj.as_array() {
                Some(arr.clone())
            } else {
                t_obj.get("semester_groups").and_then(|v| v.as_array()).cloned()
            };

            if let Some(arr) = groups {
                for grp in arr {
                    let sem_name = grp.get("semester_name").or_else(|| grp.get("semester_label")).and_then(|v| v.as_str()).unwrap_or("2025-2026.1");
                    if let Some(subj_arr) = grp.get("courses").or_else(|| grp.get("subjects")).and_then(|v| v.as_array()) {
                        for c_val in subj_arr {
                            let code = c_val.get("course_code").or_else(|| c_val.get("subject_code")).and_then(|v| v.as_str()).unwrap_or("");
                            let name = c_val.get("course_name").or_else(|| c_val.get("subject_name")).and_then(|v| v.as_str()).unwrap_or("");
                            let credits = c_val.get("credits").or_else(|| c_val.get("number_of_credit")).and_then(|v| v.as_i64()).unwrap_or(0);
                            let score = c_val.get("total_score").or_else(|| c_val.get("final_score")).or_else(|| c_val.get("course_point"))
                                .and_then(|v| if let Some(n) = v.as_f64() { Some(n) } else if let Some(s) = v.as_str() { s.trim().parse::<f64>().ok() } else { None });

                            if !code.is_empty() {
                                courses_to_insert.push((sem_name.to_string(), code.to_string(), name.to_string(), credits, score));
                            }
                        }
                    }
                }
            }
        }
    }

    for (sem_id, code, name, credits, score) in courses_to_insert {
        semester_id_resolved = sem_id.clone();
        if let Some(sc) = score {
            if credits > 0 {
                gpa_numerator += sc * (credits as f64);
                gpa_credits += credits;
            }
        }
        term_credits_sum += credits;

        // Đảm bảo academic_semesters có bản ghi để thỏa mãn foreign key
        let _ = tx.execute(
            "INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
            rusqlite::params![sem_id, "2025-2026", 1, now],
        );

        let id = format!("{sem_id}_{code}");
        let is_passed = score.map(|s| s >= 5.0).unwrap_or(false);
        let course_point_val: f64 = score.unwrap_or(0.0);

        tx.execute(
            "INSERT INTO academic_courses 
                (id, semester_id, course_code, course_name, credits, course_point, final_score, summary_score_10, is_passed, is_gpa_calculated, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, 1, ?9, ?9)
             ON CONFLICT(semester_id, course_code) DO UPDATE SET
                course_name = excluded.course_name,
                credits = excluded.credits,
                course_point = excluded.course_point,
                final_score = excluded.final_score,
                summary_score_10 = excluded.summary_score_10,
                is_passed = excluded.is_passed,
                updated_at = excluded.updated_at",
            rusqlite::params![id, sem_id, code, name, credits, course_point_val, score, is_passed as i64, now],
        ).map_err(|e| format!("Lỗi insert academic_courses ({code}): {e}"))?;
    }

    // 3. Xử lý DRL (Data Integrity Guard) & Macro Metrics
    let sync_status = final_payload.get("drl_sync_status")
        .and_then(|s| s.as_str())
        .unwrap_or("confirmed");

    let drl_array = final_payload.get("drl").and_then(|d| d.as_array());

    // 1. Lưu từng học kỳ DRL nếu status là 'confirmed' và mảng có dữ liệu
    if sync_status == "confirmed" {
        if let Some(list) = drl_array {
            ingest_drl_records(&tx, list)?;
        }
    }

    // 2. Tính toán điểm DRL đại diện cho macro metrics (Học kỳ mới nhất hoặc trung bình)
    let latest_drl_score: Option<i64> = if sync_status == "timeout_unknown" {
        None
    } else {
        drl_array
            .and_then(|arr| arr.first())
            .and_then(|v| {
                if let Some(i) = v.get("score").and_then(|s| s.as_i64()) {
                    Some(i)
                } else if let Some(s) = v.get("score").and_then(|s| s.as_str()) {
                    s.trim().parse::<i64>().ok()
                } else if let Some(f) = v.get("score").and_then(|s| s.as_f64()) {
                    Some(f as i64)
                } else {
                    None
                }
            })
    };

    let calculated_gpa = if gpa_credits > 0 {
        (gpa_numerator / (gpa_credits as f64) * 100.0).round() / 100.0
    } else {
        0.0
    };
    let term_gpa = calculated_gpa;
    let cumulative_gpa = calculated_gpa;
    let classification = if cumulative_gpa >= 9.0 {
        "Xuất sắc"
    } else if cumulative_gpa >= 8.0 {
        "Giỏi"
    } else if cumulative_gpa >= 6.5 {
        "Khá"
    } else if cumulative_gpa >= 5.0 {
        "Trung bình"
    } else if cumulative_gpa > 0.0 {
        "Yếu"
    } else {
        "Chưa xếp loại"
    };
    let term_credits = term_credits_sum;
    let cumulative_credits = term_credits_sum;

    tx.execute(
        "INSERT INTO academic_macro_metrics (semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'))
         ON CONFLICT(semester_id) DO UPDATE SET
           term_gpa = excluded.term_gpa,
           cumulative_gpa = excluded.cumulative_gpa,
           classification = excluded.classification,
           term_credits = excluded.term_credits,
           cumulative_credits = excluded.cumulative_credits,
           drl = excluded.drl,
           updated_at = excluded.updated_at",
        rusqlite::params![semester_id_resolved, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, latest_drl_score],
    ).map_err(|e| format!("Failed to update macro metrics with DRL: {e}"))?;

    tx.commit().map_err(|e| format!("Lỗi commit transaction: {e}"))?;

    if let Some(profile) = profile_opt {
        let _ = app.emit("student-profile-synced", &profile);
    }
    let _ = app.emit("academic://sync-complete", ());
    let _ = app.emit("academic-data-synced", ());

    Ok(())
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicMacroMetricSSOT {
    pub semester_id: String,
    pub semester_label: String,
    pub year_name: String,
    pub term_gpa: f64,
    pub cumulative_gpa: f64,
    pub term_credits: i64,
    pub cumulative_credits: i64,
    pub drl_score: i64,
    pub rank_label: String,
    pub updated_at: i64,
}

pub fn ingest_full_academic_payload_internal(
    app: &tauri::AppHandle,
    state: &tauri::State<crate::db::SharedDb>,
    transcript: serde_json::Value,
    drl: serde_json::Value,
) -> Result<(), String> {
    let mut conn = state.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    // Chuyển đổi transcript và drl thành IngestionPayload
    let mut payload = if let Ok(dyn_payload) = serde_json::from_value::<crate::modules::academic::portal_ingestion::IngestionPayload>(transcript.clone()) {
        dyn_payload
    } else if let Ok(groups) = serde_json::from_value::<Vec<crate::modules::academic::portal_ingestion::GenericSemesterGroup>>(transcript.clone()) {
        crate::modules::academic::portal_ingestion::IngestionPayload {
            semester_groups: groups,
            term_summaries: None,
            drl: None,
        }
    } else {
        return Err("Không thể parse transcript JSON payload".to_string());
    };

    if let Ok(drl_items) = serde_json::from_value::<Vec<crate::modules::academic::portal_ingestion::GenericDrlItem>>(drl.clone()) {
        payload.drl = Some(drl_items);
    } else if let Ok(drl_obj) = serde_json::from_value::<crate::modules::academic::portal_ingestion::IngestionPayload>(drl.clone()) {
        if drl_obj.drl.is_some() {
            payload.drl = drl_obj.drl;
        }
    }

    crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(&mut conn, payload)?;

    // Đồng bộ total_degree_credits theo curriculum resolved từ settings
    let (curriculum_code, major_code) = {
        let get_val = |k: &str| -> String {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [k],
                |r| r.get(0),
            ).unwrap_or_default()
        };
        (get_val("curriculum_code"), get_val("major_code"))
    };
    if let Ok(res) = crate::modules::academic::curriculum_resolver::resolve_curriculum(
        &conn,
        &curriculum_code,
        if major_code.is_empty() { None } else { Some(&major_code) },
    ) {
        let _ = conn.execute(
            "INSERT INTO academic_program_summary (id, total_degree_credits, updated_at)
             VALUES ('MAIN', ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET total_degree_credits = excluded.total_degree_credits",
            rusqlite::params![res.total_credits, chrono::Utc::now().timestamp()],
        );
    }

    let _ = app.emit("academic://sync-complete", ());
    let _ = app.emit("academic-data-synced", ());
    Ok(())
}

/// Nạp toàn bộ bảng điểm và lịch sử ĐRL từ JSON payload
#[tauri::command]
pub fn ingest_full_academic_payload(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    match payload {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => {
            // Thử deserialize thành IngestionPayload trước
            if let Ok(dyn_payload) = serde_json::from_str::<crate::modules::academic::portal_ingestion::IngestionPayload>(&s) {
                crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(&mut conn, dyn_payload)?;
            } else {
                let req: crate::modules::academic::portal_ingestion::FullPortalIngestionRequest =
                    serde_json::from_str(&s).map_err(|e| format!("Lỗi parse JSON payload: {e}"))?;
                crate::modules::academic::portal_ingestion::execute_portal_ingest(&mut conn, req)?;
            }
        }
        Some(v) if !v.is_null() => {
            if let Ok(dyn_payload) = serde_json::from_value::<crate::modules::academic::portal_ingestion::IngestionPayload>(v.clone()) {
                crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(&mut conn, dyn_payload)?;
            } else {
                let req: crate::modules::academic::portal_ingestion::FullPortalIngestionRequest =
                    serde_json::from_value(v).map_err(|e| format!("Lỗi parse object payload: {e}"))?;
                crate::modules::academic::portal_ingestion::execute_portal_ingest(&mut conn, req)?;
            }
        }
        _ => {
            let req = crate::modules::academic::portal_ingestion::get_default_portal_seed();
            crate::modules::academic::portal_ingestion::execute_portal_ingest(&mut conn, req)?;
        }
    };

    let _ = app.emit("academic://sync-complete", ());
    let _ = app.emit("academic-data-synced", ());
    Ok(())
}


/// Nạp dữ liệu học vụ linh hoạt từ chuỗi JSON generic.
/// Luôn dùng kết nối từ AppState.db (không tạo Connection::open riêng lẻ).
#[tauri::command]
pub fn ingest_dynamic_academic_data(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
    payload_json: String,
) -> Result<(), String> {
    let payload: crate::modules::academic::portal_ingestion::IngestionPayload =
        serde_json::from_str(&payload_json).map_err(|e| format!("Lỗi parse JSON payload: {e}"))?;

    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::modules::academic::portal_ingestion::ingest_dynamic_academic_payload(&mut conn, payload)?;

    let _ = app.emit("academic://sync-complete", ());
    Ok(())
}


/// Lấy danh sách macro metrics theo chuẩn SSOT (phục vụ Cards và Semester Tabs)
#[tauri::command]
pub fn get_academic_macro_metrics_ssot(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<AcademicMacroMetricSSOT>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    // Tự động phục hồi và chuẩn hóa dữ liệu học kỳ / loại bỏ LATEST
    crate::db::academic::self_heal_academic_data(&conn)
        .map_err(|e| format!("Lỗi self-heal academic data: {e}"))?;

    let query_fn = |c: &rusqlite::Connection| -> Result<Vec<AcademicMacroMetricSSOT>, String> {
        let mut stmt = c
            .prepare(
                r#"
                SELECT semester_id, 
                       COALESCE(NULLIF(semester_label, ''), 'Học kỳ ' || semester_id),
                       COALESCE(NULLIF(year_name, ''), '2025-2026'),
                       term_gpa, cumulative_gpa, term_credits, cumulative_credits,
                       COALESCE(NULLIF(drl_score, 0), drl, 0),
                       COALESCE(NULLIF(rank_label, ''), classification, 'Giỏi'),
                       updated_at
                FROM academic_macro_metrics
                WHERE semester_id != 'LATEST' AND semester_id NOT LIKE 'Học_kỳ_%'
                ORDER BY semester_id ASC
                "#,
            )
            .map_err(|e| format!("Lỗi prepare query: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(AcademicMacroMetricSSOT {
                    semester_id: row.get(0)?,
                    semester_label: row.get(1)?,
                    year_name: row.get(2)?,
                    term_gpa: row.get(3)?,
                    cumulative_gpa: row.get(4)?,
                    term_credits: row.get(5)?,
                    cumulative_credits: row.get(6)?,
                    drl_score: row.get(7)?,
                    rank_label: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|e| format!("Lỗi query: {e}"))?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r.map_err(|e| e.to_string())?);
        }
        Ok(list)
    };

    let list = query_fn(&conn)?;

    Ok(list)
}

/// Lệnh gọi trực tiếp để dọn sạch toàn bộ mock courses và nạp lại dữ liệu chuẩn xác 100% của UIT
#[tauri::command]
pub fn purge_and_seed_canonical_academic_data(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<(), String> {
    let mut conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::academic::purge_and_seed_canonical_data(&mut conn)
        .map_err(|e| format!("Lỗi purge_and_seed_canonical_data: {e}"))?;
    let _ = app.emit("academic://sync-complete", ());
    Ok(())
}

/// Lấy toàn bộ danh mục chương trình đào tạo & tiến độ học tập
#[tauri::command]
pub fn get_academic_curriculum(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<crate::modules::academic::parser::CurriculumCourseRecord>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::academic::get_all_curriculum_courses(&conn)
        .map_err(|e| format!("Lỗi get_academic_curriculum: {e}"))
}

/// Trả về kết quả phân giải chương trình đào tạo đa ngành từ settings (hoặc fallback)
#[tauri::command]
pub fn get_resolved_curriculum(
    db: tauri::State<'_, SharedDb>,
) -> Result<crate::modules::academic::curriculum_resolver::CurriculumResolution, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;

    // 1. Tầng ưu tiên cao nhất (Single Source of Truth):
    // Nếu portal API đã trả về total_program_credit trực tiếp từ byCtdt.statistics
    // và đã lưu vào academic_program_summary (id='MAIN') hoặc settings
    let portal_credits: Option<i64> = conn.query_row(
        "SELECT total_degree_credits FROM academic_program_summary WHERE id = 'MAIN' AND total_degree_credits > 0",
        [],
        |r| r.get(0),
    ).ok().or_else(|| {
        conn.query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'total_degree_credits' AND CAST(value AS INTEGER) > 0",
            [],
            |r| r.get(0),
        ).ok()
    });

    let (curriculum_code, major_code, student_class) = {
        let get_val = |k: &str| -> String {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [k],
                |r| r.get(0),
            ).unwrap_or_default()
        };
        (get_val("curriculum_code"), get_val("major_code"), get_val("student_class"))
    };

    let user_major: String = conn.query_row(
        "SELECT value FROM settings WHERE key = 'user_major'",
        [],
        |r| r.get(0),
    ).unwrap_or_else(|_| "UIT".to_string());

    if let Some(credits) = portal_credits {
        let resolved_code = if !major_code.is_empty() {
            major_code
        } else if !user_major.is_empty() && user_major != "UIT" {
            user_major
        } else {
            "OFFICIAL_CTDT".to_string()
        };
        return Ok(crate::modules::academic::curriculum_resolver::CurriculumResolution {
            major_code: resolved_code,
            total_credits: credits,
            matched_via: "portal_api_direct".to_string(),
        });
    }

    let combined_hint = format!("{major_code} {student_class}");
    crate::modules::academic::curriculum_resolver::resolve_curriculum(
        &conn,
        &curriculum_code,
        if combined_hint.trim().is_empty() { None } else { Some(&combined_hint) },
    )
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurriculumIndexDto {
    pub slug: String,
    pub major_name: String,
    pub degree_level: Option<String>,
    pub cohort_year: Option<i32>,
    pub cohort_num: Option<i32>,
    pub total_credits: Option<f64>,
    pub training_duration: Option<String>,
    pub training_form: Option<String>,
    pub is_cached: bool,
    pub updated_at: Option<i64>,
}

/// Lấy danh sách các CTĐT UIT có trong danh mục để sinh viên lựa chọn
#[tauri::command]
pub fn get_available_curriculums(
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<CurriculumIndexDto>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT slug, major_name, degree_level, cohort_year, cohort_num,
                   total_credits, training_duration, training_form, is_cached, updated_at
            FROM curriculum_index
            ORDER BY is_cached DESC, cohort_year DESC, major_name ASC
            "#,
        )
        .map_err(|e| format!("Lỗi query curriculum_index: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(CurriculumIndexDto {
                slug: row.get(0)?,
                major_name: row.get(1)?,
                degree_level: row.get(2)?,
                cohort_year: row.get(3)?,
                cohort_num: row.get(4)?,
                total_credits: row.get(5)?,
                training_duration: row.get(6)?,
                training_form: row.get(7)?,
                is_cached: row.get::<_, i64>(8)? != 0,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| format!("Lỗi map row curriculum_index: {e}"))?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| e.to_string())?);
    }
    Ok(list)
}

/// Lưu slug CTĐT mà sinh viên lựa chọn làm chuẩn kiểm toán
#[tauri::command]
pub fn set_student_curriculum_slug(
    db: tauri::State<'_, SharedDb>,
    slug: String,
) -> Result<(), String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('curriculum_slug', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![slug.trim()],
    )
    .map_err(|e| format!("Lỗi lưu curriculum_slug: {e}"))?;
    Ok(())
}

/// Tải và cache CTĐT từ Portal UIT theo slug
#[tauri::command]
pub async fn fetch_and_cache_curriculum(
    db: tauri::State<'_, SharedDb>,
    slug: String,
) -> Result<crate::services::curriculum_harvester::ParsedCurriculum, String> {
    crate::services::curriculum_harvester::sync_curriculum_by_slug(&db, slug.trim())
        .await
        .map_err(|e| e.to_string())
}

/// Tính toán và trả về Báo cáo Kiểm toán Tốt nghiệp (Degree Audit Report)
#[tauri::command]
pub async fn get_degree_audit_report(
    db: tauri::State<'_, SharedDb>,
    preferred_slug: Option<String>,
) -> Result<crate::modules::academic::degree_audit::DegreeAuditReport, String> {
    // 1. Kiểm tra xem slug mục tiêu đã được cache chưa
    let target_slug = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        crate::modules::academic::degree_audit::run_degree_audit(&conn, preferred_slug.as_deref())
            .map(|r| r.slug)
            .ok()
            .or(preferred_slug.clone())
            .unwrap_or_else(|| "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025".to_string())
    };

    let needs_fetch = {
        let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM curriculum_rules WHERE slug = ?1",
                params![target_slug],
                |r| r.get(0),
            )
            .unwrap_or(0);
        count == 0
    };

    if needs_fetch {
        // Tự động fetch từ Portal UIT nếu chưa có trong DB
        let _ = crate::services::curriculum_harvester::sync_curriculum_by_slug(&db, &target_slug).await;
    }

    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::modules::academic::degree_audit::run_degree_audit(&conn, Some(&target_slug))
        .map_err(|e| e.to_string())
}


/// Trả về sync token hiện tại (hoặc sinh mới nếu chưa có) để hiển thị
/// trong SyncTokenDisplay và dán vào Tampermonkey script.
#[tauri::command]
pub fn get_sync_token(db: tauri::State<'_, SharedDb>) -> Result<String, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::settings::get_or_create_sync_token(&conn)
        .map_err(|e| format!("Lỗi get_sync_token: {e}"))
}

pub const DEFAULT_MAJOR_SENTINEL: &str = "CS";

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct StudentProfilePayload {
    pub student_id: String,
    pub full_name: String,
    pub faculty: String,
    pub major_code: String,
    pub specialization: String,
    pub student_class: String,
    pub curriculum_code: String,
    pub cohort: String,
}

pub fn save_student_profile_internal(
    app: &tauri::AppHandle,
    state: &tauri::State<crate::db::SharedDb>,
    payload: StudentProfilePayload,
) -> Result<(), String> {
    let mut conn = state.lock().map_err(|e| e.to_string())?;
    execute_save_student_profile(&mut conn, &payload)?;

    app.emit("student-profile-synced", &payload)
        .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn execute_save_student_profile(
    conn: &mut rusqlite::Connection,
    payload: &StudentProfilePayload,
) -> Result<(), String> {
    use rusqlite::{params, OptionalExtension};

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let upsert = |key: &str, value: &str, tx: &rusqlite::Transaction| -> Result<(), String> {
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    };

    if !payload.student_id.trim().is_empty() {
        upsert("student_id", payload.student_id.trim(), &tx)?;
    }
    if !payload.full_name.trim().is_empty() {
        upsert("student_name", payload.full_name.trim(), &tx)?;
    }
    if !payload.faculty.trim().is_empty() {
        upsert("faculty", payload.faculty.trim(), &tx)?;
    }
    if !payload.major_code.trim().is_empty() {
        upsert("major_code", payload.major_code.trim(), &tx)?;
    }
    if !payload.specialization.trim().is_empty() {
        upsert("specialization", payload.specialization.trim(), &tx)?;
    }
    if !payload.student_class.trim().is_empty() {
        upsert("student_class", payload.student_class.trim(), &tx)?;
    }
    if !payload.curriculum_code.trim().is_empty() {
        upsert("curriculum_code", payload.curriculum_code.trim(), &tx)?;
    }
    if !payload.cohort.trim().is_empty() {
        upsert("admission_year", payload.cohort.trim(), &tx)?;
    }

    // Kiểm tra giá trị user_major hiện tại trước khi nâng cấp
    let current_major: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key = 'user_major'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let should_upgrade_major = match current_major.as_deref() {
        None => true,
        Some(v) => v == DEFAULT_MAJOR_SENTINEL,
    };

    if should_upgrade_major && !payload.specialization.trim().is_empty() {
        upsert("user_major", &payload.specialization, &tx)?;
    }

    // Cập nhật total_degree_credits động trong academic_program_summary
    if let Ok(res) = crate::modules::academic::curriculum_resolver::resolve_curriculum(
        &tx,
        &payload.curriculum_code,
        Some(&payload.major_code),
    ) {
        let _ = tx.execute(
            "INSERT INTO academic_program_summary (id, total_degree_credits, updated_at)
             VALUES ('MAIN', ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET total_degree_credits = excluded.total_degree_credits",
            params![res.total_credits, chrono::Utc::now().timestamp()],
        );
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(())
}

pub fn query_student_profile(conn: &rusqlite::Connection) -> Result<Option<StudentProfilePayload>, String> {
    use rusqlite::params;
    let get_val = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        ).ok()
    };

    if let (Some(student_id), Some(full_name)) = (get_val("student_id"), get_val("student_name")) {
        Ok(Some(StudentProfilePayload {
            student_id,
            full_name,
            faculty: get_val("faculty").unwrap_or_default(),
            major_code: get_val("major_code").unwrap_or_default(),
            specialization: get_val("specialization").unwrap_or_default(),
            student_class: get_val("student_class").unwrap_or_default(),
            curriculum_code: get_val("curriculum_code").unwrap_or_default(),
            cohort: get_val("admission_year").unwrap_or_default(),
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn get_student_profile(
    db: tauri::State<'_, SharedDb>,
) -> Result<Option<StudentProfilePayload>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    query_student_profile(&conn)
}

#[tauri::command]
pub fn ingest_portal_sync_payload_json(
    app: AppHandle,
    db: tauri::State<'_, SharedDb>,
    payload_json: String,
) -> Result<usize, String> {
    if payload_json.contains("\"training_point_history\"") && !payload_json.contains("\"bySemester\"") {
        let drl_payload: crate::services::portal_harvester::OfficialUitDrlPayload =
            serde_json::from_str(&payload_json).map_err(|e| format!("Lỗi parse JSON DRL UIT: {e}"))?;
        let count = crate::services::portal_harvester::PortalIngestionEngine::commit_drl_records(
            db.inner().clone(),
            drl_payload,
        )?;
        let _ = app.emit("academic-data-synced", ());
        let _ = app.emit("academic://sync-complete", ());
        return Ok(count);
    }

    let (profile, drl_records, courses, summary, avg_drl) = if payload_json.contains("\"bySemester\"") {
        let official: crate::services::portal_harvester::OfficialUitTranscriptPayload =
            serde_json::from_str(&payload_json).map_err(|e| format!("Lỗi parse JSON Official UIT: {e}"))?;
        crate::services::portal_harvester::convert_official_uit_payload(official)
    } else {
        let payload: crate::server::PortalSyncPayload =
            serde_json::from_str(&payload_json).map_err(|e| format!("Lỗi parse JSON PortalSyncPayload: {e}"))?;
        (
            payload.profile.unwrap_or_default(),
            payload.drl_records.unwrap_or_default(),
            payload.courses,
            payload.summary,
            payload.avg_drl,
        )
    };

    let courses_count = courses.len();
    let db_arc = db.inner().clone();
    crate::services::portal_harvester::PortalIngestionEngine::commit_academic_records(
        db_arc,
        profile,
        drl_records,
        courses,
        summary,
        avg_drl,
        1,
        1,
    )?;

    let _ = app.emit("academic-data-synced", ());
    let _ = app.emit("academic://sync-complete", ());
    Ok(courses_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );"
        ).unwrap();
        conn
    }

    #[test]
    fn test_save_student_profile_preserves_user_nickname() {
        let mut conn = setup_test_db();

        // 1. Giả lập người dùng đã thiết lập nickname cá nhân
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('user_nickname', 'DiarkArchitect')",
            [],
        ).unwrap();

        let payload = StudentProfilePayload {
            student_id: "21520000".to_string(),
            full_name: "Nguyen Van A".to_string(),
            faculty: "Khoa Khoa hoc May tinh".to_string(),
            major_code: "7480101".to_string(),
            specialization: "Tri tue nhan tao".to_string(),
            student_class: "KHMT2021".to_string(),
            curriculum_code: "K2021".to_string(),
            cohort: "2021".to_string(),
        };

        // 2. Chạy execute_save_student_profile
        execute_save_student_profile(&mut conn, &payload).unwrap();

        // 3. Xác nhận nickname không bao giờ bị ghi đè hay thay đổi
        let nickname: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'user_nickname'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(nickname, "DiarkArchitect");

        // 4. Xác nhận các trường hồ sơ sinh viên được ghi nhận đầy đủ
        let profile = query_student_profile(&conn).unwrap().unwrap();
        assert_eq!(profile.student_id, "21520000");
        assert_eq!(profile.full_name, "Nguyen Van A");
        assert_eq!(profile.faculty, "Khoa Khoa hoc May tinh");
        assert_eq!(profile.student_class, "KHMT2021");
    }

    #[test]
    fn test_save_student_profile_major_sentinel_protection() {
        let mut conn = setup_test_db();

        let payload = StudentProfilePayload {
            student_id: "21521111".to_string(),
            full_name: "Tran Van B".to_string(),
            faculty: "Khoa Khoa hoc May tinh".to_string(),
            major_code: "7480101".to_string(),
            specialization: "Data Science".to_string(),
            student_class: "KHMT2021.1".to_string(),
            curriculum_code: "K2021".to_string(),
            cohort: "2021".to_string(),
        };

        // Case 1: user_major là "CS" (sentinel mặc định) -> Phải được nâng cấp thành "Data Science"
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('user_major', 'CS')",
            [],
        ).unwrap();
        execute_save_student_profile(&mut conn, &payload).unwrap();
        let major: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'user_major'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(major, "Data Science");

        // Case 2: user_major là ngành tùy biến khác ("Software Engineering") -> Tuyệt đối không bị ghi đè
        conn.execute(
            "UPDATE settings SET value = 'Software Engineering' WHERE key = 'user_major'",
            [],
        ).unwrap();

        let payload2 = StudentProfilePayload {
            student_id: "21521111".to_string(),
            full_name: "Tran Van B".to_string(),
            faculty: "Khoa Khoa hoc May tinh".to_string(),
            major_code: "7480101".to_string(),
            specialization: "Computer Vision".to_string(),
            student_class: "KHMT2021.1".to_string(),
            curriculum_code: "K2021".to_string(),
            cohort: "2021".to_string(),
        };

        execute_save_student_profile(&mut conn, &payload2).unwrap();
        let major_preserved: String = conn.query_row(
            "SELECT value FROM settings WHERE key = 'user_major'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(major_preserved, "Software Engineering");
    }

    #[test]
    fn test_academic_radar_metrics_drl_preserves_null() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE academic_macro_metrics (
                semester_id TEXT PRIMARY KEY,
                term_gpa REAL NOT NULL DEFAULT 0.0,
                cumulative_gpa REAL NOT NULL DEFAULT 0.0,
                classification TEXT NOT NULL DEFAULT 'Chưa xếp loại',
                term_credits INTEGER NOT NULL DEFAULT 0,
                cumulative_credits INTEGER NOT NULL DEFAULT 0,
                drl INTEGER,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO academic_macro_metrics (semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl, updated_at)
            VALUES ('2025-2026.1', 8.5, 8.5, 'Giỏi', 18, 18, NULL, 1234567890);
            INSERT INTO academic_macro_metrics (semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl, updated_at)
            VALUES ('2025-2026.2', 9.0, 8.75, 'Xuất sắc', 20, 38, 95, 1234567891);
            "
        ).unwrap();

        let mut stmt = conn.prepare(
            "SELECT semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl
             FROM academic_macro_metrics
             ORDER BY semester_id ASC"
        ).unwrap();

        let rows = stmt.query_map([], |row| {
            Ok(AcademicRadarMetrics {
                semester_id: row.get(0)?,
                term_gpa: row.get(1)?,
                cumulative_gpa: row.get(2)?,
                classification: row.get(3)?,
                term_credits: row.get(4)?,
                cumulative_credits: row.get(5)?,
                drl: row.get::<_, Option<i64>>(6)?,
            })
        }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].semester_id, "2025-2026.1");
        assert_eq!(rows[0].drl, None);
        assert_eq!(rows[1].semester_id, "2025-2026.2");
        assert_eq!(rows[1].drl, Some(95));
    }

    #[test]
    fn test_ingest_drl_records_multi_semester_and_upsert() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE academic_drl (
                semester TEXT PRIMARY KEY,
                score INTEGER NOT NULL,
                grade_text TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            );"
        ).unwrap();

        let tx = conn.transaction().unwrap();

        let json_data = serde_json::json!([
            {
                "semester": "Học kỳ 2 Năm học 2024-2025",
                "score": 100,
                "grade_text": "Xuất sắc"
            },
            {
                "semester": "Học kỳ 1 Năm học 2024-2025",
                "score": 95,
                "grade_text": "Xuất sắc"
            }
        ]);

        let list = json_data.as_array().unwrap();
        ingest_drl_records(&tx, list).unwrap();
        tx.commit().unwrap();

        let mut stmt = conn.prepare("SELECT semester, score, grade_text FROM academic_drl ORDER BY score DESC").unwrap();
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "Học kỳ 2 Năm học 2024-2025");
        assert_eq!(rows[0].1, 100);
        assert_eq!(rows[0].2, "Xuất sắc");
        assert_eq!(rows[1].0, "Học kỳ 1 Năm học 2024-2025");
        assert_eq!(rows[1].1, 95);
        assert_eq!(rows[1].2, "Xuất sắc");
    }

    #[test]
    fn test_partial_student_profile_deserialization_defaults() {
        let partial_json = serde_json::json!({
            "student_id": "21529999",
            "full_name": "Le Thi C"
        });
        let res: Result<StudentProfilePayload, _> = serde_json::from_value(partial_json);
        assert!(res.is_ok());
        let profile = res.unwrap();
        assert_eq!(profile.student_id, "21529999");
        assert_eq!(profile.full_name, "Le Thi C");
        assert_eq!(profile.faculty, "");
        assert_eq!(profile.specialization, "");
    }

    #[test]
    fn test_academic_course_insertion_with_none_score_defaults_course_point() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE academic_semesters (
                id TEXT PRIMARY KEY,
                academic_year TEXT NOT NULL,
                semester_term INTEGER NOT NULL,
                is_completed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE academic_courses (
                id TEXT PRIMARY KEY,
                semester_id TEXT NOT NULL,
                course_code TEXT NOT NULL,
                course_name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                course_point REAL NOT NULL DEFAULT 0.0,
                final_score REAL,
                summary_score_10 REAL,
                is_passed INTEGER NOT NULL DEFAULT 0,
                is_gpa_calculated INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(semester_id) REFERENCES academic_semesters(id) ON DELETE CASCADE,
                UNIQUE(semester_id, course_code)
            );"
        ).unwrap();

        let tx = conn.transaction().unwrap();
        let sem_id = "2025-2026.1";
        let now = 1000000;

        tx.execute(
            "INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)",
            rusqlite::params![sem_id, "2025-2026", 1, now],
        ).unwrap();

        let code = "PE001";
        let name = "Giao duc the chat 1";
        let credits = 0;
        let score: Option<f64> = None;
        let is_passed = false;
        let course_point_val: f64 = score.unwrap_or(0.0);
        let id = format!("{sem_id}_{code}");

        let res = tx.execute(
            "INSERT INTO academic_courses 
                (id, semester_id, course_code, course_name, credits, course_point, final_score, summary_score_10, is_passed, is_gpa_calculated, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, 1, ?9, ?9)
             ON CONFLICT(semester_id, course_code) DO UPDATE SET
                course_name = excluded.course_name,
                credits = excluded.credits,
                course_point = excluded.course_point,
                final_score = excluded.final_score,
                summary_score_10 = excluded.summary_score_10,
                is_passed = excluded.is_passed,
                updated_at = excluded.updated_at",
            rusqlite::params![id, sem_id, code, name, credits, course_point_val, score, is_passed as i64, now],
        );

        assert!(res.is_ok());
        tx.commit().unwrap();

        let point: f64 = conn.query_row(
            "SELECT course_point FROM academic_courses WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(point, 0.0);
    }

    #[test]
    fn test_ingest_drl_records_skips_invalid_rows_gracefully() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE academic_drl (
                semester TEXT PRIMARY KEY,
                score INTEGER NOT NULL,
                grade_text TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL
            );"
        ).unwrap();

        let tx = conn.transaction().unwrap();
        let payload = serde_json::json!([
            { "invalid_row": true },
            { "semester": "", "score": 80 },
            { "semester": "HK1 2025", "score": "not_a_number" },
            { "semester": "HK1 2025", "score": 90, "grade_text": "Xuất sắc" }
        ]);

        let res = ingest_drl_records(&tx, payload.as_array().unwrap());
        assert!(res.is_ok());
        tx.commit().unwrap();

        let count: i64 = conn.query_row("SELECT count(*) FROM academic_drl", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }
}
