import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink, Search } from "lucide-react";
import { PORTAL_LINK_CATEGORIES, PORTAL_QUICK_LINKS } from "../constants/portalLinks";
import { openExternalUrl } from "../lib/tauri-client";

export const PortalQuickActionsPopover: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => inputRef.current?.focus());

    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const filteredLinks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PORTAL_QUICK_LINKS;
    return PORTAL_QUICK_LINKS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q)
    );
  }, [query]);

  const handleOpenLink = (url: string) => {
    setIsOpen(false);
    setQuery("");
    void openExternalUrl(url).catch((err: unknown) => {
      console.error("[PortalQuickActions] Không mở được URL:", err);
    });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#121213] px-2.5 text-xs font-medium text-zinc-300 transition-colors duration-150 ease-out hover:border-white/[0.15] hover:bg-[#19191b] hover:text-white active:scale-[0.98] cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
      >
        <span>Thủ tục Portal</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-150 ease-out ${
            isOpen ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-80 origin-top-right rounded-xl border border-white/[0.08] bg-[#121213] shadow-2xl"
        >
          <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm nhanh thủ tục Portal..."
              className="w-full bg-transparent text-xs text-zinc-100 placeholder-zinc-500 outline-none"
            />
          </div>

          <div className="max-h-96 overflow-y-auto py-1.5">
            {filteredLinks.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-zinc-500">
                Không khớp liên kết Portal nào
              </div>
            ) : (
              PORTAL_LINK_CATEGORIES.map((category) => {
                const group = filteredLinks.filter((l) => l.category === category);
                if (group.length === 0) return null;
                return (
                  <div key={category} className="py-1">
                    <div className="px-3 py-1 text-[11px] font-medium text-zinc-500">
                      {category}
                    </div>
                    {group.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        onClick={() => handleOpenLink(item.url)}
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors duration-100 hover:bg-zinc-800/70 hover:text-zinc-100 cursor-pointer"
                      >
                        <span className="truncate">{item.label}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 text-zinc-600" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
