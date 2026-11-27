export type MarkdownBlock =
  | { type: "code"; startLine: number; language: string; code: string }
  | { type: "hr"; startLine: number }
  | { type: "heading"; startLine: number; level: 1 | 2 | 3 | 4; text: string }
  | { type: "callout"; startLine: number; kind: string; customTitle: string; lines: string[] }
  | { type: "blockquote"; startLine: number; lines: string[] }
  | { type: "table"; startLine: number; headers: string[]; rows: string[][] }
  | {
      type: "ul";
      startLine: number;
      items: Array<{ lineIndex: number; text: string; isTask: boolean; checked: boolean }>;
    }
  | {
      type: "ol";
      startLine: number;
      items: Array<{ lineIndex: number; num: string; text: string }>;
    }
  | { type: "paragraph"; startLine: number; text: string };

const HEADING_RE = /^(#{1,4})\s+(.+)$/;
const HR_RE = /^(-{3,}|\*{3,})$/;
const TABLE_SEP_RE = /^\s*\|?[\s:-]+\|/;
const CALLOUT_RE = /^>\s*\[!([a-zA-Z]+)\]\s*(.*)$/;
const UL_ITEM_RE = /^\s*[-*]\s+/;
const TASK_ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const OL_ITEM_RE = /^\s*(\d+)\.\s+(.*)$/;

export function isTableStart(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false;
  return lines[idx].trim().startsWith("|") && TABLE_SEP_RE.test(lines[idx + 1]);
}

export function isBlockStart(lines: string[], idx: number): boolean {
  const line = lines[idx];
  const trimmed = line.trim();
  return (
    trimmed.startsWith("```") ||
    HR_RE.test(trimmed) ||
    HEADING_RE.test(trimmed) ||
    trimmed.startsWith(">") ||
    isTableStart(lines, idx) ||
    UL_ITEM_RE.test(line) ||
    OL_ITEM_RE.test(line)
  );
}

function parseTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      const startLine = i;
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", startLine, language: lang, code: codeLines.join("\n") });
      continue;
    }

    if (HR_RE.test(trimmed)) {
      blocks.push({ type: "hr", startLine: i });
      i += 1;
      continue;
    }

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", startLine: i, level, text: headingMatch[2] });
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const startLine = i;
      const calloutMatch = CALLOUT_RE.exec(trimmed);
      const quoteLines: string[] = [];
      if (calloutMatch) {
        const kind = calloutMatch[1].toLowerCase();
        const customTitle = calloutMatch[2].trim();
        i += 1;
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        blocks.push({ type: "callout", startLine, kind, customTitle, lines: quoteLines });
      } else {
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        blocks.push({ type: "blockquote", startLine, lines: quoteLines });
      }
      continue;
    }

    if (isTableStart(lines, i)) {
      const startLine = i;
      const headers = parseTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", startLine, headers, rows });
      continue;
    }

    if (UL_ITEM_RE.test(line)) {
      const startLine = i;
      const items: Array<{ lineIndex: number; text: string; isTask: boolean; checked: boolean }> = [];
      while (i < lines.length && UL_ITEM_RE.test(lines[i])) {
        const taskMatch = TASK_ITEM_RE.exec(lines[i]);
        if (taskMatch) {
          items.push({
            lineIndex: i,
            text: taskMatch[2],
            isTask: true,
            checked: taskMatch[1].toLowerCase() === "x",
          });
        } else {
          items.push({
            lineIndex: i,
            text: lines[i].replace(UL_ITEM_RE, ""),
            isTask: false,
            checked: false,
          });
        }
        i += 1;
      }
      blocks.push({ type: "ul", startLine, items });
      continue;
    }

    if (OL_ITEM_RE.test(line)) {
      const startLine = i;
      const items: Array<{ lineIndex: number; num: string; text: string }> = [];
      while (i < lines.length && OL_ITEM_RE.test(lines[i])) {
        const m = OL_ITEM_RE.exec(lines[i]);
        if (m) {
          items.push({ lineIndex: i, num: m[1], text: m[2] });
        }
        i += 1;
      }
      blocks.push({ type: "ol", startLine, items });
      continue;
    }

    // Consume the current line unconditionally so malformed block prefixes always advance.
    const startLine = i;
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim().length > 0 && !isBlockStart(lines, i)) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", startLine, text: paraLines.join(" ") });
  }

  return blocks;
}
