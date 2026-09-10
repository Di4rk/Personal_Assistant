pub mod commands;
pub mod db;
pub mod error;
pub mod gamification;
pub mod modules;
pub mod server;
pub mod services;

use std::sync::{Arc, Mutex};

use tauri::Manager;
use tokio::sync::watch;

use services::cf_worker::{self, SyncLock};

/// Chu kỳ sync bình thường - 60s là điểm cân bằng hợp lý: đủ nhanh để cảm
/// giác "gần real-time" khi vừa AC 1 bài, nhưng không dồn dập tới mức có nguy
/// cơ bị Codeforces coi là traffic bất thường. Có thể expose ra settings UI
/// sau này nếu muốn user tự chỉnh.
const DEFAULT_SYNC_INTERVAL_SECS: u64 = 60;

pub fn run() {
    let build_result = tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            let db_path = app_data_dir.join("jarvis.sqlite3");
            println!("[jarvis] DB path: {}", db_path.display());

            let conn = db::init_db(&db_path)?;
            let shared_db: db::SharedDb = Arc::new(Mutex::new(conn));
            app.manage(shared_db.clone());

            // HTTP client (15s timeout) — dùng chung giữa worker và IPC command
            // trigger_cf_sync, tránh tạo nhiều pool connection mỗi khi user bấm sync.
            let http_client = cf_worker::build_http_client()
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            app.manage(http_client.clone());

            // SyncLock — flag AtomicBool dùng chung giữa background worker và
            // IPC command trigger_cf_sync để tránh 2 luồng sync chạy cùng lúc.
            let sync_lock = SyncLock::new();
            app.manage(sync_lock.clone());

            // Kênh shutdown: khi cửa sổ chính đóng, gửi tín hiệu `true` để worker
            // tự thoát vòng lặp NGAY ở lượt select! kế tiếp, thay vì bị kill đột
            // ngột giữa lúc đang giữ transaction SQLite dở dang (rủi ro corrupt DB).
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            app.manage(shutdown_tx);

            // Spawn CF sync worker chạy nền. tauri::async_runtime::spawn dùng chung
            // tokio runtime với chính Tauri app - không cần tự tạo runtime riêng.
            let worker_app_handle = app.handle().clone();
            let worker_db = shared_db.clone();
            let worker_client = http_client.clone();
            let worker_lock = sync_lock.clone();
            tauri::async_runtime::spawn(async move {
                cf_worker::start_cf_sync_worker(
                    worker_app_handle,
                    worker_db,
                    worker_client,
                    worker_lock,
                    DEFAULT_SYNC_INTERVAL_SECS,
                    shutdown_rx,
                )
                .await;
            });

            // Server HTTP cũ (nhận webhook từ Chrome extension) vẫn chạy song song -
            // 2 nguồn ghi vào CÙNG 1 DB, dedup qua UNIQUE INDEX cf_submission_id đảm
            // bảo dù cả 2 nguồn cùng bắt được 1 submission cũng không double-count XP.
            let server_db = shared_db.clone();
            tauri::async_runtime::spawn(async move {
                server::run_server(server_db).await;
            });

            // Portal Browser Bridge — Loopback sync server nhận payload từ
            // Tampermonkey userscript trên student.uit.edu.vn.
            // Chỉ bind 127.0.0.1, xác thực qua X-Jarvis-Sync-Token.
            let sync_app_handle = app.handle().clone();
            let sync_db = shared_db.clone();
            tauri::async_runtime::spawn(async move {
                crate::modules::academic::sync_server::start_sync_server(
                    sync_app_handle,
                    sync_db,
                )
                .await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(shutdown_tx) = window.app_handle().try_state::<watch::Sender<bool>>() {
                    // Bỏ qua lỗi send có chủ đích: nếu receiver đã bị drop (worker
                    // chết sớm vì lý do khác) thì không còn gì để báo hiệu nữa,
                    // và đó không phải lỗi cần chặn quá trình đóng app.
                    let _ = shutdown_tx.send(true);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_today_stats,
            commands::get_recent_submissions,
            commands::get_level_info,
            commands::get_yearly_heatmap,
            commands::set_cf_handle,
            commands::get_cf_handle,
            commands::trigger_cf_sync,
            commands::post_mortem::save_post_mortem,
            commands::post_mortem::get_post_mortem,
            commands::post_mortem::delete_post_mortem,
            commands::post_mortem::search_post_mortems,
            commands::academic::get_academic_overview,
            commands::academic::get_semester_courses,
            commands::academic::upsert_academic_courses,
            commands::academic::upsert_academic_semester,
            commands::academic::sync_portal_uit_data,
            commands::academic::sync_uit_portal,
            commands::academic::submit_portal_transcript,
            commands::academic::get_academic_macro_metrics,
            commands::academic::get_academic_macro_metrics_ssot,
            commands::academic::ingest_full_academic_payload,
            commands::academic::ingest_dynamic_academic_data,
            commands::academic::purge_and_seed_canonical_academic_data,
            commands::academic::get_academic_curriculum,
            commands::workspace::ingest_moodle_course_html,
            commands::workspace::get_upcoming_deadlines,
            commands::workspace::mark_deadline_submitted,
            commands::workspace::upsert_workspace_config,
            commands::workspace::get_workspace_config,
            commands::workspace::check_and_launch_vscode,
            commands::matrix::recompute_today_xp,
            commands::matrix::get_heatmap_matrix,
            commands::matrix::get_life_matrix_range,
            commands::vault::scan_vault,
            commands::vault::search_vault,
            commands::vault::get_vault_stats,
            commands::academic::get_sync_token,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = build_result {
        eprintln!("[jarvis] Lỗi fatal khi khởi chạy Tauri application: {e}");
        std::process::exit(1);
    }
}
