import React, { useCallback, useState } from "react";
import { ingestWecodeSubmissionsJson, launchWecodeSsoSync } from "../../../lib/tauri-client";
import { useTauriEvent } from "../../../hooks/useTauriEvent";
import { WECODE_BROWSER_SYNC_SCRIPT } from "../utils/browserSyncScripts";
import {
  Check,
  Copy,
  ExternalLink,
  AlertCircle,
  Code2,
  CheckCircle2,
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

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
  const [showManualSection, setShowManualSection] = useState<boolean>(false);
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
  useTauriEvent<string>("sso-callback-success", (target) => {
    if (target === "wecode") {
      handleSyncComplete();
    }
  });
  useTauriEvent<string>("wecode-sync-failed", (reason) => {
    setErrorMessage(`Đồng bộ thất bại: ${reason}`);
    setStatus("error");
    setIsListening(false);
  });

  const handleLaunchAutoSync = async () => {
    setErrorMessage(null);
    setStatus("listening");
    setIsListening(true);
    try {
      await launchWecodeSsoSync();
    } catch (err) {
      const msg = typeof err === "string" ? err : "Không thể khởi chạy cửa sổ đăng nhập Wecode.";
      setErrorMessage(msg);
      setStatus("error");
      setIsListening(false);
    }
  };

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
                Đồng bộ Wecode UIT
              </h3>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Tự động thu thập bài nộp, điểm số & Gamification XP
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
          ) : (
            <>
              {/* PRIMARY ACTION: 1-CLICK AUTO SSO SYNC */}
              <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 space-y-3">
                <div className="flex items-center gap-2 font-semibold text-emerald-300">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  <span>Phương thức Tự động (Khuyên dùng):</span>
                </div>
                <p className="text-[11px] text-zinc-300 leading-relaxed">
                  Nhấn nút bên dưới, đăng nhập tài khoản UIT trên cửa sổ Wecode xuất hiện.
                  Diark OS sẽ <b>tự động thu thập toàn bộ bài nộp, điểm số & Gamification XP</b>, sau đó tự đóng cửa sổ.
                </p>

                <button
                  type="button"
                  onClick={handleLaunchAutoSync}
                  disabled={isListening}
                  className={`w-full py-2.5 px-4 rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-sm cursor-pointer ${
                    isListening
                      ? "bg-zinc-800 text-zinc-400 cursor-not-allowed border border-zinc-700"
                      : "bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-bold"
                  }`}
                >
                  {isListening ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                      <span>Đang chờ bạn đăng nhập trên cửa sổ Wecode...</span>
                    </>
                  ) : (
                    <>
                      <span className="text-base">🚀</span>
                      <span>Đăng nhập & Tự động đồng bộ Wecode</span>
                    </>
                  )}
                </button>

                {isListening && (
                  <div className="p-3 rounded-lg bg-zinc-950/90 border border-zinc-800 space-y-1.5 text-[11px]">
                    <div className="flex items-center gap-2 text-emerald-400 font-medium">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping shrink-0" />
                      <span>Cửa sổ Wecode đã mở — Hãy đăng nhập tài khoản UIT</span>
                    </div>
                    <p className="text-zinc-400 text-[10px] pl-4">
                      Ngay khi đăng nhập xong, hệ thống sẽ tự động bóc tách dữ liệu và đóng cửa sổ.
                    </p>
                  </div>
                )}
              </div>

              {/* SECONDARY / MANUAL FALLBACK SECTION */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowManualSection(!showManualSection)}
                  className="w-full flex items-center justify-between text-[11px] text-zinc-400 hover:text-zinc-300 p-2 rounded-lg hover:bg-zinc-800/50 transition-colors"
                >
                  <span>Phương thức dự phòng (Console F12 / Dán JSON)</span>
                  {showManualSection ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>

                {showManualSection && (
                  <div className="mt-2 space-y-3 text-xs border-t border-zinc-800/80 pt-3">
                    {!showManualInput ? (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 space-y-2 text-[11px] text-zinc-400 leading-relaxed">
                          <div>
                            Nếu trình duyệt mặc định đang có sẵn phiên đăng nhập:
                          </div>
                          <ol className="list-decimal list-inside space-y-1 text-zinc-300">
                            <li>
                              Mở{" "}
                              <a
                                href="https://khmt.uit.edu.vn/wecode25"
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 text-emerald-400 hover:underline"
                              >
                                khmt.uit.edu.vn/wecode25
                                <ExternalLink className="w-3 h-3 ml-0.5" />
                              </a>
                            </li>
                            <li>Bấm F12 → Tab Console</li>
                            <li>Dán script và Enter</li>
                          </ol>
                        </div>

                        <button
                          type="button"
                          onClick={handleCopyScript}
                          className={`w-full py-2 px-3 rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-sm ${
                            copied
                              ? "bg-emerald-600 text-white"
                              : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
                          }`}
                        >
                          {copied ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              <span>✓ Đã sao chép Script Console!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Sao chép Script Console F12</span>
                            </>
                          )}
                        </button>

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
                    ) : (
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-300 font-medium">Dán JSON Submissions:</span>
                          <button
                            type="button"
                            onClick={() => setShowManualInput(false)}
                            className="text-zinc-400 hover:text-zinc-200 underline text-[11px]"
                          >
                            Quay lại script F12
                          </button>
                        </div>
                        <textarea
                          rows={5}
                          value={manualJson}
                          onChange={(e) => setManualJson(e.target.value)}
                          placeholder='[{"submission_id": 12345, "assignment_id": 1, ...}]'
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[11px] text-zinc-200 placeholder-zinc-700 focus:border-emerald-600 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleManualSubmit}
                          className="w-full py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors"
                        >
                          Nạp JSON Submissions
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
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
