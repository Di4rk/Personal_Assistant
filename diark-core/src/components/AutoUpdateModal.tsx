import React from "react";
import { ArrowUpCircle, Download, CheckCircle2, AlertTriangle, X, RefreshCw } from "lucide-react";
import type { UpdateInfo, UpdateStatus } from "../hooks/useAutoUpdater";

interface AutoUpdateModalProps {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
  onInstall: () => void;
  onDismiss: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export const AutoUpdateModal: React.FC<AutoUpdateModalProps> = ({
  status,
  updateInfo,
  downloadProgress,
  downloadedBytes,
  totalBytes,
  error,
  onInstall,
  onDismiss,
}) => {
  // Chỉ hiển thị modal khi có bản cập nhật mới, đang tải, lỗi, hoặc đang khởi động lại
  const isVisible =
    status === "available" ||
    status === "downloading" ||
    status === "ready-to-relaunch" ||
    (status === "error" && updateInfo !== null);

  if (!isVisible || !updateInfo) {
    return null;
  }

  const isDownloading = status === "downloading";
  const isReady = status === "ready-to-relaunch";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-modal-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-600/10 text-violet-400">
              <ArrowUpCircle className="h-5 w-5" />
            </div>
            <div>
              <h2 id="update-modal-title" className="text-sm font-bold text-zinc-100">
                Bản Cập Nhật Mới Có Sẵn
              </h2>
              <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-zinc-400">
                <span className="rounded bg-zinc-900 px-1.5 py-0.5 border border-zinc-800 text-zinc-400">
                  v{updateInfo.currentVersion}
                </span>
                <span>→</span>
                <span className="rounded bg-emerald-950/60 px-1.5 py-0.5 border border-emerald-800/60 text-emerald-400 font-semibold">
                  v{updateInfo.version}
                </span>
                {updateInfo.date && (
                  <span className="text-zinc-500">({updateInfo.date.split("T")[0]})</span>
                )}
              </div>
            </div>
          </div>

          {!isDownloading && !isReady && (
            <button
              onClick={onDismiss}
              className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 transition-colors"
              title="Để sau"
              aria-label="Đóng thông báo"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Content Body: Release Notes */}
        <div className="mt-4 space-y-3">
          <div className="text-xs font-medium text-zinc-400">Nội dung thay đổi (Changelog):</div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3 font-mono text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed select-text">
            {updateInfo.body ? (
              updateInfo.body
            ) : (
              <span className="text-zinc-500 italic">Phiên bản mới bổ sung các tính năng và bản sửa lỗi nâng cao độ ổn định.</span>
            )}
          </div>

          {/* Download Progress Bar */}
          {isDownloading && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <RefreshCw className="h-3 w-3 animate-spin text-violet-400" />
                  Đang tải gói cập nhật...
                </span>
                <span className="text-violet-400 font-bold">
                  {downloadProgress}% {totalBytes > 0 && `(${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-900 border border-zinc-800">
                <div
                  className="h-full bg-violet-600 transition-all duration-200"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Ready to relaunch */}
          {isReady && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-800/40 bg-emerald-950/20 p-3 text-xs text-emerald-300">
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>Gói cập nhật đã tải xong! Đang khởi động lại DIARK Core...</span>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-800/40 bg-rose-950/20 p-3 text-xs text-rose-300">
              <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="mt-6 flex items-center justify-end gap-3 border-t border-zinc-800/80 pt-4">
          {!isDownloading && !isReady && (
            <>
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors cursor-pointer"
              >
                Bỏ qua / Để sau
              </button>
              <button
                type="button"
                onClick={onInstall}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-xs font-medium text-white hover:bg-violet-500 transition-colors cursor-pointer shadow-sm shadow-violet-900/40"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Cập nhật ngay</span>
              </button>
            </>
          )}

          {isDownloading && (
            <button
              disabled
              className="flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-400 cursor-not-allowed"
            >
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>Đang cài đặt...</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
