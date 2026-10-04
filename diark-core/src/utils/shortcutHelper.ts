import type { SystemErrorCode } from "../services/systemService";

/**
 * Ánh xạ phím e.code từ bàn phím trình duyệt sang token chuẩn của Tauri/global-hotkey.
 * Hàm thuần (pure function) để dùng chung và unit test độc lập.
 */
export function mapCodeToTauriToken(code: string): string | null {
  // Bỏ qua các phím modifier độc lập
  if (
    code.startsWith("Control") ||
    code.startsWith("Shift") ||
    code.startsWith("Alt") ||
    code.startsWith("Meta") ||
    code.startsWith("OS")
  ) {
    return null;
  }

  // Chữ cái: KeyA -> A, KeyZ -> Z
  if (code.startsWith("Key") && code.length === 4) {
    return code.slice(3).toUpperCase();
  }

  // Số hàng trên: Digit0 -> 0, Digit9 -> 9
  if (code.startsWith("Digit") && code.length === 6) {
    return code.slice(5);
  }

  // Phím chức năng: F1 -> F12
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }

  // Phím số bàn phím phụ: Numpad0 -> Numpad0
  if (code.startsWith("Numpad") && code.length === 7) {
    return code;
  }

  // Phím thông dụng
  switch (code) {
    case "Space":
      return "Space";
    case "Escape":
      return "Escape";
    case "Tab":
      return "Tab";
    case "Backspace":
      return "Backspace";
    case "Enter":
      return "Enter";
    case "ArrowUp":
      return "ArrowUp";
    case "ArrowDown":
      return "ArrowDown";
    case "ArrowLeft":
      return "ArrowLeft";
    case "ArrowRight":
      return "ArrowRight";
    case "Home":
      return "Home";
    case "End":
      return "End";
    case "PageUp":
      return "PageUp";
    case "PageDown":
      return "PageDown";
    case "Insert":
      return "Insert";
    case "Delete":
      return "Delete";
    default:
      return null;
  }
}

/**
 * Kiểm tra nhanh phía UI các quy tắc rủi ro và denylist của mục 6.5.
 * Trả về thông báo lỗi nếu vi phạm, hoặc null nếu hợp lệ.
 */
export function validateShortcutUi(
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  meta: boolean,
  keyToken: string
): string | null {
  // Phải có ít nhất 1 modifier trong [Ctrl, Alt, Meta/Win]
  if (!ctrl && !alt && !meta) {
    return "Phím tắt phải kết hợp ít nhất một trong các phím Ctrl, Alt hoặc Win.";
  }

  // AltGr / xung đột gõ tiếng Việt: Ctrl + Alt + chữ/số
  if (ctrl && alt && !shift && !meta) {
    if (keyToken.length === 1 && /[A-Z0-9]/.test(keyToken)) {
      return "Tổ hợp Ctrl+Alt+[Ký tự] bị chặn để tránh xung đột với phím AltGr và bộ gõ tiếng Việt (Unikey/EVKey).";
    }
  }

  // Chuỗi đại diện để kiểm tra denylist
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  if (meta) parts.push("Super");
  parts.push(keyToken);
  const combo = parts.join("+");

  const denylist = new Set([
    "Ctrl+C",
    "Ctrl+V",
    "Ctrl+X",
    "Ctrl+Z",
    "Ctrl+Y",
    "Ctrl+A",
    "Ctrl+S",
    "Ctrl+W",
    "Alt+Tab",
    "Alt+F4",
    "Alt+Escape",
    "Ctrl+Escape",
    "Ctrl+Shift+Escape",
    "Ctrl+Alt+Delete",
    "Super+L",
    "Super+D",
  ]);

  if (denylist.has(combo)) {
    return `Tổ hợp ${combo} bị hệ thống cấm vì là phím tắt hệ thống Windows quan trọng.`;
  }

  return null;
}

/**
 * Bản đồ dịch mã lỗi backend thành thông báo tiếng Việt dễ hiểu.
 */
export function getFriendlyErrorMessage(code: SystemErrorCode, fallbackMessage?: string): string {
  switch (code) {
    case "INVALID_SHORTCUT_FORMAT":
      return "Định dạng phím tắt không hợp lệ.";
    case "SHORTCUT_TOO_RISKY":
      return "Tổ hợp phím bị từ chối vì rủi ro hệ thống (yêu cầu kèm Ctrl/Alt/Win, tránh AltGr và phím tắt Windows cốt lõi).";
    case "HOTKEY_ALREADY_REGISTERED":
      return "Phím tắt đang bị ứng dụng khác chiếm (ví dụ Unikey/EVKey hoặc phần mềm khác).";
    case "PERSIST_FAILED":
      return "Không thể lưu cấu hình phím tắt vào cơ sở dữ liệu.";
    case "AUTOSTART_OS_FAILED":
      return "Thao tác trên Windows Registry thất bại.";
    case "AUTOSTART_PERSIST_FAILED":
      return "Không thể lưu trạng thái khởi động vào cơ sở dữ liệu.";
    case "INTERNAL_LOCK_POISONED":
      return "Lỗi khóa đồng bộ nội bộ hệ thống.";
    default:
      return fallbackMessage || "Đã xảy ra lỗi không xác định.";
  }
}
