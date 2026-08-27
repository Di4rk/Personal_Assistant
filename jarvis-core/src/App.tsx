import { useEffect, useState } from "react";
import {
  fetchTodayStats,
  fetchRecentSubmissions,
  fetchLevelInfo,
  fetchYearlyHeatmap,
  devSeedMockData,
  devClearMockData,
} from "./lib/tauri-client";
import type {
  DailyStats,
  SubmissionRecord,
  LevelInfo,
  HeatmapDay,
} from "./types";

export default function App() {
  const [stats, setStats] = useState<DailyStats>({
    date: "",
    total_xp: 0,
    ac_count: 0,
    wa_count: 0,
    other_count: 0,
  });
  const [levelInfo, setLevelInfo] = useState<LevelInfo | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapDay[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const currentYear = new Date().getFullYear();

  const formatDateDMY = (dateStr: string) => {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
};

  const [hoveredDay, setHoveredDay] = useState<{
    data: any;
    x: number;
    y: number;
  } | null>(null);
  // Load toàn bộ data từ backend SQLite
  const loadAllData = async () => {
    try {
      const [todayStats, subs, lvl, hm] = await Promise.all([
        fetchTodayStats(),
        fetchRecentSubmissions(20),
        fetchLevelInfo(),
        fetchYearlyHeatmap(currentYear),
      ]);
      setStats(todayStats);
      setSubmissions(subs);
      setLevelInfo(lvl);
      setHeatmap(hm);
    } catch (err) {
      console.error("Lỗi tải dữ liệu:", err);
    }
  };

  useEffect(() => {
    loadAllData();
    // Tự động poll cập nhật mỗi 5 giây
    const interval = setInterval(loadAllData, 5000);
    return () => clearInterval(interval);
  }, []);

  // Xử lý tạo mock data
  const handleSeedMock = async () => {
    setLoading(true);
    setMessage("");
    const count = await devSeedMockData(90);
    setMessage(`Đã nạp thành công ${count} submission mẫu!`);
    await loadAllData();
    setLoading(false);
  };

  // Xử lý xóa mock data
  const handleClearMock = async () => {
    setLoading(true);
    setMessage("");
    const count = await devClearMockData();
    setMessage(`Đã dọn sạch ${count} submission mẫu!`);
    await loadAllData();
    setLoading(false);
  };

  // Hàm chọn màu theo verdict
  const getVerdictBadge = (verdict: string) => {
    switch (verdict) {
      case "OK":
        return <span className="text-emerald-400 font-semibold">Accepted (AC)</span>;
      case "WRONG_ANSWER":
        return <span className="text-rose-400">Wrong Answer (WA)</span>;
      case "TIME_LIMIT_EXCEEDED":
        return <span className="text-amber-400">Time Limit (TLE)</span>;
      default:
        return <span className="text-zinc-400">{verdict}</span>;
    }
  };

  // Hàm tính màu cho ô Heatmap
  const getHeatmapColor = (xp?: number) => {
  const safeXp = Number(xp) || 0;

  if (safeXp === 0) return "bg-zinc-900 border border-zinc-800/60";
  if (safeXp < 30) return "bg-emerald-950/80 border border-emerald-800/40";
  if (safeXp < 60) return "bg-emerald-600 shadow-[0_0_6px_rgba(16,185,129,0.3)]";
  if (safeXp < 100) return "bg-violet-600 shadow-[0_0_8px_rgba(139,92,246,0.4)]";
  return "bg-fuchsia-400 shadow-[0_0_12px_rgba(232,121,249,0.8)] border border-white/50";
};

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 font-sans">
      <div className="max-w-5xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div>
            <p className="text-xs font-semibold tracking-wider text-violet-400 uppercase">
              Diark Core v0.1
            </p>
            <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
              Codeforces Observer & Gamification
            </h1>
          </div>
          
          {/* Dev Mock Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSeedMock}
              disabled={loading}
              className="px-3 py-1.5 text-xs font-medium bg-violet-600/20 text-violet-300 border border-violet-500/30 rounded-md hover:bg-violet-600/30 transition disabled:opacity-50"
            >
              Seed Mock Data
            </button>
            <button
              onClick={handleClearMock}
              disabled={loading}
              className="px-3 py-1.5 text-xs font-medium bg-rose-950/40 text-rose-300 border border-rose-800/40 rounded-md hover:bg-rose-900/40 transition disabled:opacity-50"
            >
              Clear Mock
            </button>
          </div>
        </div>

        {/* Thông báo thao tác */}
        {message && (
          <div className="p-3 bg-violet-950/40 border border-violet-800/50 rounded-lg text-sm text-violet-300">
            {message}
          </div>
        )}

        {/* Level Progress Bar */}
        {levelInfo && (
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-600 font-black text-white text-sm">
                  Lv.{levelInfo.level}
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-200">
                    Chỉ số Cày cấp
                  </h3>
                  <p className="text-xs text-zinc-400">
                    Tổng tích lũy: <span className="text-violet-400 font-medium">{levelInfo.total_xp} XP</span>
                  </p>
                </div>
              </div>
              <div className="text-right">
                <span className="text-xs font-medium text-zinc-400">
                  {levelInfo.xp_in_level ?? levelInfo.current_level_xp ?? 0} / {levelInfo.xp_to_next ?? levelInfo.next_level_xp ?? 100} XP ({levelInfo.progress_pct ?? 0}%)
                </span>
              </div>
            </div>
            
            {/* Progress Bar */}
            <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden">
              <div
                className="bg-violet-500 h-2.5 rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(139,92,246,0.5)]"
                style={{ width: `${levelInfo.progress_pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Stats Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5">
            <p className="text-xs font-medium text-zinc-400">XP Today</p>
            <p className="text-3xl font-extrabold text-violet-400 mt-2">
              +{stats.total_xp}
            </p>
            <p className="text-xs text-zinc-500 mt-1">+20 XP cho mỗi First AC</p>
          </div>

          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5">
            <p className="text-xs font-medium text-zinc-400">Accepted Today</p>
            <p className="text-3xl font-extrabold text-emerald-400 mt-2">
              {stats.ac_count}
            </p>
            <p className="text-xs text-zinc-500 mt-1">Bài nộp đạt AC hôm nay</p>
          </div>

          <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5">
            <p className="text-xs font-medium text-zinc-400">Wrong / Others</p>
            <p className="text-3xl font-extrabold text-rose-400 mt-2">
              {stats.wa_count + stats.other_count}
            </p>
            <p className="text-xs text-zinc-500 mt-1">WA, TLE, MLE, CE</p>
          </div>
        </div>

        {/* Activity Heatmap Grid chuẩn GitHub (7 hàng dọc x 52+ cột ngang) */}
<div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5 space-y-3">
  <div className="flex items-center justify-between">
    <h3 className="text-sm font-semibold text-zinc-200">
      Activity Heatmap ({currentYear})
    </h3>
    <div className="flex items-center gap-1.5 text-xs text-zinc-400">
      <span>Nghỉ</span>
      <div className="w-2.5 h-2.5 rounded-sm bg-zinc-900 border border-zinc-800" />
      <div className="w-2.5 h-2.5 rounded-sm bg-emerald-950 border border-emerald-800" />
      <div className="w-2.5 h-2.5 rounded-sm bg-emerald-600" />
      <div className="w-2.5 h-2.5 rounded-sm bg-violet-600" />
      <div className="w-2.5 h-2.5 rounded-sm bg-fuchsia-400" />
      <span>God Mode</span>
    </div>
  </div>

          {/* Container cuộn ngang chuẩn */}
    <div className="overflow-x-auto pb-2">
      <div className="grid grid-flow-col grid-rows-7 gap-1.5 w-max py-2">
        {heatmap.map((day: any) => {
          const xpValue = (day as any).total_xp ?? day.xp ?? 0;
          return (
            <div
              key={day.date}
              onMouseEnter={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setHoveredDay({
                  data: day,
                  x: rect.left + rect.width / 2,
                  y: rect.top,
                });
              }}
              onMouseLeave={() => setHoveredDay(null)}
              className={`w-3 h-3 rounded-[3px] ${getHeatmapColor(xpValue)} transition-all hover:scale-125 cursor-pointer`}
            />
          );
        })}
      </div>
    </div>
  </div>

        {/* Recent Submissions Table */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-200">
            Recent Submissions (SQLite Cache)
          </h3>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800 text-zinc-400 uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-3">Problem</th>
                  <th className="py-2.5 px-3">Verdict</th>
                  <th className="py-2.5 px-3">Language</th>
                  <th className="py-2.5 px-3">First AC</th>
                  <th className="py-2.5 px-3">Submitted At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {submissions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-zinc-500">
                      Chưa có dữ liệu bài nộp. Bấm "Seed Mock Data" ở góc phải để nạp dữ liệu test!
                    </td>
                  </tr>
                ) : (
                  submissions.map((sub) => (
                    <tr key={sub.id} className="hover:bg-zinc-800/30 transition">
                      <td className="py-2.5 px-3 font-medium text-zinc-200">
                        {sub.problem_name} ({sub.problem_id})
                      </td>
                      <td className="py-2.5 px-3">
                        {getVerdictBadge(sub.verdict)}
                      </td>
                      <td className="py-2.5 px-3 text-zinc-400">{sub.language}</td>
                      <td className="py-2.5 px-3">
                        {sub.is_first_ac ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800">
                            +20 XP
                          </span>
                        ) : (
                          <span className="text-zinc-600">-</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-zinc-400">
                        {new Date(sub.submitted_at).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>{/* Global Fixed Neon Tooltip - Tự do bay đè lên mọi khung viền */}
      {hoveredDay && (
        <div
          style={{
            left: `${hoveredDay.x}px`,
            top: `${hoveredDay.y - 8}px`,
            transform: "translate(-50%, -100%)",
          }}
          className="fixed flex flex-col gap-1.5 w-44 p-2.5 bg-zinc-950/95 border border-violet-500/70 rounded-lg shadow-[0_0_25px_rgba(139,92,246,0.45)] backdrop-blur-md z-[9999] pointer-events-none text-[11px]"
        >
          {/* Header ngày */}
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-1">
            <span className="font-mono text-zinc-400">
              📅 {formatDateDMY(hoveredDay.data.date)}
            </span>
            <span className="font-bold text-violet-400">
              +{hoveredDay.data.total_xp ?? hoveredDay.data.xp ?? 0} XP
            </span>
          </div>

          {/* Thống kê AC & Lỗi */}
          <div className="space-y-1 pt-0.5 font-sans">
            <div className="flex items-center justify-between text-emerald-400">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                Accepted (AC)
              </span>
              <span className="font-bold font-mono">
                {hoveredDay.data.ac_count ?? hoveredDay.data.accepted_count ?? 0}
              </span>
            </div>

            <div className="flex items-center justify-between text-rose-400">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400 inline-block shadow-[0_0_6px_rgba(251,113,133,0.8)]" />
                Lỗi / Khác
              </span>
              <span className="font-bold font-mono">
                {Math.max(
                  0,
                  (hoveredDay.data.submission_count ?? 0) -
                    (hoveredDay.data.ac_count ?? hoveredDay.data.accepted_count ?? 0)
                )}
              </span>
            </div>
          </div>

          {/* Mũi tên nhọn phía dưới */}
          <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-2 h-2 bg-zinc-950 border-r border-b border-violet-500/70 rotate-45" />
        </div>
      )}
    </div>
  );
}