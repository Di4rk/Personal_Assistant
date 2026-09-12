import React, { useEffect, useState } from "react";
import LevelProgressBar from "../../components/LevelProgressBar";
import ActivityHeatmap from "../../components/ActivityHeatmap";
import { classifyVerdict, type DailyStats, type LevelInfo, type SubmissionRecord } from "../../types";
import {
  getCfHandle,
  triggerCfSync,
  type UserProfileDto,
  type SyncCompletePayload,
} from "../../lib/tauri-client";
import { Loader2 } from "lucide-react";

interface CodeforcesDashboardProps {
  stats?: DailyStats | null;
  levelInfo?: LevelInfo | null;
  submissions?: SubmissionRecord[];
  userProfile?: UserProfileDto;
  onSyncComplete?: (payload: SyncCompletePayload) => void;
  onProfileUpdated?: (profile: UserProfileDto) => void;
  onResetIdentity?: () => void;
  onSelectSubmission?: (sub: { problemId: string; problemName: string; verdict: string }) => void;
}

export const CodeforcesDashboard: React.FC<CodeforcesDashboardProps> = ({
  stats,
  levelInfo,
  submissions = [],
  userProfile,
  onSyncComplete,
  onSelectSubmission,
}) => {
  const [handle, setHandle] = useState<string>("");
  const [isLoadingHandle, setIsLoadingHandle] = useState<boolean>(true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncFeedback, setSyncFeedback] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchHandle = () => {
      getCfHandle()
        .then((saved) => {
          if (mounted) {
            setHandle(saved ?? "");
            setIsLoadingHandle(false);
          }
        })
        .catch((err) => {
          console.error("Lỗi lấy CF handle:", err);
          if (mounted) setIsLoadingHandle(false);
        });
    };

    fetchHandle();

    window.addEventListener("focus", fetchHandle);
    return () => {
      mounted = false;
      window.removeEventListener("focus", fetchHandle);
    };
  }, [userProfile]);

  const handleTriggerSync = async () => {
    if (!handle.trim() || isSyncing) return;
    setIsSyncing(true);
    setSyncFeedback(null);

    try {
      const result = await triggerCfSync();
      onSyncComplete?.(result);
      setSyncFeedback({
        success: result.success,
        message: result.success
          ? (result.new_submissions_count > 0
              ? `+${result.new_submissions_count} submission mới — ${result.message}`
              : result.message)
          : result.message,
      });
    } catch (err) {
      setSyncFeedback({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top row: Handle banner or Unlinked Empty State */}
      {!isLoadingHandle && !handle.trim() ? (
        <div className="flex flex-col items-center justify-center p-8 text-center rounded-xl border border-border bg-card/40">
          <p className="text-sm text-muted-foreground">Chưa liên kết tài khoản Codeforces.</p>
          <button
            type="button"
            onClick={() => {
              // Mở Settings Modal và chuyển sang tab Profile
              window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "profile" } }));
            }}
            className="mt-3 px-4 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            Thiết lập Handle trong Cài đặt
          </button>
        </div>
      ) : (
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 flex flex-col gap-3 font-mono shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <h3 className="text-sm font-semibold text-zinc-100">
                Codeforces Engine: <span className="text-cyan-400 font-bold">@{handle}</span>
              </h3>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "profile" } }));
                }}
                className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                Đổi Handle
              </button>
              <button
                type="button"
                onClick={() => void handleTriggerSync()}
                disabled={isSyncing}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-xs font-medium text-white transition-colors cursor-pointer disabled:opacity-50"
              >
                {isSyncing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Syncing…</span>
                  </>
                ) : (
                  <span>Đồng bộ ngay</span>
                )}
              </button>
            </div>
          </div>

          {syncFeedback && (
            <p className={`text-xs ${syncFeedback.success ? "text-emerald-400" : "text-red-400"}`}>
              {syncFeedback.success ? "✓" : "✕"} {syncFeedback.message}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* --- Stats card hôm nay --- */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <h3 className="text-sm font-medium text-zinc-400 mb-3 font-mono">Hôm nay</h3>
          {stats ? (
            <div className="grid grid-cols-2 gap-3 font-mono">
              <div className="rounded-lg bg-zinc-800/60 p-2.5">
                <span className="block text-[11px] text-zinc-500">XP</span>
                <span className="text-base font-bold text-cyan-400">{stats.total_xp}</span>
              </div>
              <div className="rounded-lg bg-zinc-800/60 p-2.5">
                <span className="block text-[11px] text-zinc-500">AC</span>
                <span className="text-base font-bold text-emerald-400">{stats.ac_count}</span>
              </div>
              <div className="rounded-lg bg-zinc-800/60 p-2.5">
                <span className="block text-[11px] text-zinc-500">WA</span>
                <span className="text-base font-bold text-red-400">{stats.wa_count}</span>
              </div>
              <div className="rounded-lg bg-zinc-800/60 p-2.5">
                <span className="block text-[11px] text-zinc-500">Khác</span>
                <span className="text-base font-bold text-zinc-400">{stats.other_count}</span>
              </div>
            </div>
          ) : (
            <div className="h-16 animate-pulse bg-zinc-800 rounded" />
          )}
        </div>

        <LevelProgressBar info={levelInfo ?? null} />

        <div className="lg:col-span-1 rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-4 flex flex-col justify-center">
          <div className="text-xs font-mono text-cyan-400 font-semibold mb-1">
            FIRST-PARTY ENGINE: CP-CODEFORCES
          </div>
          <p className="text-xs text-zinc-500 font-mono leading-relaxed">
            Hệ thống chấm bài trực tiếp, tính toán First-AC XP và ghi nhận sự kiện vào Activity Log SSOT.
          </p>
        </div>
      </div>

      <div>
        <ActivityHeatmap />
      </div>

      {/* --- Recent submissions --- */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
        <h3 className="text-sm font-medium text-zinc-400 mb-3 font-mono">Recent Submissions</h3>
        {submissions.length === 0 ? (
          <p className="text-sm text-zinc-600 font-mono">
            Chưa có submission nào. Bấm &quot;Đồng bộ ngay&quot; để tải các bài nộp gần đây.
          </p>
        ) : (
          <div className="space-y-1.5">
            {submissions.map((sub) => {
              const tier = classifyVerdict(sub.verdict);
              return (
                <div
                  key={sub.id}
                  className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-zinc-800/40 focus:outline-none focus:ring-2 focus:ring-violet-500 font-mono text-xs"
                  onClick={() => {
                    onSelectSubmission?.({
                      problemId: sub.problem_id,
                      problemName: sub.problem_name,
                      verdict: sub.verdict,
                    });
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        tier === "AC"
                          ? "text-emerald-400 bg-emerald-950/40"
                          : tier === "WA"
                          ? "text-red-400 bg-red-950/40"
                          : "text-zinc-400 bg-zinc-800"
                      }`}
                    >
                      {sub.verdict}
                    </span>
                    <span className="text-zinc-200">{sub.problem_id}</span>
                    <span className="text-zinc-500 hidden sm:inline">- {sub.problem_name}</span>
                  </div>
                  <span className="text-[11px] text-zinc-500">{sub.submitted_at.slice(0, 10)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default CodeforcesDashboard;
