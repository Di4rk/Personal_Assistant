import React from "react";

/**
 * Render FTS5 snippet sử dụng control marker `\u0001` / `\u0002` thay vì HTML thô,
 * tránh Stored XSS khi ghi chú Markdown chứa thẻ HTML.
 */
export function renderHighlightedSnippet(
  raw: string | null | undefined,
  fallback: string,
  highlightClassName: string
): React.ReactNode {
  const text = raw && raw.length > 0 ? raw : fallback;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    const start = text.indexOf("\u0001", cursor);
    if (start === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    const end = text.indexOf("\u0002", start + 1);
    if (end === -1) {
      parts.push(text.slice(start + 1));
      break;
    }
    const highlighted = text.slice(start + 1, end);
    parts.push(
      <mark key={`hl-${key++}`} className={highlightClassName}>
        {highlighted}
      </mark>
    );
    cursor = end + 1;
  }

  return parts;
}
