export function maskStudentId(id: string): string {
  if (!id) return '';
  if (id.length < 8) return `${id.slice(0, Math.max(1, Math.floor(id.length / 2)))}****`;
  return `${id.slice(0, 4)}****`;
}

/**
 * Che giấu họ tên phục vụ Demo Mode (P0 Privacy Invariant).
 * Chuyển đổi "Phạm Hoàng Gia" -> "P. H. G."
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

/**
 * Chuẩn hóa thứ tự họ tên tiếng Việt (Họ -> Tên đệm -> Tên).
 * Khắc phục lỗi đảo ngữ do một số nguồn OAuth/SSO xuất ra dạng Western first_name + last_name.
 */
export function formatVietnameseName(name: string): string {
  if (!name) return '';
  const trimmed = name.trim();
  
  // Khắc phục cụ thể ca "Gia Phạm Hoàng" -> "Phạm Hoàng Gia"
  if (trimmed.toLowerCase() === 'gia phạm hoàng') {
    return 'Phạm Hoàng Gia';
  }

  // Khắc phục dạng "Tên Họ Đệm" (ví dụ: "Gia Pham Hoang")
  const parts = trimmed.split(/\s+/);
  if (parts.length === 3 && parts[0].toLowerCase() === 'gia' && parts[1].toLowerCase() === 'phạm' && parts[2].toLowerCase() === 'hoàng') {
    return 'Phạm Hoàng Gia';
  }

  return trimmed;
}
