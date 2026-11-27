export interface EditorJsonMark {
  type: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

export interface EditorJsonNode {
  type?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  content?: EditorJsonNode[];
  marks?: EditorJsonMark[];
  text?: string;
}

const HEADING_RE = /^(#{1,4})\s+(.+)$/;
const HR_RE = /^(-{3,}|\*{3,})$/;
const TABLE_SEP_RE = /^\s*\|?[\s:-]+\|/;
const CALLOUT_RE = /^>\s*\[!([a-zA-Z]+)\]\s*(.*)$/;
const UL_ITEM_RE = /^\s*[-*]\s+/;
const TASK_ITEM_RE = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
const OL_ITEM_RE = /^\s*(\d+)\.\s+(.*)$/;
const STANDALONE_IMG_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(raw: string): string {
  return escapeHtml(raw).replace(/\n/g, "&#10;");
}

function isSafeHttpOrDataUrl(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("data:image/");
}

function isSafeLinkUrl(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("onenote:");
}

function renderImageTag(alt: string, src: string): string {
  const safeDirect = isSafeHttpOrDataUrl(src) ? src : "";
  return `<img src="${escapeAttr(safeDirect)}" data-vault-src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`;
}

const INLINE_REGEX =
  /(\[\[[^\]|]+(?:\|[^\]]+)?\]\]|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`[^`]+`|<u>[^<]+<\/u>|\*\*[^*]+\*\*|~~[^~]+~~|==[^=]+==|\*[^*]+\*|\$(?:[^\s$](?:[^$\n]*?[^\s$])?)\$)/g;

export function renderInlineMarkdownToHtml(text: string): string {
  let out = "";
  let lastIndex = 0;
  const regex = new RegExp(INLINE_REGEX.source, "g");
  let match: RegExpExecArray | null = regex.exec(text);

  while (match !== null) {
    if (match[0].length === 0) break;
    if (match.index > lastIndex) {
      out += escapeHtml(text.slice(lastIndex, match.index));
    }

    const token = match[0];

    if (token.startsWith("[[") && token.endsWith("]]")) {
      const inner = token.slice(2, -2);
      const [rawTarget, alias] = inner.split("|");
      const target = rawTarget.trim();
      const label = (alias ?? rawTarget).trim();
      out += `<span data-wikilink="${escapeAttr(target)}" data-label="${escapeAttr(label)}">${escapeHtml(label)}</span>`;
    } else if (token.startsWith("![")) {
      const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
      if (m) {
        out += renderImageTag(m[1], m[2].trim());
      } else {
        out += escapeHtml(token);
      }
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const splitIdx = token.indexOf("](");
      const label = token.slice(1, splitIdx);
      const url = token.slice(splitIdx + 2, -1).trim();
      if (isSafeLinkUrl(url)) {
        out += `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`;
      } else {
        out += escapeHtml(label);
      }
    } else if (token.startsWith("`") && token.endsWith("`")) {
      out += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith("<u>") && token.endsWith("</u>")) {
      out += `<u>${escapeHtml(token.slice(3, -4))}</u>`;
    } else if (token.startsWith("**") && token.endsWith("**")) {
      out += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      out += `<s>${escapeHtml(token.slice(2, -2))}</s>`;
    } else if (token.startsWith("==") && token.endsWith("==")) {
      out += `<mark>${escapeHtml(token.slice(2, -2))}</mark>`;
    } else if (token.startsWith("*") && token.endsWith("*")) {
      out += `<em>${escapeHtml(token.slice(1, -1))}</em>`;
    } else if (token.startsWith("$") && token.endsWith("$")) {
      const latex = token.slice(1, -1).trim();
      out += `<span data-inline-math="${escapeAttr(latex)}"></span>`;
    } else {
      out += escapeHtml(token);
    }

    lastIndex = match.index + token.length;
    match = regex.exec(text);
  }

  if (lastIndex < text.length) {
    out += escapeHtml(text.slice(lastIndex));
  }

  return out;
}

function isTableStart(lines: string[], idx: number): boolean {
  if (idx + 1 >= lines.length) return false;
  return lines[idx].trim().startsWith("|") && TABLE_SEP_RE.test(lines[idx + 1]);
}

function isBlockStart(lines: string[], idx: number): boolean {
  const line = lines[idx];
  const trimmed = line.trim();
  return (
    trimmed.startsWith("```") ||
    trimmed.startsWith("$$") ||
    HR_RE.test(trimmed) ||
    HEADING_RE.test(trimmed) ||
    trimmed.startsWith(">") ||
    isTableStart(lines, idx) ||
    UL_ITEM_RE.test(line) ||
    OL_ITEM_RE.test(line) ||
    STANDALONE_IMG_RE.test(trimmed)
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

export function markdownToEditorHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const htmlParts: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("$$")) {
      if (trimmed.length > 4 && trimmed.endsWith("$$")) {
        const latex = trimmed.slice(2, -2).trim();
        htmlParts.push(`<div data-block-math="${escapeAttr(latex)}"></div>`);
        i += 1;
        continue;
      }
      const mathLines: string[] = [];
      const firstAfter = trimmed.slice(2).trim();
      if (firstAfter) mathLines.push(firstAfter);
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("$$")) {
        mathLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      htmlParts.push(`<div data-block-math="${escapeAttr(mathLines.join("\n").trim())}"></div>`);
      continue;
    }

    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const langAttr = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      htmlParts.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (HR_RE.test(trimmed)) {
      htmlParts.push("<hr />");
      i += 1;
      continue;
    }

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${renderInlineMarkdownToHtml(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
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
        const inner =
          quoteLines.length > 0
            ? quoteLines.map((ql) => `<p>${renderInlineMarkdownToHtml(ql)}</p>`).join("")
            : "<p></p>";
        htmlParts.push(
          `<div data-callout="${escapeAttr(kind)}" data-callout-title="${escapeAttr(customTitle)}">${inner}</div>`
        );
      } else {
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i += 1;
        }
        const inner =
          quoteLines.length > 0
            ? quoteLines.map((ql) => `<p>${renderInlineMarkdownToHtml(ql)}</p>`).join("")
            : "<p></p>";
        htmlParts.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = parseTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      const headHtml = headers
        .map((h) => `<th><p>${renderInlineMarkdownToHtml(h)}</p></th>`)
        .join("");
      const bodyHtml = rows
        .map(
          (row) =>
            `<tr>${headers
              .map((_, idx) => `<td><p>${renderInlineMarkdownToHtml(row[idx] ?? "")}</p></td>`)
              .join("")}</tr>`
        )
        .join("");
      htmlParts.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    if (UL_ITEM_RE.test(line)) {
      const firstIsTask = TASK_ITEM_RE.test(line);
      if (firstIsTask) {
        const taskItems: string[] = [];
        while (i < lines.length && TASK_ITEM_RE.test(lines[i])) {
          const m = TASK_ITEM_RE.exec(lines[i]);
          if (m) {
            const checked = m[1].toLowerCase() === "x";
            taskItems.push(
              `<li data-type="taskItem" data-checked="${checked ? "true" : "false"}"><p>${renderInlineMarkdownToHtml(m[2])}</p></li>`
            );
          }
          i += 1;
        }
        htmlParts.push(`<ul data-type="taskList">${taskItems.join("")}</ul>`);
      } else {
        const bulletItems: string[] = [];
        while (i < lines.length && UL_ITEM_RE.test(lines[i]) && !TASK_ITEM_RE.test(lines[i])) {
          const text = lines[i].replace(UL_ITEM_RE, "");
          bulletItems.push(`<li><p>${renderInlineMarkdownToHtml(text)}</p></li>`);
          i += 1;
        }
        htmlParts.push(`<ul>${bulletItems.join("")}</ul>`);
      }
      continue;
    }

    if (OL_ITEM_RE.test(line)) {
      const olItems: string[] = [];
      while (i < lines.length && OL_ITEM_RE.test(lines[i])) {
        const m = OL_ITEM_RE.exec(lines[i]);
        if (m) {
          olItems.push(`<li><p>${renderInlineMarkdownToHtml(m[2])}</p></li>`);
        }
        i += 1;
      }
      htmlParts.push(`<ol>${olItems.join("")}</ol>`);
      continue;
    }

    const standaloneImg = STANDALONE_IMG_RE.exec(trimmed);
    if (standaloneImg) {
      htmlParts.push(renderImageTag(standaloneImg[1], standaloneImg[2].trim()));
      i += 1;
      continue;
    }

    // Consume the current line unconditionally so malformed block prefixes always advance.
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim().length > 0 && !isBlockStart(lines, i)) {
      paraLines.push(lines[i]);
      i += 1;
    }
    htmlParts.push(`<p>${renderInlineMarkdownToHtml(paraLines.join(" "))}</p>`);
  }

  return htmlParts.join("") || "<p></p>";
}

function serializeMarks(text: string, marks?: EditorJsonMark[]): string {
  if (!marks || marks.length === 0) return text;
  let result = text;
  const hasCode = marks.some((m) => m.type === "code");
  if (hasCode) {
    result = `\`${result}\``;
  }
  for (const mark of marks) {
    if (mark.type === "code") continue;
    if (mark.type === "bold") result = `**${result}**`;
    else if (mark.type === "italic") result = `*${result}*`;
    else if (mark.type === "strike") result = `~~${result}~~`;
    else if (mark.type === "highlight") result = `==${result}==`;
    else if (mark.type === "underline") result = `<u>${result}</u>`;
    else if (mark.type === "link") {
      const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
      if (href) result = `[${result}](${href})`;
    }
  }
  return result;
}

function serializeInlineNodes(nodes?: EditorJsonNode[]): string {
  if (!nodes || nodes.length === 0) return "";
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return serializeMarks(node.text ?? "", node.marks);
      }
      if (node.type === "hardBreak") {
        return "\n";
      }
      if (node.type === "wikilink") {
        const target = typeof node.attrs?.target === "string" ? node.attrs.target.trim() : "";
        const label = typeof node.attrs?.label === "string" ? node.attrs.label.trim() : "";
        if (!target) return "";
        return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
      }
      if (node.type === "inlineMath") {
        const latex = typeof node.attrs?.latex === "string" ? node.attrs.latex.trim() : "";
        return latex ? `$${latex}$` : "";
      }
      if (node.type === "image") {
        const vaultSrc = typeof node.attrs?.vaultSrc === "string" ? node.attrs.vaultSrc : "";
        const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
        const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
        return `![${alt}](${vaultSrc || src})`;
      }
      return serializeInlineNodes(node.content);
    })
    .join("");
}

function serializeTable(node: EditorJsonNode): string {
  const rows = node.content ?? [];
  if (rows.length === 0) return "";

  const matrix: string[][] = [];
  let hasHeader = false;
  rows.forEach((row, rowIdx) => {
    const cells = (row.content ?? []).map((cell) => {
      if (rowIdx === 0 && cell.type === "tableHeader") {
        hasHeader = true;
      }
      const text = (cell.content ?? [])
        .map((inner) => serializeInlineNodes(inner.content))
        .join(" ")
        .replace(/\|/g, "\\|")
        .trim();
      return text;
    });
    if (cells.length > 0) matrix.push(cells);
  });

  if (matrix.length === 0) return "";
  const colCount = Math.max(...matrix.map((r) => r.length));
  const normalizeRow = (r: string[]) => {
    const padded = Array.from({ length: colCount }, (_, idx) => r[idx] ?? "");
    return `| ${padded.join(" | ")} |`;
  };

  const lines: string[] = [];
  if (hasHeader) {
    lines.push(normalizeRow(matrix[0]));
    lines.push(`| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`);
    for (let r = 1; r < matrix.length; r += 1) {
      lines.push(normalizeRow(matrix[r]));
    }
  } else {
    lines.push(`| ${Array.from({ length: colCount }, () => " ").join(" | ")} |`);
    lines.push(`| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`);
    for (const row of matrix) {
      lines.push(normalizeRow(row));
    }
  }
  return lines.join("\n");
}

function serializeListItem(item: EditorJsonNode, marker: string, indent: string): string {
  const children = item.content ?? [];
  const out: string[] = [];

  children.forEach((child, idx) => {
    if (child.type === "paragraph") {
      const text = serializeInlineNodes(child.content);
      out.push(idx === 0 ? `${indent}${marker}${text}` : `${indent}  ${text}`);
    } else if (
      child.type === "bulletList" ||
      child.type === "orderedList" ||
      child.type === "taskList"
    ) {
      out.push(serializeBlockNode(child, `${indent}  `));
    } else {
      const rendered = serializeBlockNode(child, `${indent}  `);
      if (rendered) out.push(rendered);
    }
  });

  if (out.length === 0) {
    return `${indent}${marker}`;
  }
  return out.join("\n");
}

function serializeBlockNode(node: EditorJsonNode, indent = ""): string {
  switch (node.type) {
    case "paragraph":
      return serializeInlineNodes(node.content);

    case "heading": {
      const rawLevel = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      const level = Math.min(4, Math.max(1, rawLevel));
      return `${"#".repeat(level)} ${serializeInlineNodes(node.content)}`;
    }

    case "bulletList":
      return (node.content ?? [])
        .map((item) => serializeListItem(item, "- ", indent))
        .join("\n");

    case "orderedList":
      return (node.content ?? [])
        .map((item, idx) => serializeListItem(item, `${idx + 1}. `, indent))
        .join("\n");

    case "taskList":
      return (node.content ?? [])
        .map((item) => {
          const checked = Boolean(item.attrs?.checked);
          return serializeListItem(item, checked ? "- [x] " : "- [ ] ", indent);
        })
        .join("\n");

    case "blockquote": {
      const inner = (node.content ?? [])
        .map((child) => serializeBlockNode(child))
        .filter((s) => s.length > 0)
        .join("\n\n");
      return inner
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    }

    case "callout": {
      const kind = typeof node.attrs?.kind === "string" && node.attrs.kind.trim() ? node.attrs.kind.trim() : "note";
      const title = typeof node.attrs?.title === "string" ? node.attrs.title.trim() : "";
      const header = title ? `> [!${kind}] ${title}` : `> [!${kind}]`;
      const inner = (node.content ?? [])
        .map((child) => serializeBlockNode(child))
        .join("\n")
        .trimEnd();
      if (!inner) return header;
      const bodyLines = inner
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"));
      return [header, ...bodyLines].join("\n");
    }

    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const codeText = (node.content ?? [])
        .map((n) => n.text ?? "")
        .join("");
      return `\`\`\`${lang}\n${codeText}\n\`\`\``;
    }

    case "blockMath": {
      const latex = typeof node.attrs?.latex === "string" ? node.attrs.latex.trim() : "";
      return `$$\n${latex}\n$$`;
    }

    case "image": {
      const vaultSrc = typeof node.attrs?.vaultSrc === "string" ? node.attrs.vaultSrc : "";
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      return `![${alt}](${vaultSrc || src})`;
    }

    case "horizontalRule":
      return "---";

    case "table":
      return serializeTable(node);

    default:
      return (node.content ?? [])
        .map((child) => serializeBlockNode(child, indent))
        .filter((s) => s.length > 0)
        .join("\n\n");
  }
}

export function editorJsonToMarkdown(doc: EditorJsonNode): string {
  const blocks = doc.content ?? [];
  const serialized = blocks
    .map((block) => serializeBlockNode(block))
    .filter((block, idx, arr) => block.length > 0 || (arr.length === 1 && idx === 0));

  const joined = serialized.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return joined.length > 0 ? `${joined}\n` : "";
}
