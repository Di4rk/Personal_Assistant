// Ẩn console window trên Windows release build (không ảnh hưởng debug build)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod gamification;
mod server;

use std::sync::{Arc, Mutex};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Lấy đúng thư mục app data theo chuẩn OS (Windows: %APPDATA%\jarvis-core\)
            // - KHÔNG hardcode path, tránh lỗi khi build trên máy khác.
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Không lấy được app_data_dir - kiểm tra lại tauri.conf.json identifier");

            std::fs::create_dir_all(&app_data_dir)
                .expect("Không tạo được thư mục app data");

            let db_path = app_data_dir.join("jarvis.sqlite3");
            println!("[jarvis] DB path: {}", db_path.display());

            let conn = db::init_db(&db_path).expect("Không khởi tạo được SQLite DB");
            let shared_db: db::SharedDb = Arc::new(Mutex::new(conn));

            // Đăng ký state để cả Tauri commands lẫn Axum server dùng chung 1 connection.
            app.manage(shared_db.clone());

            // Spawn HTTP server chạy nền trong tokio runtime của Tauri.
            // KHÔNG dùng std::thread::spawn thường vì axum::serve cần tokio runtime.
            tauri::async_runtime::spawn(async move {
                server::run_server(shared_db).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_today_stats,
            commands::get_recent_submissions,
            commands::get_level_info,
            commands::get_yearly_heatmap,
            // generate_handler! hỗ trợ #[cfg(...)] trên từng command - 2 lệnh này
            // biến mất hoàn toàn khỏi release build, không cần nhớ xoá tay.
            #[cfg(debug_assertions)]
            commands::dev_seed_mock_data,
            #[cfg(debug_assertions)]
            commands::dev_clear_mock_data,
        ])
        .run(tauri::generate_context!())
        .expect("Lỗi khi khởi chạy Tauri application");
}
