import React, { useCallback, useState } from "react";
import { ingestWecodeSubmissionsJson } from "../../../lib/tauri-client";
import { useTauriEvent } from "../../../hooks/useTauriEvent";
import { WECODE_BROWSER_SYNC_SCRIPT } from "../utils/browserSyncScripts";
import { Check, Copy, ExternalLink, Terminal, AlertCircle, Code2, CheckCircle2 } from "lucide-react";

export interface SyncWecodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncSuccess?: () => void;
}

export const SyncWecodeModal: React.FC<SyncWecodeModalProps> = ({
  isOpen,
  onClose,
  onSyncSuccess,
}) => {
  const [copied, setCopied] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [status, setStatus] = useState<"idle" | "listening" | "completed" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncedCount, setSyncedCount] = useState<number | null>(null);
  const [showManualInput, setShowManualInput] = useState<boolean>(false);
  const [manualJson, setManualJson] = useState<string>("");

  const handleSyncComplete = useCallback(() => {
    setStatus("completed");
    setIsListening(false);
    if (onSyncSuccess) {
      onSyncSuccess();
    }
  }, [onSyncSuccess]);

  useTauriEvent("wecode-submissions-synced", handleSyncComplete);

  const handleCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(WECODE_BROWSER_SYNC_SCRIPT);
      setCopied(true);
      setIsListening(true);
      setStatus("listening");
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setErrorMessage("Không thể sao chép vào clipboard. Vui lòng thử lại.");
    }
  };

  const handleManualSubmit = async () => {
    if (!manualJson.trim()) {
      setErrorMessage("Vui lòng dán payload JSON Wecode Submissions.");
      return;
    }

    setErrorMessage(null);
    try {
      const count = await ingestWecodeSubmissionsJson(manualJson);
      setSyncedCount(count);
      setStatus("completed");
      if (onSyncSuccess) {
        onSyncSuccess();
      }
    } catch (err) {
      const msg =
        typeof err === "string"
          ? err
          : err instanceof Error
          ? err.message
          : "JSON submissions không đúng định dạng.";
      setErrorMessage(msg);
      setStatus("error");
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setIsListening(false);
    setErrorMessage(null);
    setSyncedCount(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-100 shadow-2xl p-6 font-mono">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-950/60 border border-emerald-800/50 text-emerald-400">
              <Code2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100">
                Đồng bộ Wecode UIT (Direct Sync)
              </h3>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Không dùng Webview — Đồng bộ 100% an toàn từ trình duyệt chính
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1.5 rounded-lg hover:bg-zinc-800 text-xs"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="py-4 space-y-4">
          {status === "completed" ? (
            <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-5 text-center space-y-3">
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
              <h4 className="text-sm font-bold text-emerald-300">
                Đồng bộ Wecode thành công!
              </h4>
              <p className="text-xs text-zinc-300 leading-relaxed">
                {syncedCount !== null
                  ? `Đã nạp ${syncedCount} bài nộp vào Diark OS.`
                  : "Toàn bộ bài nộp và XP đã được ghi nhận vào SQLite và cập nhật Life Matrix."}
              </p>
            </div>
          ) : !showManualInput ? (
            <div className="space-y-4 text-xs">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-4 space-y-3">
                <div className="font-semibold text-zinc-200 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-emerald-400" />
                  <span>3 Bước đồng bộ cực nhanh (1-Click):</span>
                </div>
                <ol className="list-decimal list-inside space-y-2 text-zinc-300 text-[11px] leading-relaxed">
                  <li>
                    Mở trang Wecode môn học của bạn trên Chrome/Edge:
                    <a
                      href="https://khmt.uit.edu.vn/wecode25"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 ml-1.5 text-emerald-400 hover:underline"
                    >
                      khmt.uit.edu.vn/wecode25
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    Nhấn <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200">F12</kbd> (hoặc Ctrl+Shift+I) → chọn tab <b className="text-zinc-100">Console</b>.
                  </li>
                  <li>
                    Dán script (bấm nút bên dưới) rồi nhấn <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200">Enter</kbd>.
                  </li>
                </ol>
              </div>

              {/* Action Button */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={handleCopyScript}
                  className={`w-full py-2.5 px-4 rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-sm ${
                    copied
                      ? "bg-emerald-600 text-white"
                      : "bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950"
                  }`}
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4" />
                      <span>✓ Đã sao chép Script vào Clipboard!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      <span>Sao chép Script đồng bộ Wecode</span>
                    </>
                  )}
                </button>

                {isListening && (
                  <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-2 text-zinc-300">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                      <span>Đang lắng nghe dữ liệu từ cổng local 3030...</span>
                    </div>
                    <span className="text-zinc-500">Tự động nhận diện</span>
                  </div>
                )}

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => setShowManualInput(true)}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 underline"
                  >
                    Hoặc dán JSON sao lưu thủ công
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-zinc-300 font-medium">Dán JSON Submissions:</span>
                <button
                  type="button"
                  onClick={() => setShowManualInput(false)}
                  className="text-zinc-400 hover:text-zinc-200 underline text-[11px]"
                >
                  Quay lại hướng dẫn
                </button>
              </div>
              <textarea
                rows={7}
                value={manualJson}
                onChange={(e) => setManualJson(e.target.value)}
                placeholder='[&#10;  {&#10;    "submission_id": 12345,&#10;    "assignment_id": 1,&#10;    "problem_id": 10,&#10;    "problem_name": "Two Sum",&#10;    "submit_time_str": "Fri, 17 Jul 2026 01:50:46",&#10;    "verdict": "CORRECT ANSWER",&#10;    "score": 100,&#10;    "execution_time": 0.02,&#10;    "memory_kib": 1024,&#10;    "language": "C++",&#10;    "is_final": true&#10;  }&#10;]'
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] text-zinc-200 placeholder-zinc-700 focus:border-emerald-600 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleManualSubmit}
                className="w-full py-2 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors"
              >
                Nạp JSON Submissions
              </button>
            </div>
          )}

          {errorMessage && (
            <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>{errorMessage}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end space-x-2 pt-3 border-t border-zinc-800 text-xs">
          {status === "completed" ? (
            <button
              type="button"
              onClick={onClose}
              className="py-1.5 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-semibold transition-colors"
            >
              Hoàn tất
            </button>
          ) : (
            <>
              {status === "error" && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="py-1.5 px-3 rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Thử lại
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="py-1.5 px-3 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                Đóng
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SyncWecodeModal;
