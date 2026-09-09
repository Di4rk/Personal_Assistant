import React, { useCallback, useState } from "react";
import { submitPortalTranscript, syncPortalUitData } from "../../../lib/tauri-client";
import { useTauriEvent } from "../../../hooks/useTauriEvent";
import type { AcademicOverviewDto, PortalSyncStatus, RawPortalSemester } from "../types";

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
  const [status, setStatus] = useState<PortalSyncStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultOverview, setResultOverview] = useState<AcademicOverviewDto | null>(null);
  const [showManualInput, setShowManualInput] = useState<boolean>(false);
  const [manualJson, setManualJson] = useState<string>("");

  // Lắng nghe sự kiện sync-complete từ Tauri backend khi SSO Webview hoàn thành
  const handleSyncComplete = useCallback(
    (overview: AcademicOverviewDto) => {
      setResultOverview(overview);
      setStatus("completed");
      if (onSyncSuccess) {
        onSyncSuccess(overview);
      }
    },
    [onSyncSuccess]
  );

  useTauriEvent<AcademicOverviewDto>("academic://sync-complete", handleSyncComplete);

  const handleStartSso = async () => {
    setStatus("awaiting_sso");
    setErrorMessage(null);

    try {
      const overview = await syncPortalUitData();
      // Nếu backend sync xong ngay hoặc trả về overview
      setResultOverview(overview);
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Lỗi khi mở popup SSO UIT";
      setErrorMessage(msg);
      setStatus("error");
    }
  };

  const handleManualSubmit = async () => {
    if (!manualJson.trim()) {
      setErrorMessage("Vui lòng dán payload JSON bảng điểm.");
      return;
    }

    setStatus("ingesting");
    setErrorMessage(null);

    try {
      const parsed: RawPortalSemester[] = JSON.parse(manualJson);
      const overview = await submitPortalTranscript(parsed);
      setResultOverview(overview);
      setStatus("completed");
      if (onSyncSuccess) {
        onSyncSuccess(overview);
      }
    } catch (err) {
      const msg =
        typeof err === "string"
          ? err
          : err instanceof Error
          ? err.message
          : "JSON không đúng định dạng học kỳ UIT.";
      setErrorMessage(msg);
      setStatus("error");
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setErrorMessage(null);
    setResultOverview(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 shadow-2xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div>
            <h3 className="text-base font-semibold text-zinc-100">
              Đồng bộ Cổng thông tin UIT
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Hỗ trợ SSO trực tiếp &amp; phân giải bảng điểm Next.js portal.uit.edu.vn
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded hover:bg-zinc-800 text-sm"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="py-5 space-y-4">
          {/* Status Indicator */}
          {status === "idle" && (
            <div className="space-y-4">
              <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-4 text-xs text-zinc-300 space-y-2">
                <div className="font-medium text-zinc-200">Quy trình tự động hoá:</div>
                <ul className="list-disc list-inside space-y-1 text-zinc-400">
                  <li>Mở cửa sổ Webview SSO đăng nhập tài khoản sinh viên UIT.</li>
                  <li>Tự động nhận diện session và nạp bảng điểm học kỳ.</li>
                  <li>Tự động phân loại môn GDTC (PE) và GDQP (ME) khỏi tính GPA.</li>
                  <li>Tính toán tự động thang điểm hệ 4 và cập nhật tổng chỉ số cGPA.</li>
                </ul>
              </div>

              {!showManualInput ? (
                <div className="flex flex-col space-y-2">
                  <button
                    type="button"
                    onClick={handleStartSso}
                    className="w-full py-2.5 px-4 rounded-md bg-zinc-100 text-zinc-900 font-medium text-sm hover:bg-white transition-colors flex items-center justify-center space-x-2"
                  >
                    <span>Mở Popup SSO UIT</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowManualInput(true)}
                    className="text-xs text-zinc-400 hover:text-zinc-200 underline text-center pt-1"
                  >
                    Hoặc nạp qua JSON payload / Fallback Parser
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-zinc-300 font-medium">Dán JSON bảng điểm:</span>
                    <button
                      type="button"
                      onClick={() => setShowManualInput(false)}
                      className="text-zinc-400 hover:text-zinc-200 underline"
                    >
                      Quay lại SSO
                    </button>
                  </div>
                  <textarea
                    rows={6}
                    value={manualJson}
                    onChange={(e) => setManualJson(e.target.value)}
                    placeholder='[&#10;  {&#10;    "header": "Học kỳ 1/2024-2025",&#10;    "courses": [&#10;      { "courseCode": "IT002", "courseName": "OOP", "credits": 4, "summaryScore10": 9.0 }&#10;    ]&#10;  }&#10;]'
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleManualSubmit}
                    className="w-full py-2 px-4 rounded-md bg-zinc-200 text-zinc-900 font-medium text-xs hover:bg-white transition-colors"
                  >
                    Nạp JSON bảng điểm
                  </button>
                </div>
              )}
            </div>
          )}

          {status === "awaiting_sso" && (
            <div className="rounded-md border border-amber-900/50 bg-amber-950/20 p-4 space-y-3 text-center">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Awaiting SSO
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">
                Cửa sổ đăng nhập SSO của UIT đã mở. Vui lòng hoàn tất xác thực Microsoft
                trên popup. Khi cổng tải xong bảng điểm, hệ thống sẽ tự động đồng bộ.
              </p>
              <div className="pt-2 flex justify-center space-x-2">
                <button
                  type="button"
                  onClick={() => setStatus("ingesting")}
                  className="text-xs text-zinc-400 hover:text-zinc-200 underline"
                >
                  Đã đăng nhập xong? Bấm để tiếp tục
                </button>
              </div>
            </div>
          )}

          {status === "ingesting" && (
            <div className="rounded-md border border-blue-900/50 bg-blue-950/20 p-4 space-y-3 text-center">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/30">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                Ingesting
              </div>
              <p className="text-xs text-zinc-300">
                Đang chuẩn hoá danh sách môn học, lọc các môn miễn trừ và cập nhật cGPA...
              </p>
            </div>
          )}

          {status === "completed" && resultOverview && (
            <div className="rounded-md border border-emerald-900/50 bg-emerald-950/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  <span>✓</span> Completed
                </div>
                <span className="text-xs text-zinc-400 font-mono">
                  {resultOverview.academicYear} - HK{resultOverview.semesterTerm}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
                <div className="bg-zinc-950/60 p-2 rounded border border-zinc-800">
                  <span className="text-zinc-500 block">GPA Hệ 10</span>
                  <span className="text-sm font-semibold text-zinc-100">
                    {resultOverview.actualGpa10 !== null ? resultOverview.actualGpa10.toFixed(2) : "–"}
                  </span>
                </div>
                <div className="bg-zinc-950/60 p-2 rounded border border-zinc-800">
                  <span className="text-zinc-500 block">GPA Hệ 4</span>
                  <span className="text-sm font-semibold text-emerald-400">
                    {resultOverview.actualGpa4 !== null ? resultOverview.actualGpa4.toFixed(2) : "–"}
                  </span>
                </div>
                <div className="bg-zinc-950/60 p-2 rounded border border-zinc-800">
                  <span className="text-zinc-500 block">Tín chỉ tích lũy</span>
                  <span className="text-sm font-semibold text-zinc-100">
                    {resultOverview.passedCredits} / {resultOverview.totalCredits} TC
                  </span>
                </div>
                <div className="bg-zinc-950/60 p-2 rounded border border-zinc-800">
                  <span className="text-zinc-500 block">Điểm Rèn Luyện</span>
                  <span className="text-sm font-semibold text-zinc-100">
                    {resultOverview.actualDrl} Đ
                  </span>
                </div>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="rounded-md border border-red-900/50 bg-red-950/30 p-3 text-xs text-red-300">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end space-x-2 pt-3 border-t border-zinc-800 text-xs">
          {status === "completed" ? (
            <button
              type="button"
              onClick={onClose}
              className="py-1.5 px-4 rounded bg-zinc-200 text-zinc-900 font-medium hover:bg-white transition-colors"
            >
              Hoàn tất
            </button>
          ) : (
            <>
              {status !== "idle" && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="py-1.5 px-3 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Thử lại
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="py-1.5 px-3 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
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
