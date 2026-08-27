import { useEffect, useState } from "react";
import { fetchYearlyHeatmap } from "../lib/tauri-client";
import type { HeatmapDay, HeatmapTier } from "../types";

const TIER_COLOR: Record<HeatmapTier, string> = {
  rest: "bg-zinc-800",
  productive: "bg-emerald-600",
  god_mode: "bg-violet-500",
};

const TIER_LABEL: Record<HeatmapTier, string> = {
  rest: "Rest",
  productive: "Productive",
  god_mode: "God Mode",
};

/**
 * Chuyển mảng 365/366 ngày liên tục thành cấu trúc [tuần][thứ trong tuần]
 * để render dạng lưới kiểu GitHub contributions graph.
 * Padding ô rỗng ở đầu để ngày 1/1 rơi đúng cột theo thứ trong tuần (CN=0).
 */
function groupIntoWeeks(days: HeatmapDay[]): (HeatmapDay | null)[][] {
  if (days.length === 0) return [];

  const firstDate = new Date(days[0].date);
  const paddingCount = firstDate.getDay(); // 0 = Chủ nhật

  const padded: (HeatmapDay | null)[] = [
    ...Array(paddingCount).fill(null),
    ...days,
  ];

  const weeks: (HeatmapDay | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) {
    weeks.push(padded.slice(i, i + 7));
  }
  return weeks;
}

export default function ActivityHeatmap() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [days, setDays] = useState<HeatmapDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<HeatmapDay | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchYearlyHeatmap(year).then((data) => {
      if (!cancelled) {
        setDays(data);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [year]);

  const weeks = groupIntoWeeks(days);
  const totalXpThisYear = days.reduce((sum, d) => sum + d.total_xp, 0);

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-zinc-300">Activity Heatmap</h3>
          <p className="text-xs text-zinc-500 mt-0.5">{totalXpThisYear} XP trong năm {year}</p>
        </div>

        <div className="flex gap-1">
          {[currentYear - 1, currentYear].map((y) => (
            <button
              key={y}
              onClick={() => setYear(y)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                y === year
                  ? "bg-violet-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-24 flex items-center justify-center text-xs text-zinc-600">
          Đang tải...
        </div>
      ) : (
        <>
          <div className="flex gap-[3px] overflow-x-auto pb-2">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {week.map((day, di) =>
                  day ? (
                    <div
                      key={di}
                      onMouseEnter={() => setHovered(day)}
                      onMouseLeave={() => setHovered(null)}
                      className={`w-[11px] h-[11px] rounded-[2px] ${TIER_COLOR[day.tier]} hover:ring-1 hover:ring-white/50 cursor-pointer transition-all`}
                      title={`${day.date}: ${day.total_xp} XP`}
                    />
                  ) : (
                    <div key={di} className="w-[11px] h-[11px]" />
                  )
                )}
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              {(Object.keys(TIER_COLOR) as HeatmapTier[]).map((tier) => (
                <div key={tier} className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-[2px] ${TIER_COLOR[tier]}`} />
                  <span>{TIER_LABEL[tier]}</span>
                </div>
              ))}
            </div>

            {hovered && (
              <span className="text-xs text-zinc-400">
                {hovered.date} · {hovered.total_xp} XP · {hovered.ac_count} AC
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
