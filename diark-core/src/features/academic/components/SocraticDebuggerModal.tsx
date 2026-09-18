import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Sparkles,
  Cpu,
  Clock,
  ShieldAlert,
  FileCode2,
  Send,
  CheckCircle2,
  RefreshCw,
  X,
  Key,
  BookMarked,
  HelpCircle,
  Bug,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  getGeminiConfig,
  triggerSocraticDebug,
  savePostMortem,
  GeminiStreamChunk,
  SocraticDebugRequest,
} from '../../../lib/tauri-client';
import type { WecodeSubmission } from '../../../types/wecode';
import { useSettingsStore } from '../../../stores/useSettingsStore';

interface SocraticDebuggerModalProps {
  isOpen: boolean;
  onClose: () => void;
  submission: WecodeSubmission | null;
}

export const SocraticDebuggerModal: React.FC<SocraticDebuggerModalProps> = ({
  isOpen,
  onClose,
  submission,
}) => {
  const [streamText, setStreamText] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean>(true);
  const [activeModel, setActiveModel] = useState<string>('gemini-1.5-flash');
  const [userQuery, setUserQuery] = useState<string>('');
  const [showCode, setShowCode] = useState<boolean>(false);
  const [isSavingPostMortem, setIsSavingPostMortem] = useState<boolean>(false);
  const [postMortemSaved, setPostMortemSaved] = useState<boolean>(false);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const currentSessionIdRef = useRef<string>('');
  const streamBottomRef = useRef<HTMLDivElement | null>(null);

  // Cuộn xuống đáy mượt mà khi nhận stream chunks
  useEffect(() => {
    if (isStreaming && streamBottomRef.current) {
      streamBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamText, isStreaming]);

  // Kiểm tra API Key khi mở Modal
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    getGeminiConfig()
      .then((cfg) => {
        if (!isMounted) return;
        if (cfg.model) setActiveModel(cfg.model);
        if (!cfg.api_key || cfg.api_key.trim() === '') {
          setHasApiKey(false);
          setStreamError('Chưa cấu hình Gemini API Key. Vui lòng thêm API Key để sử dụng.');
        } else {
          setHasApiKey(true);
          setStreamError(null);
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('[SocraticDebugger] Lỗi đọc config:', err);
      });

    return () => {
      isMounted = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [isOpen]);

  const cleanupListener = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }, []);

  const handleStartAnalysis = useCallback(
    async (customQuery?: string) => {
      if (!submission) return;

      cleanupListener();
      setIsStreaming(true);
      setStreamError(null);
      setPostMortemSaved(false);

      if (!customQuery) {
        setStreamText('');
      } else {
        setStreamText((prev) => prev + `\n\n---\n**Hỏi tiếp:** ${customQuery}\n\n`);
      }

      const sessionId = `socratic_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      currentSessionIdRef.current = sessionId;

      try {
        const unlisten = await listen<GeminiStreamChunk>(
          `gemini-stream-${sessionId}`,
          (event) => {
            const payload = event.payload;
            if (payload.session_id !== currentSessionIdRef.current) return;

            if (payload.chunk) {
              setStreamText((prev) => prev + payload.chunk);
            }

            if (payload.error) {
              setStreamError(payload.error);
              setIsStreaming(false);
            }

            if (payload.is_done) {
              setIsStreaming(false);
              cleanupListener();
            }
          }
        );

        unlistenRef.current = unlisten;

        const req: SocraticDebugRequest = {
          session_id: sessionId,
          problem_name: submission.problem_name || `Bài #${submission.problem_id}`,
          problem_id: submission.problem_id,
          verdict: submission.verdict || 'WRONG ANSWER',
          score: submission.score,
          execution_time: submission.execution_time,
          memory_kib: submission.memory_kib,
          language: submission.language || 'C++',
          code_snippet: submission.code || null,
          user_query: customQuery ? customQuery : null,
        };

        await triggerSocraticDebug(req);
      } catch (err) {
        console.error('[SocraticDebugger] Trigger error:', err);
        const errMsg = typeof err === 'string' ? err : 'Lỗi kết nối tới Gemini API.';
        setStreamError(errMsg);
        setIsStreaming(false);
        cleanupListener();
      }
    },
    [submission, cleanupListener]
  );

  // Tự động phân tích khi vừa mở modal và có bài nộp
  useEffect(() => {
    if (isOpen && submission && hasApiKey && !isStreaming && streamText === '') {
      handleStartAnalysis();
    }
  }, [isOpen, submission, hasApiKey]);

  const handleSendFollowUp = (e: React.FormEvent) => {
    e.preventDefault();
    const query = userQuery.trim();
    if (!query || isStreaming) return;
    setUserQuery('');
    handleStartAnalysis(query);
  };

  const handleSaveToPostMortem = async () => {
    if (!submission || isSavingPostMortem) return;
    setIsSavingPostMortem(true);

    try {
      const probId = String(submission.problem_id || submission.submission_id);
      const probName = submission.problem_name || `Problem #${submission.problem_id}`;

      // Rút trích ngắn gọn insight từ kết quả AI
      const keyInsight = streamText.slice(0, 400).trim() || 'Socratic debugging session';

      await savePostMortem({
        problem_id: probId,
        problem_name: probName,
        platform: 'wecode',
        root_cause: submission.verdict?.includes('TIME') ? 'TIME_COMPLEXITY' : 'CORNER_CASE',
        key_insight: `[Socratic Coach] ${keyInsight}`,
        tags: 'wecode,socratic,ai-copilot',
      });

      setPostMortemSaved(true);
      setTimeout(() => setPostMortemSaved(false), 3500);
    } catch (err) {
      console.error('[SocraticDebugger] Lưu Post-Mortem thất bại:', err);
    } finally {
      setIsSavingPostMortem(false);
    }
  };

  const handleOpenSettings = () => {
    useSettingsStore.getState().openSettings('copilot');
  };

  if (!isOpen || !submission) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-3xl rounded-xl border border-zinc-800 bg-zinc-950 p-5 sm:p-6 shadow-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/25">
              <Sparkles className="h-5 w-5 animate-pulse" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">Socratic Debugger</h2>
                <span className="rounded-md bg-indigo-950/80 px-2 py-0.5 text-[11px] font-mono text-indigo-400 border border-indigo-800/60">
                  {activeModel}
                </span>
                <span className="rounded-md bg-amber-950/70 px-2 py-0.5 text-[11px] font-mono text-amber-300 border border-amber-800/60">
                  No Spoiler Policy
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Huấn luyện viên thuật toán: Khám phá test case biên và câu hỏi phản biện, tự mình chinh phục AC.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer"
            aria-label="Đóng modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Problem Context Banner */}
        <div className="my-3.5 rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3 flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-zinc-200">
              {submission.problem_name || `Problem #${submission.problem_id}`}
            </span>
            <span className="text-zinc-500">#{submission.submission_id}</span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold bg-rose-950/90 text-rose-400 border border-rose-800/70">
              <ShieldAlert className="w-3 h-3" />
              {submission.verdict || 'WRONG ANSWER'} ({submission.score}đ)
            </span>
          </div>

          <div className="flex items-center gap-3 text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-zinc-500" />
              {submission.execution_time.toFixed(2)}s
            </span>
            <span className="inline-flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5 text-zinc-500" />
              {submission.memory_kib} KiB
            </span>
            <span className="inline-flex items-center gap-1">
              <FileCode2 className="w-3.5 h-3.5 text-zinc-500" />
              {submission.language}
            </span>
            {submission.code && (
              <button
                type="button"
                onClick={() => setShowCode((v) => !v)}
                className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer underline"
              >
                {showCode ? 'Ẩn mã' : 'Xem mã'}
                {showCode ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
            )}
          </div>
        </div>

        {/* Collapsible Source Code Preview */}
        {showCode && submission.code && (
          <div className="mb-3 max-h-40 overflow-y-auto rounded-lg border border-zinc-800 bg-black/60 p-3 font-mono text-[11px] text-zinc-300">
            <pre className="whitespace-pre-wrap">{submission.code}</pre>
          </div>
        )}

        {/* Missing API Key Warning */}
        {!hasApiKey && (
          <div className="mb-4 rounded-lg border border-amber-600/30 bg-amber-950/30 p-3.5 text-xs text-amber-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Key className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Bạn chưa cấu hình Gemini API Key cá nhân. Hãy thêm API Key (hoàn toàn miễn phí) để bật Copilot.
              </span>
            </div>
            <button
              type="button"
              onClick={handleOpenSettings}
              className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold text-xs whitespace-nowrap cursor-pointer transition-colors"
            >
              Cấu hình BYOK
            </button>
          </div>
        )}

        {/* AI Stream Content Box */}
        <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 font-mono text-xs text-zinc-200 space-y-3 min-h-[220px]">
          {streamText === '' && isStreaming && (
            <div className="flex items-center gap-2 text-zinc-400 py-8 justify-center">
              <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
              <span>Gemini đang phân tích mã nguồn và thiết lập bộ test case biên...</span>
            </div>
          )}

          {streamText !== '' && (
            <div className="whitespace-pre-wrap leading-relaxed space-y-2">
              {streamText}
            </div>
          )}

          {isStreaming && (
            <span className="inline-block w-2 h-3.5 bg-indigo-400 animate-pulse align-middle ml-1" />
          )}

          {streamError && (
            <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 p-3 text-rose-300">
              <div className="flex items-center gap-2 font-semibold">
                <Bug className="w-4 h-4 text-rose-400" />
                <span>Lỗi phân tích:</span>
              </div>
              <p className="mt-1 text-[11px]">{streamError}</p>
            </div>
          )}

          <div ref={streamBottomRef} />
        </div>

        {/* Follow-up Question Input */}
        <form onSubmit={handleSendFollowUp} className="mt-3.5 flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder="Hỏi thêm huấn luyện viên Socratic (VD: 'Giải thích vì sao N=1 bị lỗi', 'Gợi ý cấu trúc dữ liệu')..."
              disabled={isStreaming || !hasApiKey}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2 text-xs text-zinc-200 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={isStreaming || !hasApiKey || !userQuery.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            {isStreaming ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
            <span>Hỏi</span>
          </button>
        </form>

        {/* Footer Actions */}
        <div className="mt-3.5 flex items-center justify-between border-t border-zinc-800 pt-3 text-xs">
          <div className="flex items-center gap-2 text-zinc-400">
            <HelpCircle className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-[11px]">Nguyên lý Socratic: AI định hướng tư duy, học viên viết mã.</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleStartAnalysis()}
              disabled={isStreaming || !hasApiKey}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isStreaming ? 'animate-spin' : ''}`} />
              <span>Phân tích lại</span>
            </button>

            <button
              type="button"
              onClick={handleSaveToPostMortem}
              disabled={isSavingPostMortem || streamText.trim() === ''}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg font-semibold transition-colors cursor-pointer ${
                postMortemSaved
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700'
              } disabled:opacity-50`}
            >
              {postMortemSaved ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Đã lưu vào Post-Mortem!</span>
                </>
              ) : (
                <>
                  <BookMarked className="w-3.5 h-3.5 text-amber-400" />
                  <span>Lưu vào Post-Mortem</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
