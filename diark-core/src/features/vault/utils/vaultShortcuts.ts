export type VaultShortcutAction =
  | "newNote"
  | "openTemplates"
  | "saveNote"
  | "toggleSource"
  | "toggleGraph"
  | "openGlobalGraph"
  | "focusSearch"
  | "exportPdf";

export type VaultShortcutMap = Record<VaultShortcutAction, string>;

export const DEFAULT_VAULT_SHORTCUTS: VaultShortcutMap = {
  newNote: "Ctrl+N",
  openTemplates: "Ctrl+Shift+T",
  saveNote: "Ctrl+S",
  toggleSource: "Ctrl+M",
  toggleGraph: "Ctrl+G",
  openGlobalGraph: "Ctrl+Shift+G",
  focusSearch: "Ctrl+Shift+F",
  exportPdf: "Ctrl+P",
};

export const VAULT_SHORTCUT_META: Array<{
  action: VaultShortcutAction;
  label: string;
  description: string;
}> = [
  {
    action: "newNote",
    label: "Tạo ghi chú mới",
    description: "Mở nhanh một trang ghi chú trống",
  },
  {
    action: "openTemplates",
    label: "Mở bộ mẫu UIT",
    description: "Chọn mẫu Bài giảng, Code, Việc nhóm, Ôn thi, Lab",
  },
  {
    action: "saveNote",
    label: "Lưu ghi chú hiện tại",
    description: "Ghi ngay nội dung ra file .md và cập nhật chỉ mục",
  },
  {
    action: "toggleSource",
    label: "Chuyển trực quan / Mã .md",
    description: "Xem hoặc sửa trực tiếp mã Markdown gốc",
  },
  {
    action: "toggleGraph",
    label: "Hiện / ẩn mạng liên kết",
    description: "Mở hoặc thu gọn khung đồ thị liên kết bên phải",
  },
  {
    action: "openGlobalGraph",
    label: "Mở toàn bộ đồ thị",
    description: "Xem toàn cảnh các ghi chú đang nối với nhau",
  },
  {
    action: "focusSearch",
    label: "Tìm kiếm ghi chú",
    description: "Đưa con trỏ vào ô tìm nhanh trong danh sách ghi chú",
  },
  {
    action: "exportPdf",
    label: "In / Xuất PDF",
    description: "Mở hộp thoại in hoặc lưu ghi chú thành PDF",
  },
];

export interface KeyboardEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code: string;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function resolveMainKey(e: KeyboardEventLike): string | null {
  const code = e.code || "";
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }
  switch (code) {
    case "Slash":
      return "/";
    case "Backquote":
      return "`";
    case "BracketLeft":
      return "[";
    case "BracketRight":
      return "]";
    case "Comma":
      return ",";
    case "Period":
      return ".";
    case "Minus":
      return "-";
    case "Equal":
      return "=";
    case "Enter":
      return "Enter";
    case "Space":
      return "Space";
    default:
      break;
  }

  const key = (e.key || "").trim();
  if (!key || MODIFIER_KEYS.has(key)) return null;
  if (key.length === 1) return key.toUpperCase();
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  return null;
}

export function normalizeShortcutFromEvent(e: KeyboardEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const mainKey = resolveMainKey(e);
  if (!mainKey) return null;

  const hasCtrl = Boolean(e.ctrlKey || e.metaKey);
  const hasAlt = Boolean(e.altKey);
  const hasShift = Boolean(e.shiftKey);
  const isFnKey = /^F([1-9]|1[0-2])$/.test(mainKey);

  if (!hasCtrl && !hasAlt && !isFnKey) {
    return null;
  }

  const parts: string[] = [];
  if (hasCtrl) parts.push("Ctrl");
  if (hasAlt) parts.push("Alt");
  if (hasShift) parts.push("Shift");
  parts.push(mainKey);
  return parts.join("+");
}

export function canonicalizeShortcutString(combo: string): string {
  const tokens = combo
    .split("+")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";

  let hasCtrl = false;
  let hasAlt = false;
  let hasShift = false;
  let mainKey = "";

  for (const raw of tokens) {
    const lower = raw.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmd" || lower === "meta") {
      hasCtrl = true;
    } else if (lower === "alt" || lower === "option") {
      hasAlt = true;
    } else if (lower === "shift") {
      hasShift = true;
    } else if (raw.length === 1) {
      mainKey = raw.toUpperCase();
    } else if (/^f([1-9]|1[0-2])$/i.test(raw)) {
      mainKey = raw.toUpperCase();
    } else {
      mainKey = raw.charAt(0).toUpperCase() + raw.slice(1);
    }
  }

  if (!mainKey) return "";
  const out: string[] = [];
  if (hasCtrl) out.push("Ctrl");
  if (hasAlt) out.push("Alt");
  if (hasShift) out.push("Shift");
  out.push(mainKey);
  return out.join("+");
}

export function matchesShortcut(e: KeyboardEventLike, combo: string): boolean {
  const expected = canonicalizeShortcutString(combo);
  if (!expected) return false;
  const actual = normalizeShortcutFromEvent(e);
  return actual !== null && actual === expected;
}
