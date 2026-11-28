import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  CheckSquare,
  Code2,
  Copy,
  FileDown,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
  Minus,
  Pilcrow,
  Plus,
  Sigma,
  Sparkles,
  Strikethrough,
  Table2,
  Trash2,
  Underline as UnderlineIcon,
} from "lucide-react";
import { saveVaultAsset } from "@/lib/tauri-client";
import type { VaultNoteSummaryDto } from "../types";
import {
  BlockMathNode,
  CalloutNode,
  InlineMathNode,
  VaultImageExtension,
  WikilinkNode,
} from "../editor/extensions";
import {
  editorJsonToMarkdown,
  markdownToEditorHtml,
  type EditorJsonNode,
} from "../utils/vaultMarkdownCodec";
import { VAULT_TEMPLATES, formatTodayShort } from "../utils/vaultTemplates";

interface NotionNoteEditorProps {
  noteId: string | null;
  content: string;
  notes: VaultNoteSummaryDto[];
  onChangeMarkdown: (markdown: string) => void;
  onOpenWikilink: (target: string) => void;
  onExportPdf: () => void;
}

interface SlashItem {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  icon: React.ReactNode;
  run: (editor: Editor, helpers: { openImagePicker: () => void; openLinkMenu: () => void }) => void;
}

interface TriggerPopupState {
  kind: "slash" | "mention";
  query: string;
  from: number;
  to: number;
  left: number;
  top: number;
}

interface SelectionBubbleState {
  left: number;
  top: number;
}

interface ContextMenuState {
  x: number;
  y: number;
}

const SLASH_ITEMS: SlashItem[] = [
  {
    id: "paragraph",
    label: "Văn bản thường",
    hint: "Đoạn chữ cơ bản",
    keywords: "van ban text p paragraph",
    icon: <Pilcrow className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().setParagraph().run(),
  },
  {
    id: "h1",
    label: "Tiêu đề lớn (H1)",
    hint: "# Tiêu đề",
    keywords: "h1 heading tieu de lon",
    icon: <Heading1 className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Tiêu đề mục (H2)",
    hint: "## Mục chính",
    keywords: "h2 heading tieu de muc",
    icon: <Heading2 className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Tiêu đề nhỏ (H3)",
    hint: "### Mục nhỏ",
    keywords: "h3 heading tieu de nho",
    icon: <Heading3 className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    id: "task",
    label: "Danh sách việc cần làm",
    hint: "- [ ] Checklist",
    keywords: "todo task checklist viec can lam",
    icon: <CheckSquare className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleTaskList().run(),
  },
  {
    id: "bullet",
    label: "Danh sách gạch đầu dòng",
    hint: "- Mục",
    keywords: "bullet list danh sach",
    icon: <List className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleBulletList().run(),
  },
  {
    id: "ordered",
    label: "Danh sách đánh số",
    hint: "1. Thứ tự",
    keywords: "ordered number list so",
    icon: <ListOrdered className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "callout",
    label: "Hộp Callout nổi bật",
    hint: "> [!note]",
    keywords: "callout note tip warning hop ghi chu",
    icon: <Sparkles className="h-3.5 w-3.5 text-[#6B9BFF]" />,
    run: (ed) =>
      ed
        .chain()
        .focus()
        .insertContent({
          type: "callout",
          attrs: { kind: "note", title: "Lưu ý" },
          content: [{ type: "paragraph" }],
        })
        .run(),
  },
  {
    id: "quote",
    label: "Trích dẫn",
    hint: "> Quote",
    keywords: "quote blockquote trich dan",
    icon: <MessageSquareQuote className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "code",
    label: "Khối mã nguồn",
    hint: "``` Code block",
    keywords: "code block lap trinh cpp python",
    icon: <Code2 className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "table",
    label: "Bảng 3×3",
    hint: "Thêm bảng dữ liệu",
    keywords: "table bang cot dong",
    icon: <Table2 className="h-3.5 w-3.5" />,
    run: (ed) =>
      ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "blockMath",
    label: "Công thức toán (Khối $$)",
    hint: "Hiển thị LaTeX căn giữa",
    keywords: "math latex formula cong thuc toan",
    icon: <Sigma className="h-3.5 w-3.5 text-[#6B9BFF]" />,
    run: (ed) =>
      ed
        .chain()
        .focus()
        .insertContent({ type: "blockMath", attrs: { latex: "" } })
        .run(),
  },
  {
    id: "inlineMath",
    label: "Công thức nội tuyến ($)",
    hint: "Chèn công thức ngay trong dòng",
    keywords: "inline math latex cong thuc nho",
    icon: <Sigma className="h-3.5 w-3.5" />,
    run: (ed) =>
      ed
        .chain()
        .focus()
        .insertContent({ type: "inlineMath", attrs: { latex: "" } })
        .run(),
  },
  {
    id: "image",
    label: "Hình ảnh từ máy",
    hint: "Hoặc dán Ctrl+V / kéo thả ảnh",
    keywords: "image picture hinh anh photo",
    icon: <ImagePlus className="h-3.5 w-3.5 text-emerald-400" />,
    run: (_ed, helpers) => helpers.openImagePicker(),
  },
  {
    id: "wikilink",
    label: "Liên kết tới ghi chú khác",
    hint: "[[Tên ghi chú]] hoặc gõ @",
    keywords: "link wikilink mention @ [[",
    icon: <Link2 className="h-3.5 w-3.5 text-[#6B9BFF]" />,
    run: (_ed, helpers) => helpers.openLinkMenu(),
  },
  {
    id: "hr",
    label: "Đường kẻ phân cách",
    hint: "---",
    keywords: "hr divider line duong ke",
    icon: <Minus className="h-3.5 w-3.5" />,
    run: (ed) => ed.chain().focus().setHorizontalRule().run(),
  },
  ...VAULT_TEMPLATES.filter((t) => t.id !== "blank").map((tpl) => ({
    id: `tpl-${tpl.id}`,
    label: `Mẫu: ${tpl.shortLabel}`,
    hint: tpl.description,
    keywords: `mau template uit ${tpl.id} ${tpl.shortLabel.toLowerCase()} ${tpl.name.toLowerCase()}`,
    icon: <Sparkles className="h-3.5 w-3.5 text-[#6B9BFF]" />,
    run: (ed: Editor) => {
      const html = markdownToEditorHtml(tpl.buildContent(formatTodayShort()));
      ed.chain().focus().insertContent(html).run();
    },
  })),
];

export const NotionNoteEditor: React.FC<NotionNoteEditorProps> = ({
  noteId,
  content,
  notes,
  onChangeMarkdown,
  onOpenWikilink,
  onExportPdf,
}) => {
  const noteIdRef = useRef<string | null>(noteId);
  noteIdRef.current = noteId;

  const onChangeMarkdownRef = useRef(onChangeMarkdown);
  onChangeMarkdownRef.current = onChangeMarkdown;

  const onOpenWikilinkRef = useRef(onOpenWikilink);
  onOpenWikilinkRef.current = onOpenWikilink;

  const lastEmittedMdRef = useRef<string>(content);
  const lastLoadedNoteIdRef = useRef<string | null | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const [triggerPopup, setTriggerPopup] = useState<TriggerPopupState | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [selectionBubble, setSelectionBubble] = useState<SelectionBubbleState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const uploadAndInsertImage = useCallback(async (ed: Editor, file: File) => {
    try {
      setUploadNotice("Đang lưu hình ảnh vào Vault...");
      const buf = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const relPath = await saveVaultAsset(file.name || "pasted-image.png", bytes);
      ed.chain()
        .focus()
        .insertContent({
          type: "image",
          attrs: {
            src: "",
            vaultSrc: relPath,
            alt: file.name ? file.name.replace(/\.[^.]+$/, "") : "",
          },
        })
        .run();
      setUploadNotice(null);
    } catch (err) {
      setUploadNotice(typeof err === "string" ? err : "Không thể chèn hình ảnh.");
      window.setTimeout(() => setUploadNotice(null), 3200);
    }
  }, []);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
      }),
      Underline,
      Highlight.configure({ multicolor: false }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({
        placeholder:
          "Viết ghi chú tự nhiên... Gõ / để mở lệnh khối, @ hoặc [[ để nối ghi chú, hoặc dán ảnh trực tiếp",
      }),
      WikilinkNode.configure({
        onOpenWikilink: (target: string) => onOpenWikilinkRef.current(target),
      }),
      InlineMathNode,
      BlockMathNode,
      CalloutNode,
      VaultImageExtension.configure({
        getNoteId: () => noteIdRef.current,
      }),
    ],
    []
  );

  const editorRef = useRef<Editor | null>(null);

  const filteredSlashItems = useMemo(() => {
    if (!triggerPopup || triggerPopup.kind !== "slash") return [];
    const q = triggerPopup.query.trim().toLowerCase();
    if (!q) return SLASH_ITEMS;
    return SLASH_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q)
    );
  }, [triggerPopup]);

  const filteredMentionNotes = useMemo(() => {
    if (!triggerPopup || triggerPopup.kind !== "mention") return [];
    const q = triggerPopup.query.trim().toLowerCase();
    const list = q
      ? notes.filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            n.folder.toLowerCase().includes(q)
        )
      : notes;
    return list.slice(0, 8);
  }, [notes, triggerPopup]);

  const triggerRef = useRef<TriggerPopupState | null>(null);
  triggerRef.current = triggerPopup;
  const activeIndexRef = useRef<number>(0);
  activeIndexRef.current = activeIndex;
  const slashItemsRef = useRef<SlashItem[]>([]);
  slashItemsRef.current = filteredSlashItems;
  const mentionNotesRef = useRef<VaultNoteSummaryDto[]>([]);
  mentionNotesRef.current = filteredMentionNotes;

  const openImagePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const openLinkMenu = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.chain().focus().insertContent("[[").run();
  }, []);

  const applySlashItem = useCallback(
    (item: SlashItem) => {
      const ed = editorRef.current;
      const trig = triggerRef.current;
      if (!ed || !trig) return;
      ed.chain().focus().deleteRange({ from: trig.from, to: trig.to }).run();
      setTriggerPopup(null);
      item.run(ed, { openImagePicker, openLinkMenu });
    },
    [openImagePicker, openLinkMenu]
  );

  const applyMentionChoice = useCallback((target: string, label: string) => {
    const ed = editorRef.current;
    const trig = triggerRef.current;
    if (!ed || !trig) return;
    ed.chain()
      .focus()
      .deleteRange({ from: trig.from, to: trig.to })
      .insertContent([
        { type: "wikilink", attrs: { target, label } },
        { type: "text", text: " " },
      ])
      .run();
    setTriggerPopup(null);
  }, []);

  const updateFloatingMenus = useCallback((ed: Editor) => {
    const { selection } = ed.state;
    const wrapEl = wrapperRef.current;
    if (!wrapEl) return;
    const wrapRect = wrapEl.getBoundingClientRect();

    if (!selection.empty && ed.isFocused) {
      try {
        const startCoords = ed.view.coordsAtPos(selection.from);
        const endCoords = ed.view.coordsAtPos(selection.to);
        const midX = (startCoords.left + endCoords.right) / 2 - wrapRect.left;
        const clampedLeft = Math.max(150, Math.min(wrapRect.width - 150, midX));
        const top = Math.max(8, startCoords.top - wrapRect.top - 44);
        setSelectionBubble({ left: clampedLeft, top });
      } catch {
        setSelectionBubble(null);
      }
    } else {
      setSelectionBubble(null);
    }

    if (!selection.empty || !ed.isFocused) {
      setTriggerPopup(null);
      return;
    }

    const $from = selection.$from;
    if ($from.parent.type.name === "codeBlock") {
      setTriggerPopup(null);
      return;
    }

    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    const slashMatch = /(?:^|\s)\/([^\s]*)$/.exec(textBefore);
    const mentionBracketMatch = /\[\[([^\]\n]*)$/.exec(textBefore);
    const mentionAtMatch = /(?:^|\s)@([^\s@]*)$/.exec(textBefore);

    let nextTrigger: Omit<TriggerPopupState, "left" | "top"> | null = null;
    if (slashMatch) {
      const tokenLen = slashMatch[1].length + 1;
      nextTrigger = {
        kind: "slash",
        query: slashMatch[1],
        from: selection.from - tokenLen,
        to: selection.from,
      };
    } else if (mentionBracketMatch) {
      const tokenLen = mentionBracketMatch[1].length + 2;
      nextTrigger = {
        kind: "mention",
        query: mentionBracketMatch[1],
        from: selection.from - tokenLen,
        to: selection.from,
      };
    } else if (mentionAtMatch) {
      const tokenLen = mentionAtMatch[1].length + 1;
      nextTrigger = {
        kind: "mention",
        query: mentionAtMatch[1],
        from: selection.from - tokenLen,
        to: selection.from,
      };
    }

    if (!nextTrigger) {
      setTriggerPopup(null);
      return;
    }

    try {
      const coords = ed.view.coordsAtPos(selection.from);
      const left = Math.max(12, Math.min(wrapRect.width - 280, coords.left - wrapRect.left));
      const top = Math.min(wrapRect.height - 40, coords.bottom - wrapRect.top + 6);
      setTriggerPopup({ ...nextTrigger, left, top });
      setActiveIndex(0);
    } catch {
      setTriggerPopup(null);
    }
  }, []);

  const editor = useEditor({
    extensions,
    content: markdownToEditorHtml(content),
    editorProps: {
      attributes: {
        class: "diark-prosemirror min-h-[420px] px-8 py-6 focus:outline-none",
      },
      handleKeyDown: (_view, event) => {
        const trig = triggerRef.current;
        if (!trig) return false;

        const optionCount =
          trig.kind === "slash"
            ? slashItemsRef.current.length
            : mentionNotesRef.current.length + (trig.query.trim() ? 1 : 0);

        if (event.key === "Escape") {
          event.preventDefault();
          setTriggerPopup(null);
          return true;
        }
        if (optionCount === 0) return false;

        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((prev) => (prev + 1) % optionCount);
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((prev) => (prev - 1 + optionCount) % optionCount);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const idx = Math.min(activeIndexRef.current, optionCount - 1);
          if (trig.kind === "slash") {
            const chosen = slashItemsRef.current[idx];
            if (chosen) applySlashItem(chosen);
          } else {
            const notesList = mentionNotesRef.current;
            if (idx < notesList.length) {
              const chosenNote = notesList[idx];
              applyMentionChoice(chosenNote.title, chosenNote.title);
            } else if (trig.query.trim()) {
              const q = trig.query.trim();
              applyMentionChoice(q, q);
            }
          }
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const ed = editorRef.current;
        const items = event.clipboardData?.items;
        if (!ed || !items) return false;
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              void uploadAndInsertImage(ed, file);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const ed = editorRef.current;
        const files = event.dataTransfer?.files;
        if (!ed || !files || files.length === 0) return false;
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          if (file.type.startsWith("image/")) {
            event.preventDefault();
            void uploadAndInsertImage(ed, file);
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = editorJsonToMarkdown(ed.getJSON() as EditorJsonNode);
      lastEmittedMdRef.current = md;
      onChangeMarkdownRef.current(md);
      updateFloatingMenus(ed);
    },
    onSelectionUpdate: ({ editor: ed }) => {
      updateFloatingMenus(ed);
    },
  });

  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    const noteSwitched = lastLoadedNoteIdRef.current !== noteId;
    const externalChanged = content !== lastEmittedMdRef.current;
    if (noteSwitched || externalChanged) {
      lastLoadedNoteIdRef.current = noteId;
      lastEmittedMdRef.current = content;
      editor.commands.setContent(markdownToEditorHtml(content), false);
      setTriggerPopup(null);
      setSelectionBubble(null);
      setContextMenu(null);
    }
  }, [content, editor, noteId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const wrapEl = wrapperRef.current;
    if (!wrapEl) return;
    const rect = wrapEl.getBoundingClientRect();
    const menuW = 240;
    const menuH = 380;
    const x = Math.max(8, Math.min(rect.width - menuW, e.clientX - rect.left));
    const y = Math.max(8, Math.min(rect.height - menuH, e.clientY - rect.top));
    setContextMenu({ x, y });
  };

  const handleSetLinkFromBubble = () => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Nhập đường dẫn URL:", previous || "https://");
    if (url === null) return;
    const clean = url.trim();
    if (!clean) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: clean }).run();
  };

  const handleWrapInlineMath = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, " ").trim();
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({ type: "inlineMath", attrs: { latex: selectedText } })
      .run();
  };

  const handleCopyMarkdown = async () => {
    if (!editor) return;
    const md = editorJsonToMarkdown(editor.getJSON() as EditorJsonNode);
    try {
      await navigator.clipboard.writeText(md);
      setUploadNotice("Đã chép toàn bộ nội dung Markdown.");
      window.setTimeout(() => setUploadNotice(null), 2000);
    } catch {
      // ignore clipboard restrictions
    }
    setContextMenu(null);
  };

  return (
    <div
      ref={wrapperRef}
      onContextMenu={handleContextMenu}
      className="relative flex-1 min-h-0 overflow-y-auto bg-[#0B101B]"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && editor) {
            void uploadAndInsertImage(editor, file);
          }
          e.target.value = "";
        }}
      />

      {uploadNotice && (
        <div className="sticky top-2 z-30 mx-auto w-fit rounded-lg border border-[#2F6BFF]/50 bg-[#0F1420]/95 px-3 py-1 text-xs text-[#6B9BFF] shadow-lg">
          {uploadNotice}
        </div>
      )}

      <div className="mx-auto max-w-3xl">
        <EditorContent editor={editor} />
      </div>

      {/* Floating selection toolbar */}
      {editor && selectionBubble && (
        <div
          style={{ left: selectionBubble.left, top: selectionBubble.top }}
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-30 -translate-x-1/2 flex items-center gap-0.5 rounded-lg border border-[#2B3957] bg-[#0F1420] p-1 shadow-xl"
        >
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="In đậm (Ctrl+B)"
            className={`rounded p-1.5 cursor-pointer ${
              editor.isActive("bold") ? "bg-[#2F6BFF]/25 text-[#6B9BFF]" : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <Bold className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="In nghiêng (Ctrl+I)"
            className={`rounded p-1.5 cursor-pointer ${
              editor.isActive("italic") ? "bg-[#2F6BFF]/25 text-[#6B9BFF]" : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <Italic className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            title="Gạch chân (Ctrl+U)"
            className={`rounded p-1.5 cursor-pointer ${
              editor.isActive("underline") ? "bg-[#2F6BFF]/25 text-[#6B9BFF]" : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <UnderlineIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Gạch ngang"
            className={`rounded p-1.5 cursor-pointer ${
              editor.isActive("strike") ? "bg-[#2F6BFF]/25 text-[#6B9BFF]" : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <Strikethrough className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleHighlight().run()}
            title="Tô sáng"
            className={`rounded p-1.5 cursor-pointer ${
              editor.isActive("highlight") ? "bg-amber-500/25 text-amber-300" : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <Highlighter className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="Mã nội tuyến"
            className={`rounded p-1.5 cursor-pointer ${
              editor.isActive("code") ? "bg-[#2F6BFF]/25 text-[#6B9BFF]" : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
          </button>
          <div className="mx-0.5 h-4 w-px bg-[#1D263B]" />
          <button
            type="button"
            onClick={handleSetLinkFromBubble}
            title="Gắn liên kết web"
            className={`rounded p-1.5 cursor-pointer ${
              editor.isActive("link") ? "bg-[#2F6BFF]/25 text-[#6B9BFF]" : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleWrapInlineMath}
            title="Chuyển thành công thức LaTeX"
            className="rounded p-1.5 text-zinc-300 hover:bg-[#151C2C] cursor-pointer"
          >
            <Sigma className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            title="Tiêu đề H1"
            className={`rounded px-1.5 py-1 text-[11px] font-semibold cursor-pointer ${
              editor.isActive("heading", { level: 1 })
                ? "bg-[#2F6BFF]/25 text-[#6B9BFF]"
                : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            H1
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            title="Tiêu đề H2"
            className={`rounded px-1.5 py-1 text-[11px] font-semibold cursor-pointer ${
              editor.isActive("heading", { level: 2 })
                ? "bg-[#2F6BFF]/25 text-[#6B9BFF]"
                : "text-zinc-300 hover:bg-[#151C2C]"
            }`}
          >
            H2
          </button>
        </div>
      )}

      {/* Slash / Mention Autocomplete Menu */}
      {triggerPopup && (
        <div
          style={{ left: triggerPopup.left, top: triggerPopup.top }}
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-40 w-72 max-h-72 overflow-y-auto rounded-xl border border-[#2B3957] bg-[#0F1420] p-1.5 shadow-2xl"
        >
          {triggerPopup.kind === "slash" ? (
            filteredSlashItems.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-500">Không có lệnh khối phù hợp.</div>
            ) : (
              filteredSlashItems.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => applySlashItem(item)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    idx === activeIndex
                      ? "bg-[#2F6BFF]/20 text-zinc-100"
                      : "text-zinc-300 hover:bg-[#151C2C]"
                  }`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#1D263B] bg-[#080B12] text-zinc-300">
                    {item.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{item.label}</div>
                    <div className="truncate text-[10px] text-zinc-500">{item.hint}</div>
                  </div>
                </button>
              ))
            )
          ) : (
            <>
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Liên kết ghi chú
              </div>
              {filteredMentionNotes.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => applyMentionChoice(item.title, item.title)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    idx === activeIndex
                      ? "bg-[#2F6BFF]/20 text-zinc-100"
                      : "text-zinc-300 hover:bg-[#151C2C]"
                  }`}
                >
                  <span className="truncate text-xs font-medium">{item.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                    {item.folder}
                  </span>
                </button>
              ))}
              {triggerPopup.query.trim() && (
                <button
                  type="button"
                  onClick={() =>
                    applyMentionChoice(triggerPopup.query.trim(), triggerPopup.query.trim())
                  }
                  className={`mt-1 flex w-full items-center gap-2 rounded-lg border-t border-[#1D263B] px-2.5 py-1.5 text-left text-xs text-[#6B9BFF] cursor-pointer ${
                    activeIndex === filteredMentionNotes.length
                      ? "bg-[#2F6BFF]/20"
                      : "hover:bg-[#151C2C]"
                  }`}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="truncate">
                    Tạo liên kết mới [[{triggerPopup.query.trim()}]]
                  </span>
                </button>
              )}
              {filteredMentionNotes.length === 0 && !triggerPopup.query.trim() && (
                <div className="px-3 py-2 text-xs text-zinc-500">Chưa có ghi chú nào khác.</div>
              )}
            </>
          )}
        </div>
      )}

      {/* Right-click context menu */}
      {editor && contextMenu && (
        <div
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          className="absolute z-50 w-60 rounded-xl border border-[#2B3957] bg-[#0F1420] p-1.5 text-xs text-zinc-200 shadow-2xl"
        >
          <div className="px-2 py-1 text-[10px] font-medium text-zinc-500">Định dạng nhanh</div>
          <div className="grid grid-cols-5 gap-1 px-1 pb-1.5">
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleBold().run();
                setContextMenu(null);
              }}
              className="flex items-center justify-center rounded border border-[#1D263B] bg-[#080B12] py-1 hover:bg-[#151C2C] cursor-pointer"
              title="Đậm"
            >
              <Bold className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleItalic().run();
                setContextMenu(null);
              }}
              className="flex items-center justify-center rounded border border-[#1D263B] bg-[#080B12] py-1 hover:bg-[#151C2C] cursor-pointer"
              title="Nghiêng"
            >
              <Italic className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleUnderline().run();
                setContextMenu(null);
              }}
              className="flex items-center justify-center rounded border border-[#1D263B] bg-[#080B12] py-1 hover:bg-[#151C2C] cursor-pointer"
              title="Gạch chân"
            >
              <UnderlineIcon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleHighlight().run();
                setContextMenu(null);
              }}
              className="flex items-center justify-center rounded border border-[#1D263B] bg-[#080B12] py-1 hover:bg-[#151C2C] cursor-pointer"
              title="Tô sáng"
            >
              <Highlighter className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleCode().run();
                setContextMenu(null);
              }}
              className="flex items-center justify-center rounded border border-[#1D263B] bg-[#080B12] py-1 hover:bg-[#151C2C] cursor-pointer"
              title="Code"
            >
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="my-1 border-t border-[#1D263B]" />
          <div className="px-2 py-1 text-[10px] font-medium text-zinc-500">Chuyển khối</div>
          <div className="grid grid-cols-2 gap-1 px-1 pb-1">
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().setParagraph().run();
                setContextMenu(null);
              }}
              className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
            >
              Văn bản
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleHeading({ level: 1 }).run();
                setContextMenu(null);
              }}
              className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
            >
              Tiêu đề H1
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleHeading({ level: 2 }).run();
                setContextMenu(null);
              }}
              className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
            >
              Tiêu đề H2
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleTaskList().run();
                setContextMenu(null);
              }}
              className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
            >
              Checklist
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleBlockquote().run();
                setContextMenu(null);
              }}
              className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
            >
              Trích dẫn
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().toggleCodeBlock().run();
                setContextMenu(null);
              }}
              className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
            >
              Khối Code
            </button>
          </div>

          <div className="my-1 border-t border-[#1D263B]" />
          <div className="px-2 py-1 text-[10px] font-medium text-zinc-500">Chèn khối</div>
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              openImagePicker();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#151C2C] cursor-pointer"
          >
            <ImagePlus className="h-3.5 w-3.5 text-emerald-400" />
            <span>Chèn hình ảnh từ máy</span>
          </button>
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#151C2C] cursor-pointer"
          >
            <Table2 className="h-3.5 w-3.5 text-zinc-400" />
            <span>Chèn bảng 3×3</span>
          </button>
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().insertContent({ type: "blockMath", attrs: { latex: "" } }).run();
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#151C2C] cursor-pointer"
          >
            <Sigma className="h-3.5 w-3.5 text-[#6B9BFF]" />
            <span>Chèn công thức toán (LaTeX)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              editor
                .chain()
                .focus()
                .insertContent({
                  type: "callout",
                  attrs: { kind: "note", title: "Lưu ý" },
                  content: [{ type: "paragraph" }],
                })
                .run();
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#151C2C] cursor-pointer"
          >
            <Sparkles className="h-3.5 w-3.5 text-[#6B9BFF]" />
            <span>Chèn hộp Callout</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              openLinkMenu();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#151C2C] cursor-pointer"
          >
            <Link2 className="h-3.5 w-3.5 text-[#6B9BFF]" />
            <span>Liên kết ghi chú ([[...]])</span>
          </button>

          {editor.isActive("table") && (
            <>
              <div className="my-1 border-t border-[#1D263B]" />
              <div className="px-2 py-1 text-[10px] font-medium text-zinc-500">Thao tác bảng</div>
              <div className="grid grid-cols-2 gap-1 px-1 pb-1">
                <button
                  type="button"
                  onClick={() => {
                    editor.chain().focus().addRowAfter().run();
                    setContextMenu(null);
                  }}
                  className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
                >
                  + Thêm dòng
                </button>
                <button
                  type="button"
                  onClick={() => {
                    editor.chain().focus().addColumnAfter().run();
                    setContextMenu(null);
                  }}
                  className="rounded px-2 py-1 text-left hover:bg-[#151C2C] cursor-pointer"
                >
                  + Thêm cột
                </button>
                <button
                  type="button"
                  onClick={() => {
                    editor.chain().focus().deleteRow().run();
                    setContextMenu(null);
                  }}
                  className="rounded px-2 py-1 text-left text-rose-300 hover:bg-[#151C2C] cursor-pointer"
                >
                  Xóa dòng
                </button>
                <button
                  type="button"
                  onClick={() => {
                    editor.chain().focus().deleteColumn().run();
                    setContextMenu(null);
                  }}
                  className="rounded px-2 py-1 text-left text-rose-300 hover:bg-[#151C2C] cursor-pointer"
                >
                  Xóa cột
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  editor.chain().focus().deleteTable().run();
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-rose-300 hover:bg-[#151C2C] cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Xóa toàn bộ bảng</span>
              </button>
            </>
          )}

          <div className="my-1 border-t border-[#1D263B]" />
          <button
            type="button"
            onClick={() => void handleCopyMarkdown()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#151C2C] cursor-pointer"
          >
            <Copy className="h-3.5 w-3.5 text-zinc-400" />
            <span>Sao chép dạng Markdown</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              onExportPdf();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#151C2C] cursor-pointer"
          >
            <FileDown className="h-3.5 w-3.5 text-zinc-400" />
            <span>In / Xuất PDF</span>
          </button>
        </div>
      )}
    </div>
  );
};
