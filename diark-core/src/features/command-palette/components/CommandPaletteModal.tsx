import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Search,
  Zap,
  FileText,
  ExternalLink,
  Loader2,
  ArrowRight,
  Compass,
} from "lucide-react";
import {
  searchVault,
  openOnenoteLink,
  getVaultStats,
  openExternalUrl,
} from "@/lib/tauri-client";
import type { VaultSearchResultDto, VaultRecentNote } from "@/features/vault/types";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { useQuickCaptureStore } from "@/stores/useQuickCaptureStore";
import { PORTAL_QUICK_LINKS } from "@/constants/portalLinks";
import { renderHighlightedSnippet } from "@/lib/snippet";

interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  snippet?: string;
  type: "action" | "nav" | "portal" | "note";
  targetTab?: string;
  externalUri?: string;
}

interface CommandPaletteModalProps {
  onNavigateTab?: (tab: string) => void;
}

const NAV_COMMANDS: Array<{ id: string; title: string; subtitle: string; tab: string }> = [
  { id: "nav-home", title: "Trang chủ · Hôm nay", subtitle: "Lịch học, Google Calendar, Deadline", tab: "home" },
  { id: "nav-schedule", title: "Lịch tuần & Google Calendar", subtitle: "TKB UIT + ICS cá nhân + Xuất .ics", tab: "schedule" },
  { id: "nav-academic", title: "Sức khỏe học vụ", subtitle: "Bảng điểm, CTĐT, Học phí, Chứng chỉ", tab: "academic" },
  { id: "nav-courses", title: "Moodle / Courses UIT", subtitle: "Bài tập, tài liệu và điểm quá trình", tab: "uit-courses" },
  { id: "nav-wecode", title: "Wecode UIT", subtitle: "Theo dõi bài tập thực hành lập trình", tab: "uit-wecode" },
  { id: "nav-vault", title: "Ghi chú & Tài liệu", subtitle: "Ghi chú và tài liệu ngoại tuyến", tab: "vault" },
];

export const CommandPaletteModal: React.FC<CommandPaletteModalProps> = ({
  onNavigateTab,
}) => {
  const { isOpen, setIsOpen, inputRef, hideHud } = useCommandPalette();
  const [query, setQuery] = useState<string>("");
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<VaultSearchResultDto[]>([]);
  const [recentNotes, setRecentNotes] = useState<VaultRecentNote[]>([]);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      const stats = await getVaultStats();
      if (stats?.recentNotes) {
        setRecentNotes(stats.recentNotes.slice(0, 5));
      }
    } catch (err) {
      console.error("Failed to load recent notes for palette:", err);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setSearchResults([]);
      void loadRecent();
    }
  }, [isOpen, loadRecent]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    setSelectedIndex(0);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    const trimmed = val.trim();
    if (!trimmed || trimmed.startsWith(">")) {
      setSearchResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchVault(trimmed);
        setSearchResults(results);
      } catch (err) {
        console.error("Command palette search failed:", err);
        setSearchResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 150);
  };

  const items: PaletteItem[] = useMemo(() => {
    const list: PaletteItem[] = [];
    const q = query.trim().toLowerCase();
    const cleanQ = q.startsWith(">") ? q.slice(1).trim() : q;

    const isQuickNoteTrigger = q.startsWith(">note") || q === "note" || q === ">";
    if (isQuickNoteTrigger || !q) {
      list.push({
        id: "action-quick-note",
        title: "Quick Note Capture",
        subtitle: "Ghi chép nhanh vào Vault (>note)",
        type: "action",
      });
    }

    // Navigation shortcuts
    for (const nav of NAV_COMMANDS) {
      if (
        !cleanQ ||
        nav.title.toLowerCase().includes(cleanQ) ||
        nav.subtitle.toLowerCase().includes(cleanQ)
      ) {
        list.push({
          id: nav.id,
          title: nav.title,
          subtitle: nav.subtitle,
          type: "nav",
          targetTab: nav.tab,
        });
      }
    }

    // Portal Quick Links
    const matchedPortal = cleanQ
      ? PORTAL_QUICK_LINKS.filter(
          (p) =>
            p.label.toLowerCase().includes(cleanQ) ||
            p.category.toLowerCase().includes(cleanQ) ||
            p.keywords.toLowerCase().includes(cleanQ)
        )
      : PORTAL_QUICK_LINKS.slice(0, 4);

    for (const p of matchedPortal) {
      list.push({
        id: p.id,
        title: `Portal: ${p.label}`,
        subtitle: p.category,
        type: "portal",
        externalUri: p.url,
      });
    }

    // Vault Notes
    if (searchResults.length > 0) {
      for (const r of searchResults) {
        list.push({
          id: r.id,
          title: r.title,
          snippet: r.snippet,
          subtitle: r.id,
          type: "note",
        });
      }
    } else if (!q && recentNotes.length > 0) {
      for (const note of recentNotes) {
        list.push({
          id: note.id,
          title: note.title,
          subtitle: note.id,
          externalUri: note.externalUri,
          type: "note",
        });
      }
    }

    return list;
  }, [query, searchResults, recentNotes]);

  const handleSelectItem = async (item: PaletteItem) => {
    if (item.type === "action") {
      if (item.id === "action-quick-note") {
        setIsOpen(false);
        useQuickCaptureStore.getState().openQuickCapture();
      }
      return;
    }

    if (item.type === "nav" && item.targetTab) {
      onNavigateTab?.(item.targetTab);
      setIsOpen(false);
      return;
    }

    if (item.type === "portal" && item.externalUri) {
      try {
        await openExternalUrl(item.externalUri);
      } catch (err) {
        console.error("Failed to open Portal URL:", err);
      }
      setIsOpen(false);
      return;
    }

    if (item.externalUri) {
      try {
        await openOnenoteLink(item.externalUri);
      } catch (err) {
        console.error("Failed to open OneNote link:", err);
      }
    }
    setIsOpen(false);
    void hideHud();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length > 0 ? (prev + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length > 0 ? (prev - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items.length > 0 && selectedIndex < items.length) {
        void handleSelectItem(items[selectedIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4"
      onClick={() => {
        setIsOpen(false);
        void hideHud();
      }}
    >
      <div
        className="fixed left-1/2 top-[14%] z-50 flex max-h-[70vh] w-full max-w-2xl -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-zinc-800 bg-zinc-950 px-4 py-3">
          <Search className="mr-3 h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            placeholder="Tìm ghi chú, chuyển màn hình hoặc mở thủ tục Portal..."
            className="flex-1 bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
          />
          {isLoading && (
            <Loader2 className="ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" aria-hidden="true" />
          )}
          <kbd className="ml-2 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
            ESC
          </kbd>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-500">
              {isLoading ? "Đang tìm..." : "Không tìm thấy kết quả phù hợp"}
            </div>
          ) : (
            items.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={`${item.id}-${idx}`}
                  type="button"
                  onClick={() => void handleSelectItem(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left cursor-pointer ${
                    isSelected
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-300 hover:bg-zinc-800/50"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3 pr-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-950 text-zinc-400">
                      {item.type === "action" ? (
                        <Zap className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                      ) : item.type === "nav" ? (
                        <Compass className="h-3.5 w-3.5 text-zinc-300" aria-hidden="true" />
                      ) : item.type === "portal" ? (
                        <ExternalLink className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-zinc-100">
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div className="truncate font-mono text-[11px] text-zinc-500">
                          {item.subtitle}
                        </div>
                      )}
                      {item.snippet && (
                        <div className="mt-0.5 line-clamp-1 text-[11px] text-zinc-400">
                          {renderHighlightedSnippet(
                            item.snippet,
                            "",
                            "rounded bg-zinc-800 px-1 font-semibold text-emerald-300"
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {isSelected && (
                    <span className="flex shrink-0 items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                      <span>Mở</span>
                      <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950 px-4 py-2 text-[11px] text-zinc-500">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="font-mono text-zinc-400">↑↓</kbd> chọn
            </span>
            <span>
              <kbd className="font-mono text-zinc-400">↵</kbd> mở
            </span>
            <span>
              <kbd className="font-mono text-zinc-400">&gt;note</kbd> ghi chép
            </span>
          </div>
          <span className="font-mono text-[10px] text-zinc-500">Ctrl+K</span>
        </div>
      </div>
    </div>
  );
};
