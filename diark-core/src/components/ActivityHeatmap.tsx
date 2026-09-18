import { useEffect, useState } from "react";
import { fetchYearlyHeatmap } from "../lib/tauri-client";
import type { HeatmapDay } from "../types";

function getHeatmapCellClass(totalXp: number): string {
  if (totalXp === 0) {
    return "w-3 h-3 rounded-[3px] bg-slate-950 border border-slate-800/60";
  }

  if (totalXp < 30) {
    return "w-3 h-3 rounded-[3px] bg-emerald-950/80 border border-emerald-800/40 text-emerald-300";
  }

  if (totalXp < 60) {
    return "w-3 h-3 rounded-[3px] bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]";
  }

  if (totalXp < 100) {
    return "w-3 h-3 rounded-[3px] bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]";
  }

  return "w-3 h-3 rounded-[3px] bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.8)] border border-amber-200/60";
}

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
          <div className="overflow-x-auto pb-2">
            <div className="flex gap-1">
              {weeks.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-1">
                  {week.map((day, di) =>
                    day ? (
                      <div
                        key={di}
                        onMouseEnter={() => setHovered(day)}
                        onMouseLeave={() => setHovered(null)}
                        className={`${getHeatmapCellClass(day.total_xp)} cursor-pointer transition-all duration-150 ease-out hover:scale-125 hover:ring-1 hover:ring-white/50`}
                        title={`${day.date}: ${day.total_xp} XP`}
                      />
                    ) : (
                      <div key={di} className="w-3 h-3" />
                    )
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between mt-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-[3px] bg-zinc-900 border border-zinc-800/60" />
                <span>Rest</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-[3px] bg-emerald-950/80 border border-emerald-800/40" />
                <span>&lt;30 XP</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-[3px] bg-emerald-600 shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
                <span>&lt;60 XP</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-[3px] bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.5)]" />
                <span>&lt;100 XP</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-[3px] bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.8)] border border-amber-200/60" />
                <span>God Mode</span>
              </div>
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
