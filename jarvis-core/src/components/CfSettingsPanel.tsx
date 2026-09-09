import { useEffect, useRef, useState } from "react";
import { getCfHandle, setCfHandle, triggerCfSync } from "../lib/tauri-client";
import type { SyncCompletePayload } from "../lib/tauri-client";

type SyncStatus =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "success"; payload: SyncCompletePayload }
  | { kind: "error"; message: string };

interface CfSettingsPanelProps {
  /** Called after a successful sync so App.tsx can refetch dashboard data. */
  onSyncComplete?: (payload: SyncCompletePayload) => void;
}

/**
 * Live Codeforces settings card.
 *
 * Responsibilities (single):
 *   - Read / write the CF handle via IPC.
 *   - Trigger an immediate sync and surface the result inline.
 *
 * Does NOT manage global refetch — that's App.tsx's job via the `onSyncComplete`
 * callback and the `cf-sync-complete` event listener.
 */
export default function CfSettingsPanel({ onSyncComplete }: CfSettingsPanelProps) {
  const [handle, setHandle] = useState("");
  const [status, setStatus] = useState<SyncStatus>({ kind: "idle" });
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

  const isSyncing = status.kind === "syncing";

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center gap-2">
        {/* Pulsing emerald dot — active indicator */}
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <h3 className="text-sm font-semibold text-zinc-100">Codeforces Sync</h3>
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
          placeholder="Your Codeforces handle"
          disabled={isSyncing}
          className="flex-1 min-w-0 rounded-lg bg-zinc-800 border border-zinc-700
                     px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500
                     focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent
                     disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
          aria-label="Codeforces handle"
        />
        <button
          id="cf-save-sync-btn"
          onClick={() => void handleSaveAndSync()}
          disabled={isSyncing}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg
                     bg-violet-600 hover:bg-violet-500 active:bg-violet-700
                     text-sm font-medium text-white
                     disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors focus:outline-none focus:ring-2 focus:ring-violet-400"
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
      <p className="text-xs text-zinc-400">
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
    <p className="text-xs text-red-400">
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
