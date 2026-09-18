import React, { useCallback, useState } from 'react';
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
} from 'lucide-react';

export interface SyncMoodleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSyncSuccess?: () => void;
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

  const handleSyncComplete = useCallback(() => {
    setStatus('completed');
    setIsListening(false);
    if (onSyncSuccess) {
      onSyncSuccess();
    }
  }, [onSyncSuccess]);

  useTauriEvent('moodle-data-synced', handleSyncComplete);
  useTauriEvent<string>('sso-callback-success', (target) => {
    if (target === 'moodle') {
      handleSyncComplete();
    }
  });

  if (!isOpen) return null;

  const handleLaunchAutoSync = async () => {
    setErrorMessage(null);
    setStatus('listening');
    setIsListening(true);
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
              <p className="text-xs text-slate-400">Thu thập môn học, thông tin giảng viên và tài liệu slide</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-900 hover:text-slate-300 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* State Banner */}
        {status === 'completed' ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-4 text-center space-y-2">
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400" />
            <div className="text-sm font-semibold text-emerald-300">Đồng bộ Moodle thành công!</div>
            <p className="text-xs text-slate-400">
              {syncedCount !== null
                ? `Đã cập nhật ${syncedCount} bản ghi môn học và tài liệu.`
                : 'Toàn bộ khóa học và bài tập đã được nạp vào SQLite.'}
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
                Mở cửa sổ đăng nhập Moodle UIT. Hệ thống sẽ tự động trích xuất các môn học, bài giảng và bài tập đang diễn ra.
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
