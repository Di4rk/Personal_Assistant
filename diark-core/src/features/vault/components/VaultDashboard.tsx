import React, { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FileText,
  FolderOpen,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Zap,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Columns2,
  Eye,
  Pencil,
  Hash,
} from "lucide-react";
import {
  ensureDefaultVaultPath,
  listVaultNotes,
  readVaultNote,
  saveVaultNote,
  deleteVaultNote,
  searchVault,
  scanVault,
  setVaultPath as setVaultPathBackend,
  scaffoldSemesterVault,
  openOnenoteLink,
  openExternalUrl,
  VaultSyncEvent,
} from "@/lib/tauri-client";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type {
  VaultBacklinkDto,
  VaultNoteSummaryDto,
  VaultSearchResultDto,
} from "../types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { QuickCaptureModal } from "./QuickCaptureModal";
import { renderHighlightedSnippet } from "@/lib/snippet";

type EditorMode = "edit" | "split" | "preview";

function formatRelativeTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${min}`;
}

function folderLabel(folder: string): string {
  if (folder === "notes" || folder === "root") return "Chung";
  if (folder === "algo") return "Thuật toán";
  if (folder === "academic") return "Môn học";
  if (folder === "onenote") return "OneNote";
  return folder;
}

function shortenFolderPath(folder: string): string {
  if (folder === "notes" || folder === "root" || folder === "algo" || folder === "academic" || folder === "onenote") {
    return folderLabel(folder);
  }
  const parts = folder.split(/[/\\]/).filter((p) => p.length > 0);
  if (parts.length <= 2) return parts.join(" / ") || folder;
  return parts.slice(-2).join(" / ");
}

export const VaultDashboard: React.FC = () => {
  const [vaultPath, setVaultPath] = useState<string>("");
  const [notes, setNotes] = useState<VaultNoteSummaryDto[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>("all");
  const [isLoadingList, setIsLoadingList] = useState<boolean>(true);

  // Active note editor state
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>("");
  const [folder, setFolder] = useState<string>("notes");
  const [tagsInput, setTagsInput] = useState<string>("");
  const [noteType, setNoteType] = useState<string>("GENERAL");
  const [externalUri, setExternalUri] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const deferredContent = useDeferredValue(content);
  const [backlinks, setBacklinks] = useState<VaultBacklinkDto[]>([]);
  const [isLoadingNote, setIsLoadingNote] = useState<boolean>(false);

  // Save state
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("split");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<VaultSearchResultDto[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Secondary vault tools
  const [showVaultTools, setShowVaultTools] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isQuickCaptureOpen, setIsQuickCaptureOpen] = useState<boolean>(false);
  const [toolMessage, setToolMessage] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const activeNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeNoteIdRef.current = activeNoteId;
  }, [activeNoteId]);

  const refreshNotesList = useCallback(async (selectIdIfEmpty = true) => {
    try {
      const list = await listVaultNotes();
      setNotes(list);
      if (selectIdIfEmpty && !activeNoteIdRef.current && list.length > 0) {
        const first = list[0];
        setIsLoadingNote(true);
        try {
          const detail = await readVaultNote(first.id);
          setActiveNoteId(detail.id);
          setTitle(detail.title);
          setFolder(detail.folder);
          setTagsInput(detail.tags.join(", "));
          setNoteType(detail.noteType);
          setExternalUri(detail.externalUri);
          setContent(detail.content);
          setBacklinks(detail.backlinks);
          setSaveState("saved");
        } finally {
          setIsLoadingNote(false);
        }
      }
    } catch (err) {
      setEditorError(typeof err === "string" ? err : "Không thể tải danh sách ghi chú.");
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      setIsLoadingList(true);
      try {
        const path = await ensureDefaultVaultPath();
        if (mounted) setVaultPath(path);
        await refreshNotesList(true);
      } catch (err) {
        if (mounted) {
          setEditorError(typeof err === "string" ? err : "Không thể khởi tạo thư mục ghi chú.");
        }
      } finally {
        if (mounted) setIsLoadingList(false);
      }
    };
    void init();
    return () => {
      mounted = false;
    };
  }, [refreshNotesList]);

  useTauriEvent<VaultSyncEvent>("vault-synced", () => {
    void refreshNotesList(false);
  });

  const openNoteById = useCallback(async (noteId: string) => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setEditorError(null);
    setConfirmDeleteId(null);
    setIsLoadingNote(true);
    try {
      const detail = await readVaultNote(noteId);
      setActiveNoteId(detail.id);
      setTitle(detail.title);
      setFolder(detail.folder);
      setTagsInput(detail.tags.join(", "));
      setNoteType(detail.noteType);
      setExternalUri(detail.externalUri);
      setContent(detail.content);
      setBacklinks(detail.backlinks);
      setSaveState("saved");
    } catch (err) {
      setEditorError(typeof err === "string" ? err : "Không thể mở ghi chú.");
    } finally {
      setIsLoadingNote(false);
    }
  }, []);

  const handleSaveNote = useCallback(
    async (overrideContent?: string) => {
      const bodyToSave = overrideContent ?? content;
      const cleanTitle = title.trim() || "Ghi chú chưa đặt tên";
      const parsedTags = tagsInput
        .split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter((t) => t.length > 0);

      setSaveState("saving");
      setEditorError(null);
      try {
        const saved = await saveVaultNote({
          id: activeNoteId ?? undefined,
          folder,
          title: cleanTitle,
          noteType,
          tags: parsedTags,
          content: bodyToSave,
          externalUri: externalUri || undefined,
        });
        setActiveNoteId(saved.id);
        setTitle(saved.title);
        setFolder(saved.folder);
        setBacklinks(saved.backlinks);
        setSaveState("saved");
        await refreshNotesList(false);
      } catch (err) {
        setSaveState("dirty");
        setEditorError(typeof err === "string" ? err : "Lỗi khi lưu ghi chú.");
      }
    },
    [activeNoteId, content, externalUri, folder, noteType, refreshNotesList, tagsInput, title]
  );

  // Debounced autosave for existing or edited notes
  useEffect(() => {
    if (saveState !== "dirty") return;
    if (!title.trim() && !content.trim() && !activeNoteId) return;

    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      void handleSaveNote();
    }, 800);

    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [activeNoteId, content, handleSaveNote, saveState, tagsInput, title]);

  // Ctrl+S shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveNote();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSaveNote]);

  // FTS5 Search debounce
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const results = await searchVault(trimmed);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 180);

    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const handleCreateNewNote = () => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setActiveNoteId(null);
    setTitle("");
    setFolder(selectedFolder !== "all" ? selectedFolder : "notes");
    setTagsInput("");
    setNoteType("GENERAL");
    setExternalUri("");
    setContent("# Ghi chú mới\n\n- [ ] Việc cần làm đầu tiên\n");
    setBacklinks([]);
    setSaveState("dirty");
    setEditorError(null);
    setEditorMode((prev) => (prev === "preview" ? "split" : prev));
  };

  const handleDeleteNote = async (noteId: string) => {
    try {
      await deleteVaultNote(noteId);
      setConfirmDeleteId(null);
      if (activeNoteId === noteId) {
        setActiveNoteId(null);
        setTitle("");
        setContent("");
        setTagsInput("");
        setBacklinks([]);
        setSaveState("saved");
      }
      await refreshNotesList(true);
    } catch (err) {
      setEditorError(typeof err === "string" ? err : "Không thể xóa ghi chú.");
    }
  };

  const handleToggleTaskLine = (lineIndex: number) => {
    const lines = content.split(/\r?\n/);
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    const line = lines[lineIndex];
    if (/^\s*[-*]\s+\[ \]/.test(line)) {
      lines[lineIndex] = line.replace(/^(\s*[-*]\s+)\[ \]/, "$1[x]");
    } else if (/^\s*[-*]\s+\[[xX]\]/.test(line)) {
      lines[lineIndex] = line.replace(/^(\s*[-*]\s+)\[[xX]\]/, "$1[ ]");
    } else {
      return;
    }
    const updated = lines.join("\n");
    setContent(updated);
    setSaveState("dirty");
  };

  const handleOpenWikilink = async (target: string) => {
    const targetLower = target.toLowerCase();
    const matched = notes.find(
      (n) =>
        n.title.toLowerCase() === targetLower ||
        n.id.toLowerCase() === targetLower ||
        n.id.toLowerCase() === `${targetLower}.md` ||
        n.id.toLowerCase().endsWith(`/${targetLower}.md`)
    );
    if (matched) {
      await openNoteById(matched.id);
      return;
    }
    // Create a new draft note with this wikilink title
    setActiveNoteId(null);
    setTitle(target);
    setFolder("notes");
    setTagsInput("");
    setNoteType("GENERAL");
    setExternalUri("");
    setContent(`# ${target}\n\n`);
    setBacklinks([]);
    setSaveState("dirty");
    setEditorMode((prev) => (prev === "preview" ? "split" : prev));
  };

  const insertSnippet = (before: string, after = "", placeholder = "") => {
    const el = textareaRef.current;
    if (!el) {
      setContent((prev) => `${prev}${prev.endsWith("\n") || prev === "" ? "" : "\n"}${before}${placeholder}${after}`);
      setSaveState("dirty");
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const nextText = `${content.slice(0, start)}${before}${selected}${after}${content.slice(end)}`;
    setContent(nextText);
    setSaveState("dirty");
    window.requestAnimationFrame(() => {
      el.focus();
      const cursorPos = start + before.length + selected.length;
      el.setSelectionRange(cursorPos, cursorPos);
    });
  };

  const handleSelectVaultDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Chọn thư mục lưu ghi chú (hỗ trợ Obsidian Vault)",
      });
      if (selected && typeof selected === "string") {
        setIsSyncing(true);
        await setVaultPathBackend(selected);
        await scanVault(selected);
        setVaultPath(selected);
        setToolMessage("Đã liên kết và đồng bộ thư mục ghi chú.");
        await refreshNotesList(true);
      }
    } catch (err) {
      setEditorError(typeof err === "string" ? err : "Không thể mở thư mục Vault.");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleRescan = async () => {
    if (!vaultPath.trim()) return;
    setIsSyncing(true);
    try {
      await scanVault(vaultPath);
      await refreshNotesList(false);
      setToolMessage("Đã quét lại các file Markdown.");
    } catch (err) {
      setEditorError(typeof err === "string" ? err : "Lỗi khi quét lại thư mục.");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleScaffoldFolders = async () => {
    if (!vaultPath.trim()) return;
    setIsSyncing(true);
    try {
      const res = await scaffoldSemesterVault(vaultPath);
      await scanVault(vaultPath);
      await refreshNotesList(false);
      setToolMessage(
        `Đã tạo ${res.createdFolders} thư mục môn học và ${res.createdNotes} ghi chú mẫu.`
      );
    } catch (err) {
      setEditorError(typeof err === "string" ? err : "Không thể tạo thư mục môn học.");
    } finally {
      setIsSyncing(false);
    }
  };

  const folderOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) {
      const key = n.folder || "notes";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (!counts.has("notes")) counts.set("notes", 0);

    return Array.from(counts.entries())
      .map(([key, count]) => ({
        folder: key,
        label: shortenFolderPath(key),
        count,
      }))
      .sort((a, b) => {
        if (a.folder === "notes") return -1;
        if (b.folder === "notes") return 1;
        return a.label.localeCompare(b.label, "vi");
      });
  }, [notes]);

  const visibleNotes = useMemo(() => {
    if (selectedFolder === "all") return notes;
    return notes.filter((n) => n.folder === selectedFolder);
  }, [notes, selectedFolder]);

  return (
    <div className="mx-auto max-w-7xl space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-[calc(100vh-120px)]">
        {/* LEFT PANE: Note Sidebar */}
        <aside className="lg:col-span-4 xl:col-span-3 flex flex-col rounded-xl border border-[#1D263B] bg-[#0F1420] overflow-hidden">
          <div className="p-3 border-b border-[#1D263B] space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">Ghi chú học tập</h2>
                <p className="text-[11px] text-zinc-500">{notes.length} ghi chú đã lưu</p>
              </div>
              <button
                type="button"
                onClick={handleCreateNewNote}
                className="inline-flex items-center gap-1 rounded-lg bg-[#2F6BFF] hover:bg-[#2558DB] px-2.5 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Ghi chú mới</span>
              </button>
            </div>

            {/* Instant Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Tìm kiếm ghi chú"
                placeholder="Tìm nhanh tiêu đề, nội dung, code..."
                className="w-full rounded-lg border border-[#1D263B] bg-[#080B12] pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:border-[#2F6BFF] focus:outline-none"
              />
            </div>

            {/* Compact Folder Filter Select */}
            {!searchQuery.trim() && (
              <select
                aria-label="Lọc theo thư mục"
                value={selectedFolder}
                onChange={(e) => setSelectedFolder(e.target.value)}
                className="w-full cursor-pointer rounded-lg border border-[#1D263B] bg-[#080B12] px-2.5 py-1.5 text-xs text-zinc-200 focus:border-[#2F6BFF] focus:outline-none"
              >
                <option value="all">Tất cả thư mục ({notes.length})</option>
                {folderOptions.map((opt) => (
                  <option key={opt.folder} value={opt.folder} title={opt.folder}>
                    {opt.label} ({opt.count})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Note / Search Results List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {searchQuery.trim() ? (
              isSearching ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin text-[#6B9BFF]" />
                  <span>Đang tìm...</span>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500">
                  Không thấy ghi chú nào khớp &ldquo;{searchQuery.trim()}&rdquo;.
                </div>
              ) : (
                searchResults.map((res) => (
                  <button
                    key={res.id}
                    type="button"
                    onClick={() => void openNoteById(res.id)}
                    className={`w-full text-left rounded-lg border p-2.5 transition-colors cursor-pointer ${
                      activeNoteId === res.id
                        ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.14]"
                        : "border-[#1D263B]/80 bg-[#080B12] hover:border-[#2F6BFF]/35 hover:bg-[#151C2C]"
                    }`}
                  >
                    <div className="text-xs font-semibold text-zinc-100 truncate">{res.title}</div>
                    <div className="mt-1 text-[11px] text-zinc-400 line-clamp-2">
                      {renderHighlightedSnippet(
                        res.snippet,
                        res.title,
                        "rounded bg-[#2F6BFF]/25 px-0.5 text-[#6B9BFF]"
                      )}
                    </div>
                  </button>
                ))
              )
            ) : isLoadingList ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin text-[#6B9BFF]" />
                <span>Đang tải ghi chú...</span>
              </div>
            ) : visibleNotes.length === 0 ? (
              <div className="py-8 px-3 text-center text-xs text-zinc-500 space-y-2">
                <FileText className="mx-auto h-6 w-6 text-zinc-600" />
                <p>Chưa có ghi chú nào. Bấm &ldquo;Ghi chú mới&rdquo; để bắt đầu viết ngay.</p>
              </div>
            ) : (
              visibleNotes.map((item) => {
                const isSelected = activeNoteId === item.id;
                const isConfirming = confirmDeleteId === item.id;
                return (
                  <div
                    key={item.id}
                    className={`group rounded-lg border p-2.5 transition-colors ${
                      isSelected
                        ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.14]"
                        : "border-[#1D263B]/70 bg-[#080B12] hover:border-[#2F6BFF]/35 hover:bg-[#151C2C]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => void openNoteById(item.id)}
                        className="min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <div className="text-xs font-semibold text-zinc-100 truncate">{item.title}</div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-500 font-mono">
                          <span className="min-w-0 truncate" title={item.folder}>
                            {shortenFolderPath(item.folder)}
                          </span>
                          <span className="shrink-0">{formatRelativeTime(item.updatedAt)}</span>
                        </div>
                      </button>

                      {isConfirming ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => void handleDeleteNote(item.id)}
                            className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-rose-500 cursor-pointer"
                          >
                            Xóa
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700 cursor-pointer"
                          >
                            Hủy
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(item.id)}
                          className="opacity-0 group-hover:opacity-100 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 transition-opacity cursor-pointer"
                          title="Xóa ghi chú"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    {item.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {item.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Bottom Secondary Tools (Vault directory & Obsidian) */}
          <div className="border-t border-[#1D263B] p-2.5">
            <button
              type="button"
              onClick={() => setShowVaultTools((prev) => !prev)}
              className="flex w-full items-center justify-between text-[11px] font-medium text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-zinc-500" />
                <span>Thư mục lưu &amp; Obsidian</span>
              </span>
              {showVaultTools ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            {showVaultTools && (
              <div className="mt-2.5 space-y-2 text-[11px]">
                <div className="truncate font-mono text-[10px] text-zinc-500" title={vaultPath}>
                  {vaultPath || "Chưa thiết lập thư mục"}
                </div>
                {toolMessage && <div className="text-[#6B9BFF]">{toolMessage}</div>}
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleSelectVaultDir()}
                    disabled={isSyncing}
                    className="rounded border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2 py-1 text-zinc-200 cursor-pointer"
                  >
                    Đổi thư mục
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRescan()}
                    disabled={isSyncing}
                    className="inline-flex items-center gap-1 rounded border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2 py-1 text-zinc-200 cursor-pointer"
                  >
                    <RefreshCw className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} />
                    <span>Quét lại</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleScaffoldFolders()}
                    disabled={isSyncing}
                    className="rounded border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2 py-1 text-zinc-200 cursor-pointer"
                  >
                    Tạo theo môn học
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsQuickCaptureOpen(true)}
                    className="inline-flex items-center gap-1 rounded border border-[#2F6BFF]/45 bg-[#2F6BFF]/[0.14] hover:bg-[#2F6BFF]/[0.24] px-2 py-1 text-[#6B9BFF] cursor-pointer"
                  >
                    <Zap className="h-3 w-3" />
                    <span>Lưu nhanh</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT PANE: Markdown Editor & Preview */}
        <section className="lg:col-span-8 xl:col-span-9 flex flex-col rounded-xl border border-line bg-surface overflow-hidden">
          {isLoadingNote ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin text-uit-accent" aria-hidden="true" />
              <span>Đang mở ghi chú...</span>
            </div>
          ) : (
            <>
              {/* Title + Metadata Bar */}
              <div className="border-b border-line px-5 pt-4 pb-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setSaveState("dirty");
                    }}
                    aria-label="Tiêu đề ghi chú"
                    placeholder="Tiêu đề ghi chú..."
                    className="min-w-0 flex-1 bg-transparent text-lg font-bold text-zinc-100 placeholder-zinc-600 focus:outline-none"
                  />

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-[11px] font-medium px-2 py-0.5 rounded border ${
                        saveState === "saving"
                          ? "border-amber-700/50 bg-amber-950/30 text-amber-300"
                          : saveState === "dirty"
                          ? "border-line bg-surface-hover text-zinc-300"
                          : "border-emerald-800/50 bg-emerald-950/30 text-emerald-400"
                      }`}
                    >
                      {saveState === "saving"
                        ? "Đang lưu..."
                        : saveState === "dirty"
                        ? "Chưa lưu"
                        : "Đã lưu"}
                    </span>

                    <button
                      type="button"
                      onClick={() => void handleSaveNote()}
                      className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-hover hover:border-uit/40 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                    >
                      <Save className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                      <span>Lưu</span>
                    </button>

                    {/* View mode switcher */}
                    <div className="flex rounded-lg border border-line bg-canvas p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setEditorMode("edit")}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors cursor-pointer ${
                          editorMode === "edit"
                            ? "bg-uit/20 text-white font-semibold"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        <span>Soạn thảo</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditorMode("split")}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors cursor-pointer ${
                          editorMode === "split"
                            ? "bg-uit/20 text-white font-semibold"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <Columns2 className="h-3 w-3" aria-hidden="true" />
                        <span>Chia đôi</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditorMode("preview")}
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors cursor-pointer ${
                          editorMode === "preview"
                            ? "bg-uit/20 text-white font-semibold"
                            : "text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        <Eye className="h-3 w-3" aria-hidden="true" />
                        <span>Đọc</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Folder + Tags row */}
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <div className="flex items-center gap-1.5">
                    <label htmlFor="vault-folder-input" className="text-[11px] text-zinc-500">
                      Thư mục:
                    </label>
                    <input
                      id="vault-folder-input"
                      type="text"
                      value={folder}
                      onChange={(e) => {
                        if (!activeNoteId) {
                          setFolder(e.target.value);
                          setSaveState("dirty");
                        }
                      }}
                      readOnly={Boolean(activeNoteId)}
                      className={`w-28 rounded border border-line bg-canvas px-2 py-0.5 font-mono text-[11px] text-zinc-300 focus:border-uit focus:outline-none ${
                        activeNoteId ? "opacity-75" : ""
                      }`}
                    />
                  </div>

                  <div className="flex flex-1 min-w-[200px] items-center gap-1.5">
                    <Hash className="h-3.5 w-3.5 text-zinc-500 shrink-0" aria-hidden="true" />
                    <input
                      type="text"
                      value={tagsInput}
                      onChange={(e) => {
                        setTagsInput(e.target.value);
                        setSaveState("dirty");
                      }}
                      aria-label="Thẻ ghi chú"
                      placeholder="Thẻ: it004, on-thi, thuat-toan..."
                      className="w-full rounded border border-line bg-canvas px-2 py-0.5 text-[11px] text-zinc-300 placeholder-zinc-600 focus:border-uit focus:outline-none"
                    />
                  </div>

                  {externalUri && (
                    <button
                      type="button"
                      onClick={() => {
                        if (externalUri.startsWith("onenote:")) {
                          void openOnenoteLink(externalUri);
                        } else {
                          void openExternalUrl(externalUri);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded border border-emerald-700/50 bg-emerald-950/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/40 cursor-pointer"
                    >
                      <ExternalLink className="h-3 w-3" />
                      <span>Mở liên kết gốc</span>
                    </button>
                  )}
                </div>

                {/* Formatting Toolbar */}
                {editorMode !== "preview" && (
                  <div className="flex flex-wrap items-center gap-1 pt-1">
                    <button
                      type="button"
                      onClick={() => insertSnippet("# ", "", "Tiêu đề")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-semibold text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      H1
                    </button>
                    <button
                      type="button"
                      onClick={() => insertSnippet("## ", "", "Mục nhỏ")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-semibold text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      H2
                    </button>
                    <button
                      type="button"
                      onClick={() => insertSnippet("**", "**", "in đậm")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-bold text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      Đậm
                    </button>
                    <button
                      type="button"
                      onClick={() => insertSnippet("*", "*", "in nghiêng")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] italic text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      Nghiêng
                    </button>
                    <button
                      type="button"
                      onClick={() => insertSnippet("\n- [ ] ", "", "Việc cần làm")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      Checklist
                    </button>
                    <button
                      type="button"
                      onClick={() => insertSnippet("\n```cpp\n", "\n```\n", "// code")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-mono text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      Code
                    </button>
                    <button
                      type="button"
                      onClick={() => insertSnippet("\n> [!note] Lưu ý\n> ", "", "Nội dung cần nhớ")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      Callout
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        insertSnippet(
                          "\n| Cột 1 | Cột 2 |\n| --- | --- |\n| ",
                          " | giá trị |\n",
                          "mục"
                        )
                      }
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-700 cursor-pointer"
                    >
                      Bảng
                    </button>
                    <button
                      type="button"
                      onClick={() => insertSnippet("[[", "]]", "Tên ghi chú")}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] text-emerald-300 hover:border-zinc-700 cursor-pointer"
                    >
                      [[Link]]
                    </button>
                  </div>
                )}

                {editorError && (
                  <div className="rounded-lg border border-rose-800/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                    {editorError}
                  </div>
                )}
              </div>

              {/* Editor + Preview Body */}
              <div
                className={`flex-1 min-h-0 grid ${
                  editorMode === "split" ? "grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-line" : "grid-cols-1"
                }`}
              >
                {editorMode !== "preview" && (
                  <textarea
                    ref={textareaRef}
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setSaveState("dirty");
                    }}
                    aria-label="Nội dung ghi chú Markdown"
                    placeholder="Viết ghi chú bằng Markdown... Hỗ trợ # tiêu đề, - [ ] checklist, > [!tip] callout, bảng, khối code và [[Liên kết ghi chú]]."
                    className="h-full min-h-[380px] w-full resize-none bg-canvas/60 p-5 font-mono text-xs leading-relaxed text-zinc-200 placeholder-zinc-600 focus:outline-none"
                  />
                )}

                {editorMode !== "edit" && (
                  <div className="h-full min-h-[380px] overflow-y-auto p-5 bg-zinc-900/20">
                    <MarkdownRenderer
                      content={deferredContent}
                      onToggleTaskLine={handleToggleTaskLine}
                      onOpenWikilink={(target) => void handleOpenWikilink(target)}
                      onOpenExternalUrl={(url) => void openExternalUrl(url)}
                    />
                  </div>
                )}
              </div>

              {/* Backlinks Footer */}
              <div className="border-t border-zinc-800 bg-zinc-950/50 px-5 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                    <Link2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Liên kết trỏ tới ({backlinks.length}):</span>
                  </span>
                  {backlinks.length === 0 ? (
                    <span className="text-[11px] text-zinc-600">
                      Chưa có ghi chú nào nhắc tới trang này qua [[{title || "..."}]].
                    </span>
                  ) : (
                    backlinks.map((bl) => (
                      <button
                        key={bl.id}
                        type="button"
                        onClick={() => void openNoteById(bl.id)}
                        className="rounded border border-zinc-700 bg-zinc-800 hover:border-emerald-500/50 hover:text-emerald-300 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors cursor-pointer"
                      >
                        {bl.title}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <QuickCaptureModal
        isOpen={isQuickCaptureOpen}
        onClose={() => setIsQuickCaptureOpen(false)}
        onSuccess={() => {
          setToolMessage("Đã thêm ghi chú mới.");
          void refreshNotesList(false);
        }}
        vaultPath={vaultPath}
      />
    </div>
  );
};

export default VaultDashboard;
