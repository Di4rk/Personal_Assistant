use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_i = MenuItem::with_id(app, "show", "Show HUD (Alt+K)", true, None::<&str>)?;
    let briefing_i = MenuItem::with_id(app, "briefing", "📢 Daily Briefing (Thông báo)", true, None::<&str>)?;
    let status_i = MenuItem::with_id(app, "status", "Status: Running", false, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit Diark OS", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &briefing_i, &status_i, &quit_i])?;

    let icon = match app.default_window_icon() {
        Some(icon) => icon.clone(),
        None => {
            let bytes = include_bytes!("../icons/32x32.png");
            tauri::image::Image::from_bytes(bytes)?
        }
    };

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = show_and_focus_hud(&window);
                }
            }
            "briefing" => {
                if let Some(shared_db) = app.try_state::<crate::db::SharedDb>() {
                    if let Ok(conn) = shared_db.lock() {
                        let _ = crate::modules::system::dispatch_daily_briefing(app, &conn);
                    }
                }
            }
            "quit" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    graceful_shutdown(app_handle).await;
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let is_visible = window.is_visible().unwrap_or(false);
                    if is_visible {
                        let _ = window.hide();
                    } else {
                        let _ = show_and_focus_hud(&window);
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

pub fn show_and_focus_hud(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_always_on_top(true);
    window.set_focus().map_err(|e| e.to_string())?;
    let _ = window.set_always_on_top(false);
    window.emit("hud-shown", ()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn checkpoint_wal(conn: &rusqlite::Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| format!("Failed to prepare WAL checkpoint: {e}"))?;
    let _ = stmt
        .query_row([], |_row| Ok(()))
        .map_err(|e| format!("Failed to execute WAL checkpoint: {e}"))?;
    Ok(())
}

pub async fn graceful_shutdown(app: AppHandle) {
    if let Some(shutdown_tx) = app.try_state::<tokio::sync::watch::Sender<bool>>() {
        let _ = shutdown_tx.send(true);
    }

    // Grace period cho in-flight write tasks
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Truncate checkpoint SQLite WAL
    if let Some(shared_db) = app.try_state::<crate::db::SharedDb>() {
        if let Ok(conn) = shared_db.lock() {
            let _ = checkpoint_wal(&conn);
        }
    }

    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::Shortcut;

    #[test]
    fn test_parse_valid_shortcut_and_fallback() {
        let parsed: Result<Shortcut, _> = "Alt+K".parse();
        assert!(parsed.is_ok(), "Alt+K must be a valid shortcut");

        let invalid: Result<Shortcut, _> = "InvalidKeyCombo123".parse();
        assert!(invalid.is_err(), "Invalid shortcut combo must return Err");
    }

    #[test]
    fn test_checkpoint_wal_succeeds() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let db_path = temp_dir.path().join("test.db");
        let conn = rusqlite::Connection::open(&db_path).expect("open temp db");
        let _: String = conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
            .expect("enable WAL");
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)", []).expect("create table");
        let res = checkpoint_wal(&conn);
        assert!(res.is_ok(), "checkpoint_wal must succeed on disk-backed WAL connection: {:?}", res);
    }
}
