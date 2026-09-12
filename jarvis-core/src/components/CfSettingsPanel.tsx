import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, X, Loader2 } from "lucide-react";
import { getCfHandle, setCfHandle, triggerCfSync, purgeCfData } from "../lib/tauri-client";
import type { SyncCompletePayload } from "../lib/tauri-client";

type SyncStatus =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "success"; payload: SyncCompletePayload }
  | { kind: "error"; message: string };

interface CfSettingsPanelProps {
  /** Called after a successful sync or reset so App.tsx can refetch dashboard data. */
  onSyncComplete?: (payload: SyncCompletePayload) => void;
}

/**
 * Live Codeforces settings card with Cyberpunk / Monokai palette.
 *
 * Responsibilities:
 *   - Read / write the CF handle via IPC.
 *   - Trigger live synchronization.
 *   - Purge CF data safely with explicit Moodle deadline protection confirmation.
 */
export default function CfSettingsPanel({ onSyncComplete }: CfSettingsPanelProps) {
  const [handle, setHandle] = useState("");
  const [status, setStatus] = useState<SyncStatus>({ kind: "idle" });
  const [isPurgeModalOpen, setIsPurgeModalOpen] = useState<boolean>(false);
  const [isPurging, setIsPurging] = useState<boolean>(false);
  const mounted = useRef(true);

  // Initialize input from persisted settings on mount.
  useEffect(() => {
    mounted.current = true;
    getCfHandle().then((saved) => {
      if (mounted.current && saved) setHandle(saved);
    });
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleSaveAndSync = async () => {
    const trimmed = handle.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "CF handle không được để trống." });
      return;
    }

    setStatus({ kind: "syncing" });

    try {
      // 1. Persist the handle first — sync will read it from the DB.
      await setCfHandle(trimmed);
    } catch (err) {
      if (mounted.current) {
        const msg = typeof err === "string" ? err : "Không lưu được handle.";
        setStatus({ kind: "error", message: msg });
      }
      return;
    }

    // 2. Trigger live sync — never throws (errors are in the payload).
    const result = await triggerCfSync();

    if (!mounted.current) return;

    if (result.success) {
      setStatus({ kind: "success", payload: result });
      onSyncComplete?.(result);
    } else {
      setStatus({ kind: "error", message: result.message });
    }
  };

  const handleConfirmPurge = async () => {
    setIsPurging(true);
    try {
      await purgeCfData();
      if (mounted.current) {
        setHandle("");
        setStatus({ kind: "idle" });
        setIsPurgeModalOpen(false);
      }
      onSyncComplete?.({
        success: true,
        message: "Đã xóa dữ liệu Codeforces và bảo toàn lịch sử deadline Moodle.",
        new_submissions_count: 0,
      });
    } catch (err) {
      console.error("Purge CF error:", err);
      if (mounted.current) {
        setStatus({
          kind: "error",
          message: typeof err === "string" ? err : "Lỗi khi xóa dữ liệu Codeforces.",
        });
        setIsPurgeModalOpen(false);
      }
    } finally {
      if (mounted.current) {
        setIsPurging(false);
      }
    }
  };

  const isSyncing = status.kind === "syncing";

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col gap-3 shadow-sm">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Pulsing emerald dot — active indicator */}
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <h3 className="text-sm font-semibold text-slate-100">Codeforces Sync</h3>
        </div>

        <button
          type="button"
          onClick={() => setIsPurgeModalOpen(true)}
          disabled={isSyncing || isPurging}
          className="flex items-center gap-1 text-[11px] text-amber-400/90 hover:text-amber-300 transition-colors cursor-pointer disabled:opacity-50"
          title="Đổi handle hoặc xóa trắng dữ liệu bài nộp CF"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Đổi Handle / Reset</span>
        </button>
      </div>

      {/* Handle input + action button */}
      <div className="flex gap-2">
        <input
          id="cf-handle-input"
          type="text"
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value);
            if (status.kind !== "idle") setStatus({ kind: "idle" });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isSyncing) void handleSaveAndSync();
          }}
          placeholder="Codeforces handle..."
          disabled={isSyncing || isPurging}
          className="flex-1 min-w-0 rounded-lg bg-slate-950 border border-slate-800
                     px-3 py-2 text-sm text-slate-100 placeholder-slate-500
                     focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500
                     disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors font-mono"
          aria-label="Codeforces handle"
        />
        <button
          id="cf-save-sync-btn"
          onClick={() => void handleSaveAndSync()}
          disabled={isSyncing || isPurging}
          className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-lg
                     bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700
                     text-sm font-medium text-white
                     disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.3)]"
          aria-label="Save handle and trigger sync"
        >
          {isSyncing ? (
            <>
              <SyncSpinner />
              <span>Syncing…</span>
            </>
          ) : (
            <span>Save &amp; Sync</span>
          )}
        </button>
      </div>

      {/* Status feedback */}
      <StatusMessage status={status} />

      {/* Reset Confirmation Modal */}
      {isPurgeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5 text-amber-400">
                <div className="p-2 rounded-lg bg-amber-950/60 border border-amber-800/50">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <h4 className="text-sm font-semibold text-slate-100">
                  Đổi Handle / Reset Dữ liệu Codeforces
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setIsPurgeModalOpen(false)}
                disabled={isPurging}
                className="text-slate-400 hover:text-slate-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/70 p-3 rounded-lg border border-slate-800">
              <span className="font-semibold text-amber-300">Lưu ý an toàn dữ liệu:</span> Thao tác này chỉ xóa lịch sử Codeforces và tính lại XP,{" "}
              <span className="font-semibold text-emerald-400">
                bảo toàn 100% lịch sử deadline Moodle của bạn
              </span>.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setIsPurgeModalOpen(false)}
                disabled={isPurging}
                className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition-colors"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmPurge()}
                disabled={isPurging}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white rounded-lg transition-colors shadow-sm disabled:opacity-50"
              >
                {isPurging ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Đang dọn sạch...</span>
                  </>
                ) : (
                  <span>Xác nhận xóa &amp; Đặt lại</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Sub-components (presentation-only, no state)
// ============================================================

function StatusMessage({ status }: { status: SyncStatus }) {
  if (status.kind === "idle") return null;

  if (status.kind === "syncing") {
    return (
      <p className="text-xs text-slate-400">
        Đang kết nối Codeforces API…
      </p>
    );
  }

  if (status.kind === "success") {
    const { payload } = status;
    const countLabel =
      payload.new_submissions_count > 0
        ? `+${payload.new_submissions_count} submission mới`
        : "Không có submission mới";
    return (
      <p className="text-xs text-emerald-400">
        ✓ {countLabel} — {payload.message}
      </p>
    );
  }

  // error
  return (
    <p className="text-xs text-rose-400">
      ✕ {status.message}
    </p>
  );
}

function SyncSpinner() {
  return (
    <svg
      className="animate-spin h-3.5 w-3.5 text-white"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
