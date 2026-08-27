import { useEffect, useState } from "react";
import { fetchLevelInfo } from "../lib/tauri-client";
import type { LevelInfo } from "../types";

/**
 * Card hiển thị Level + progress bar lên cấp tiếp theo.
 * Tự poll lại mỗi 5s để cập nhật ngay sau khi có submission mới về
 * (không cần refresh page hay lift state phức tạp - MVP ưu tiên đơn giản).
 */
export default function LevelProgressBar() {
  const [info, setInfo] = useState<LevelInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const data = await fetchLevelInfo();
      if (!cancelled) setInfo(data);
    };

    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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
        <span className="text-2xl font-bold text-violet-400">Lv.{info.level}</span>
      </div>

      <div className="h-3 w-full bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 rounded-full transition-all duration-500 ease-out"
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
