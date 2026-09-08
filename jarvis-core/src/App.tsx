import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTodayStats, fetchLevelInfo, fetchRecentSubmissions } from "./lib/tauri-client";
import { useDiarkEvents } from "./hooks/useDiarkEvents";
import type { DailyStats, LevelInfo, SubmissionRecord, VerdictKind } from "./types";
import { classifyVerdict } from "./types";
import LevelProgressBar from "./components/LevelProgressBar";
import ActivityHeatmap from "./components/ActivityHeatmap";
import DevMockPanel from "./components/DevMockPanel";

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

export default function App() {
  // ============================================================
  // SINGLE SOURCE OF TRUTH: mọi state hiển thị dồn về đây, các
  // component con (LevelProgressBar...) chỉ nhận props, KHÔNG tự fetch.
  // ============================================================
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [levelInfo, setLevelInfo] = useState<LevelInfo | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Không còn setInterval - hook này hoàn toàn event-driven, chỉ đổi
  // syncVersion khi Rust worker thật sự emit "cf://sync-event".
  const { lastSync, syncVersion } = useDiarkEvents();

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

  // Refetch MỖI KHI syncVersion tăng - tức là mỗi khi Rust worker vừa insert
  // xong submission mới và emit event. Đây là điểm thay thế hoàn toàn cho
  // setInterval cũ: không polling mù quáng, chỉ refetch khi THẬT SỰ có gì mới.
  const isFirstSyncRender = useRef(true);
  useEffect(() => {
    if (isFirstSyncRender.current) {
      // syncVersion bắt đầu ở 0, effect này chạy 1 lần lúc mount do React
      // strict effect semantics - bỏ qua lần đầu vì refetchAll() ở effect
      // trên đã lo phần fetch ban đầu rồi, tránh gọi trùng 2 lần.
      isFirstSyncRender.current = false;
      return;
    }
    refetchAll();
  }, [syncVersion, refetchAll]);

  // Bắn toast mỗi khi có sync event mới - tách riêng khỏi refetchAll vì đây
  // là side-effect thuần UI (thông báo), không liên quan gì tới việc lấy data.
  useEffect(() => {
    if (!lastSync) return;

    const message = lastSync.first_ac_count > 0
      ? `🎉 First AC! +${lastSync.total_daily_xp} XP hôm nay (${lastSync.new_submissions_count} submission mới)`
      : `+${lastSync.new_submissions_count} submission mới, +${lastSync.total_daily_xp} XP hôm nay`;

    const toast: Toast = {
      id: ++toastIdCounter,
      message,
      isFirstAc: lastSync.first_ac_count > 0,
    };

    setToasts((prev) => [...prev, toast]);

    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== toast.id));
    }, 5000);

    return () => clearTimeout(timer);
  }, [lastSync]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <header className="mb-6">
        <h1 className="text-xl font-bold text-zinc-100">JARVIS Personal OS</h1>
        <p className="text-sm text-zinc-500">Diark Core Dashboard</p>
      </header>

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

        <div className="lg:col-span-1">
          {import.meta.env.DEV && <DevMockPanel />}
        </div>
      </div>

      <div className="mt-4">
        <ActivityHeatmap />
      </div>

      {/* --- Recent submissions --- */}
      <div className="mt-4 rounded-xl bg-zinc-900 border border-zinc-800 p-4">
        <h3 className="text-sm font-medium text-zinc-400 mb-3">Recent Submissions</h3>
        {submissions.length === 0 ? (
          <p className="text-sm text-zinc-600">Chưa có submission nào. Chờ worker sync hoặc seed mock data.</p>
        ) : (
          <div className="space-y-1.5">
            {submissions.map((sub) => {
              const tier = classifyVerdict(sub.verdict);
              return (
                <div
                  key={sub.id}
                  className="flex items-center justify-between text-sm py-1.5 px-2 rounded-lg hover:bg-zinc-800/50"
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
