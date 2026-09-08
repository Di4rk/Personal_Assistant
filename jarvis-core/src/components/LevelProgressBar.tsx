import type { LevelInfo } from "../types";

interface LevelProgressBarProps {
  info: LevelInfo | null;
}

/**
 * PURE COMPONENT - không tự fetch, không tự tính toán XP/level.
 * Toàn bộ số liệu (level, %, xp_needed...) đã được Rust tính sẵn qua
 * get_level_info command. Component này chỉ render những gì nhận được.
 */
export default function LevelProgressBar({ info }: LevelProgressBarProps) {
  if (!info) {
    return (
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 animate-pulse">
        <div className="h-4 w-24 bg-zinc-800 rounded mb-3" />
        <div className="h-3 w-full bg-zinc-800 rounded-full" />
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-sm font-medium text-zinc-400">Level</span>
        <span className="rounded-md bg-violet-600 px-2 py-1 font-mono text-2xl font-bold text-white shadow-[0_0_12px_rgba(139,92,246,0.4)]">
          Lv.{info.level}
        </span>
      </div>

      <div className="h-3 w-full bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="bg-violet-500 h-2.5 rounded-full transition-all duration-500 shadow-[0_0_12px_rgba(139,92,246,0.7)]"
          style={{ width: `${info.progress_percent}%` }}
        />
      </div>

      <div className="flex justify-between mt-1.5 text-xs text-zinc-500">
        <span>{info.current_level_xp} XP</span>
        <span>{info.xp_needed_for_level} XP cần để lên cấp</span>
      </div>

      <div className="mt-2 text-xs text-zinc-600">
        Tổng cộng: <span className="text-zinc-400 font-medium">{info.total_xp} XP</span>
      </div>
    </div>
  );
}
