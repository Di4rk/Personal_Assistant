import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  FolderGit2,
  Folder,
  RefreshCw,
  Search,
  FileText,
  Link2,
  Hash,
  Loader2,
  Plus,
  ExternalLink,
  Zap,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  getVaultStats,
  scanVault,
  searchVault,
  openOnenoteLink,
  getVaultPath,
  setVaultPath as setVaultPathBackend,
  scaffoldSemesterVault,
  getMoodleCourses,
} from "@/lib/tauri-client";
import type { VaultStatsDto, VaultSearchResultDto, NoteType } from "../types";
import { QuickCaptureModal } from "./QuickCaptureModal";

export const VaultDashboard: React.FC = () => {
  const [stats, setStats] = useState<VaultStatsDto | null>(null);
  const [vaultPath, setVaultPath] = useState<string>("");
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [isQuickCaptureOpen, setIsQuickCaptureOpen] = useState<boolean>(false);
  const [coursesCount, setCoursesCount] = useState<number>(0);
  const [isScaffolding, setIsScaffolding] = useState<boolean>(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<VaultSearchResultDto[]>([]);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const data = await getVaultStats();
      setStats(data);
    } catch (err) {
      console.error("Failed to load vault stats:", err);
    }
  }, []);

  useEffect(() => {
    void loadStats();
    void (async () => {
      try {
        const [saved, moodleCourses] = await Promise.all([
          getVaultPath().catch(() => null),
          getMoodleCourses().catch(() => []),
        ]);
        if (saved) {
          setVaultPath(saved);
        }
        if (moodleCourses && moodleCourses.length > 0) {
          setCoursesCount(moodleCourses.length);
        }
      } catch (err) {
        console.error("Failed to load initial vault context:", err);
      }
    })();
  }, [loadStats]);

  const handleScaffoldVault = async () => {
    if (!vaultPath || !vaultPath.trim()) {
      setSyncError("Vui lòng chọn thư mục Vault trước khi khởi tạo cấu trúc!");
      return;
    }
    setIsScaffolding(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const res = await scaffoldSemesterVault(vaultPath, "HK2 2025-2026");
      setSyncMessage(
        `Khởi tạo HK2 thành công: Đã tạo ${res.createdFolders} thư mục, ${res.createdNotes} ghi chú môn học mới (Bỏ qua ${res.skippedNotes} ghi chú đã tồn tại để tránh ghi đè).`
      );
      await loadStats();
      await triggerScanVault(vaultPath);
    } catch (err) {
      setSyncError(typeof err === "string" ? err : "Lỗi khi khởi tạo cấu trúc Vault");
    } finally {
      setIsScaffolding(false);
    }
  };

  const renderNoteTypeBadge = (type?: NoteType | string) => {
    switch (type) {
      case "ALGO_TRICK":
        return (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-950/60 text-blue-300 border border-blue-800/40">
            ALGO
          </span>
        );
      case "TEACHING_SHEET":
        return (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40">
            TEACHING
          </span>
        );
      case "ONENOTE_LINK":
        return (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800/40">
            ONENOTE
          </span>
        );
      case "ACADEMIC_SUMMARY":
        return (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/40">
            ACADEMIC
          </span>
        );
      default:
        return (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800/60 text-zinc-400 border border-zinc-700/40">
            NOTE
          </span>
        );
    }
  };

  // Debounced search handler (200ms)
  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchQuery(val);

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    if (!val.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const results = await searchVault(val);
        setSearchResults(results);
      } catch (err) {
        console.error("Search failed:", err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 200);
  };

  const triggerScanVault = async (targetPath: string) => {
    if (!targetPath.trim()) {
      setSyncError("Vui lòng chọn thư mục Vault hợp lệ");
      return;
    }

    setIsSyncing(true);
    setSyncError(null);
    setSyncMessage(null);

    try {
      const result = await scanVault(targetPath.trim());
      setStats(result);
      setSyncMessage(
        `Đồng bộ hoàn tất: ${result.totalNotes} notes, ${result.totalLinks} links, ${result.totalTags} tags.`
      );
      // If active query, re-run search
      if (searchQuery.trim()) {
        const results = await searchVault(searchQuery.trim());
        setSearchResults(results);
      }
    } catch (err) {
      setSyncError(typeof err === "string" ? err : "Đồng bộ thất bại. Kiểm tra lại đường dẫn.");
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePickDirectory = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected && typeof selected === "string") {
        setVaultPath(selected);
        await setVaultPathBackend(selected);
        await triggerScanVault(selected);
      }
    } catch (err) {
      console.error("Error picking vault directory:", err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Sync Controls */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <FolderGit2 className="w-5 h-5 text-violet-400" />
              <h2 className="text-base font-semibold text-zinc-100">Native Vault Engine</h2>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-violet-950/60 text-violet-300 border border-violet-800/40">
                SQLite FTS5
              </span>
            </div>
            <p className="text-xs text-zinc-400">
              Quét tệp Markdown theo dõi thay đổi incremental, trích xuất wikilinks và tra cứu snippet tốc độ cao.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full md:w-auto">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePickDirectory}
                disabled={isSyncing}
                className="flex items-center justify-center gap-2 px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs font-medium rounded-lg transition-colors border border-zinc-700 shadow-sm whitespace-nowrap"
              >
                <Folder className="w-4 h-4 text-violet-400" />
                <span>Chọn thư mục Vault</span>
              </button>
              {vaultPath ? (
                <span
                  className="text-xs text-zinc-300 font-mono truncate max-w-[200px] sm:max-w-[260px] px-2.5 py-1 bg-zinc-950 border border-zinc-800 rounded-lg"
                  title={vaultPath}
                >
                  {vaultPath}
                </span>
              ) : (
                <span className="text-xs text-zinc-500 italic">Chưa chọn thư mục</span>
              )}
            </div>
            <button
              onClick={() => setIsQuickCaptureOpen(true)}
              className="flex items-center justify-center gap-1.5 px-3.5 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-lg transition-colors shadow-sm whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>+ Quick Note</span>
            </button>
            <button
              onClick={() => triggerScanVault(vaultPath)}
              disabled={isSyncing || !vaultPath.trim()}
              className="flex items-center justify-center gap-2 px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900/50 disabled:opacity-50 text-zinc-200 text-xs font-medium rounded-lg transition-colors border border-zinc-700 shadow-sm whitespace-nowrap cursor-pointer"
            >
              {isSyncing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Đang quét...</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Sync Vault</span>
                </>
              )}
            </button>
            {vaultPath && (
              <button
                type="button"
                onClick={handleScaffoldVault}
                disabled={isScaffolding || isSyncing}
                className="flex items-center justify-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm whitespace-nowrap border border-indigo-500/40 cursor-pointer"
                title="Tự động tạo cây thư mục môn học HK2 và ghi chú khởi tạo từ Moodle"
              >
                {isScaffolding ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang tạo cấu trúc...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-3.5 h-3.5 text-amber-300" />
                    <span>Khởi tạo cấu trúc HK2 ({coursesCount > 0 ? `${coursesCount} môn` : "8 môn"})</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Sync status messages */}
        {syncMessage && (
          <div className="mt-3 text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-900/60 px-3 py-2 rounded-lg">
            {syncMessage}
          </div>
        )}
        {syncError && (
          <div className="mt-3 text-xs text-red-400 bg-red-950/40 border border-red-900/60 px-3 py-2 rounded-lg">
            {syncError}
          </div>
        )}
      </div>

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 flex items-center gap-4">
          <div className="p-2.5 rounded-lg bg-violet-950/50 border border-violet-800/40 text-violet-400">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-zinc-400 font-medium">Total Notes</div>
            <div className="text-2xl font-bold font-mono text-zinc-100">
              {stats ? stats.totalNotes : "—"}
            </div>
          </div>
        </div>

        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 flex items-center gap-4">
          <div className="p-2.5 rounded-lg bg-emerald-950/50 border border-emerald-800/40 text-emerald-400">
            <Link2 className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-zinc-400 font-medium">Wikilinks</div>
            <div className="text-2xl font-bold font-mono text-zinc-100">
              {stats ? stats.totalLinks : "—"}
            </div>
          </div>
        </div>

        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 flex items-center gap-4">
          <div className="p-2.5 rounded-lg bg-amber-950/50 border border-amber-800/40 text-amber-400">
            <Hash className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs text-zinc-400 font-medium">Distinct Tags</div>
            <div className="text-2xl font-bold font-mono text-zinc-100">
              {stats ? stats.totalTags : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Search & Results HUD */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5 space-y-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <Search className="w-4 h-4 text-violet-400" />
            FTS5 Full-Text Search
          </h3>
          <div className="relative w-full sm:w-80">
            <input
              type="text"
              value={searchQuery}
              onChange={handleQueryChange}
              placeholder="Tìm kiếm nội dung note, keyword..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
            />
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-2.5" />
            {isSearching && (
              <Loader2 className="w-3.5 h-3.5 text-violet-400 animate-spin absolute right-3 top-2.5" />
            )}
          </div>
        </div>

        {/* Search Results List */}
        {searchQuery.trim() !== "" ? (
          <div className="space-y-2 pt-2 border-t border-zinc-800/80">
            {searchResults.length === 0 && !isSearching ? (
              <div className="py-8 text-center text-xs text-zinc-500">
                Không tìm thấy kết quả phù hợp cho &quot;{searchQuery}&quot;
              </div>
            ) : (
              <div className="space-y-2">
                {searchResults.map((item) => (
                  <div
                    key={item.id}
                    className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800 hover:border-zinc-700 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-xs font-semibold text-violet-300 font-mono">
                        {item.title}
                      </span>
                      <span className="text-[11px] text-zinc-500 font-mono truncate max-w-[200px]">
                        {item.id}
                      </span>
                    </div>
                    <div
                      className="text-xs text-zinc-400 font-sans line-clamp-2 [&>b]:text-amber-300 [&>b]:bg-amber-950/40 [&>b]:px-1 [&>b]:py-0.5 [&>b]:rounded"
                      dangerouslySetInnerHTML={{ __html: item.snippet || "Không có đoạn trích" }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Recent Notes feed when no search query */
          <div className="pt-2 border-t border-zinc-800/80">
            <h4 className="text-xs font-medium text-zinc-400 mb-2.5">Gần đây</h4>
            {stats?.recentNotes && stats.recentNotes.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {stats.recentNotes.map((note) => (
                  <div
                    key={note.id}
                    className="p-2.5 rounded-lg bg-zinc-950/50 border border-zinc-800/60 flex items-center justify-between hover:border-zinc-700 transition-colors gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-0.5">
                        {renderNoteTypeBadge(note.noteType)}
                        <div className="text-xs font-medium text-zinc-200 truncate">
                          {note.title}
                        </div>
                      </div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate">
                        {note.id}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {note.externalUri && note.externalUri.trim().length > 0 && (
                        <button
                          onClick={() => void openOnenoteLink(note.externalUri!)}
                          title={`Mở trong OneNote: ${note.externalUri}`}
                          className="p-1 rounded bg-purple-950/50 hover:bg-purple-900/60 text-purple-400 hover:text-purple-300 border border-purple-800/40 transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <span className="text-[10px] text-zinc-500 whitespace-nowrap font-mono">
                        {new Date(note.updatedAt * 1000).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-zinc-500">
                Chưa có note nào trong vault. Bấm &quot;Chọn thư mục Vault&quot; để bắt đầu.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Quick Capture Modal */}
      <QuickCaptureModal
        isOpen={isQuickCaptureOpen}
        onClose={() => setIsQuickCaptureOpen(false)}
        onSuccess={() => {
          setSyncMessage("Tạo note mới thành công!");
          void loadStats();
          if (vaultPath.trim()) {
            void triggerScanVault(vaultPath);
          }
        }}
        vaultPath={vaultPath}
      />
    </div>
  );
};

export default VaultDashboard;
