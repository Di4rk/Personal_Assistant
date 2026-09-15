pub mod commands;
pub mod db;
pub mod error;
pub mod gamification;
pub mod modules;
pub mod server;
pub mod services;
pub mod tray;

use std::sync::{Arc, Mutex};

use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tokio::sync::watch;

use services::cf_worker::{self, SyncLock};

#[derive(Clone)]
pub struct AppState {
    pub db: crate::db::SharedDb,
}

/// Chu kỳ sync bình thường - 60s là điểm cân bằng hợp lý: đủ nhanh để cảm
/// giác "gần real-time" khi vừa AC 1 bài, nhưng không dồn dập tới mức có nguy
/// cơ bị Codeforces coi là traffic bất thường. Có thể expose ra settings UI
/// sau này nếu muốn user tự chỉnh.
const DEFAULT_SYNC_INTERVAL_SECS: u64 = 60;

#[cfg(debug_assertions)]
macro_rules! registered_commands {
    () => {
        tauri::generate_handler![
            // Core CP & Stats
            commands::get_today_stats,
            commands::get_recent_submissions,
            commands::get_level_info,
            commands::get_yearly_heatmap,
            commands::set_cf_handle,
            commands::get_cf_handle,
            commands::trigger_cf_sync,
            commands::purge_cf_data,
            // Post Mortem
            commands::post_mortem::save_post_mortem,
            commands::post_mortem::get_post_mortem,
            commands::post_mortem::delete_post_mortem,
            commands::post_mortem::search_post_mortems,
            // Academic
            commands::academic::get_academic_overview,
            commands::academic::get_semester_courses,
            commands::academic::upsert_academic_courses,
            commands::academic::upsert_academic_semester,
            commands::academic::sync_portal_uit_data,
            commands::academic::sync_uit_portal,
            commands::academic::submit_portal_transcript,
            commands::academic::get_academic_macro_metrics,
            commands::academic::get_academic_macro_metrics_ssot,
            commands::academic::get_academic_radar_metrics,
            commands::academic::ingest_full_academic_payload,
            commands::academic::ingest_dynamic_academic_data,
            commands::academic::purge_and_seed_canonical_academic_data,
            commands::academic::get_academic_curriculum,
            commands::academic::get_resolved_curriculum,
            commands::academic::get_sync_token,
            commands::academic::get_student_profile,
            commands::academic::ingest_portal_sync_payload_json,
            // Portal In-App SSO
            commands::portal_auth::launch_portal_sso_sync,
            commands::portal_auth::launch_wecode_sso_sync,
            // Wecode
            commands::wecode::get_wecode_submissions,
            commands::wecode::ingest_wecode_submissions_json,
            // Moodle & Workspace
            commands::workspace::ingest_moodle_course_html,
            commands::workspace::get_upcoming_deadlines,
            commands::workspace::mark_deadline_submitted,
            commands::workspace::upsert_workspace_config,
            commands::workspace::get_workspace_config,
            commands::workspace::check_and_launch_vscode,
            // Life Matrix
            commands::matrix::recompute_today_xp,
            commands::matrix::get_heatmap_matrix,
            commands::matrix::get_life_matrix_range,
            // Vault & Window
            commands::vault::scan_vault,
            commands::vault::search_vault,
            commands::vault::get_vault_stats,
            commands::vault::create_structured_note,
            commands::vault::open_onenote_link,
            commands::vault::set_vault_path,
            commands::vault::get_vault_path,
            commands::hide_hud,
            // Settings & Identity
            commands::settings::get_user_profile,
            commands::settings::save_user_profile,
            commands::settings::save_setting,
            commands::settings::get_system_storage_stats,
            commands::settings::reset_identity_state,
            commands::settings::reset_user_data_to_genesis,
            // Plugin Engine
            commands::plugins::list_installed_plugins,
            commands::plugins::toggle_plugin,
            commands::plugins::plugin_storage_get,
            commands::plugins::plugin_storage_set,
            commands::plugins::record_activity_event,
            commands::plugins::trigger_recompute_daily_matrix,
            commands::plugins::fetch_remote_registry,
            commands::plugins::install_remote_plugin,
            // Dev Tools (Debug Only)
            commands::dev_tools::seed_mock_academic_data,
            commands::dev_tools::clear_cf_cache,
        ]
    };
}

#[cfg(not(debug_assertions))]
macro_rules! registered_commands {
    () => {
        tauri::generate_handler![
            // Core CP & Stats
            commands::get_today_stats,
            commands::get_recent_submissions,
            commands::get_level_info,
            commands::get_yearly_heatmap,
            commands::set_cf_handle,
            commands::get_cf_handle,
            commands::trigger_cf_sync,
            commands::purge_cf_data,
            // Post Mortem
            commands::post_mortem::save_post_mortem,
            commands::post_mortem::get_post_mortem,
            commands::post_mortem::delete_post_mortem,
            commands::post_mortem::search_post_mortems,
            // Academic
            commands::academic::get_academic_overview,
            commands::academic::get_semester_courses,
            commands::academic::upsert_academic_courses,
            commands::academic::upsert_academic_semester,
            commands::academic::sync_portal_uit_data,
            commands::academic::sync_uit_portal,
            commands::academic::submit_portal_transcript,
            commands::academic::get_academic_macro_metrics,
            commands::academic::get_academic_macro_metrics_ssot,
            commands::academic::get_academic_radar_metrics,
            commands::academic::ingest_full_academic_payload,
            commands::academic::ingest_dynamic_academic_data,
            commands::academic::purge_and_seed_canonical_academic_data,
            commands::academic::get_academic_curriculum,
            commands::academic::get_resolved_curriculum,
            commands::academic::get_sync_token,
            commands::academic::get_student_profile,
            commands::academic::ingest_portal_sync_payload_json,
            // Portal In-App SSO
            commands::portal_auth::launch_portal_sso_sync,
            commands::portal_auth::launch_wecode_sso_sync,
            // Wecode
            commands::wecode::get_wecode_submissions,
            commands::wecode::ingest_wecode_submissions_json,
            // Moodle & Workspace
            commands::workspace::ingest_moodle_course_html,
            commands::workspace::get_upcoming_deadlines,
            commands::workspace::mark_deadline_submitted,
            commands::workspace::upsert_workspace_config,
            commands::workspace::get_workspace_config,
            commands::workspace::check_and_launch_vscode,
            // Life Matrix
            commands::matrix::recompute_today_xp,
            commands::matrix::get_heatmap_matrix,
            commands::matrix::get_life_matrix_range,
            // Vault & Window
            commands::vault::scan_vault,
            commands::vault::search_vault,
            commands::vault::get_vault_stats,
            commands::vault::create_structured_note,
            commands::vault::open_onenote_link,
            commands::vault::set_vault_path,
            commands::vault::get_vault_path,
            commands::hide_hud,
            // Settings & Identity (Always available)
            commands::settings::get_user_profile,
            commands::settings::save_user_profile,
            commands::settings::save_setting,
            commands::settings::get_system_storage_stats,
            commands::settings::reset_identity_state,
            commands::settings::reset_user_data_to_genesis,
            // Plugin Engine
            commands::plugins::list_installed_plugins,
            commands::plugins::toggle_plugin,
            commands::plugins::plugin_storage_get,
            commands::plugins::plugin_storage_set,
            commands::plugins::record_activity_event,
            commands::plugins::trigger_recompute_daily_matrix,
            commands::plugins::fetch_remote_registry,
            commands::plugins::install_remote_plugin,
        ]
    };
}

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
            app.manage(AppState { db: shared_db.clone() });
            app.manage(crate::commands::portal_auth::WatchdogRegistry::new());
            app.manage(crate::commands::portal_auth::PartialStateRegistry::default());

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
            let server_app = app.handle().clone();
            let server_db = shared_db.clone();
            tauri::async_runtime::spawn(async move {
                server::run_server(server_app, server_db).await;
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

            // Setup System Tray
            crate::tray::setup_tray(app.handle())?;

            // Periodic Idle WAL Checkpoint (chạy mỗi 15 phút = 900 giây)
            let checkpoint_db = shared_db.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(900));
                loop {
                    interval.tick().await;
                    if let Ok(conn) = checkpoint_db.lock() {
                        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
                    }
                }
            });

            // Global Shortcut Alt+K
            let shortcut: Result<Shortcut, _> = "Alt+K".parse();
            match shortcut {
                Ok(sc) => {
                    let app_handle = app.handle().clone();
                    match app.global_shortcut().register(sc) {
                        Ok(_) => {
                            let _ = app.global_shortcut().on_shortcut(sc, move |_app, _shortcut, _event| {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let is_visible = window.is_visible().unwrap_or(false);
                                    if is_visible {
                                        let _ = window.hide();
                                    } else {
                                        let _ = crate::tray::show_and_focus_hud(&window);
                                    }
                                }
                            });
                        }
                        Err(e) => {
                            eprintln!("[WARN] Failed to register Alt+K global shortcut: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[WARN] Failed to parse Alt+K shortcut: {}", e);
                }
            }

            // Chặn sự kiện đóng cửa sổ (CloseRequested) trên main window để ẩn vào System Tray
            if let Some(main_window) = app.get_webview_window("main") {
                let nickname: String = {
                    if let Ok(conn) = shared_db.lock() {
                        conn.query_row(
                            "SELECT value FROM settings WHERE key = 'user_nickname'",
                            [],
                            |row| row.get(0),
                        ).unwrap_or_else(|_| "Diark".to_string())
                    } else {
                        "Diark".to_string()
                    }
                };

                #[cfg(debug_assertions)]
                let env_prefix = "[DEV] ";
                #[cfg(not(debug_assertions))]
                let env_prefix = "";

                let _ = main_window.set_title(&format!("{env_prefix}{nickname} // OS"));
                let _ = main_window.show();

                let window_clone = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(shutdown_tx) = window.app_handle().try_state::<watch::Sender<bool>>() {
                    let _ = shutdown_tx.send(true);
                }
            }
        })
        .invoke_handler(registered_commands!())
        .run(tauri::generate_context!());

    if let Err(e) = build_result {
        eprintln!("[jarvis] Lỗi fatal khi khởi chạy Tauri application: {e}");
        std::process::exit(1);
    }
}
