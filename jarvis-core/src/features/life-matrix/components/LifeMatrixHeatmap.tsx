import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { LifeMatrixCellData, HoveredCellState, StateTier, LifeMatrixEntryDto } from '../types';
import { HeatmapCell } from './HeatmapCell';

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
  const [hovered, setHovered] = useState<HoveredCellState | null>(null);

  // Refs để điều phối rAF batching
  const latestPos = useRef<{ x: number; y: number; data: LifeMatrixCellData } | null>(null);
  const rafId = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, []);

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

  // Event Delegation với rAF batching
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('[data-matrix-cell="true"]');
    if (!target) return; // Bỏ qua seam/gap, không clear hover

    const ds = (target as HTMLElement).dataset;
    const rect = e.currentTarget.getBoundingClientRect();

    latestPos.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      data: {
        date: ds.date || '',
        acCount: Number(ds.ac) || 0,
        deadlinesCleared: Number(ds.deadlines) || 0,
        totalXp: Number(ds.xp) || 0,
        stateTier: parseTier(ds.tier),
      },
    };

    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(() => {
        if (latestPos.current) {
          setHovered({
            data: latestPos.current.data,
            x: latestPos.current.x,
            y: latestPos.current.y,
          });
        }
        rafId.current = null;
      });
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    latestPos.current = null;
    setHovered(null);
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
        aria-hidden={!hovered}
        className={`pointer-events-none absolute z-50 bg-zinc-900 border border-zinc-700 text-xs px-2.5 py-1.5 rounded shadow-lg text-zinc-200 transition-opacity duration-75 ${
          hovered ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          transform: `translate3d(${hovered ? hovered.x + 12 : 0}px, ${hovered ? hovered.y + 12 : 0}px, 0)`,
          top: 0,
          left: 0,
          willChange: 'transform',
          visibility: hovered ? 'visible' : 'hidden',
        }}
      >
        <div className="font-semibold text-zinc-100">{hovered?.data.date}</div>
        <div className="text-emerald-400">Total XP: +{hovered?.data.totalXp}</div>
        <div className="text-zinc-400">
          AC: {hovered?.data.acCount} | Deadlines: {hovered?.data.deadlinesCleared}
        </div>
      </div>
    </div>
  );
};
