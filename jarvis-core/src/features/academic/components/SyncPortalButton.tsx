import React, { useCallback, useState } from "react";
import { syncUitPortal } from "../../../lib/tauri-client";
import { useTauriEvent } from "../../../hooks/useTauriEvent";
import type { AcademicOverviewDto, UitSyncState } from "../types";

export interface SyncPortalButtonProps {
  onSyncSuccess?: (overview: AcademicOverviewDto) => void;
  className?: string;
}

export const SyncPortalButton: React.FC<SyncPortalButtonProps> = ({
  onSyncSuccess,
  className = "",
}) => {
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncState, setSyncState] = useState<UitSyncState | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const getStatusText = (state: UitSyncState | null): string => {
    if (!state) return "Đồng bộ Cổng UIT";
    switch (state.state) {
      case "Opening":
        return "Đang mở Cổng thông tin UIT...";
      case "Authenticating":
        return "Vui lòng đăng nhập trên cửa sổ UIT...";
      case "Extracting":
        return "Đang đọc bảng điểm...";
      case "Parsing":
        return "Đang chuẩn hóa môn học & cGPA...";
      case "Persisting":
        return "Đang lưu trữ vào SQLite...";
      case "Completed":
        return "Đã đồng bộ thành công!";
      case "Failed":
        return "Đồng bộ thất bại";
    }
  };

  // Lắng nghe state stream từ Rust qua event academic://sync-state
  const handleSyncState = useCallback(
    (state: UitSyncState) => {
      setSyncState(state);

      if (state.state === "Completed") {
        setIsSyncing(false);
        setToast({
          type: "success",
          message: "Đồng bộ bảng điểm Cổng thông tin UIT thành công! Đã cập nhật cGPA.",
        });
        setTimeout(() => setToast(null), 4000);
      } else if (state.state === "Failed") {
        setIsSyncing(false);
        setToast({
          type: "error",
          message: state.message || "Quá trình đồng bộ bảng điểm thất bại.",
        });
        setTimeout(() => setToast(null), 6000);
      }
    },
    []
  );

  useTauriEvent<UitSyncState>("academic://sync-state", handleSyncState);

  const handleStartSync = async () => {
    if (isSyncing) return;

    setIsSyncing(true);
    setToast(null);
    setSyncState({ state: "Opening" });

    try {
      const overview = await syncUitPortal();
      if (onSyncSuccess) {
        onSyncSuccess(overview);
      }
    } catch (err) {
      const msg =
        typeof err === "string"
          ? err
          : err instanceof Error
          ? err.message
          : "Không thể kết nối đến Cổng thông tin UIT.";
      setIsSyncing(false);
      setSyncState({ state: "Failed", message: msg });
      setToast({ type: "error", message: msg });
      setTimeout(() => setToast(null), 6000);
    }
  };

  return (
    <div className="relative inline-flex flex-col items-end">
      {/* Toast Alert Banner */}
      {toast && (
        <div
          className={`absolute bottom-full mb-2 right-0 z-50 px-3 py-2 rounded-md text-xs border shadow-lg flex items-center gap-2 whitespace-nowrap ${
            toast.type === "success"
              ? "bg-emerald-950/90 text-emerald-300 border-emerald-800/80"
              : "bg-red-950/90 text-red-300 border-red-800/80"
          }`}
        >
          <span>{toast.type === "success" ? "✓" : "⚠"}</span>
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-1 text-zinc-400 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Trigger Button */}
      <button
        type="button"
        disabled={isSyncing}
        onClick={handleStartSync}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
          isSyncing
            ? "bg-zinc-800 border-zinc-700 text-zinc-400 cursor-not-allowed"
            : "bg-zinc-900 border-zinc-700 text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600 hover:text-white"
        } ${className}`}
      >
        {isSyncing ? (
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
        ) : (
          <span className="text-zinc-400">⚡</span>
        )}
        <span>{getStatusText(syncState)}</span>
      </button>

      {/* Progress detail indicator below button during syncing */}
      {isSyncing && syncState && syncState.state !== "Opening" && (
        <span className="text-[10px] text-zinc-500 mt-1 font-mono">
          Trạng thái: {syncState.state}
        </span>
      )}
    </div>
  );
};
