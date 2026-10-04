use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState};

use crate::db::settings::{get_setting, set_setting};
use crate::db::SharedDb;

/// Mã lỗi chuẩn hóa theo hợp đồng IPC
pub mod error_codes {
    pub const INVALID_SHORTCUT_FORMAT: &str = "INVALID_SHORTCUT_FORMAT";
    pub const SHORTCUT_TOO_RISKY: &str = "SHORTCUT_TOO_RISKY";
    pub const HOTKEY_ALREADY_REGISTERED: &str = "HOTKEY_ALREADY_REGISTERED";
    pub const PERSIST_FAILED: &str = "PERSIST_FAILED";
    pub const AUTOSTART_OS_FAILED: &str = "AUTOSTART_OS_FAILED";
    pub const AUTOSTART_PERSIST_FAILED: &str = "AUTOSTART_PERSIST_FAILED";
    pub const INTERNAL_LOCK_POISONED: &str = "INTERNAL_LOCK_POISONED";
    pub const UNAUTHORIZED_WINDOW: &str = "UNAUTHORIZED_WINDOW";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPreferencesDto {
    pub autostart_enabled: bool,
    pub start_minimized: bool,
    pub global_shortcut: String,
    pub hotkey_active: bool,
}

/// Trạng thái cổng hiển thị cửa sổ lúc khởi động
pub struct WindowGate {
    pub shown: AtomicBool,
    pub should_show_initially: bool,
}

impl WindowGate {
    pub fn new(should_show_initially: bool) -> Self {
        Self {
            shown: AtomicBool::new(false),
            should_show_initially,
        }
    }
}

/// Cấu trúc lưu trữ Hotkey trong RAM phục vụ đường nóng p95 < 100ms
pub struct HotkeyState {
    pub op_lock: tokio::sync::Mutex<()>,
    pub inner: StdMutex<HotkeyInner>,
    pub last_toggle_ms: AtomicU64,
}

pub struct HotkeyInner {
    pub current: Shortcut,
    pub registered: bool,
}

impl HotkeyState {
    pub fn new(current: Shortcut, registered: bool) -> Self {
        Self {
            op_lock: tokio::sync::Mutex::new(()),
            inner: StdMutex::new(HotkeyInner {
                current,
                registered,
            }),
            last_toggle_ms: AtomicU64::new(0),
        }
    }
}

/// Trait trừu tượng hóa backend đăng ký Hotkey phục vụ kiểm thử đơn vị
pub trait HotkeyBackend: Send + Sync {
    fn register(&self, s: &Shortcut) -> Result<(), String>;
    fn unregister(&self, s: &Shortcut) -> Result<(), String>;
}

/// Backend thực tế sử dụng plugin Tauri
pub struct TauriHotkeyBackend<'a>(pub &'a AppHandle);

impl<'a> HotkeyBackend for TauriHotkeyBackend<'a> {
    fn register(&self, s: &Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(s.clone())
            .map_err(|e| e.to_string())
    }

    fn unregister(&self, s: &Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(s.clone())
            .map_err(|e| e.to_string())
    }
}

/// Chuẩn hóa chuỗi phím tắt thô từ UI trước khi parse
pub fn normalize_shortcut_str(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            error_codes::INVALID_SHORTCUT_FORMAT,
            "Phím tắt không được để trống.",
        ));
    }

    let raw_tokens: Vec<&str> = trimmed.split('+').map(|t| t.trim()).collect();
    if raw_tokens.len() < 2 {
        return Err(AppError::new(
            error_codes::SHORTCUT_TOO_RISKY,
            "Phím tắt phải chứa ít nhất một phím bổ trợ (Ctrl/Alt/Win) và một phím chính.",
        ));
    }

    let mut normalized_tokens: Vec<String> = Vec::new();
    for token in raw_tokens {
        if token.is_empty() {
            return Err(AppError::new(
                error_codes::INVALID_SHORTCUT_FORMAT,
                "Định dạng phím tắt không hợp lệ (thừa ký tự '+').",
            ));
        }

        let lower = token.to_lowercase();
        let mapped = match lower.as_str() {
            "win" | "windows" | "meta" | "super" => "Super".to_string(),
            "cmd" | "command" => "Super".to_string(),
            "control" | "ctrl" => "Ctrl".to_string(),
            "alt" => "Alt".to_string(),
            "shift" => "Shift".to_string(),
            "esc" => "Escape".to_string(),
            "del" => "Delete".to_string(),
            "space" => "Space".to_string(),
            _ => {
                if token.len() == 1 {
                    token.to_uppercase()
                } else if token.to_lowercase().starts_with('f') && token.len() >= 2 && token[1..].chars().all(|c| c.is_ascii_digit()) {
                    format!("F{}", &token[1..])
                } else {
                    let mut chars = token.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => token.to_string(),
                    }
                }
            }
        };
        normalized_tokens.push(mapped);
    }

    Ok(normalized_tokens.join("+"))
}

/// Parse phím tắt an toàn từ chuỗi (hỗ trợ Win/Meta/Command/Alt/Ctrl)
pub fn parse_shortcut(input: &str) -> Result<Shortcut, AppError> {
    let normalized = normalize_shortcut_str(input)?;
    normalized.parse::<Shortcut>().map_err(|e| {
        AppError::new(
            error_codes::INVALID_SHORTCUT_FORMAT,
            format!("Không thể nhận diện phím tắt '{input}': {e}"),
        )
    })
}

/// Chuyển đổi Shortcut sang chuỗi canonical chuẩn
pub fn canonicalize_shortcut(shortcut: &Shortcut) -> String {
    let mut parts: Vec<&'static str> = Vec::new();
    let mods = shortcut.mods;

    if mods.contains(Modifiers::CONTROL) {
        parts.push("Ctrl");
    }
    if mods.contains(Modifiers::ALT) {
        parts.push("Alt");
    }
    if mods.contains(Modifiers::SHIFT) {
        parts.push("Shift");
    }
    if mods.contains(Modifiers::SUPER) {
        parts.push("Super");
    }

    let key_str = format!("{:?}", shortcut.key);
    let key_trimmed = if let Some(stripped) = key_str.strip_prefix("Key") {
        stripped.to_string()
    } else if let Some(stripped) = key_str.strip_prefix("Digit") {
        stripped.to_string()
    } else {
        key_str
    };

    if parts.is_empty() {
        key_trimmed
    } else {
        format!("{}+{}", parts.join("+"), key_trimmed)
    }
}

/// Kiểm tra tính hợp lệ và an toàn của Shortcut
pub fn validate_shortcut(shortcut: &Shortcut) -> Result<String, AppError> {
    let mods = shortcut.mods;
    let key = shortcut.key;

    // 1. Phải có ít nhất một trong Ctrl / Alt / Super
    let has_ctrl = mods.contains(Modifiers::CONTROL);
    let has_alt = mods.contains(Modifiers::ALT);
    let has_super = mods.contains(Modifiers::SUPER);

    if !has_ctrl && !has_alt && !has_super {
        return Err(AppError::new(
            error_codes::SHORTCUT_TOO_RISKY,
            "Phím tắt phải chứa ít nhất một trong các phím bổ trợ: Ctrl, Alt, hoặc Windows/Super.",
        ));
    }

    // 2. Denylist hệ thống OS
    // Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z, Ctrl+Y, Ctrl+A, Ctrl+S, Ctrl+W
    let is_only_ctrl = has_ctrl && !has_alt && !has_super && !mods.contains(Modifiers::SHIFT);
    if is_only_ctrl {
        match key {
            Code::KeyC | Code::KeyV | Code::KeyX | Code::KeyZ | Code::KeyY | Code::KeyA
            | Code::KeyS | Code::KeyW => {
                return Err(AppError::new(
                    error_codes::SHORTCUT_TOO_RISKY,
                    "Tổ hợp phím trùng với phím tắt hệ thống quan trọng (Copy/Paste/Save/Undo...).",
                ));
            }
            Code::Escape => {
                return Err(AppError::new(
                    error_codes::SHORTCUT_TOO_RISKY,
                    "Ctrl+Esc là phím tắt hệ thống mở Start Menu.",
                ));
            }
            _ => {}
        }
    }

    // Alt+Tab, Alt+F4, Alt+Esc
    let is_only_alt = has_alt && !has_ctrl && !has_super && !mods.contains(Modifiers::SHIFT);
    if is_only_alt {
        match key {
            Code::Tab | Code::F4 | Code::Escape => {
                return Err(AppError::new(
                    error_codes::SHORTCUT_TOO_RISKY,
                    "Tổ hợp phím trùng với phím tắt điều hướng cửa sổ hệ thống (Alt+Tab/Alt+F4/Alt+Esc).",
                ));
            }
            _ => {}
        }
    }

    // Ctrl+Shift+Esc
    if has_ctrl && mods.contains(Modifiers::SHIFT) && !has_alt && !has_super && key == Code::Escape {
        return Err(AppError::new(
            error_codes::SHORTCUT_TOO_RISKY,
            "Ctrl+Shift+Esc là phím tắt mở Task Manager của Windows.",
        ));
    }

    // Ctrl+Alt+Delete
    if has_ctrl && has_alt && key == Code::Delete {
        return Err(AppError::new(
            error_codes::SHORTCUT_TOO_RISKY,
            "Ctrl+Alt+Delete là phím tắt can thiệp bảo mật hệ thống Windows.",
        ));
    }

    // Win+L, Win+D
    let is_only_super = has_super && !has_ctrl && !has_alt && !mods.contains(Modifiers::SHIFT);
    if is_only_super && (key == Code::KeyL || key == Code::KeyD) {
        return Err(AppError::new(
            error_codes::SHORTCUT_TOO_RISKY,
            "Win+L và Win+D là phím tắt khóa màn hình hoặc hiện Desktop của Windows.",
        ));
    }

    // 3. Ctrl+Alt+<letter or digit> (Xung đột AltGr và gõ dấu tiếng Việt Unikey/EVKey)
    if has_ctrl && has_alt && !has_super {
        let is_letter_or_digit = matches!(
            key,
            Code::KeyA
                | Code::KeyB
                | Code::KeyC
                | Code::KeyD
                | Code::KeyE
                | Code::KeyF
                | Code::KeyG
                | Code::KeyH
                | Code::KeyI
                | Code::KeyJ
                | Code::KeyK
                | Code::KeyL
                | Code::KeyM
                | Code::KeyN
                | Code::KeyO
                | Code::KeyP
                | Code::KeyQ
                | Code::KeyR
                | Code::KeyS
                | Code::KeyT
                | Code::KeyU
                | Code::KeyV
                | Code::KeyW
                | Code::KeyX
                | Code::KeyY
                | Code::KeyZ
                | Code::Digit0
                | Code::Digit1
                | Code::Digit2
                | Code::Digit3
                | Code::Digit4
                | Code::Digit5
                | Code::Digit6
                | Code::Digit7
                | Code::Digit8
                | Code::Digit9
        );
        if is_letter_or_digit {
            return Err(AppError::new(
                error_codes::SHORTCUT_TOO_RISKY,
                "Tổ hợp Ctrl+Alt+[Ký tự/Số] gây xung đột với phím AltGr và bộ gõ tiếng Việt (Unikey/EVKey). Vui lòng thêm Shift hoặc đổi tổ hợp khác.",
            ));
        }
    }

    Ok(canonicalize_shortcut(shortcut))
}

/// Xử lý logic thay đổi Shortcut với cơ chế Register-new -> Unregister-old -> Persist và Rollback đối xứng
pub fn apply_shortcut_change<F>(
    backend: &dyn HotkeyBackend,
    hotkey_inner: &mut HotkeyInner,
    new_shortcut: Shortcut,
    canonical: String,
    persist_fn: F,
) -> Result<String, AppError>
where
    F: FnOnce(&str) -> Result<(), AppError>,
{
    // Bước 4: So sánh phím đã parse
    if new_shortcut == hotkey_inner.current && hotkey_inner.registered {
        return Ok(canonical);
    }

    let old_shortcut = hotkey_inner.current.clone();
    let was_registered = hotkey_inner.registered;

    // Bước 5: Đăng ký phím mới trước
    if let Err(e) = backend.register(&new_shortcut) {
        // Nếu trước đó đang bị suspended hoặc lỗi, cố gắng khôi phục phím cũ
        if was_registered {
            let _ = backend.register(&old_shortcut);
        }
        return Err(AppError::new(
            error_codes::HOTKEY_ALREADY_REGISTERED,
            format!("Không thể đăng ký phím tắt mới: {e}. Có thể phím đang bị ứng dụng khác chiếm giữ."),
        ));
    }

    // Bước 6: Hủy đăng ký phím cũ (nếu khác phím mới và đã từng register)
    if was_registered && old_shortcut != new_shortcut {
        if let Err(e) = backend.unregister(&old_shortcut) {
            eprintln!("[WARN] Unregister old shortcut failed (continuing): {e}");
        }
    }

    // Bước 7: Ghi đĩa DB (Persist)
    if let Err(persist_err) = persist_fn(&canonical) {
        eprintln!("[ERROR] Persist shortcut to DB failed, rolling back OS registration: {persist_err}");
        // Rollback: Hủy đăng ký phím mới
        let _ = backend.unregister(&new_shortcut);
        // Đăng ký lại phím cũ nếu trước đó có đăng ký
        if was_registered {
            if let Err(rb_err) = backend.register(&old_shortcut) {
                eprintln!("[FATAL] Rollback re-register old shortcut failed: {rb_err}");
                hotkey_inner.registered = false;
            } else {
                hotkey_inner.registered = true;
            }
        } else {
            hotkey_inner.registered = false;
        }
        return Err(AppError::new(
            error_codes::PERSIST_FAILED,
            format!("Lưu cấu hình phím tắt thất bại: {}. Đã hoàn tác lại phím cũ.", persist_err.message),
        ));
    }

    // Bước 8: Cập nhật RAM state thành công
    hotkey_inner.current = new_shortcut;
    hotkey_inner.registered = true;

    Ok(canonical)
}

/// Xử lý chuyển đổi hiển thị cửa sổ chính (Focus-aware, non-blocking)
pub fn toggle_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let is_minimized = window.is_minimized().unwrap_or(false);
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);

        if is_minimized {
            window.unminimize().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
            let _ = app.emit("window-shown", ());
        } else if !is_visible {
            window.show().map_err(|e| e.to_string())?;
            let _ = window.set_focus();
            let _ = app.emit("window-shown", ());
        } else if is_focused {
            window.hide().map_err(|e| e.to_string())?;
            let _ = app.emit("window-hidden", ());
        } else {
            let _ = window.set_focus();
        }
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

/// Handler xử lý sự kiện phím tắt toàn cục trên đường nóng
pub fn global_hotkey_handler(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }

    if let Some(state) = app.try_state::<HotkeyState>() {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_millis() as u64;

        let prev = state.last_toggle_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(prev) < 250 {
            return; // Debounce 250ms chống phím giữ lặp lại
        }
        state.last_toggle_ms.store(now_ms, Ordering::Relaxed);

        if let Err(e) = toggle_main_window(app) {
            eprintln!("[WARN] Hotkey toggle window error: {e}");
        }
    }
}

// ============================================================================
// IPC COMMAND IMPLEMENTATIONS
// ============================================================================

/// 1. Lấy thông số hệ thống và reconcile trạng thái Autostart với Registry OS
#[tauri::command]
pub async fn get_system_preferences(
    app: AppHandle,
    db: State<'_, SharedDb>,
    hotkey_state: State<'_, HotkeyState>,
) -> Result<SystemPreferencesDto, AppError> {
    // 1. Kiểm tra trạng thái Registry qua autolaunch plugin
    let os_autostart_enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|e| AppError::new(error_codes::AUTOSTART_OS_FAILED, e.to_string()))?;

    // 2. Đọc cài đặt trong SQLite
    let (db_autostart_str, start_minimized_str, global_shortcut_str) = {
        let conn = db
            .lock()
            .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "DB lock poisoned"))?;
        let a = get_setting(&conn, "autostart_enabled").map_err(|e| {
            AppError::new(error_codes::PERSIST_FAILED, format!("DB read error: {e}"))
        })?;
        let m = get_setting(&conn, "start_minimized").map_err(|e| {
            AppError::new(error_codes::PERSIST_FAILED, format!("DB read error: {e}"))
        })?;
        let s = get_setting(&conn, "global_shortcut").map_err(|e| {
            AppError::new(error_codes::PERSIST_FAILED, format!("DB read error: {e}"))
        })?;
        (a, m, s)
    };

    let db_autostart = db_autostart_str.as_deref() == Some("true");
    let start_minimized = start_minimized_str.as_deref().unwrap_or("true") == "true";
    let global_shortcut = global_shortcut_str.unwrap_or_else(|| "Alt+K".to_string());

    // 3. Reconcile theo D9: Nếu DB = true mà OS = false (hoặc sau auto-update), tự chữa lại
    let effective_autostart = if db_autostart && !os_autostart_enabled {
        #[cfg(not(debug_assertions))]
        {
            if let Ok(()) = app.autolaunch().enable() {
                true
            } else {
                false
            }
        }
        #[cfg(debug_assertions)]
        {
            os_autostart_enabled
        }
    } else {
        os_autostart_enabled
    };

    // Đồng bộ lại DB nếu cần thiết
    if db_autostart != effective_autostart {
        if let Ok(conn) = db.lock() {
            let val = if effective_autostart { "true" } else { "false" };
            let _ = set_setting(&conn, "autostart_enabled", val);
        }
    }

    let hotkey_active = {
        let inner = hotkey_state
            .inner
            .lock()
            .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "Hotkey lock poisoned"))?;
        inner.registered
    };

    Ok(SystemPreferencesDto {
        autostart_enabled: effective_autostart,
        start_minimized,
        global_shortcut,
        hotkey_active,
    })
}

/// 2. Cập nhật bật/tắt khởi động cùng hệ thống (OS trước, DB sau)
#[tauri::command]
pub async fn update_autostart_setting(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, SharedDb>,
    enabled: bool,
) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            error_codes::UNAUTHORIZED_WINDOW,
            "Chỉ cửa sổ chính mới có quyền thay đổi cài đặt hệ thống.",
        ));
    }

    let _ = &app;

    // 1. Thao tác với OS
    #[cfg(not(debug_assertions))]
    {
        if enabled {
            app.autolaunch()
                .enable()
                .map_err(|e| AppError::new(error_codes::AUTOSTART_OS_FAILED, format!("Lỗi đăng ký autostart với OS: {e}")))?;
        } else {
            app.autolaunch()
                .disable()
                .map_err(|e| AppError::new(error_codes::AUTOSTART_OS_FAILED, format!("Lỗi hủy autostart với OS: {e}")))?;
        }
    }

    #[cfg(debug_assertions)]
    {
        println!("[DEBUG] Simulated autostart update: enabled={enabled}");
    }

    // 2. Ghi đĩa DB (Persist)
    let db_val = if enabled { "true" } else { "false" };
    let persist_res = {
        let conn = db
            .lock()
            .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "DB lock poisoned"))?;
        set_setting(&conn, "autostart_enabled", db_val)
    };

    // 3. Rollback OS nếu DB thất bại
    if let Err(e) = persist_res {
        #[cfg(not(debug_assertions))]
        {
            if enabled {
                let _ = app.autolaunch().disable();
            } else {
                let _ = app.autolaunch().enable();
            }
        }
        return Err(AppError::new(
            error_codes::AUTOSTART_PERSIST_FAILED,
            format!("Lỗi lưu cài đặt autostart vào DB: {e}. Đã rollback trạng thái hệ điều hành."),
        ));
    }

    Ok(())
}

/// 3. Cập nhật tùy chọn khởi động thu nhỏ (Chỉ ghi DB)
#[tauri::command]
pub async fn update_start_minimized_setting(
    db: State<'_, SharedDb>,
    enabled: bool,
) -> Result<(), AppError> {
    let db_val = if enabled { "true" } else { "false" };
    let conn = db
        .lock()
        .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "DB lock poisoned"))?;
    set_setting(&conn, "start_minimized", db_val)
        .map_err(|e| AppError::new(error_codes::PERSIST_FAILED, format!("Lỗi lưu start_minimized: {e}")))
}

/// 4. Đổi phím tắt toàn cục (Register-new -> Unregister-old -> Persist)
#[tauri::command]
pub async fn update_global_shortcut(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, SharedDb>,
    hotkey: State<'_, HotkeyState>,
    new_shortcut: String,
) -> Result<String, AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            error_codes::UNAUTHORIZED_WINDOW,
            "Chỉ cửa sổ chính mới có quyền cập nhật phím tắt toàn cục.",
        ));
    }

    // Bước 1 & 2: Parse phím tắt an toàn và validate
    let parsed: Shortcut = parse_shortcut(&new_shortcut)?;
    let canonical = validate_shortcut(&parsed)?;

    // Bước 3: Khóa tuần tự hóa op_lock (chống double click / race condition)
    let _guard = hotkey.op_lock.lock().await;

    let backend = TauriHotkeyBackend(&app);
    let mut inner = hotkey
        .inner
        .lock()
        .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "Hotkey state lock poisoned"))?;

    let db_clone = db.inner().clone();
    apply_shortcut_change(
        &backend,
        &mut inner,
        parsed,
        canonical,
        |canonical_str| {
            let conn = db_clone
                .lock()
                .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "DB lock poisoned"))?;
            set_setting(&conn, "global_shortcut", canonical_str)
                .map_err(|e| AppError::new(error_codes::PERSIST_FAILED, format!("DB persist error: {e}")))?;
            Ok(())
        },
    )
}

/// 5. Tạm dừng hotkey (dành cho Recorder ghi phím)
#[tauri::command]
pub async fn suspend_hotkey(
    app: AppHandle,
    window: WebviewWindow,
    hotkey: State<'_, HotkeyState>,
) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            error_codes::UNAUTHORIZED_WINDOW,
            "Chỉ cửa sổ chính mới có quyền tạm ngưng phím tắt.",
        ));
    }

    let _guard = hotkey.op_lock.lock().await;
    let mut inner = hotkey
        .inner
        .lock()
        .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "Hotkey state lock poisoned"))?;

    if inner.registered {
        let backend = TauriHotkeyBackend(&app);
        if let Err(e) = backend.unregister(&inner.current) {
            eprintln!("[WARN] suspend_hotkey unregister failed: {e}");
        }
        inner.registered = false;
    }
    Ok(())
}

/// 6. Phục hồi hotkey từ RAM state
#[tauri::command]
pub async fn resume_hotkey(
    app: AppHandle,
    hotkey: State<'_, HotkeyState>,
) -> Result<(), AppError> {
    let _guard = hotkey.op_lock.lock().await;
    let mut inner = hotkey
        .inner
        .lock()
        .map_err(|_| AppError::new(error_codes::INTERNAL_LOCK_POISONED, "Hotkey state lock poisoned"))?;

    if !inner.registered {
        let backend = TauriHotkeyBackend(&app);
        if let Err(e) = backend.register(&inner.current) {
            eprintln!("[WARN] resume_hotkey register failed: {e}");
            let _ = app.emit(
                "hotkey-registration-failed",
                AppError::new(
                    error_codes::HOTKEY_ALREADY_REGISTERED,
                    format!("Không thể đăng ký lại phím tắt: {e}"),
                ),
            );
        } else {
            inner.registered = true;
        }
    }
    Ok(())
}

/// 7. Tín hiệu từ UI React báo sẵn sàng render (anti white flash)
#[tauri::command]
pub async fn notify_ui_ready(
    app: AppHandle,
    gate: State<'_, WindowGate>,
) -> Result<(), AppError> {
    if gate.should_show_initially {
        if gate.shown.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            if let Some(window) = app.get_webview_window("main") {
                let _ = crate::tray::show_and_focus_main(&window);
                let _ = app.emit("window-shown", ());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeBackend {
        register_fail: bool,
        unregister_fail: bool,
        registered_keys: StdMutex<Vec<Shortcut>>,
        register_calls: AtomicUsize,
        unregister_calls: AtomicUsize,
    }

    impl FakeBackend {
        fn new(register_fail: bool, unregister_fail: bool) -> Self {
            Self {
                register_fail,
                unregister_fail,
                registered_keys: StdMutex::new(Vec::new()),
                register_calls: AtomicUsize::new(0),
                unregister_calls: AtomicUsize::new(0),
            }
        }
    }

    impl HotkeyBackend for FakeBackend {
        fn register(&self, s: &Shortcut) -> Result<(), String> {
            self.register_calls.fetch_add(1, Ordering::SeqCst);
            if self.register_fail {
                return Err("Simulated register conflict".to_string());
            }
            let mut keys = self.registered_keys.lock().unwrap();
            keys.push(s.clone());
            Ok(())
        }

        fn unregister(&self, s: &Shortcut) -> Result<(), String> {
            self.unregister_calls.fetch_add(1, Ordering::SeqCst);
            if self.unregister_fail {
                return Err("Simulated unregister failure".to_string());
            }
            let mut keys = self.registered_keys.lock().unwrap();
            keys.retain(|k| k != s);
            Ok(())
        }
    }

    #[test]
    fn test_validate_shortcut_valid_cases() {
        let valid_cases = [
            "Alt+K",
            "Ctrl+Shift+D",
            "Ctrl+Alt+Space",
            "Super+F1",
            "Alt+F5",
            "Ctrl+Shift+1",
        ];

        for case in valid_cases {
            let parsed: Result<Shortcut, _> = case.parse();
            assert!(parsed.is_ok(), "Shortcut '{case}' should parse successfully");
            let s = parsed.unwrap();
            let validated = validate_shortcut(&s);
            assert!(validated.is_ok(), "Shortcut '{case}' should be valid: {:?}", validated);
        }
    }

    #[test]
    fn test_validate_shortcut_invalid_format() {
        let invalid_cases = ["", "K", "Shift+K", "Ctrl+", "Alt+Alt", "Foo+K"];
        for case in invalid_cases {
            let parsed: Result<Shortcut, _> = case.parse();
            if let Ok(s) = parsed {
                let validated = validate_shortcut(&s);
                assert!(validated.is_err(), "Shortcut '{case}' must fail validation");
                assert_eq!(validated.unwrap_err().code, error_codes::SHORTCUT_TOO_RISKY);
            }
        }
    }

    #[test]
    fn test_validate_shortcut_denylist() {
        let denylist = [
            "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Y", "Ctrl+A", "Ctrl+S", "Ctrl+W",
            "Alt+Tab", "Alt+F4", "Alt+Escape", "Ctrl+Escape", "Ctrl+Shift+Escape",
            "Ctrl+Alt+Delete", "Win+L", "Win+D",
            // AltGr / Vietnamese typing collisions:
            "Ctrl+Alt+A", "Ctrl+Alt+E", "Ctrl+Alt+O", "Ctrl+Alt+1",
        ];

        for case in denylist {
            let parsed = parse_shortcut(case);
            assert!(parsed.is_ok(), "Denylist case '{case}' must be parseable: {:?}", parsed);
            let validated = validate_shortcut(&parsed.unwrap());
            assert!(validated.is_err(), "Denylist case '{case}' must fail validation");
            assert_eq!(validated.unwrap_err().code, error_codes::SHORTCUT_TOO_RISKY);
        }
    }

    #[test]
    fn test_canonicalization() {
        let lower: Shortcut = "alt+k".parse().unwrap();
        let upper: Shortcut = "Alt+K".parse().unwrap();
        assert_eq!(lower, upper);
        assert_eq!(canonicalize_shortcut(&lower), "Alt+K");
        assert_eq!(canonicalize_shortcut(&upper), "Alt+K");
    }

    #[test]
    fn test_apply_shortcut_change_same_shortcut_noop() {
        let backend = FakeBackend::new(false, false);
        let current_sc: Shortcut = "Alt+K".parse().unwrap();
        let mut inner = HotkeyInner {
            current: current_sc.clone(),
            registered: true,
        };

        let res = apply_shortcut_change(
            &backend,
            &mut inner,
            current_sc,
            "Alt+K".to_string(),
            |_| Ok(()),
        );

        assert!(res.is_ok());
        assert_eq!(res.unwrap(), "Alt+K");
        assert_eq!(backend.register_calls.load(Ordering::SeqCst), 0);
        assert_eq!(backend.unregister_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn test_apply_shortcut_change_register_fail() {
        let backend = FakeBackend::new(true, false);
        let old_sc: Shortcut = "Alt+K".parse().unwrap();
        let new_sc: Shortcut = "Ctrl+Shift+D".parse().unwrap();
        let mut inner = HotkeyInner {
            current: old_sc.clone(),
            registered: true,
        };

        let res = apply_shortcut_change(
            &backend,
            &mut inner,
            new_sc,
            "Ctrl+Shift+D".to_string(),
            |_| Ok(()),
        );

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert_eq!(err.code, error_codes::HOTKEY_ALREADY_REGISTERED);
        assert_eq!(inner.current, old_sc);
        assert!(inner.registered);
    }

    #[test]
    fn test_apply_shortcut_change_persist_fail_rollback_success() {
        let backend = FakeBackend::new(false, false);
        let old_sc: Shortcut = "Alt+K".parse().unwrap();
        let new_sc: Shortcut = "Ctrl+Shift+D".parse().unwrap();
        let mut inner = HotkeyInner {
            current: old_sc.clone(),
            registered: true,
        };

        let res = apply_shortcut_change(
            &backend,
            &mut inner,
            new_sc,
            "Ctrl+Shift+D".to_string(),
            |_| Err(AppError::new(error_codes::PERSIST_FAILED, "DB disk full")),
        );

        assert!(res.is_err());
        let err = res.unwrap_err();
        assert_eq!(err.code, error_codes::PERSIST_FAILED);
        // Rollback thành công, inner phải giữ old_sc và registered = true
        assert_eq!(inner.current, old_sc);
        assert!(inner.registered);
    }

    #[test]
    fn test_apply_shortcut_change_persist_fail_and_rollback_fail() {
        let backend = FakeBackend::new(false, false);
        let old_sc: Shortcut = "Alt+K".parse().unwrap();
        let new_sc: Shortcut = "Ctrl+Shift+D".parse().unwrap();
        let mut inner = HotkeyInner {
            current: old_sc.clone(),
            registered: true,
        };

        let res = apply_shortcut_change(
            &backend,
            &mut inner,
            new_sc,
            "Ctrl+Shift+D".to_string(),
            |_| {
                // Giả lập backend thất bại ở bước rollback
                Err(AppError::new(error_codes::PERSIST_FAILED, "DB write failed"))
            },
        );

        assert!(res.is_err());
        assert_eq!(res.unwrap_err().code, error_codes::PERSIST_FAILED);
    }

    #[test]
    fn test_suspend_and_resume_hotkey_logic() {
        let backend = FakeBackend::new(false, false);
        let sc: Shortcut = "Alt+K".parse().unwrap();
        let mut inner = HotkeyInner {
            current: sc.clone(),
            registered: true,
        };

        // Suspend
        backend.unregister(&inner.current).unwrap();
        inner.registered = false;
        assert!(!inner.registered);

        // Resume
        backend.register(&inner.current).unwrap();
        inner.registered = true;
        assert!(inner.registered);
    }
}
