import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
  Code2,
  GitBranch,
  Maximize2,
  Printer,
  Hash,
  X,
  LayoutTemplate,
  Keyboard,
} from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useVaultShortcutsStore } from "@/stores/useVaultShortcutsStore";
import { matchesShortcut } from "../utils/vaultShortcuts";
import {
  VAULT_TEMPLATES,
  formatTodayShort,
  type VaultTemplateSpec,
} from "../utils/vaultTemplates";
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
  getVaultGraph,
  VaultSyncEvent,
} from "@/lib/tauri-client";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type {
  VaultBacklinkDto,
  VaultGraphDto,
  VaultGraphNodeDto,
  VaultNoteSummaryDto,
  VaultSearchResultDto,
} from "../types";
import { NotionNoteEditor } from "./NotionNoteEditor";
import { VaultGraphView } from "./VaultGraphView";
import { QuickCaptureModal } from "./QuickCaptureModal";
import { renderHighlightedSnippet } from "@/lib/snippet";

type EditorViewMode = "wysiwyg" | "source";

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
  const [backlinks, setBacklinks] = useState<VaultBacklinkDto[]>([]);
  const [isLoadingNote, setIsLoadingNote] = useState<boolean>(false);

  // Save & layout state
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<EditorViewMode>("wysiwyg");
  const [showGraphInspector, setShowGraphInspector] = useState<boolean>(true);
  const [isGlobalGraphOpen, setIsGlobalGraphOpen] = useState<boolean>(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState<boolean>(false);
  const [vaultGraph, setVaultGraph] = useState<VaultGraphDto>({ nodes: [], edges: [] });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const shortcuts = useVaultShortcutsStore((s) => s.shortcuts);
  const isSettingsOpen = useSettingsStore((s) => s.isOpen);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<VaultSearchResultDto[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Secondary vault tools
  const [showVaultTools, setShowVaultTools] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isQuickCaptureOpen, setIsQuickCaptureOpen] = useState<boolean>(false);
  const [toolMessage, setToolMessage] = useState<string | null>(null);

  const autosaveTimerRef = useRef<number | null>(null);
  const activeNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeNoteIdRef.current = activeNoteId;
  }, [activeNoteId]);

  const refreshGraph = useCallback(async () => {
    try {
      const g = await getVaultGraph();
      setVaultGraph(g);
    } catch {
      // keep existing graph snapshot
    }
  }, []);

  const refreshNotesList = useCallback(
    async (selectIdIfEmpty = true) => {
      try {
        const list = await listVaultNotes();
        setNotes(list);
        void refreshGraph();
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
    },
    [refreshGraph]
  );

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

  const handleCreateNewNote = useCallback(() => {
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
    setViewMode("wysiwyg");
  }, [selectedFolder]);

  const handleCreateFromTemplate = useCallback(
    (tpl: VaultTemplateSpec) => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      const today = formatTodayShort();
      setActiveNoteId(null);
      setTitle(tpl.buildTitle(today));
      setFolder(
        selectedFolder !== "all" ? selectedFolder : tpl.defaultFolder || "notes"
      );
      setTagsInput(tpl.defaultTags.join(", "));
      setNoteType(tpl.noteType);
      setExternalUri("");
      setContent(tpl.buildContent(today));
      setBacklinks([]);
      setSaveState("dirty");
      setEditorError(null);
      setViewMode("wysiwyg");
      setIsTemplateModalOpen(false);
    },
    [selectedFolder]
  );

  // Customizable Vault keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isSettingsOpen) return;
      if (e.key === "Escape") {
        if (isTemplateModalOpen) {
          e.preventDefault();
          setIsTemplateModalOpen(false);
          return;
        }
        if (isGlobalGraphOpen) {
          e.preventDefault();
          setIsGlobalGraphOpen(false);
          return;
        }
      }

      if (matchesShortcut(e, shortcuts.saveNote)) {
        e.preventDefault();
        void handleSaveNote();
      } else if (matchesShortcut(e, shortcuts.newNote)) {
        e.preventDefault();
        handleCreateNewNote();
      } else if (matchesShortcut(e, shortcuts.openTemplates)) {
        e.preventDefault();
        setIsTemplateModalOpen((prev) => !prev);
      } else if (matchesShortcut(e, shortcuts.toggleSource)) {
        e.preventDefault();
        setViewMode((prev) => (prev === "wysiwyg" ? "source" : "wysiwyg"));
      } else if (matchesShortcut(e, shortcuts.toggleGraph)) {
        e.preventDefault();
        setShowGraphInspector((prev) => !prev);
      } else if (matchesShortcut(e, shortcuts.openGlobalGraph)) {
        e.preventDefault();
        setIsGlobalGraphOpen((prev) => !prev);
      } else if (matchesShortcut(e, shortcuts.focusSearch)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (matchesShortcut(e, shortcuts.exportPdf)) {
        e.preventDefault();
        window.print();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    handleCreateNewNote,
    handleSaveNote,
    isGlobalGraphOpen,
    isSettingsOpen,
    isTemplateModalOpen,
    shortcuts,
  ]);

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
    setActiveNoteId(null);
    setTitle(target);
    setFolder("notes");
    setTagsInput("");
    setNoteType("GENERAL");
    setExternalUri("");
    setContent(`# ${target}\n\n`);
    setBacklinks([]);
    setSaveState("dirty");
    setViewMode("wysiwyg");
  };

  const handleGraphSelectNode = (node: VaultGraphNodeDto) => {
    if (node.isUnresolved) {
      void handleOpenWikilink(node.title);
      return;
    }
    void openNoteById(node.id);
  };

  const handleExportPdf = () => {
    window.print();
  };

  const handleSelectVaultDir = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Chọn thư mục lưu ghi chú",
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
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setIsTemplateModalOpen(true)}
                  title={`Tạo từ mẫu UIT (${shortcuts.openTemplates})`}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2 py-1.5 text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                >
                  <LayoutTemplate className="h-3.5 w-3.5 text-[#6B9BFF]" />
                  <span>Mẫu</span>
                </button>
                <button
                  type="button"
                  onClick={handleCreateNewNote}
                  title={`Ghi chú mới (${shortcuts.newNote})`}
                  className="inline-flex items-center gap-1 rounded-lg bg-[#2F6BFF] hover:bg-[#2558DB] px-2.5 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Mới</span>
                </button>
              </div>
            </div>

            {/* Instant Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Tìm kiếm ghi chú"
                placeholder={`Tìm nhanh (${shortcuts.focusSearch})...`}
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

          {/* Bottom Secondary Tools */}
          <div className="border-t border-[#1D263B] p-2.5">
            <button
              type="button"
              onClick={() => setShowVaultTools((prev) => !prev)}
              className="flex w-full items-center justify-between text-[11px] font-medium text-zinc-400 hover:text-zinc-200 cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                <FolderOpen className="h-3.5 w-3.5 text-zinc-500" />
                <span>Thư mục &amp; Phím tắt</span>
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
                  <button
                    type="button"
                    onClick={() => openSettings("system")}
                    className="inline-flex items-center gap-1 rounded border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2 py-1 text-zinc-200 cursor-pointer"
                  >
                    <Keyboard className="h-3 w-3 text-[#6B9BFF]" />
                    <span>Chỉnh phím tắt</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* RIGHT PANE: Unified Editor + Graph Inspector */}
        <section className="lg:col-span-8 xl:col-span-9 flex flex-col rounded-xl border border-[#1D263B] bg-[#0F1420] overflow-hidden vault-print-target">
          {isLoadingNote ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin text-[#6B9BFF]" aria-hidden="true" />
              <span>Đang mở ghi chú...</span>
            </div>
          ) : (
            <>
              {/* Title + Metadata Bar */}
              <div className="border-b border-[#1D263B] px-5 pt-4 pb-3 space-y-2.5 vault-no-print">
                <div className="flex flex-wrap items-center justify-between gap-2">
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

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <span
                      className={`text-[11px] font-medium px-2 py-0.5 rounded border ${
                        saveState === "saving"
                          ? "border-amber-700/50 bg-amber-950/30 text-amber-300"
                          : saveState === "dirty"
                          ? "border-[#1D263B] bg-[#151C2C] text-zinc-300"
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
                      title={`Lưu ghi chú (${shortcuts.saveNote})`}
                      className="inline-flex items-center gap-1 rounded-lg border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors cursor-pointer"
                    >
                      <Save className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                      <span>Lưu</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setViewMode((prev) => (prev === "wysiwyg" ? "source" : "wysiwyg"))
                      }
                      title={`Chuyển giữa soạn thảo trực quan và mã nguồn .md (${shortcuts.toggleSource})`}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                        viewMode === "source"
                          ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/20 text-[#6B9BFF]"
                          : "border-[#1D263B] bg-[#080B12] text-zinc-300 hover:bg-[#151C2C]"
                      }`}
                    >
                      <Code2 className="h-3.5 w-3.5" />
                      <span>{viewMode === "source" ? "Trực quan" : "Mã .md"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowGraphInspector((prev) => !prev)}
                      title={`Bật/tắt bảng mạng liên kết (${shortcuts.toggleGraph})`}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                        showGraphInspector
                          ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/20 text-[#6B9BFF]"
                          : "border-[#1D263B] bg-[#080B12] text-zinc-300 hover:bg-[#151C2C]"
                      }`}
                    >
                      <GitBranch className="h-3.5 w-3.5" />
                      <span>Đồ thị</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleExportPdf}
                      title={`In hoặc Xuất PDF (${shortcuts.exportPdf})`}
                      className="inline-flex items-center gap-1 rounded-lg border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2 py-1 text-xs text-zinc-300 transition-colors cursor-pointer"
                    >
                      <Printer className="h-3.5 w-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => openSettings("system")}
                      title="Chỉnh phím tắt ghi chú trong Cài đặt"
                      className="inline-flex items-center gap-1 rounded-lg border border-[#1D263B] bg-[#080B12] hover:bg-[#151C2C] px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                    >
                      <Keyboard className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Folder + Tags + Shortcut Hint row */}
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
                      className={`w-36 rounded border border-[#1D263B] bg-[#080B12] px-2 py-0.5 font-mono text-[11px] text-zinc-300 focus:border-[#2F6BFF] focus:outline-none ${
                        activeNoteId ? "opacity-75" : ""
                      }`}
                    />
                  </div>

                  <div className="flex flex-1 min-w-[180px] items-center gap-1.5">
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
                      className="w-full rounded border border-[#1D263B] bg-[#080B12] px-2 py-0.5 text-[11px] text-zinc-300 placeholder-zinc-600 focus:border-[#2F6BFF] focus:outline-none"
                    />
                  </div>

                  <span className="hidden xl:inline text-[11px] text-zinc-500">
                    Gõ <code className="rounded bg-[#080B12] px-1 text-zinc-300">/</code> chèn khối ·{" "}
                    <code className="rounded bg-[#080B12] px-1 text-zinc-300">@</code> hoặc{" "}
                    <code className="rounded bg-[#080B12] px-1 text-zinc-300">[[</code> nối ghi chú · Chuột phải để tùy chọn
                  </span>

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

                {editorError && (
                  <div className="rounded-lg border border-rose-800/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                    {editorError}
                  </div>
                )}
              </div>

              {/* Main Single-Pane Workspace + Optional Right Graph Inspector */}
              <div className="flex-1 min-h-0 flex flex-col xl:flex-row overflow-hidden">
                {viewMode === "wysiwyg" ? (
                  <NotionNoteEditor
                    noteId={activeNoteId}
                    content={content}
                    notes={notes}
                    onChangeMarkdown={(md) => {
                      setContent(md);
                      setSaveState("dirty");
                    }}
                    onOpenWikilink={(target) => void handleOpenWikilink(target)}
                    onExportPdf={handleExportPdf}
                  />
                ) : (
                  <textarea
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setSaveState("dirty");
                    }}
                    aria-label="Mã nguồn Markdown"
                    placeholder="Mã nguồn Markdown (.md)..."
                    className="flex-1 min-h-[420px] w-full resize-none bg-[#080B12] p-6 font-mono text-xs leading-relaxed text-zinc-200 placeholder-zinc-600 focus:outline-none"
                  />
                )}

                {showGraphInspector && (
                  <aside className="xl:w-72 shrink-0 border-t xl:border-t-0 xl:border-l border-[#1D263B] bg-[#080B12] p-3 flex flex-col gap-3 overflow-y-auto vault-no-print">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-semibold text-zinc-200">Mạng liên kết</h3>
                        <p className="text-[10px] text-zinc-500">
                          {vaultGraph.nodes.length} nút · {vaultGraph.edges.length} liên kết
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsGlobalGraphOpen(true)}
                        title={`Mở toàn bộ đồ thị (${shortcuts.openGlobalGraph})`}
                        className="inline-flex items-center gap-1 rounded border border-[#1D263B] bg-[#0F1420] hover:bg-[#151C2C] px-2 py-1 text-[11px] text-[#6B9BFF] cursor-pointer"
                      >
                        <Maximize2 className="h-3 w-3" />
                        <span>Toàn đồ thị</span>
                      </button>
                    </div>

                    <VaultGraphView
                      graph={vaultGraph}
                      activeNoteId={activeNoteId}
                      mode="local"
                      onSelectNode={handleGraphSelectNode}
                      className="h-56 w-full"
                    />

                    <div className="space-y-1.5 border-t border-[#1D263B] pt-2.5">
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-300">
                        <Link2 className="h-3.5 w-3.5 text-[#6B9BFF]" />
                        <span>Liên kết trỏ tới ({backlinks.length})</span>
                      </div>
                      {backlinks.length === 0 ? (
                        <p className="text-[11px] text-zinc-500">
                          Chưa có ghi chú nào nhắc tới [[{title || "..."}]].
                        </p>
                      ) : (
                        <div className="space-y-1">
                          {backlinks.map((bl) => (
                            <button
                              key={bl.id}
                              type="button"
                              onClick={() => void openNoteById(bl.id)}
                              className="w-full truncate rounded-md border border-[#1D263B] bg-[#0F1420] hover:border-[#2F6BFF]/45 hover:text-[#6B9BFF] px-2.5 py-1.5 text-left text-xs text-zinc-300 transition-colors cursor-pointer"
                            >
                              {bl.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {isGlobalGraphOpen && (
        <div
          onClick={() => setIsGlobalGraphOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-xs vault-no-print"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[#2B3957] bg-[#0F1420] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#1D263B] px-5 py-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  Đồ thị liên kết ghi chú
                </h3>
                <p className="text-[11px] text-zinc-400">
                  {vaultGraph.nodes.length} ghi chú · {vaultGraph.edges.length} liên kết · Nhấp vào nút để mở hoặc tạo ghi chú
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsGlobalGraphOpen(false)}
                className="rounded-lg border border-[#1D263B] bg-[#080B12] p-1.5 text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <VaultGraphView
              graph={vaultGraph}
              activeNoteId={activeNoteId}
              mode="global"
              onSelectNode={(node) => {
                handleGraphSelectNode(node);
                setIsGlobalGraphOpen(false);
              }}
              className="flex-1 rounded-none border-0"
            />
          </div>
        </div>
      )}

      {isTemplateModalOpen && (
        <div
          onClick={() => setIsTemplateModalOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs vault-no-print"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl overflow-hidden rounded-xl border border-[#2B3957] bg-[#0F1420] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[#1D263B] px-5 py-3.5">
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  Tạo ghi chú từ mẫu học tập UIT
                </h3>
                <p className="text-[11px] text-zinc-400">
                  Chọn cấu trúc sẵn để ghi nhanh bài giảng, code, việc nhóm, ôn thi hoặc báo cáo Lab.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsTemplateModalOpen(false)}
                className="rounded-lg border border-[#1D263B] bg-[#080B12] p-1.5 text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2.5 p-4 sm:grid-cols-2">
              {VAULT_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => handleCreateFromTemplate(tpl)}
                  className="flex flex-col items-start gap-1.5 rounded-xl border border-[#1D263B] bg-[#080B12] p-3.5 text-left transition-colors hover:border-[#2F6BFF]/60 hover:bg-[#151C2C] cursor-pointer"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-100">{tpl.name}</span>
                    <span className="rounded border border-[#1D263B] bg-[#0F1420] px-1.5 py-0.5 font-mono text-[10px] text-[#6B9BFF]">
                      {tpl.defaultFolder}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    {tpl.description}
                  </p>
                  {tpl.defaultTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {tpl.defaultTags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-[#0F1420] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
