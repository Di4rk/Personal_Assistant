pub mod commands;
pub mod db;
pub mod error;
pub mod gamification;
pub mod modules;
pub mod server;
pub mod services;
pub mod tray;
#[path = "commands/webview_lifecycle.rs"]
pub mod webview_lifecycle;

use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
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

// Macro duy nhất cho cả debug & release.
// Dev tools commands (seed_mock_academic_data, clear_cf_cache) chỉ tồn tại
// trong debug build vì bản thân commands/dev_tools.rs được guard bởi
// #[cfg(debug_assertions)] ở commands/mod.rs. Ta đăng ký chúng riêng vào
// .invoke_handler trong setup() dưới đây qua cfg conditional.
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
            commands::academic::get_degree_audit_report,
            commands::academic::fetch_and_cache_curriculum,
            commands::academic::get_available_curriculums,
            commands::academic::set_student_curriculum_slug,
            commands::academic::get_sync_token,
            commands::academic::get_student_profile,
            commands::academic::ingest_portal_sync_payload_json,
            // Portal In-App SSO
            commands::portal_auth::launch_portal_sso_sync,
            commands::portal_auth::launch_wecode_sso_sync,
            commands::portal_auth::launch_moodle_sso_sync,
            commands::portal_auth::launch_portal_silent_sync,
            commands::portal_auth::launch_wecode_silent_sync,
            commands::portal_auth::launch_moodle_silent_sync,
            // Wecode
            commands::wecode::get_wecode_submissions,
            commands::wecode::get_wecode_problems,
            commands::wecode::get_wecode_assignments,
            commands::wecode::get_sync_timestamps,
            commands::wecode::ingest_wecode_submissions_json,
            // Moodle & Courses Engine
            commands::moodle::get_moodle_courses,
            commands::moodle::get_moodle_tasks,
            commands::moodle::get_moodle_materials,
            commands::moodle::download_course_materials,
            commands::moodle::open_local_material,
            commands::moodle::ingest_moodle_sync_payload_json,
            commands::moodle::update_moodle_course_instructor,
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
            commands::vault::scaffold_semester_vault,
            commands::vault::open_vault_course_folder,
            commands::vault::start_vault_watcher,
            commands::vault::stop_vault_watcher,
            commands::vault::get_vault_watcher_status,
            commands::vault::archive_semester,
            commands::open_external_url,
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
            // Exam Radar & Automation
            commands::exam::get_exam_schedules,
            commands::exam::sync_exam_schedules,
            commands::exam::update_exam_checklist,
            commands::exam::trigger_daily_briefing,
            // Gemini AI Copilot
            commands::gemini::get_gemini_config,
            commands::gemini::save_gemini_config,
            commands::gemini::test_gemini_key,
            commands::gemini::trigger_socratic_debug,
            commands::gemini::extract_moodle_tasks,
            commands::gemini::save_extracted_moodle_tasks,
            // System, Hotkey & Autostart
            commands::system::get_system_preferences,
            commands::system::update_autostart_setting,
            commands::system::update_start_minimized_setting,
            commands::system::update_global_shortcut,
            commands::system::suspend_hotkey,
            commands::system::resume_hotkey,
            commands::system::notify_ui_ready,
        ]
    };
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        // D2: single-instance ĐẦU TIÊN
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = crate::tray::show_and_focus_main(&window);
                let _ = app.emit("window-shown", ());
            }
        }))
        // D1: Autostart với cờ --autostart
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        // D3: Global shortcut handler gắn 1 lần với with_handler
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(crate::commands::system::global_hotkey_handler)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder = builder.setup(|app| {
        let app_data_dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&app_data_dir)?;

        // DB Migration: nếu tồn tại file cũ từ thời jarvis, tự động rename sang diàrk
        // trước khi mở connection, đảm bảo dữ liệu người dùng không bị mất.
        let legacy_db = app_data_dir.join("jarvis.sqlite3");
        let db_path = app_data_dir.join("diark.sqlite3");
        if legacy_db.exists() && !db_path.exists() {
            println!("[diark] Migrating database: jarvis.sqlite3 → diark.sqlite3");
            std::fs::rename(&legacy_db, &db_path)
                .map_err(|e| anyhow::anyhow!("DB migration failed: {e}"))?;
            // Di chuyển cả WAL và SHM files nếu có
            for ext in &["-wal", "-shm"] {
                let old = app_data_dir.join(format!("jarvis.sqlite3{ext}"));
                let new = app_data_dir.join(format!("diark.sqlite3{ext}"));
                if old.exists() {
                    let _ = std::fs::rename(old, new);
                }
            }
        }
        println!("[diark] DB path: {}", db_path.display());

        let conn = db::init_db(&db_path)?;
        let pools = db::init_pools(&db_path)?;

        // Seed settings mặc định (D8: autostart_enabled = "false", start_minimized = "true", global_shortcut = "Alt+K")
        {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES ('autostart_enabled', 'false')",
                [],
            );
            let _ = conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES ('start_minimized', 'true')",
                [],
            );
            let _ = conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES ('global_shortcut', 'Alt+K')",
                [],
            );
        }

        // Đọc cấu hình khởi động 1 lần, rồi thả lock
        let (shortcut_str, start_minimized, user_nickname) = {
            let s_shortcut: String = conn
                .query_row("SELECT value FROM settings WHERE key = 'global_shortcut'", [], |r| r.get(0))
                .unwrap_or_else(|_| "Alt+K".to_string());
            let s_minimized: bool = conn
                .query_row("SELECT value FROM settings WHERE key = 'start_minimized'", [], |r| r.get(0))
                .map(|v: String| v == "true")
                .unwrap_or(true);
            let s_nick: Option<String> = conn
                .query_row("SELECT value FROM settings WHERE key = 'user_nickname'", [], |r| r.get(0))
                .ok();
            (s_shortcut, s_minimized, s_nick)
        };

        // Logic D7: Tính toán hiển thị lúc khởi động
        let launched_by_autostart = std::env::args().any(|a| a == "--autostart");
        let first_run = user_nickname.as_deref().unwrap_or("").trim().is_empty();
        let should_show_initially = first_run || !(launched_by_autostart && start_minimized);

        // Parse và đăng ký shortcut lúc boot
        let default_shortcut = crate::commands::system::parse_shortcut("Alt+K").unwrap_or_else(|_| {
            Shortcut::new(
                Some(tauri_plugin_global_shortcut::Modifiers::ALT),
                tauri_plugin_global_shortcut::Code::KeyK,
            )
        });
        let parsed_shortcut: Shortcut = crate::commands::system::parse_shortcut(&shortcut_str)
            .unwrap_or(default_shortcut);
        let mut hotkey_active = false;
        match app.global_shortcut().register(parsed_shortcut) {
            Ok(_) => {
                hotkey_active = true;
                println!(
                    "[diark] Registered global shortcut: {}",
                    crate::commands::system::canonicalize_shortcut(&parsed_shortcut)
                );
            }
            Err(e) => {
                eprintln!("[WARN] Failed to register global shortcut on boot: {e}");
                let _ = app.emit(
                    "hotkey-registration-failed",
                    crate::commands::system::AppError::new(
                        crate::commands::system::error_codes::HOTKEY_ALREADY_REGISTERED,
                        format!("Phím tắt '{shortcut_str}' đang bị ứng dụng khác chiếm giữ."),
                    ),
                );
            }
        }

        app.manage(crate::commands::system::HotkeyState::new(parsed_shortcut, hotkey_active));
        let window_gate = Arc::new(crate::commands::system::WindowGate::new(should_show_initially));
        app.manage(window_gate.clone());

        let shared_db: db::SharedDb = Arc::new(Mutex::new(conn));
        app.manage(pools.clone());
        app.manage(shared_db.clone());
        app.manage(AppState { db: shared_db.clone() });
        app.manage(crate::commands::portal_auth::WatchdogRegistry::new());
        app.manage(crate::commands::portal_auth::PartialStateRegistry::default());
        app.manage(crate::webview_lifecycle::SsoSessionRegistry::new());

        let vault_watcher_state = crate::modules::vault::VaultWatcherState::default();
        app.manage(vault_watcher_state.clone());

        // HTTP client (15s timeout)
        let http_client = cf_worker::build_http_client()
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        app.manage(http_client.clone());

        let sync_lock = SyncLock::new();
        app.manage(sync_lock.clone());

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        app.manage(shutdown_tx);

        let worker_app_handle = app.handle().clone();
        let worker_pools = pools.clone();
        let worker_client = http_client.clone();
        let worker_lock = sync_lock.clone();
        tauri::async_runtime::spawn(async move {
            cf_worker::start_cf_sync_worker(
                worker_app_handle,
                worker_pools,
                worker_client,
                worker_lock,
                DEFAULT_SYNC_INTERVAL_SECS,
                shutdown_rx,
            )
            .await;
        });

        let server_app = app.handle().clone();
        let server_pools = pools.clone();
        tauri::async_runtime::spawn(async move {
            server::run_server(server_app, server_pools).await;
        });

        let sync_app_handle = app.handle().clone();
        let sync_pools = pools.clone();
        tauri::async_runtime::spawn(async move {
            crate::modules::academic::sync_server::start_sync_server(
                sync_app_handle,
                sync_pools,
            )
            .await;
        });

        let auto_app = app.handle().clone();
        let auto_pools = pools.clone();
        let auto_watcher = vault_watcher_state.clone();
        tauri::async_runtime::spawn(async move {
            let saved_path_opt = {
                auto_pools.read(|conn| {
                    crate::db::settings::get_setting(conn, "vault_path").map_err(Into::into)
                }).ok().flatten()
            };
            if let Some(path) = saved_path_opt {
                if std::path::Path::new(&path).exists() {
                    println!("[Vault Watcher] Tự động khởi chạy watcher cho: {path}");
                    let _ = crate::modules::vault::start_vault_watcher_with_pools(auto_app, path, &auto_watcher, auto_pools).await;
                }
            }
        });

        // Setup System Tray (chỉ vá, không dựng lại)
        crate::tray::setup_tray(app.handle())?;

        // Spawn Daily Briefing Scheduler (08:00 & 20:00)
        crate::modules::system::spawn_daily_briefing_scheduler_with_pools(app.handle().clone(), pools.clone());

        // Periodic Maintenance & Idle WAL Checkpoint (chạy mỗi 15 phút = 900 giây)
        let maintenance_pools = pools.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(900));
            loop {
                interval.tick().await;
                let _ = maintenance_pools.maintenance().await;
            }
        });

        // Spawn fallback timeout 3s: nếu chưa nhận được notify_ui_ready và should_show_initially thì tự hiện
        let app_timeout = app.handle().clone();
        let gate_timeout = window_gate.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if gate_timeout.should_show_initially
                && gate_timeout
                    .shown
                    .compare_exchange(
                        false,
                        true,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    )
                    .is_ok()
            {
                if let Some(window) = app_timeout.get_webview_window("main") {
                    let _ = crate::tray::show_and_focus_main(&window);
                    let _ = app_timeout.emit("window-shown", ());
                }
            }
        });

        // Chặn sự kiện đóng cửa sổ (CloseRequested) trên main window để ẩn vào System Tray
        if let Some(main_window) = app.get_webview_window("main") {
            let nickname = user_nickname.unwrap_or_else(|| "Diark".to_string());
            #[cfg(debug_assertions)]
            let env_prefix = "[DEV] ";
            #[cfg(not(debug_assertions))]
            let env_prefix = "";

            let _ = main_window.set_title(&format!("{env_prefix}{nickname} // OS"));

            let window_clone = main_window.clone();
            let app_handle_for_close = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_clone.hide();
                    let _ = app_handle_for_close.emit("window-hidden", ());
                }
            });
        }

        Ok(())
    });

    let app = match builder
        .invoke_handler(registered_commands!())
        .build(tauri::generate_context!())
    {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[diark] Lỗi fatal khi build Tauri application: {e}");
            std::process::exit(1);
        }
    };

    // 5.5 Thoát sạch (Clean exit sequence)
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            println!("[diark] Clean exit sequence initiated...");
            // 0. Thu hồi toàn bộ remote SSO webviews và phiên WebView2
            if let Some(sso_reg) = app_handle.try_state::<crate::webview_lifecycle::SsoSessionRegistry>() {
                crate::webview_lifecycle::cleanup_all_sso_sessions(
                    app_handle,
                    &sso_reg,
                    crate::webview_lifecycle::CleanupReason::AppExit,
                );
            }

            // 1. Tín hiệu shutdown background workers (CF poller, sync server, briefing)
            if let Some(shutdown_tx) = app_handle.try_state::<watch::Sender<bool>>() {
                let _ = shutdown_tx.send(true);
            }

            // 2. Dừng Vault watcher
            if let Some(watcher_state) = app_handle.try_state::<crate::modules::vault::VaultWatcherState>() {
                let _ = tauri::async_runtime::block_on(async {
                    crate::modules::vault::stop_vault_watcher(&watcher_state).await
                });
            }

            // 3. PRAGMA wal_checkpoint(TRUNCATE) (best-effort)
            if let Some(pools) = app_handle.try_state::<crate::db::DbPools>() {
                let _ = tauri::async_runtime::block_on(async {
                    pools.checkpoint_truncate().await
                });
            } else if let Some(shared_db) = app_handle.try_state::<crate::db::SharedDb>() {
                if let Ok(conn) = shared_db.lock() {
                    let _ = crate::tray::checkpoint_wal(&conn);
                }
            }

            // 4. unregister_all() của global-shortcut (best-effort)
            let _ = app_handle.global_shortcut().unregister_all();
        }
    });
}
