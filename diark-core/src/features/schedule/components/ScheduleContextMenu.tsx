import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  onSelect: () => void | Promise<void>;
}

interface ScheduleContextMenuProps {
  x: number;
  y: number;
  header?: string;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ScheduleContextMenu: React.FC<ScheduleContextMenuProps> = ({
  x,
  y,
  header,
  items,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 12;
    const clampedLeft = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
    const clampedTop = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
    setCoords({ left: clampedLeft, top: clampedTop });
  }, [x, y, items.length, confirmingId]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const handleDismiss = () => onClose();

    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleDismiss, true);
    window.addEventListener("resize", handleDismiss);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleDismiss, true);
      window.removeEventListener("resize", handleDismiss);
    };
  }, [onClose]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.confirmLabel && confirmingId !== item.id) {
      setConfirmingId(item.id);
      return;
    }
    onClose();
    void item.onSelect();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: `${coords.left}px`, top: `${coords.top}px` }}
      className="uit-modal-in fixed z-50 min-w-[220px] rounded-xl border border-[#1D263B] bg-[#0F1420] py-1.5 shadow-2xl"
    >
      {header && (
        <div className="border-b border-[#1D263B]/75 px-3 py-1.5 font-mono text-[10px] font-medium text-zinc-500">
          {header}
        </div>
      )}
      <div className="py-0.5">
        {items.map((item) => {
          const isConfirming = Boolean(item.confirmLabel && confirmingId === item.id);
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => handleItemClick(item)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-100 cursor-pointer ${
                isConfirming
                  ? "bg-red-500/15 font-medium text-red-300"
                  : item.danger
                  ? "text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  : "text-zinc-200 hover:bg-[#151C2C] hover:text-white"
              }`}
            >
              {item.icon && <span className="shrink-0">{item.icon}</span>}
              <span className="truncate">
                {isConfirming ? item.confirmLabel : item.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
