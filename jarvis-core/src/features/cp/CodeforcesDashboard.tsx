import React from "react";
import CfSettingsPanel from "../../components/CfSettingsPanel";
import LevelProgressBar from "../../components/LevelProgressBar";
import ActivityHeatmap from "../../components/ActivityHeatmap";
import { classifyVerdict, type DailyStats, type LevelInfo, type SubmissionRecord } from "../../types";
import type { UserProfileDto, SyncCompletePayload } from "../../lib/tauri-client";

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
  onProfileUpdated,
  onResetIdentity,
  onSelectSubmission,
}) => {
  return (
    <div className="space-y-4">
      {/* Top row settings */}
      <div>
        <CfSettingsPanel
          onSyncComplete={onSyncComplete}
          userProfile={userProfile}
          onProfileUpdated={onProfileUpdated}
          onResetIdentity={onResetIdentity}
        />
      </div>

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
            Chưa có submission nào. Nhập CF handle và bấm &quot;Save &amp; Sync&quot; để bắt đầu.
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
