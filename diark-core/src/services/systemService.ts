import { invoke } from "@tauri-apps/api/core";

export type SystemErrorCode =
  | "INVALID_SHORTCUT_FORMAT"
  | "SHORTCUT_TOO_RISKY"
  | "HOTKEY_ALREADY_REGISTERED"
  | "PERSIST_FAILED"
  | "AUTOSTART_OS_FAILED"
  | "AUTOSTART_PERSIST_FAILED"
  | "INTERNAL_LOCK_POISONED"
  | "UNKNOWN_ERROR";

export interface SystemError {
  code: SystemErrorCode;
  message: string;
}

export interface SystemPreferencesDto {
  autostartEnabled: boolean;
  startMinimized: boolean;
  globalShortcut: string;
  hotkeyActive: boolean;
}

/**
 * Narrows an unknown IPC error into a typed SystemError without using `any`.
 */
export function parseSystemError(err: unknown): SystemError {
  if (typeof err === "object" && err !== null) {
    const candidate = err as Record<string, unknown>;
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code as SystemErrorCode,
        message:
          typeof candidate.message === "string"
            ? candidate.message
            : "Lỗi hệ thống không xác định.",
      };
    }
  }
  return {
    code: "UNKNOWN_ERROR",
    message: typeof err === "string" ? err : "Đã xảy ra lỗi không xác định.",
  };
}

/**
 * 1. Lấy thông tin cấu hình hệ thống (autostart, start minimized, hotkey, trạng thái active)
 */
export async function getSystemPreferences(): Promise<SystemPreferencesDto> {
  try {
    return await invoke<SystemPreferencesDto>("get_system_preferences");
  } catch (err: unknown) {
    throw parseSystemError(err);
  }
}

/**
 * 2. Cập nhật thiết lập khởi động cùng Windows
 */
export async function updateAutostartSetting(enabled: boolean): Promise<void> {
  try {
    await invoke<void>("update_autostart_setting", { enabled });
  } catch (err: unknown) {
    throw parseSystemError(err);
  }
}

/**
 * 3. Cập nhật thiết lập khởi động ẩn dưới khay
 */
export async function updateStartMinimizedSetting(enabled: boolean): Promise<void> {
  try {
    await invoke<void>("update_start_minimized_setting", { enabled });
  } catch (err: unknown) {
    throw parseSystemError(err);
  }
}

/**
 * 4. Đổi phím tắt toàn cục (trả về chuỗi canonical chuẩn hóa)
 */
export async function updateGlobalShortcut(newShortcut: string): Promise<string> {
  try {
    return await invoke<string>("update_global_shortcut", { newShortcut });
  } catch (err: unknown) {
    throw parseSystemError(err);
  }
}

/**
 * 5. Tạm dừng hotkey (dành cho Recorder ghi phím tắt)
 */
export async function suspendHotkey(): Promise<void> {
  try {
    await invoke<void>("suspend_hotkey");
  } catch (err: unknown) {
    throw parseSystemError(err);
  }
}

/**
 * 6. Khôi phục hotkey sau khi ghi phím tắt
 */
export async function resumeHotkey(): Promise<void> {
  try {
    await invoke<void>("resume_hotkey");
  } catch (err: unknown) {
    throw parseSystemError(err);
  }
}

/**
 * 7. Báo hiệu UI React đã sẵn sàng để hiển thị cửa sổ (anti-flash)
 */
export async function notifyUiReady(): Promise<void> {
  try {
    await invoke<void>("notify_ui_ready");
  } catch (err: unknown) {
    throw parseSystemError(err);
  }
}
