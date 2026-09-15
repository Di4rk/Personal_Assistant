import React, { useCallback, useState } from "react";
import {
  submitPortalTranscript,
  ingestPortalSyncPayloadJson,
  launchPortalSsoSync,
} from "../../../lib/tauri-client";
import { useTauriEvent } from "../../../hooks/useTauriEvent";
import { PORTAL_BROWSER_SYNC_SCRIPT } from "../utils/browserSyncScripts";
import type { AcademicOverviewDto, RawPortalSemester } from "../types";
import {
  Check,
  Copy,
  ExternalLink,
  Terminal,
  AlertCircle,
  GraduationCap,
  CheckCircle2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";

export interface SyncPortalModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncSuccess?: (overview: AcademicOverviewDto) => void;
}

export const SyncPortalModal: React.FC<SyncPortalModalProps> = ({
  isOpen,
  onClose,
  onSyncSuccess,
}) => {
  const [copied, setCopied] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [status, setStatus] = useState<"idle" | "listening" | "ingesting" | "completed" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncedCoursesCount, setSyncedCoursesCount] = useState<number | null>(null);
  const [resultOverview, setResultOverview] = useState<AcademicOverviewDto | null>(null);
  const [showManualSection, setShowManualSection] = useState<boolean>(false);
  const [showManualJsonInput, setShowManualJsonInput] = useState<boolean>(false);
  const [manualJson, setManualJson] = useState<string>("");

  const handleSyncComplete = useCallback(
    (overview?: AcademicOverviewDto) => {
      if (overview) {
        setResultOverview(overview);
      }
      setStatus("completed");
      setIsListening(false);
      if (onSyncSuccess && overview) {
        onSyncSuccess(overview);
      }
    },
    [onSyncSuccess]
  );

  useTauriEvent<AcademicOverviewDto>("academic://sync-complete", handleSyncComplete);
  useTauriEvent("academic-data-synced", () => {
    setStatus("completed");
    setIsListening(false);
  });
  useTauriEvent<string>("portal-sync-failed", (reason) => {
    setErrorMessage(`Đồng bộ thất bại: ${reason}`);
    setStatus("error");
    setIsListening(false);
  });

  const handleLaunchAutoSync = async () => {
    setErrorMessage(null);
    setStatus("listening");
    setIsListening(true);
    try {
      await launchPortalSsoSync();
    } catch (err) {
      const msg = typeof err === "string" ? err : "Không thể khởi chạy cửa sổ đăng nhập UIT.";
      setErrorMessage(msg);
      setStatus("error");
      setIsListening(false);
    }
  };

  const handleCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(PORTAL_BROWSER_SYNC_SCRIPT);
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
      setErrorMessage("Vui lòng dán payload JSON.");
      return;
    }

    setStatus("ingesting");
    setErrorMessage(null);

    try {
      if (manualJson.trim().startsWith("{")) {
        const count = await ingestPortalSyncPayloadJson(manualJson);
        setSyncedCoursesCount(count);
        setStatus("completed");
      } else {
        const parsed: RawPortalSemester[] = JSON.parse(manualJson);
        const overview = await submitPortalTranscript(parsed);
        setResultOverview(overview);
        setStatus("completed");
        if (onSyncSuccess) {
          onSyncSuccess(overview);
        }
      }
    } catch (err) {
      const msg =
        typeof err === "string"
          ? err
          : err instanceof Error
          ? err.message
          : "JSON không đúng định dạng dữ liệu Portal.";
      setErrorMessage(msg);
      setStatus("error");
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setIsListening(false);
    setErrorMessage(null);
    setSyncedCoursesCount(null);
    setResultOverview(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 font-mono">
      <div className="relative w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 text-zinc-100 shadow-2xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-950/60 border border-sky-800/50 text-sky-400">
              <GraduationCap className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100">
                Đồng bộ Cổng thông tin UIT
              </h3>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Tự động 100% — Chỉ cần đăng nhập, hệ thống tự kéo toàn bộ dữ liệu
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
            <div className="rounded-lg border border-sky-900/60 bg-sky-950/30 p-5 text-center space-y-3">
              <CheckCircle2 className="w-10 h-10 text-sky-400 mx-auto" />
              <h4 className="text-sm font-bold text-sky-300">
                Đồng bộ Portal UIT thành công!
              </h4>
              <p className="text-xs text-zinc-300 leading-relaxed">
                {syncedCoursesCount !== null
                  ? `Đã cập nhật ${syncedCoursesCount} môn học, điểm rèn luyện và hồ sơ sinh viên vào SQLite.`
                  : "Toàn bộ điểm học kỳ, DRL và tín chỉ tích lũy đã được nạp vào Academic Radar."}
              </p>
              {resultOverview && (
                <div className="grid grid-cols-2 gap-2 pt-2 text-xs">
                  <div className="bg-zinc-950/70 p-2.5 rounded border border-zinc-800">
                    <span className="text-zinc-500 block text-[10px]">GPA Hệ 10</span>
                    <span className="text-base font-bold text-zinc-100">
                      {resultOverview.actualGpa10 !== null ? resultOverview.actualGpa10.toFixed(2) : "–"}
                    </span>
                  </div>
                  <div className="bg-zinc-950/70 p-2.5 rounded border border-zinc-800">
                    <span className="text-zinc-500 block text-[10px]">Tín chỉ tích lũy</span>
                    <span className="text-base font-bold text-sky-400">
                      {resultOverview.passedCredits} / {resultOverview.totalCredits} TC
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              {/* PRIMARY METHOD: AUTO-SYNC SSO */}
              <div className="rounded-lg border border-sky-900/40 bg-sky-950/20 p-4 space-y-3">
                <div className="flex items-center gap-2 font-semibold text-sky-300">
                  <Sparkles className="w-4 h-4 text-sky-400" />
                  <span>Phương thức Tự động (Khuyên dùng):</span>
                </div>
                <p className="text-[11px] text-zinc-300 leading-relaxed">
                  Nhấn nút bên dưới, đăng nhập tài khoản UIT trên cửa sổ xuất hiện.
                  Diark OS sẽ <b>tự động lấy Bảng điểm, Điểm rèn luyện & Hồ sơ</b>, sau đó tự đóng cửa sổ.
                </p>

                <button
                  type="button"
                  onClick={handleLaunchAutoSync}
                  disabled={isListening}
                  className={`w-full py-2.5 px-4 rounded-lg font-semibold text-xs transition-all flex items-center justify-center gap-2 shadow-sm cursor-pointer ${
                    isListening
                      ? "bg-zinc-800 text-zinc-400 cursor-not-allowed border border-zinc-700"
                      : "bg-sky-500 hover:bg-sky-400 active:bg-sky-600 text-zinc-950"
                  }`}
                >
                  {isListening ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
                      <span>Đang chờ bạn đăng nhập trên cửa sổ UIT...</span>
                    </>
                  ) : (
                    <>
                      <span className="text-base">🚀</span>
                      <span>Đăng nhập & Tự động đồng bộ</span>
                    </>
                  )}
                </button>

                {isListening && (
                  <div className="p-3 rounded-lg bg-zinc-950/90 border border-zinc-800 space-y-1.5 text-[11px]">
                    <div className="flex items-center gap-2 text-sky-400 font-medium">
                      <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping shrink-0" />
                      <span>Cửa sổ UIT đã mở — Hãy đăng nhập tài khoản trường</span>
                    </div>
                    <p className="text-zinc-400 text-[10px] pl-4">
                      Ngay khi đăng nhập xong, hệ thống sẽ tự động bóc tách dữ liệu và đóng cửa sổ.
                    </p>
                  </div>
                )}
              </div>

              {/* SECONDARY / FALLBACK METHODS */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowManualSection(!showManualSection)}
                  className="w-full p-3 flex items-center justify-between text-left text-[11px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Terminal className="w-3.5 h-3.5 text-zinc-500" />
                    <span>Phương thức phụ (Dán script F12 / JSON thủ công)</span>
                  </div>
                  {showManualSection ? (
                    <ChevronUp className="w-3.5 h-3.5 text-zinc-500" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                  )}
                </button>

                {showManualSection && (
                  <div className="p-3.5 pt-0 space-y-3 border-t border-zinc-800/80">
                    {!showManualJsonInput ? (
                      <div className="space-y-3 text-[11px]">
                        <ol className="list-decimal list-inside space-y-1.5 text-zinc-400 leading-relaxed">
                          <li>
                            Mở
                            <a
                              href="https://portal.uit.edu.vn/sinh-vien/bang-diem"
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 mx-1 text-sky-400 hover:underline"
                            >
                              portal.uit.edu.vn/sinh-vien/bang-diem
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                            trên trình duyệt.
                          </li>
                          <li>Nhấn F12 → chọn tab Console.</li>
                          <li>Dán script dưới đây và nhấn Enter:</li>
                        </ol>

                        <button
                          type="button"
                          onClick={handleCopyScript}
                          className={`w-full py-2 px-3 rounded-lg font-medium text-[11px] transition-all flex items-center justify-center gap-2 border ${
                            copied
                              ? "bg-sky-950/80 border-sky-700 text-sky-300"
                              : "bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-200"
                          }`}
                        >
                          {copied ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              <span>Đã sao chép script Console</span>
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
                            onClick={() => setShowManualJsonInput(true)}
                            className="text-[10px] text-zinc-500 hover:text-zinc-300 underline"
                          >
                            Hoặc dán JSON thủ công
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2 text-[11px]">
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-300 font-medium">Dán JSON Bảng điểm / DRL:</span>
                          <button
                            type="button"
                            onClick={() => setShowManualJsonInput(false)}
                            className="text-zinc-400 hover:text-zinc-200 underline text-[10px]"
                          >
                            Quay lại script
                          </button>
                        </div>
                        <textarea
                          rows={5}
                          value={manualJson}
                          onChange={(e) => setManualJson(e.target.value)}
                          placeholder="Dán payload JSON tại đây..."
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[10px] text-zinc-200 placeholder-zinc-700 focus:border-sky-600 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleManualSubmit}
                          className="w-full py-1.5 px-3 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-[11px] transition-colors"
                        >
                          Nạp JSON thủ công
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
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
              className="py-1.5 px-4 rounded-lg bg-sky-500 hover:bg-sky-400 text-zinc-950 font-semibold transition-colors"
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

export default SyncPortalModal;
