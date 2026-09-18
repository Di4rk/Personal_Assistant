import type { LevelInfo } from "../types";

interface LevelProgressBarProps {
  info: LevelInfo | null;
}

export interface TitleRankInfo {
  title: string;
  badgeClass: string;
}

export function getUitTitleRank(level: number): TitleRankInfo {
  if (level <= 5) {
    return {
      title: "Script Kiddie (Tân binh UIT)",
      badgeClass: "bg-cyan-950/60 border-cyan-800/60 text-cyan-300",
    };
  }
  if (level <= 10) {
    return {
      title: "Algorithm Apprentice (Luyện đệ quy)",
      badgeClass: "bg-emerald-950/60 border-emerald-800/60 text-emerald-300",
    };
  }
  if (level <= 20) {
    return {
      title: "Data Structure Specialist (Bậc thầy Cây & Đồ thị)",
      badgeClass: "bg-amber-950/60 border-amber-800/60 text-amber-300",
    };
  }
  if (level <= 35) {
    return {
      title: "ICPC Regional Contender (Chiến binh Đấu trường)",
      badgeClass: "bg-cyan-950/80 border-cyan-500/70 text-cyan-200 shadow-[0_0_10px_rgba(6,182,212,0.3)]",
    };
  }
  return {
    title: "Grandmaster Architect (Huyền thoại UIT)",
    badgeClass: "bg-amber-950/80 border-amber-500/70 text-amber-200 shadow-[0_0_12px_rgba(245,158,11,0.4)]",
  };
}

export default function LevelProgressBar({ info }: LevelProgressBarProps) {
  if (!info) {
    return (
      <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 animate-pulse">
        <div className="h-4 w-24 bg-slate-800 rounded mb-3" />
        <div className="h-3 w-full bg-slate-800 rounded-full" />
      </div>
    );
  }

  const titleRank = getUitTitleRank(info.level);

  return (
    <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-300">Level</span>
          <span className="rounded-md bg-cyan-600 px-2 py-0.5 font-mono text-base font-bold text-white shadow-[0_0_12px_rgba(6,182,212,0.4)]">
            Lv.{info.level}
          </span>
        </div>
        <span
          className={`text-[11px] px-2.5 py-0.5 rounded-full border font-mono font-medium ${titleRank.badgeClass}`}
        >
          {titleRank.title}
        </span>
      </div>

      <div className="h-3 w-full bg-slate-950 border border-slate-800 rounded-full overflow-hidden">
        <div
          className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-2.5 rounded-full transition-all duration-500 shadow-[0_0_12px_rgba(6,182,212,0.7)]"
          style={{ width: `${info.progress_percent}%` }}
        />
      </div>

      <div className="flex justify-between mt-1.5 text-xs text-slate-400">
        <span>{info.current_level_xp} XP</span>
        <span>{info.xp_needed_for_level} XP cần để lên cấp</span>
      </div>

      <div className="mt-2 text-xs text-slate-500">
        Tổng cộng: <span className="text-slate-300 font-medium font-mono">{info.total_xp} XP</span>
      </div>
    </div>
  );
}
