export function maskStudentId(id: string): string {
  if (!id) return '';
  if (id.length < 8) return `${id.slice(0, Math.max(1, Math.floor(id.length / 2)))}****`;
  return `${id.slice(0, 4)}****`;
}

/**
 * Che giấu họ tên phục vụ Demo Mode (P0 Privacy Invariant).
 * Chuyển đổi "Nguyễn Văn An" -> "N. V. A."
 */
export function maskFullName(name: string): string {
  if (!name) return '';
  const normalized = formatVietnameseName(name);
  return normalized
    .trim()
    .split(/\s+/)
    .map((part) => (part.length > 0 ? `${part[0].toUpperCase()}.` : ''))
    .filter(Boolean)
    .join(' ');
}

export function maskClassName(className: string): string {
  if (!className) return '';
  const match = className.match(/^([A-Za-z0-9]+)/);
  const prefix = match ? match[1] : className.slice(0, 4);
  return `${prefix.slice(0, Math.min(4, prefix.length))}****`;
}

const COMMON_VN_SURNAMES: ReadonlySet<string> = new Set([
  "nguyen",
  "tran",
  "le",
  "pham",
  "hoang",
  "huynh",
  "phan",
  "vu",
  "vo",
  "dang",
  "bui",
  "do",
  "ho",
  "ngo",
  "duong",
  "ly",
  "dinh",
  "truong",
  "doan",
  "lam",
  "mai",
  "to",
  "ta",
  "trinh",
  "cao",
  "chau",
  "luu",
  "thai",
  "tang",
  "luong",
  "phung",
  "quach",
  "hua",
  "nghiem",
  "ha",
  "tu",
  "kieu",
  "bach",
  "la",
  "vuong",
  "dao",
  "chu",
  "chung",
  "mac",
  "ton",
  "diep",
  "khuu",
  "nghia",
  "quynh",
]);

function stripVnDiacritics(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
}

/**
 * Chuẩn hóa thứ tự họ tên tiếng Việt (Họ -> Tên đệm -> Tên).
 * Khắc phục lỗi đảo ngữ do một số nguồn OAuth/SSO xuất ra dạng Western first_name + last_name.
 */
export function formatVietnameseName(name: string): string {
  if (!name) return "";
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);

  if (
    parts.length >= 2 &&
    !COMMON_VN_SURNAMES.has(stripVnDiacritics(parts[0])) &&
    COMMON_VN_SURNAMES.has(stripVnDiacritics(parts[1]))
  ) {
    return [...parts.slice(1), parts[0]].join(" ");
  }

  return trimmed;
}

export function extractVietnameseGivenName(rawFullName: string): string {
  const normalized = formatVietnameseName(rawFullName).trim();
  if (!normalized) return "";
  const parts = normalized.split(/\s+/);
  return parts[parts.length - 1] ?? "";
}
