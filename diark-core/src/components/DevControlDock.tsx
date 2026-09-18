import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_DEV } from "../constants/app";
import { resetIdentityState } from "../lib/tauri-client";
import { Wrench, RotateCcw, AlertTriangle, Loader2, Shield } from "lucide-react";
import { usePrivacyStore } from "../stores/usePrivacyStore";

interface DevControlDockProps {
  onResetIdentity: () => void;
}

export const DevControlDock: React.FC<DevControlDockProps> = ({ onResetIdentity }) => {
  if (!IS_DEV) return null;

  const [isOpen, setIsOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleReset = async () => {
    if (isResetting) return;
    setIsResetting(true);
    try {
      await resetIdentityState();
      onResetIdentity();
    } catch (err) {
      console.error("Reset identity thất bại:", err);
    } finally {
      setIsResetting(false);
      setIsOpen(false);
    }
  };

  const handleDevFactoryReset = async () => {
    const confirmed = window.confirm(
      "[DEV] CẢNH BÁO: Thao tác này sẽ xóa sạch toàn bộ SQLite (trừ Curriculums tĩnh), xóa sạch Cache trình duyệt và đưa app về Genesis Zero-State. Bạn có chắc chắn không?"
    );
    if (!confirmed) return;

    try {
      // 1. Chờ backend xóa sạch SQLite và truncate WAL
      await invoke('reset_user_data_to_genesis');

      // 2. Dọn dẹp toàn bộ Web Storage
      localStorage.clear();
      sessionStorage.clear();

      // 3. Khởi động lại cửa sổ để App tự rehydrate về Zero-State
      window.location.reload();
    } catch (err) {
      console.error("Factory reset failed:", err);
      alert(`Reset thất bại: ${err}`);
    }
  };

  return (
    <aside aria-label="Developer Tools" className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 font-mono">
      {isOpen && (
        <div className="rounded-xl border border-amber-500/40 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 text-xs space-y-2 w-56">
          <div className="flex items-center gap-1.5 text-amber-400 font-bold border-b border-amber-500/20 pb-1.5">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>DEV CONTROL DOCK</span>
          </div>

          <p className="text-[11px] text-slate-400 leading-tight">
            Chỉ khả dụng trong môi trường <span className="text-amber-300 font-semibold">DEV</span>. Không xuất hiện trong release build.
          </p>

          <button
            type="button"
            onClick={() => usePrivacyStore.getState().toggleDemoMode()}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-cyan-500/20 hover:bg-cyan-500/30 active:bg-cyan-500/40 text-cyan-300 border border-cyan-500/40 font-semibold transition-all cursor-pointer"
          >
            <Shield className="w-3.5 h-3.5" />
            <span>🔒 TOGGLE DEMO PRIVACY</span>
          </button>

          <button
            type="button"
            onClick={() => void handleReset()}
            disabled={isResetting}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-amber-500/20 hover:bg-amber-500/30 active:bg-amber-500/40 text-amber-300 border border-amber-500/40 font-semibold transition-all cursor-pointer disabled:opacity-50"
          >
            {isResetting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>ĐANG RESET...</span>
              </>
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                <span>⚡ RESET ONBOARDING</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => void handleDevFactoryReset()}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg hover:bg-red-500/20 active:scale-95 transition-all cursor-pointer"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
            <span>Factory Reset (Genesis)</span>
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="bg-slate-900/90 hover:bg-slate-800/90 active:bg-slate-950 border border-amber-500/40 text-amber-400 text-xs font-mono px-3 py-1.5 rounded shadow-lg backdrop-blur flex items-center gap-2 cursor-pointer transition-all hover:shadow-[0_0_15px_rgba(245,158,11,0.2)]"
        title="Bật/tắt Dev Control Dock"
      >
        <Wrench className="w-3.5 h-3.5 text-amber-400" />
        <span>[DEV] DOCK</span>
        {isOpen && <span className="text-[10px] text-amber-500">▲</span>}
      </button>
    </aside>
  );
};

export default DevControlDock;
