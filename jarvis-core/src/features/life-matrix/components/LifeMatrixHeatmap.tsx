import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { LifeMatrixCellData, StateTier, LifeMatrixEntryDto } from '../types';
import { HeatmapCell } from './HeatmapCell';

interface HoverState {
  date: string;
  xp: number;
  tier: StateTier;
  ac: number;
  deadlines: number;
  x: number;
  y: number;
  visible: boolean;
}

// Helper: Lấy chuỗi YYYY-MM-DD theo UTC+7
export function getTodayICT(): string {
  const now = new Date();
  const utc7 = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
  return utc7.toISOString().split('T')[0];
}

// Helper tính khoảng 51 tuần trước đến Chủ nhật tuần hiện tại (chuẩn 364 ngày)
export function calculateDateBounds(todayStr: string) {
  const current = new Date(`${todayStr}T00:00:00Z`);
  const dayOfWeek = current.getUTCDay(); // 0 = Sunday, 1 = Monday...
  // Căn về Chủ Nhật tuần hiện tại (end date)
  const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  const endDate = new Date(current.getTime() + daysUntilSunday * 86400000);
  // Lùi về 364 ngày trước (52 tuần * 7)
  const startDate = new Date(endDate.getTime() - (364 - 1) * 86400000);

  return {
    startDateStr: startDate.toISOString().split('T')[0],
    endDateStr: endDate.toISOString().split('T')[0],
  };
}

export function parseTier(val: string | undefined): StateTier {
  const n = Number(val);
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  return 0;
}

export interface LifeMatrixHeatmapProps {
  entries: LifeMatrixEntryDto[];
}

export const LifeMatrixHeatmap: React.FC<LifeMatrixHeatmapProps> = ({ entries }) => {
  const [todayKey, setTodayKey] = useState<string>(() => getTodayICT());
  const [hoverState, setHoverState] = useState<HoverState>({
    date: '',
    xp: 0,
    tier: 0,
    ac: 0,
    deadlines: 0,
    x: 0,
    y: 0,
    visible: false,
  });

  // Tránh stale date sau nửa đêm
  useEffect(() => {
    const timer = setInterval(() => {
      const currentICT = getTodayICT();
      setTodayKey((prev) => (prev !== currentICT ? currentICT : prev));
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const dataMap = useMemo(() => {
    const map = new Map<string, LifeMatrixCellData>();
    for (const e of entries) {
      map.set(e.date, {
        date: e.date,
        acCount: e.ac_count,
        deadlinesCleared: e.deadlines_cleared,
        totalXp: e.total_xp,
        stateTier: parseTier(String(e.state_tier)),
      });
    }
    return map;
  }, [entries]);

  const cells = useMemo(() => {
    const { startDateStr } = calculateDateBounds(todayKey);
    const result: LifeMatrixCellData[] = [];
    const current = new Date(`${startDateStr}T00:00:00Z`);

    for (let i = 0; i < 364; i++) {
      const dateStr = current.toISOString().split('T')[0];
      const existing = dataMap.get(dateStr);
      if (existing) {
        result.push(existing);
      } else {
        result.push({
          date: dateStr,
          acCount: 0,
          deadlinesCleared: 0,
          totalXp: 0,
          stateTier: 0,
        });
      }
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return result;
  }, [todayKey, dataMap]);

  // Single delegated listener với seam no-op chống jitter
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('[data-matrix-cell]');
    if (!target) return; // Seam/gap no-op chống jitter

    const ds = (target as HTMLElement).dataset;
    const rect = e.currentTarget.getBoundingClientRect();

    setHoverState({
      date: ds.date || '',
      xp: Number(ds.xp) || 0,
      tier: parseTier(ds.tier),
      ac: Number(ds.ac) || 0,
      deadlines: Number(ds.deadlines) || 0,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      visible: true,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoverState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  return (
    <div className="relative inline-block bg-zinc-950 p-4 rounded-xl border border-zinc-800/80">
      <div
        className="grid grid-flow-col grid-rows-7 gap-[3px] select-none cursor-pointer"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {cells.map((cell) => (
          <HeatmapCell
            key={cell.date}
            date={cell.date}
            tier={cell.stateTier}
            xp={cell.totalXp}
            acCount={cell.acCount}
            deadlinesCleared={cell.deadlinesCleared}
          />
        ))}
      </div>

      {/* Persistent Tooltip Node: Luôn tồn tại trong DOM, chỉ toggle visibility/opacity & GPU translate3d */}
      <div
        aria-hidden={!hoverState.visible}
        className={`pointer-events-none absolute z-50 bg-zinc-900 border border-zinc-700 text-xs px-2.5 py-1.5 rounded shadow-lg text-zinc-200 transition-opacity duration-75 ${
          hoverState.visible ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          transform: `translate3d(${hoverState.x + 12}px, ${hoverState.y + 12}px, 0)`,
          top: 0,
          left: 0,
          willChange: 'transform',
          visibility: hoverState.visible ? 'visible' : 'hidden',
        }}
      >
        <div className="font-semibold text-zinc-100">{hoverState.date}</div>
        <div className="text-emerald-400">Total XP: +{hoverState.xp}</div>
        <div className="text-zinc-400">
          AC: {hoverState.ac} | Deadlines: {hoverState.deadlines}
        </div>
      </div>
    </div>
  );
};
