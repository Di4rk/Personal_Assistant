import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "@tiptap/extension-image";
import {
  Node,
  mergeAttributes,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import katex from "katex";
import { AlertTriangle, Info, Lightbulb, Loader2, Trash2 } from "lucide-react";
import { readVaultAssetDataUrl } from "@/lib/tauri-client";

const assetDataUrlCache = new Map<string, string>();

const WikilinkNodeView: React.FC<NodeViewProps> = ({ node, extension }) => {
  const target = typeof node.attrs.target === "string" ? node.attrs.target : "";
  const label = typeof node.attrs.label === "string" && node.attrs.label ? node.attrs.label : target;
  const opts = extension.options as { onOpenWikilink?: (target: string) => void };

  return (
    <NodeViewWrapper as="span" className="mx-0.5 inline-block align-baseline">
      <button
        type="button"
        contentEditable={false}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (target) opts.onOpenWikilink?.(target);
        }}
        className="inline-flex items-center rounded border border-[#2F6BFF]/45 bg-[#2F6BFF]/[0.14] px-1.5 py-0.5 text-[12px] font-medium text-[#6B9BFF] hover:bg-[#2F6BFF]/25 transition-colors cursor-pointer"
      >
        {label || "Liên kết"}
      </button>
    </NodeViewWrapper>
  );
};

export const WikilinkNode = Node.create<{ onOpenWikilink?: (target: string) => void }>({
  name: "wikilink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      onOpenWikilink: undefined,
    };
  },

  addAttributes() {
    return {
      target: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-wikilink") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-wikilink": typeof attrs.target === "string" ? attrs.target : "",
        }),
      },
      label: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-label") ?? el.textContent ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-label": typeof attrs.label === "string" ? attrs.label : "",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const label =
      typeof node.attrs.label === "string" && node.attrs.label
        ? node.attrs.label
        : typeof node.attrs.target === "string"
        ? node.attrs.target
        : "";
    return ["span", mergeAttributes(HTMLAttributes), label];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikilinkNodeView);
  },
});

const InlineMathNodeView: React.FC<NodeViewProps> = ({ node, updateAttributes, deleteNode }) => {
  const latex = typeof node.attrs.latex === "string" ? node.attrs.latex : "";
  const [editing, setEditing] = useState<boolean>(latex.trim().length === 0);
  const [draft, setDraft] = useState<string>(latex);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(latex);
  }, [latex]);

  useEffect(() => {
    if (editing) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editing]);

  const renderedHtml = useMemo(() => {
    return katex.renderToString(latex.trim() || "\\text{LaTeX}", {
      throwOnError: false,
      displayMode: false,
    });
  }, [latex]);

  const commit = () => {
    const clean = draft.trim();
    if (!clean) {
      deleteNode();
      return;
    }
    updateAttributes({ latex: clean });
    setEditing(false);
  };

  return (
    <NodeViewWrapper as="span" className="relative mx-0.5 inline-block align-middle">
      {editing ? (
        <span
          contentEditable={false}
          className="inline-flex items-center gap-1 rounded border border-[#2F6BFF]/60 bg-[#080B12] px-1.5 py-0.5"
        >
          <span className="font-mono text-[11px] text-[#6B9BFF]">$</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (!latex.trim()) deleteNode();
                else setEditing(false);
              }
            }}
            onBlur={commit}
            placeholder="x^2 + y^2"
            className="w-36 bg-transparent font-mono text-xs text-zinc-100 focus:outline-none"
          />
          <span className="font-mono text-[11px] text-[#6B9BFF]">$</span>
        </span>
      ) : (
        <span
          contentEditable={false}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setEditing(true);
          }}
          title="Nhấp để sửa công thức LaTeX"
          className="cursor-pointer rounded px-1 py-0.5 hover:bg-[#151C2C]"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
    </NodeViewWrapper>
  );
};

export const InlineMathNode = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-inline-math") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-inline-math": typeof attrs.latex === "string" ? attrs.latex : "",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-inline-math]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineMathNodeView);
  },
});

const BlockMathNodeView: React.FC<NodeViewProps> = ({ node, updateAttributes, deleteNode }) => {
  const latex = typeof node.attrs.latex === "string" ? node.attrs.latex : "";
  const [editing, setEditing] = useState<boolean>(latex.trim().length === 0);
  const [draft, setDraft] = useState<string>(latex);

  useEffect(() => {
    setDraft(latex);
  }, [latex]);

  const renderedHtml = useMemo(() => {
    return katex.renderToString(latex.trim() || "\\text{Công thức LaTeX}", {
      throwOnError: false,
      displayMode: true,
    });
  }, [latex]);

  const commit = () => {
    const clean = draft.trim();
    if (!clean) {
      deleteNode();
      return;
    }
    updateAttributes({ latex: clean });
    setEditing(false);
  };

  return (
    <NodeViewWrapper className="my-3">
      <div
        contentEditable={false}
        className="group relative rounded-lg border border-[#1D263B] bg-[#080B12] px-4 py-3"
      >
        {editing ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span className="font-mono text-[#6B9BFF]">Công thức toán (LaTeX)</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={deleteNode}
                  className="rounded border border-rose-800/50 bg-rose-950/30 px-2 py-0.5 text-rose-300 hover:bg-rose-900/40 cursor-pointer"
                >
                  Xóa
                </button>
                <button
                  type="button"
                  onClick={commit}
                  className="rounded bg-[#2F6BFF] px-2.5 py-0.5 font-medium text-white hover:bg-[#2558DB] cursor-pointer"
                >
                  Xong
                </button>
              </div>
            </div>
            <textarea
              autoFocus
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  if (!latex.trim()) deleteNode();
                  else setEditing(false);
                }
              }}
              placeholder="Ví dụ: \sum_{i=1}^n x_i^2"
              className="w-full rounded border border-[#1D263B] bg-[#0F1420] p-2 font-mono text-xs text-zinc-100 focus:border-[#2F6BFF] focus:outline-none"
            />
          </div>
        ) : (
          <div
            onClick={() => setEditing(true)}
            title="Nhấp để sửa công thức"
            className="cursor-pointer overflow-x-auto py-1 text-center text-zinc-100"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}
      </div>
    </NodeViewWrapper>
  );
};

export const BlockMathNode = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-block-math") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-block-math": typeof attrs.latex === "string" ? attrs.latex : "",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-block-math]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockMathNodeView);
  },
});

const CALLOUT_THEMES: Record<
  string,
  { border: string; bg: string; accent: string; icon: React.ReactNode; label: string }
> = {
  note: {
    border: "border-[#1D263B]",
    bg: "bg-[#151C2C]/70",
    accent: "text-[#6B9BFF]",
    label: "Ghi chú",
    icon: <Info className="h-3.5 w-3.5 text-[#6B9BFF]" />,
  },
  tip: {
    border: "border-emerald-800/60",
    bg: "bg-emerald-950/20",
    accent: "text-emerald-300",
    label: "Mẹo hay",
    icon: <Lightbulb className="h-3.5 w-3.5 text-emerald-400" />,
  },
  warning: {
    border: "border-amber-800/60",
    bg: "bg-amber-950/20",
    accent: "text-amber-300",
    label: "Lưu ý",
    icon: <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />,
  },
  important: {
    border: "border-rose-800/60",
    bg: "bg-rose-950/20",
    accent: "text-rose-300",
    label: "Quan trọng",
    icon: <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />,
  },
};

const CalloutNodeView: React.FC<NodeViewProps> = ({ node, updateAttributes }) => {
  const kind = typeof node.attrs.kind === "string" ? node.attrs.kind : "note";
  const title = typeof node.attrs.title === "string" ? node.attrs.title : "";
  const theme = CALLOUT_THEMES[kind] ?? CALLOUT_THEMES.note;

  return (
    <NodeViewWrapper className={`my-3 rounded-lg border px-3.5 py-2.5 ${theme.border} ${theme.bg}`}>
      <div
        contentEditable={false}
        className="mb-1.5 flex items-center justify-between gap-2"
      >
        <div className="flex flex-1 items-center gap-1.5">
          {theme.icon}
          <input
            type="text"
            value={title}
            onChange={(e) => updateAttributes({ title: e.target.value })}
            placeholder={theme.label}
            className={`w-full bg-transparent text-xs font-semibold placeholder-current/70 focus:outline-none ${theme.accent}`}
          />
        </div>
        <select
          value={kind}
          onChange={(e) => updateAttributes({ kind: e.target.value })}
          aria-label="Loại callout"
          className="rounded border border-[#1D263B] bg-[#080B12] px-1.5 py-0.5 text-[10px] text-zinc-300 focus:outline-none cursor-pointer"
        >
          <option value="note">Ghi chú</option>
          <option value="tip">Mẹo hay</option>
          <option value="warning">Lưu ý</option>
          <option value="important">Quan trọng</option>
        </select>
      </div>
      <NodeViewContent className="text-sm leading-relaxed text-zinc-200 [&>p]:my-1" />
    </NodeViewWrapper>
  );
};

export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-callout") ?? "note",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-callout": typeof attrs.kind === "string" ? attrs.kind : "note",
        }),
      },
      title: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-callout-title") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-callout-title": typeof attrs.title === "string" ? attrs.title : "",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },
});

const VaultImageNodeView: React.FC<NodeViewProps> = ({
  node,
  extension,
  deleteNode,
  selected,
}) => {
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const vaultSrc = typeof node.attrs.vaultSrc === "string" ? node.attrs.vaultSrc : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const opts = extension.options as { getNoteId?: () => string | null };
  const noteId = opts.getNoteId?.() ?? null;
  const rawSource = vaultSrc || src;

  const isDirectUrl =
    rawSource.startsWith("http://") ||
    rawSource.startsWith("https://") ||
    rawSource.startsWith("data:image/");

  const cacheKey = `${noteId ?? ""}::${rawSource}`;
  const [resolvedSrc, setResolvedSrc] = useState<string>(() =>
    isDirectUrl ? rawSource : assetDataUrlCache.get(cacheKey) ?? ""
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!isDirectUrl && !resolvedSrc);

  useEffect(() => {
    if (isDirectUrl) {
      setResolvedSrc(rawSource);
      setLoading(false);
      setErrorMsg(null);
      return;
    }
    if (!rawSource) {
      setLoading(false);
      setErrorMsg("Đường dẫn ảnh trống");
      return;
    }

    const cached = assetDataUrlCache.get(cacheKey);
    if (cached) {
      setResolvedSrc(cached);
      setLoading(false);
      setErrorMsg(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    readVaultAssetDataUrl(rawSource, noteId ?? undefined)
      .then((dataUrl) => {
        if (cancelled) return;
        assetDataUrlCache.set(cacheKey, dataUrl);
        setResolvedSrc(dataUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setErrorMsg(typeof err === "string" ? err : "Không tải được ảnh");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, isDirectUrl, noteId, rawSource]);

  return (
    <NodeViewWrapper className="my-3">
      <div
        contentEditable={false}
        className={`group relative inline-block max-w-full overflow-hidden rounded-lg border bg-[#080B12] ${
          selected ? "border-[#2F6BFF]" : "border-[#1D263B]"
        }`}
      >
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-xs text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin text-[#6B9BFF]" />
            <span>Đang tải ảnh {rawSource}...</span>
          </div>
        ) : errorMsg ? (
          <div className="px-4 py-3 text-xs text-rose-300">
            {errorMsg} ({rawSource})
          </div>
        ) : (
          <img
            src={resolvedSrc}
            alt={alt}
            className="max-h-[460px] max-w-full object-contain"
          />
        )}

        <button
          type="button"
          onClick={deleteNode}
          title="Xóa ảnh"
          className="absolute right-2 top-2 hidden rounded-md border border-[#1D263B] bg-[#080B12]/90 p-1 text-zinc-300 hover:border-rose-600/60 hover:text-rose-400 group-hover:inline-flex cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>

        {alt && !loading && !errorMsg && (
          <div className="border-t border-[#1D263B] bg-[#0F1420]/70 px-3 py-1 text-[11px] text-zinc-400">
            {alt}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
};

export const VaultImageExtension = Image.extend<{ getNoteId?: () => string | null }>({
  addOptions() {
    return {
      ...this.parent?.(),
      inline: false,
      allowBase64: true,
      HTMLAttributes: {},
      getNoteId: () => null,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      vaultSrc: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-vault-src") ?? el.getAttribute("src") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-vault-src":
            typeof attrs.vaultSrc === "string" && attrs.vaultSrc
              ? attrs.vaultSrc
              : typeof attrs.src === "string"
              ? attrs.src
              : "",
        }),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(VaultImageNodeView);
  },
});
