import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Terminal,
  Award,
  CheckCircle2,
  Clock,
  RefreshCw,
  ExternalLink,
  Filter,
  Sparkles,
  AlertTriangle,
  Code2,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getWecodeSubmissions, launchWecodeSsoSync } from "../../lib/tauri-client";
import { WecodeSubmissionsList } from "./components/WecodeSubmissionsList";
import type { WecodeSubmission } from "../../types/wecode";

export const WecodeDashboard: React.FC = () => {
  const [submissions, setSubmissions] = useState<WecodeSubmission[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [selectedAssignment, setSelectedAssignment] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [partialErrors, setPartialErrors] = useState<string[]>([]);

  const fetchSubmissions = useCallback(async (assignmentId?: number | null) => {
    setIsLoading(true);
    try {
      const data = await getWecodeSubmissions(assignmentId ?? undefined);
      setSubmissions(data);
    } catch (err) {
      console.error("[WecodeDashboard] Lỗi tải submissions:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSubmissions(selectedAssignment);
  }, [fetchSubmissions, selectedAssignment]);

  useEffect(() => {
    let unlistenSync: UnlistenFn | undefined;
    let unlistenFail: UnlistenFn | undefined;
    let unlistenPartial: UnlistenFn | undefined;

    const setupListeners = async () => {
      unlistenSync = await listen("wecode-submissions-synced", () => {
        setIsSyncing(false);
        setSyncError(null);
        void fetchSubmissions(selectedAssignment);
      });

      unlistenFail = await listen<string>("wecode-sync-failed", (event) => {
        setIsSyncing(false);
        setSyncError(event.payload);
      });

      unlistenPartial = await listen<string[]>("wecode-sync-partial-errors", (event) => {
        setPartialErrors(event.payload);
      });
    };

    void setupListeners();

    return () => {
      if (unlistenSync) unlistenSync();
      if (unlistenFail) unlistenFail();
      if (unlistenPartial) unlistenPartial();
    };
  }, [fetchSubmissions, selectedAssignment]);

  const handleTriggerSync = async () => {
    setIsSyncing(true);
    setSyncError(null);
    setPartialErrors([]);
    try {
      await launchWecodeSsoSync();
    } catch (err) {
      setIsSyncing(false);
      setSyncError(typeof err === "string" ? err : "Không thể khởi chạy cửa sổ đồng bộ");
    }
  };

  // Distinct assignment IDs for filter
  const assignmentIds = useMemo(() => {
    const ids = Array.from(new Set(submissions.map((s) => s.assignment_id)));
    return ids.sort((a, b) => b - a);
  }, [submissions]);

  // Derived statistics
  const stats = useMemo(() => {
    const total = submissions.length;
    const acList = submissions.filter(
      (s) => s.score === 100 || s.verdict === "CORRECT ANSWER"
    );
    const totalAc = acList.length;
    const uniqueProblemsAc = new Set(acList.map((s) => s.problem_id)).size;
    const totalXp = totalAc * 15;
    const acRate = total > 0 ? Math.round((totalAc / total) * 100) : 0;

    return {
      total,
      totalAc,
      uniqueProblemsAc,
      totalXp,
      acRate,
    };
  }, [submissions]);

  return (
    <div className="space-y-4">
      {/* Top Banner & Control */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-800/50 text-emerald-400">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-zinc-100 font-mono">
                  UIT Wecode Tracker
                </h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-800 text-emerald-400 border border-zinc-700">
                  v1.0.0
                </span>
              </div>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">
                Thu thập và định lượng thành tích thực hành lập trình tại wecode.uit.edu.vn
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void fetchSubmissions(selectedAssignment)}
              disabled={isLoading}
              className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono text-xs flex items-center gap-1.5 transition-colors border border-zinc-700 disabled:opacity-50"
              title="Tải lại dữ liệu"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span>Làm mới</span>
            </button>

            <button
              onClick={handleTriggerSync}
              disabled={isSyncing}
              className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-mono text-xs font-semibold flex items-center gap-2 shadow-sm transition-all disabled:opacity-50"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>{isSyncing ? "Đang đồng bộ..." : "Đồng bộ Wecode"}</span>
            </button>
          </div>
        </div>

        {/* Sync Failure Banner */}
        {syncError && (
          <div className="mt-4 p-3 rounded-lg bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs font-mono flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Lỗi đồng bộ Wecode:</div>
              <div className="text-rose-400 mt-0.5">{syncError}</div>
            </div>
          </div>
        )}

        {/* Partial Parse Errors Banner */}
        {partialErrors.length > 0 && (
          <div className="mt-4 p-3 rounded-lg bg-amber-950/60 border border-amber-800/60 text-amber-300 text-xs font-mono flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Bỏ qua {partialErrors.length} bài nộp lỗi định dạng thời gian:
              </div>
              <ul className="list-disc list-inside text-amber-400/80 mt-1 space-y-0.5 text-[11px]">
                {partialErrors.slice(0, 3).map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
                {partialErrors.length > 3 && (
                  <li>...và {partialErrors.length - 3} bản ghi khác.</li>
                )}
              </ul>
            </div>
          </div>
        )}

        {/* Gamified Metrics Cards */}
        <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3 font-mono text-xs">
          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Bài AC (100đ)</span>
            </div>
            <div className="text-2xl font-bold text-white tracking-tight">
              {stats.totalAc}{" "}
              <span className="text-xs text-zinc-500 font-normal">
                ({stats.acRate}%)
              </span>
            </div>
            <span className="text-[11px] text-zinc-500">
              {stats.uniqueProblemsAc} bài tập duy nhất giải thành công
            </span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Award className="w-4 h-4 text-cyan-400" />
              <span>Wecode XP</span>
            </div>
            <div className="text-2xl font-bold text-cyan-400 tracking-tight flex items-center gap-1.5">
              +{stats.totalXp}
              <Sparkles className="w-4 h-4 text-cyan-400" />
            </div>
            <span className="text-[11px] text-zinc-500">
              15 XP / bài AC đầu tiên
            </span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Code2 className="w-4 h-4 text-amber-400" />
              <span>Tổng bài nộp</span>
            </div>
            <div className="text-2xl font-bold text-amber-400 tracking-tight">
              {stats.total}
            </div>
            <span className="text-[11px] text-zinc-500">
              Lưu trữ đầy đủ lịch sử chấm bài
            </span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Clock className="w-4 h-4 text-indigo-400" />
              <span>Đồng bộ tự động</span>
            </div>
            <div className="text-2xl font-bold text-indigo-300 tracking-tight">
              Loopback
            </div>
            <span className="text-[11px] text-zinc-500">
              Zero-Cookie SSO Navigation Hook
            </span>
          </div>
        </div>
      </div>

      {/* Assignment Filter Chips & Submissions List */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <div className="flex items-center gap-1.5 text-zinc-400 mr-1">
            <Filter className="w-3.5 h-3.5 text-zinc-500" />
            <span>Bộ lọc Assignment:</span>
          </div>

          <button
            onClick={() => setSelectedAssignment(null)}
            className={`px-3 py-1.5 rounded-lg border transition-colors ${
              selectedAssignment === null
                ? "bg-zinc-800 border-zinc-600 text-white font-semibold"
                : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Tất cả bài nộp
          </button>

          {assignmentIds.map((id) => (
            <button
              key={id}
              onClick={() => setSelectedAssignment(id)}
              className={`px-3 py-1.5 rounded-lg border transition-colors ${
                selectedAssignment === id
                  ? "bg-emerald-950/80 border-emerald-700 text-emerald-300 font-semibold"
                  : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Assignment #{id}
            </button>
          ))}
        </div>

        <WecodeSubmissionsList
          submissions={submissions}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
};

export default WecodeDashboard;
