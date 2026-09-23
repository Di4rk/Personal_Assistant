import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Search,
  Zap,
  FileText,
  ExternalLink,
  Loader2,
  ArrowRight,
  Command,
} from "lucide-react";
import { searchVault, openOnenoteLink, getVaultStats } from "@/lib/tauri-client";
import type { VaultSearchResultDto, VaultRecentNote } from "@/features/vault/types";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { useQuickCaptureStore } from "@/stores/useQuickCaptureStore";

interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  snippet?: string;
  type: "action" | "note";
  externalUri?: string;
}

export const CommandPaletteModal: React.FC = () => {
  const { isOpen, setIsOpen, inputRef, hideHud } = useCommandPalette();
  const [query, setQuery] = useState<string>("");
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [searchResults, setSearchResults] = useState<VaultSearchResultDto[]>([]);
  const [recentNotes, setRecentNotes] = useState<VaultRecentNote[]>([]);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load recent notes once or when opened
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

  // Debounced search (150ms)
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

  // Compute items to display
  const items: PaletteItem[] = [];

  // If query is empty or starts with ">" or matches "note"
  const isQuickNoteTrigger =
    query.trim().toLowerCase().startsWith(">note") ||
    query.trim().toLowerCase().startsWith(">") ||
    query.trim().toLowerCase() === "note";

  if (isQuickNoteTrigger || !query.trim()) {
    items.push({
      id: "action-quick-note",
      title: "Quick Note Capture",
      subtitle: "Ghi chép nhanh: Algo Trick, OneNote Binder, Teaching Sheet (>note)",
      type: "action",
    });
  }

  if (searchResults.length > 0) {
    for (const r of searchResults) {
      items.push({
        id: r.id,
        title: r.title,
        snippet: r.snippet,
        subtitle: r.id,
        type: "note",
      });
    }
  } else if (!query.trim() && recentNotes.length > 0) {
    for (const note of recentNotes) {
      items.push({
        id: note.id,
        title: note.title,
        subtitle: note.id,
        externalUri: note.externalUri,
        type: "note",
      });
    }
  }

  const handleSelectItem = async (item: PaletteItem) => {
    if (item.type === "action") {
      if (item.id === "action-quick-note") {
        setIsOpen(false);
        useQuickCaptureStore.getState().openQuickCapture();
      }
    } else {
      if (item.externalUri) {
        try {
          await openOnenoteLink(item.externalUri);
        } catch (err) {
          console.error("Failed to open OneNote link:", err);
        }
      }
      setIsOpen(false);
      void hideHud();
    }
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
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-100"
          onClick={() => {
            setIsOpen(false);
            void hideHud();
          }}
        >
          <div
            className="fixed top-[15%] left-1/2 -translate-x-1/2 w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden z-50 flex flex-col max-h-[70vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Search Input Bar */}
            <div className="relative flex items-center px-4 py-3.5 border-b border-zinc-800 bg-zinc-950/50">
              <Search className="w-4 h-4 text-violet-400 shrink-0 mr-3" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={handleQueryChange}
                onKeyDown={handleKeyDown}
                placeholder="Tìm kiếm Vault hoặc gõ >note để ghi chép nhanh..."
                className="flex-1 bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none font-sans"
              />
              {isLoading && (
                <Loader2 className="w-4 h-4 text-violet-400 animate-spin shrink-0 ml-2" />
              )}
              <div className="flex items-center gap-1 ml-2 shrink-0">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                  ESC
                </span>
              </div>
            </div>

            {/* Results List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {items.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500">
                  {isLoading ? "Đang tìm kiếm..." : "Không tìm thấy ghi chú hoặc lệnh phù hợp"}
                </div>
              ) : (
                items.map((item, idx) => {
                  const isSelected = idx === selectedIndex;
                  return (
                    <div
                      key={item.id + idx}
                      onClick={() => void handleSelectItem(item)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-violet-950/50 border border-violet-700/50 text-zinc-100"
                          : "hover:bg-zinc-800/50 text-zinc-300 border border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                        <div
                          className={`p-2 rounded-md shrink-0 ${
                            item.type === "action"
                              ? "bg-violet-600/20 text-violet-300 border border-violet-500/30"
                              : "bg-zinc-800/80 text-zinc-400 border border-zinc-700/50"
                          }`}
                        >
                          {item.type === "action" ? (
                            <Zap className="w-3.5 h-3.5" />
                          ) : (
                            <FileText className="w-3.5 h-3.5" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold truncate">
                              {item.title}
                            </span>
                            {item.type === "action" && (
                              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-violet-900/60 text-violet-300 border border-violet-700/50">
                                ACTION
                              </span>
                            )}
                          </div>
                          {item.subtitle && (
                            <div className="text-[11px] text-zinc-500 font-mono truncate">
                              {item.subtitle}
                            </div>
                          )}
                          {item.snippet && (
                            <div
                              className="text-[11px] text-zinc-400 mt-1 line-clamp-1 [&>b]:text-amber-300 [&>b]:bg-amber-950/40 [&>b]:px-1 [&>b]:rounded"
                              dangerouslySetInnerHTML={{ __html: item.snippet }}
                            />
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {item.externalUri && (
                          <span
                            title={item.externalUri}
                            className="p-1 rounded bg-purple-950/60 text-purple-300 border border-purple-800/50"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </span>
                        )}
                        {isSelected && (
                          <span className="flex items-center gap-1 text-[10px] font-mono text-violet-300 bg-violet-900/40 px-2 py-0.5 rounded border border-violet-700/40">
                            <span>ENTER</span>
                            <ArrowRight className="w-2.5 h-2.5" />
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer Navigation Hints */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-zinc-800/80 bg-zinc-950/40 text-[11px] text-zinc-500">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <span className="font-mono text-zinc-400">↑↓</span> để điều hướng
                </span>
                <span className="flex items-center gap-1">
                  <span className="font-mono text-zinc-400">↵</span> để chọn
                </span>
                <span className="flex items-center gap-1">
                  <span className="font-mono text-zinc-400">&gt;note</span> tạo note
                </span>
              </div>
              <div className="flex items-center gap-1 text-zinc-400 font-mono text-[10px]">
                <Command className="w-3 h-3" />
                <span>Alt+K</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
