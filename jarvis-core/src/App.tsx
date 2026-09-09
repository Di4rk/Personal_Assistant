import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTodayStats, fetchLevelInfo, fetchRecentSubmissions } from "./lib/tauri-client";
import type { SyncCompletePayload } from "./lib/tauri-client";
import { useTauriEvent } from "./hooks/useTauriEvent";
import type { DailyStats, LevelInfo, SubmissionRecord, VerdictKind } from "./types";
import { classifyVerdict } from "./types";
import LevelProgressBar from "./components/LevelProgressBar";
import ActivityHeatmap from "./components/ActivityHeatmap";
import CfSettingsPanel from "./components/CfSettingsPanel";
import PostMortemModal from "./components/PostMortemModal";

const VERDICT_STYLE: Record<VerdictKind, string> = {
  AC: "text-emerald-400 bg-emerald-950/40",
  WA: "text-red-400 bg-red-950/40",
  TLE: "text-amber-400 bg-amber-950/40",
  RE: "text-orange-400 bg-orange-950/40",
  OTHER: "text-zinc-400 bg-zinc-800",
};

interface Toast {
  id: number;
  message: string;
  isFirstAc: boolean;
}

let toastIdCounter = 0;

import { AcademicDashboard } from "./features/academic";
import { Code2, GraduationCap } from "lucide-react";

export default function App() {
  const [activeTab, setActiveTab] = useState<"cp" | "academic">("academic");

  // ============================================================
  // SINGLE SOURCE OF TRUTH: mọi state hiển thị dồn về đây, các
  // component con (LevelProgressBar...) chỉ nhận props, KHÔNG tự fetch.
  // ============================================================
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [levelInfo, setLevelInfo] = useState<LevelInfo | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedSubmission, setSelectedSubmission] = useState<{
    problemId: string;
    problemName: string;
    verdict: string;
  } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const refetchAll = useCallback(async () => {
    const [statsData, levelData, submissionsData] = await Promise.all([
      fetchTodayStats(),
      fetchLevelInfo(),
      fetchRecentSubmissions(20),
    ]);
    setStats(statsData);
    setLevelInfo(levelData);
    setSubmissions(submissionsData);
  }, []);

  // Fetch 1 lần duy nhất lúc mount - nguồn dữ liệu ban đầu khi app vừa mở,
  // trước khi có bất kỳ sync event nào xảy ra.
  useEffect(() => {
    refetchAll();
  }, [refetchAll]);

  // ============================================================
  // Event-driven refresh: lắng nghe cả 2 event channel từ Rust worker.
  // - "cf-sync-complete" → payload đầy đủ, dùng cho toast + refetch
  // - "cf://sync-event"  → legacy channel, refetch only (backward compat)
  // useTauriEvent tự cleanup khi unmount, safe với React 18 StrictMode.
  // ============================================================

  // Flag để bỏ qua lần chạy đầu tiên của handler (tương đương isFirstSyncRender cũ).
  const initialRender = useRef(true);

  const handleSyncComplete = useCallback(
    (payload: SyncCompletePayload) => {
      if (initialRender.current) {
        // React StrictMode có thể fire listener ngay sau mount do pending events.
        // Bỏ qua lần đầu nếu payload trống (new_submissions_count === 0).
        if (payload.new_submissions_count === 0) return;
      }
      initialRender.current = false;

      // Refetch data mỗi khi có sync mới (dù có submission mới hay không,
      // để đảm bảo heatmap và level bar luôn up-to-date sau IPC trigger).
      refetchAll();

      // Chỉ bắn toast khi có data mới thực sự
      if (payload.new_submissions_count > 0) {
        const message = `+${payload.new_submissions_count} submission mới, +${payload.new_submissions_count} XP hôm nay`;
        const toast: Toast = {
          id: ++toastIdCounter,
          message,
          isFirstAc: false, // full_ac_count not in SyncCompletePayload; use SyncResult event for that
        };
        setToasts((prev) => [...prev, toast]);
        const timer = setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toast.id));
        }, 5000);
        // Note: timer is intentionally not cleared here because toast cleanup
        // is keyed by ID and the component stays mounted for the app lifetime.
        void timer;
      }
    },
    [refetchAll]
  );

  // SyncResult from worker carries first_ac_count — use for rich toast.
  const handleLegacySync = useCallback(
    (payload: { new_submissions_count: number; total_daily_xp: number; first_ac_count: number }) => {
      if (payload.new_submissions_count === 0) return;

      refetchAll();

      const message =
        payload.first_ac_count > 0
          ? `🎉 First AC! +${payload.total_daily_xp} XP hôm nay (${payload.new_submissions_count} submission mới)`
          : `+${payload.new_submissions_count} submission mới, +${payload.total_daily_xp} XP hôm nay`;

      const toast: Toast = {
        id: ++toastIdCounter,
        message,
        isFirstAc: payload.first_ac_count > 0,
      };
      setToasts((prev) => [...prev, toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 5000);
    },
    [refetchAll]
  );

  useTauriEvent<SyncCompletePayload>("cf-sync-complete", handleSyncComplete);
  useTauriEvent<{
    new_submissions_count: number;
    total_daily_xp: number;
    first_ac_count: number;
  }>("cf://sync-event", handleLegacySync);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-6 flex-wrap">
            <div>
              <h1 className="text-xl font-bold text-zinc-100">JARVIS Personal OS</h1>
              <p className="text-sm text-zinc-500">Diark Core Dashboard</p>
            </div>

            {/* Navigation Tabs */}
            <nav className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-1 text-xs">
              <button
                onClick={() => setActiveTab("academic")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${
                  activeTab === "academic"
                    ? "bg-violet-600 text-white shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <GraduationCap className="w-3.5 h-3.5" />
                <span>Academic Radar</span>
              </button>
              <button
                onClick={() => setActiveTab("cp")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${
                  activeTab === "cp"
                    ? "bg-violet-600 text-white shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>Codeforces &amp; ICPC</span>
              </button>
            </nav>
          </div>

          {activeTab === "cp" && (
            <div className="w-full sm:w-80">
              <CfSettingsPanel onSyncComplete={handleSyncComplete} />
            </div>
          )}
        </div>
      </header>

      {activeTab === "academic" ? (
        <AcademicDashboard />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* --- Stats card hôm nay --- */}
            <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
              <h3 className="text-sm font-medium text-zinc-400 mb-3">Hôm nay</h3>
              {stats ? (
                <div className="grid grid-cols-2 gap-3">
                  <StatBox label="XP" value={stats.total_xp} accent="text-violet-400" />
                  <StatBox label="AC" value={stats.ac_count} accent="text-emerald-400" />
                  <StatBox label="WA" value={stats.wa_count} accent="text-red-400" />
                  <StatBox label="Khác" value={stats.other_count} accent="text-zinc-400" />
                </div>
              ) : (
                <div className="h-16 animate-pulse bg-zinc-800 rounded" />
              )}
            </div>

            <LevelProgressBar info={levelInfo} />

            {/* Third column intentionally left for future widgets */}
            <div className="lg:col-span-1" />
          </div>

          <div className="mt-4">
            <ActivityHeatmap />
          </div>

      {/* --- Recent submissions --- */}
      <div className="mt-4 rounded-xl bg-zinc-900 border border-zinc-800 p-4">
        <h3 className="text-sm font-medium text-zinc-400 mb-3">Recent Submissions</h3>
        {submissions.length === 0 ? (
          <p className="text-sm text-zinc-600">
            Chưa có submission nào. Nhập CF handle và bấm &quot;Save &amp; Sync&quot; để bắt đầu.
          </p>
        ) : (
          <div className="space-y-1.5">
            {submissions.map((sub) => {
              const tier = classifyVerdict(sub.verdict);
              return (
                <div
                  key={sub.id}
                  className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-zinc-800/40 focus:outline-none focus:ring-2 focus:ring-violet-500"
                  onClick={() => {
                    setSelectedSubmission({
                      problemId: sub.problem_id,
                      problemName: sub.problem_name,
                      verdict: sub.verdict,
                    });
                    setIsModalOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedSubmission({
                        problemId: sub.problem_id,
                        problemName: sub.problem_name,
                        verdict: sub.verdict,
                      });
                      setIsModalOpen(true);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium shrink-0 ${VERDICT_STYLE[tier]}`}>
                      {sub.verdict}
                    </span>
                    <span className="text-zinc-300 truncate">{sub.problem_name}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-zinc-600 text-xs">{sub.language ?? "?"}</span>
                    <span className="text-violet-400 text-xs font-medium">+{sub.xp_awarded} XP</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}

      <PostMortemModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        submission={selectedSubmission}
      />

      {/* --- Toast notifications --- */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-in slide-in-from-bottom-2 ${
              toast.isFirstAc
                ? "bg-violet-600 text-white"
                : "bg-zinc-800 text-zinc-200 border border-zinc-700"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatBox({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div>
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}
