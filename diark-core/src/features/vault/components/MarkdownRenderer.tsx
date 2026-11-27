import React, { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Info, Lightbulb, AlertTriangle, CheckSquare, Square } from "lucide-react";
import { parseMarkdownBlocks } from "../utils/markdownBlocks";

interface MarkdownRendererProps {
  content: string;
  onToggleTaskLine?: (lineIndex: number) => void;
  onOpenWikilink?: (target: string) => void;
  onOpenExternalUrl?: (url: string) => void;
}

const CALLOUT_STYLES: Record<
  string,
  { border: string; bg: string; titleColor: string; label: string; icon: React.ReactNode }
> = {
  note: {
    border: "border-zinc-700",
    bg: "bg-zinc-900/70",
    titleColor: "text-zinc-200",
    label: "Ghi chú",
    icon: <Info className="h-3.5 w-3.5 text-zinc-300" />,
  },
  info: {
    border: "border-zinc-700",
    bg: "bg-zinc-900/70",
    titleColor: "text-zinc-200",
    label: "Thông tin",
    icon: <Info className="h-3.5 w-3.5 text-zinc-300" />,
  },
  tip: {
    border: "border-emerald-800/70",
    bg: "bg-emerald-950/25",
    titleColor: "text-emerald-300",
    label: "Mẹo hay",
    icon: <Lightbulb className="h-3.5 w-3.5 text-emerald-400" />,
  },
  warning: {
    border: "border-amber-800/70",
    bg: "bg-amber-950/25",
    titleColor: "text-amber-300",
    label: "Lưu ý",
    icon: <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />,
  },
  important: {
    border: "border-rose-800/70",
    bg: "bg-rose-950/25",
    titleColor: "text-rose-300",
    label: "Quan trọng",
    icon: <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />,
  },
};

function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const INLINE_TOKEN_REGEX =
  /(\[\[[^\]|]+(?:\|[^\]]+)?\]\]|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g;

const CodeBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-[11px] text-zinc-400">
        <span className="font-mono">{language || "code"}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? "Đã chép" : "Chép"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs font-mono leading-relaxed text-zinc-200">
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(({
  content,
  onToggleTaskLine,
  onOpenWikilink,
  onOpenExternalUrl,
}) => {
  const renderInline = (text: string, keyPrefix: string): React.ReactNode[] => {
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    const regex = new RegExp(INLINE_TOKEN_REGEX.source, "g");
    let match: RegExpExecArray | null = regex.exec(text);

    while (match !== null) {
      if (match[0].length === 0) break;
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }

      const token = match[0];
      const key = `${keyPrefix}-${match.index}`;

      if (token.startsWith("[[") && token.endsWith("]]")) {
        const inner = token.slice(2, -2);
        const [rawTarget, alias] = inner.split("|");
        const target = rawTarget.trim();
        const label = (alias ?? rawTarget).trim();
        parts.push(
          <button
            key={key}
            type="button"
            onClick={() => onOpenWikilink?.(target)}
            className="mx-0.5 inline-flex items-center rounded border border-emerald-700/50 bg-emerald-950/35 px-1.5 py-0.5 text-[12px] font-medium text-emerald-300 hover:bg-emerald-900/50 transition-colors cursor-pointer"
          >
            {label}
          </button>
        );
      } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
        const splitIdx = token.indexOf("](");
        const label = token.slice(1, splitIdx);
        const url = token.slice(splitIdx + 2, -1).trim();
        if (isSafeHttpUrl(url)) {
          parts.push(
            <a
              key={key}
              href={url}
              onClick={(e) => {
                if (onOpenExternalUrl) {
                  e.preventDefault();
                  onOpenExternalUrl(url);
                }
              }}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-emerald-400 underline decoration-emerald-700/60 underline-offset-2 hover:text-emerald-300"
            >
              <span>{label}</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          );
        } else {
          parts.push(label);
        }
      } else if (token.startsWith("`") && token.endsWith("`")) {
        parts.push(
          <code
            key={key}
            className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[12px] text-amber-300"
          >
            {token.slice(1, -1)}
          </code>
        );
      } else if (token.startsWith("**") && token.endsWith("**")) {
        parts.push(
          <strong key={key} className="font-semibold text-zinc-100">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith("~~") && token.endsWith("~~")) {
        parts.push(
          <del key={key} className="text-zinc-500">
            {token.slice(2, -2)}
          </del>
        );
      } else if (token.startsWith("*") && token.endsWith("*")) {
        parts.push(
          <em key={key} className="italic text-zinc-200">
            {token.slice(1, -1)}
          </em>
        );
      } else {
        parts.push(token);
      }

      lastIndex = match.index + token.length;
      match = regex.exec(text);
    }

    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    return parts;
  };

  const parsedBlocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  if (parsedBlocks.length === 0) {
    return (
      <p className="text-xs italic text-zinc-500">
        Ghi chú chưa có nội dung. Chuyển sang chế độ Soạn thảo hoặc Chia đôi để bắt đầu viết.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {parsedBlocks.map((block) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={`code-${block.startLine}`} language={block.language} code={block.code} />;

          case "hr":
            return <hr key={`hr-${block.startLine}`} className="my-4 border-zinc-800" />;

          case "heading": {
            const headingClass =
              block.level === 1
                ? "mt-5 mb-2 text-lg font-bold text-zinc-100 border-b border-zinc-800/80 pb-1.5"
                : block.level === 2
                ? "mt-4 mb-2 text-base font-semibold text-zinc-100"
                : block.level === 3
                ? "mt-3 mb-1.5 text-sm font-semibold text-zinc-200"
                : "mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-300";
            return (
              <div key={`h-${block.startLine}`} className={headingClass}>
                {renderInline(block.text, `h-${block.startLine}`)}
              </div>
            );
          }

          case "callout": {
            const style = CALLOUT_STYLES[block.kind] ?? CALLOUT_STYLES.note;
            return (
              <div
                key={`callout-${block.startLine}`}
                className={`my-3 rounded-lg border px-3.5 py-2.5 ${style.border} ${style.bg}`}
              >
                <div className={`flex items-center gap-1.5 text-xs font-semibold ${style.titleColor}`}>
                  {style.icon}
                  <span>{block.customTitle || style.label}</span>
                </div>
                {block.lines.length > 0 && (
                  <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-zinc-300">
                    {block.lines.map((ql, idx) => (
                      <p key={`ql-${idx}`}>{renderInline(ql, `callout-${block.startLine}-${idx}`)}</p>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          case "blockquote":
            return (
              <blockquote
                key={`quote-${block.startLine}`}
                className="my-2.5 border-l-2 border-zinc-700 pl-3 text-xs leading-relaxed text-zinc-300"
              >
                {block.lines.map((ql, idx) => (
                  <p key={`q-${idx}`}>{renderInline(ql, `quote-${block.startLine}-${idx}`)}</p>
                ))}
              </blockquote>
            );

          case "table":
            return (
              <div key={`tbl-${block.startLine}`} className="my-3 overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full text-left text-xs text-zinc-300">
                  <thead className="border-b border-zinc-800 bg-zinc-900 text-zinc-200">
                    <tr>
                      {block.headers.map((h, colIdx) => (
                        <th key={`th-${colIdx}`} className="px-3 py-2 font-semibold">
                          {renderInline(h, `tbl-${block.startLine}-th-${colIdx}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70 bg-zinc-950/60">
                    {block.rows.map((row, rowIdx) => (
                      <tr key={`tr-${rowIdx}`}>
                        {block.headers.map((_, colIdx) => (
                          <td key={`td-${colIdx}`} className="px-3 py-2">
                            {renderInline(row[colIdx] ?? "", `tbl-${block.startLine}-${rowIdx}-${colIdx}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case "ul":
            return (
              <ul key={`ul-${block.startLine}`} className="my-2 space-y-1.5">
                {block.items.map((item) =>
                  item.isTask ? (
                    <li key={`task-${item.lineIndex}`} className="flex items-start gap-2 text-xs leading-relaxed">
                      <button
                        type="button"
                        onClick={() => onToggleTaskLine?.(item.lineIndex)}
                        className="mt-0.5 text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer"
                        aria-label="Đánh dấu công việc"
                      >
                        {item.checked ? (
                          <CheckSquare className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <Square className="h-4 w-4 text-zinc-500" />
                        )}
                      </button>
                      <span className={item.checked ? "line-through text-zinc-500" : "text-zinc-200"}>
                        {renderInline(item.text, `task-${item.lineIndex}`)}
                      </span>
                    </li>
                  ) : (
                    <li
                      key={`li-${item.lineIndex}`}
                      className="flex items-start gap-2 pl-1 text-xs leading-relaxed text-zinc-300"
                    >
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-500" />
                      <span>{renderInline(item.text, `li-${item.lineIndex}`)}</span>
                    </li>
                  )
                )}
              </ul>
            );

          case "ol":
            return (
              <ol key={`ol-${block.startLine}`} className="my-2 space-y-1.5 pl-1">
                {block.items.map((item) => (
                  <li key={`oli-${item.lineIndex}`} className="flex items-start gap-2 text-xs leading-relaxed text-zinc-300">
                    <span className="font-mono text-[11px] text-zinc-500 mt-0.5">{item.num}.</span>
                    <span>{renderInline(item.text, `oli-${item.lineIndex}`)}</span>
                  </li>
                ))}
              </ol>
            );

          case "paragraph":
            return (
              <p key={`p-${block.startLine}`} className="my-2 text-xs leading-relaxed text-zinc-300">
                {renderInline(block.text, `p-${block.startLine}`)}
              </p>
            );
        }
      })}
    </div>
  );
});

MarkdownRenderer.displayName = "MarkdownRenderer";
