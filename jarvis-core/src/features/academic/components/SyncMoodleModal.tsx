import React, { useCallback, useState, useEffect } from 'react';
import {
  ingestMoodleSyncPayloadJson,
  launchMoodleSsoSync,
} from '../../../lib/tauri-client';
import { useTauriEvent } from '../../../hooks/useTauriEvent';
import {
  Check,
  Copy,
  ExternalLink,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronUp,
  Minus,
  Maximize2,
  X,
} from 'lucide-react';

export interface SyncMoodleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncSuccess?: () => void;
}

export interface MoodleSyncProgress {
  current: number;
  total: number;
  course_name: string;
  percent: number;
  is_final: boolean;
}

export const SyncMoodleModal: React.FC<SyncMoodleModalProps> = ({
  isOpen,
  onClose,
  onSyncSuccess,
}) => {
  const [copied, setCopied] = useState<boolean>(false);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'completed' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncedCount, setSyncedCount] = useState<number | null>(null);
  const [showManualSection, setShowManualSection] = useState<boolean>(false);
  const [manualJson, setManualJson] = useState<string>('');
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [progress, setProgress] = useState<MoodleSyncProgress | null>(null);

  // Reset status khi mở modal mới
  useEffect(() => {
    if (isOpen) {
      setStatus('idle');
      setIsListening(false);
      setErrorMessage(null);
      setSyncedCount(null);
      setShowManualSection(false);
      setIsMinimized(false);
      setProgress(null);
    }
  }, [isOpen]);

  const handleSyncComplete = useCallback((count?: number) => {
    setStatus('completed');
    setIsListening(false);
    if (typeof count === 'number' && count > 0) {
      setSyncedCount(count);
    }
    if (onSyncSuccess) {
      onSyncSuccess();
    }
  }, [onSyncSuccess]);

  // Cập nhật tiến độ streaming theo thời gian thực từ Rust backend
  useTauriEvent<MoodleSyncProgress>('moodle-sync-progress', (p) => {
    if (p) {
      setProgress(p);
      setStatus('listening');
      setIsListening(true);
      if (p.is_final) {
        handleSyncComplete(p.total);
      }
    }
  });

  useTauriEvent<string>('sso-callback-success', (target) => {
    if (target === 'moodle') {
      handleSyncComplete();
    }
  });

  useTauriEvent<string>('sso-callback-error', (reason) => {
    setErrorMessage(`Đồng bộ Moodle thất bại: ${reason}`);
    setStatus('error');
    setIsListening(false);
  });

  if (!isOpen) return null;

  const handleLaunchAutoSync = async () => {
    setErrorMessage(null);
    setStatus('listening');
    setIsListening(true);
    setProgress(null);
    try {
      await launchMoodleSsoSync();
    } catch (err) {
      const msg = typeof err === 'string' ? err : 'Không thể khởi chạy cửa sổ đăng nhập Moodle.';
      setErrorMessage(msg);
      setStatus('error');
      setIsListening(false);
    }
  };

  const handleManualIngest = async () => {
    if (!manualJson.trim()) return;
    try {
      const count = await ingestMoodleSyncPayloadJson(manualJson.trim());
      setSyncedCount(count);
      handleSyncComplete();
    } catch (err) {
      setErrorMessage(typeof err === 'string' ? err : 'Dữ liệu JSON Moodle không hợp lệ.');
      setStatus('error');
    }
  };

  const copyScriptSnippet = () => {
    const snippet = `// Mở console tại https://courses.uit.edu.vn và chạy:
(async () => {
  const sk = window.M?.cfg?.sesskey;
  if (!sk) return alert("Chưa tìm thấy sesskey, hãy đăng nhập trước!");
  const resp = await fetch("https://courses.uit.edu.vn/lib/ajax/service.php?sesskey=" + sk + "&info=core_course_get_enrolled_courses_by_timeline_classification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ index: 0, methodname: "core_course_get_enrolled_courses_by_timeline_classification", args: { classification: "all", limit: 0, offset: 0 } }])
  });
  const data = await resp.json();
  console.log("Dữ liệu môn học:", JSON.stringify(data[0]?.data?.courses));
})();`;
    navigator.clipboard.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // CHẾ ĐỘ THU NHỎ (MINIMIZED FLOATING DOCK):
  // Không che màn hình, người dùng hoàn toàn có thể tương tác với bảng danh sách môn học, quest hub,...
  if (isMinimized) {
    return (
      <div className="fixed bottom-6 right-6 z-50 w-96 max-w-[calc(100vw-3rem)] rounded-xl border border-zinc-800 bg-zinc-950/95 p-4 shadow-2xl backdrop-blur-md transition-all duration-200">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 pb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {status === 'listening' ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-400" />
            ) : status === 'completed' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : status === 'error' ? (
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            ) : (
              <BookOpen className="h-4 w-4 shrink-0 text-sky-400" />
            )}
            <span className="text-xs font-semibold text-zinc-200 truncate">
              {status === 'listening'
                ? 'Đang đồng bộ Moodle...'
                : status === 'completed'
                ? 'Đồng bộ Moodle hoàn tất'
                : status === 'error'
                ? 'Lỗi đồng bộ Moodle'
                : 'Đồng bộ Moodle'}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {status === 'listening' && progress && (
              <span className="text-[11px] font-mono font-semibold text-sky-400 mr-1.5">
                {Math.round(progress.percent)}%
              </span>
            )}
            <button
              onClick={() => setIsMinimized(false)}
              title="Phóng to / Mở lại cửa sổ"
              className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onClose}
              title="Đóng"
              className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="pt-2.5">
          {status === 'listening' ? (
            <div className="space-y-2">
              <p className="text-xs text-zinc-300 truncate font-medium">
                {progress?.course_name || 'Đang kết nối & trích xuất môn học...'}
              </p>
              <div className="flex items-center justify-between text-[11px] text-zinc-500">
                <span>
                  {progress ? `Đã nạp ${progress.current}/${progress.total} môn` : 'Đang xử lý...'}
                </span>
                <span className="text-sky-400/90 font-medium">Thời gian thực</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-sky-500 transition-all duration-300 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, progress?.percent || 8))}%` }}
                />
              </div>
            </div>
          ) : status === 'completed' ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-emerald-300">
                {syncedCount !== null
                  ? `Đã nạp ${syncedCount} bản ghi vào SQLite.`
                  : 'Toàn bộ dữ liệu môn học đã cập nhật!'}
              </span>
              <button
                onClick={() => setIsMinimized(false)}
                className="text-xs font-semibold text-sky-400 hover:text-sky-300 transition-colors"
              >
                Xem chi tiết
              </button>
            </div>
          ) : status === 'error' ? (
            <div className="space-y-1">
              <p className="text-xs text-rose-300 truncate">{errorMessage || 'Có lỗi xảy ra'}</p>
              <button
                onClick={() => setIsMinimized(false)}
                className="text-xs font-medium text-rose-400 hover:text-rose-300 underline"
              >
                Mở lại để thử lại
              </button>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">Chưa bắt đầu đồng bộ.</p>
          )}
        </div>
      </div>
    );
  }

  // CHẾ ĐỘ MODAL ĐẦY ĐỦ (FULL DIALOG):
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-950 p-6 shadow-2xl space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-100">Đồng bộ Courses UIT (Moodle)</h3>
              <p className="text-xs text-slate-400">Thu thập môn học, thông tin giảng viên và bài tập theo thời gian thực</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsMinimized(true)}
              title="Thu nhỏ cửa sổ (tiếp tục làm việc trong lúc nạp)"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
            >
              <Minus className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              title="Đóng"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* State Banner */}
        {status === 'completed' ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-4 text-center space-y-2">
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400" />
            <div className="text-sm font-semibold text-emerald-300">Đồng bộ Moodle thành công!</div>
            <p className="text-xs text-slate-400">
              {syncedCount !== null
                ? `Đã cập nhật ${syncedCount} bản ghi môn học và tài liệu.`
                : 'Toàn bộ khóa học và bài tập đã được nạp vào SQLite theo thời gian thực.'}
            </p>
            <button
              onClick={onClose}
              className="mt-2 inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors"
            >
              Đóng và xem kết quả
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Primary Action: Launch In-App SSO */}
            <div className="rounded-xl border border-sky-500/20 bg-sky-950/10 p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-sky-400 uppercase tracking-wider">
                <Sparkles className="h-4 w-4" />
                <span>Phương thức tự động (Khuyên dùng)</span>
              </div>
              <p className="text-xs text-slate-300">
                Mở cửa sổ đăng nhập Moodle UIT. Hệ thống sẽ trích xuất môn học, bài giảng và bài tập đang diễn ra theo thời gian thực.
              </p>

              <button
                onClick={handleLaunchAutoSync}
                disabled={isListening}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50 transition-colors"
              >
                {isListening ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Đang thu thập dữ liệu Moodle...</span>
                  </>
                ) : (
                  <>
                    <ExternalLink className="h-4 w-4" />
                    <span>Mở cửa sổ đồng bộ Moodle UIT</span>
                  </>
                )}
              </button>
            </div>

            {/* Real-time Progress HUD */}
            {status === 'listening' && (
              <div className="rounded-xl border border-sky-500/20 bg-sky-950/20 p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-sky-300 truncate pr-2">
                    {progress?.course_name || 'Đang trích xuất dữ liệu Moodle...'}
                  </span>
                  <span className="font-mono font-semibold text-sky-400 shrink-0">
                    {progress ? `${Math.round(progress.percent)}%` : 'Đang xử lý...'}
                  </span>
                </div>
                {progress && (
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>Đã nạp: {progress.current}/{progress.total} môn học</span>
                    <span className="text-sky-400/80 font-medium">Cập nhật thời gian thực</span>
                  </div>
                )}
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-sky-500 transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, progress?.percent || 8))}%` }}
                  />
                </div>
                <div className="flex items-center justify-between pt-1">
                  <p className="text-[11px] text-slate-400">
                    💡 Bạn có thể bấm nút <b>Thu nhỏ (—)</b> góc trên để tiếp tục sử dụng ứng dụng.
                  </p>
                  <button
                    onClick={() => setIsMinimized(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-400 hover:text-sky-300 transition-colors shrink-0 ml-2"
                  >
                    <Minus className="h-3.5 w-3.5" />
                    <span>Thu nhỏ</span>
                  </button>
                </div>
              </div>
            )}

            {/* Error banner */}
            {errorMessage && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Collapsible Manual Section */}
            <div className="border-t border-slate-800 pt-3">
              <button
                onClick={() => setShowManualSection(!showManualSection)}
                className="flex items-center justify-between w-full text-xs text-slate-400 hover:text-slate-200 transition-colors py-1"
              >
                <span>Nhập dữ liệu JSON thủ công (Dành cho Developer)</span>
                {showManualSection ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>

              {showManualSection && (
                <div className="mt-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400 font-mono">Payload JSON (MoodleSyncPayload)</span>
                    <button
                      onClick={copyScriptSnippet}
                      className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 transition-colors"
                    >
                      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                      <span>{copied ? 'Đã copy script' : 'Copy script console'}</span>
                    </button>
                  </div>
                  <textarea
                    rows={4}
                    value={manualJson}
                    onChange={(e) => setManualJson(e.target.value)}
                    placeholder='{"courses": [...], "tasks": [...], "materials": [...] }'
                    className="w-full rounded-lg border border-slate-800 bg-slate-900 p-2.5 font-mono text-xs text-slate-200 placeholder-slate-600 focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    onClick={handleManualIngest}
                    disabled={!manualJson.trim()}
                    className="w-full rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40 transition-colors"
                  >
                    Nạp JSON vào SQLite
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SyncMoodleModal;
