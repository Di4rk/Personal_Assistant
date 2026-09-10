/**
 * LifeMatrixHeatmap — Sprint v0.4
 *
 * Audited Master Life Matrix 365-day contribution grid:
 * - High-performance cell memoization: MatrixCell receives flat props (date, tier).
 * - Single-container event delegation: Only 1 onMouseMove/onMouseLeave on the parent grid.
 * - Permanent single tooltip: Positioned via CSS translate3d without mount/unmount thrashing.
 * - Standard color tokens: Tier 0 (Idle) to Tier 4 (God Mode).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Award, Calendar, CheckCircle2, Flame, RefreshCw, Trophy, Zap } from "lucide-react";

// ============================================================
//  TYPES
// ============================================================

export interface DailyMatrixRecord {
  date: string; // 'YYYY-MM-DD' (Normalized to UTC+07:00 ICT)
  ac_count: number;
  deadlines_cleared: number;
  total_xp: number;
  state_tier: number; // 0: Idle, 1: Low, 2: Mid, 3: High, 4: God Mode
  updated_at: number;
}

export interface LifeMatrixHeatmapProps {
  className?: string;
  initialYear?: number;
}

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  record: DailyMatrixRecord | null;
}

// ============================================================
//  TIER STYLES & LABELS
// ============================================================

function getTierColorClass(tier: number): string {
  switch (tier) {
    case 1:
      return "bg-emerald-950";
    case 2:
      return "bg-emerald-700";
    case 3:
      return "bg-emerald-500";
    case 4:
      return "bg-violet-600 shadow-[0_0_8px_rgba(139,92,246,0.6)]";
    case 0:
    default:
      return "bg-zinc-800";
  }
}

function getTierLabel(tier: number): string {
  switch (tier) {
    case 1:
      return "Low (1 - 30 XP)";
    case 2:
      return "Mid (31 - 60 XP)";
    case 3:
      return "High (61 - 90 XP)";
    case 4:
      return "God Mode (> 90 XP)";
    case 0:
    default:
      return "Idle (0 XP)";
  }
}

// ============================================================
//  1. CELL MEMOIZATION (Flat Props)
// ============================================================

interface MatrixCellProps {
  date: string;
  tier: number;
}

const MatrixCell = React.memo(function MatrixCell({ date, tier }: MatrixCellProps) {
  const colorClass = getTierColorClass(tier);

  return (
    <div
      data-date={date}
      className={`h-3 w-3 rounded-sm transition-colors duration-150 ${colorClass} hover:ring-1 hover:ring-white/40`}
    />
  );
});

// ============================================================
//  WEEK GROUPING HELPER
// ============================================================

interface WeekColumn {
  weekIndex: number;
  days: (DailyMatrixRecord | null)[];
}

function buildWeekColumns(records: DailyMatrixRecord[]): WeekColumn[] {
  if (records.length === 0) return [];

  // Determine starting weekday of the first record (0 = Sunday, 1 = Monday, ...)
  // We align columns to Monday-first (0 = Mon, ..., 6 = Sun)
  const firstDate = new Date(`${records[0].date}T00:00:00+07:00`);
  const dayOfWeek = firstDate.getDay(); // 0 is Sunday
  const mondayOffset = (dayOfWeek + 6) % 7; // 0 for Monday, 6 for Sunday

  const padded: (DailyMatrixRecord | null)[] = [
    ...Array<null>(mondayOffset).fill(null),
    ...records,
  ];

  const columns: WeekColumn[] = [];
  for (let i = 0; i < padded.length; i += 7) {
    columns.push({
      weekIndex: Math.floor(i / 7),
      days: padded.slice(i, i + 7),
    });
  }

  return columns;
}

// ============================================================
//  MAIN HEATMAP COMPONENT
// ============================================================

export default function LifeMatrixHeatmap({
  className = "",
  initialYear,
}: LifeMatrixHeatmapProps) {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(initialYear ?? currentYear);
  const [records, setRecords] = useState<DailyMatrixRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [recomputing, setRecomputing] = useState<boolean>(false);

  // Single Tooltip State
  const [tooltipState, setTooltipState] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    record: null,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  // Fast O(1) lookup map
  const recordMap = useMemo(() => {
    const map = new Map<string, DailyMatrixRecord>();
    for (const r of records) {
      map.set(r.date, r);
    }
    return map;
  }, [records]);

  // Load heatmap records for selected year
  const loadHeatmapData = useCallback(async (year: number) => {
    setLoading(true);
    try {
      const data = await invoke<DailyMatrixRecord[]>("get_heatmap_matrix", { year });
      setRecords(data);
    } catch (err) {
      console.error("Failed to load heatmap matrix:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Recompute today's record and update matrix
  const handleRecomputeToday = useCallback(async () => {
    setRecomputing(true);
    try {
      const todayRecord = await invoke<DailyMatrixRecord>("recompute_today_xp");
      setRecords((prev) =>
        prev.map((r) => (r.date === todayRecord.date ? todayRecord : r))
      );
    } catch (err) {
      console.error("Failed to recompute today's XP:", err);
    } finally {
      setRecomputing(false);
    }
  }, []);

  useEffect(() => {
    loadHeatmapData(selectedYear);
  }, [selectedYear, loadHeatmapData]);

  // ============================================================
  //  2. EVENT DELEGATION (Single onMouseMove / onMouseLeave)
  // ============================================================

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-date]");
      if (!target || !target.dataset.date) {
        setTooltipState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
        return;
      }

      const dateStr = target.dataset.date;
      const rec = recordMap.get(dateStr);
      if (!rec) return;

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setTooltipState({
        visible: true,
        x,
        y,
        record: rec,
      });
    },
    [recordMap]
  );

  const handleMouseLeave = useCallback(() => {
    setTooltipState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  // Weekly columns
  const weekColumns = useMemo(() => buildWeekColumns(records), [records]);

  // Summary statistics
  const stats = useMemo(() => {
    let totalXp = 0;
    let totalAc = 0;
    let totalDeadlines = 0;
    let activeDays = 0;

    for (const r of records) {
      totalXp += r.total_xp;
      totalAc += r.ac_count;
      totalDeadlines += r.deadlines_cleared;
      if (r.total_xp > 0) activeDays += 1;
    }

    return { totalXp, totalAc, totalDeadlines, activeDays };
  }, [records]);

  const dayLabels = ["T2", "", "T4", "", "T6", "", "CN"];

  return (
    <div
      className={[
        "rounded-xl border border-zinc-800 bg-zinc-950 p-5 text-zinc-100",
        className,
      ].join(" ")}
    >
      {/* ── HEADER & CONTROLS ── */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-zinc-400" />
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">
            Master Life Matrix
          </h2>
          <span className="ml-1 rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-xs font-medium text-zinc-300">
            {selectedYear}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRecomputeToday}
            disabled={recomputing}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50"
            title="Tính toán lại XP hôm nay"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${recomputing ? "animate-spin" : ""}`} />
            Sync Today
          </button>

          <div className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
            {[currentYear - 1, currentYear].map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => setSelectedYear(y)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  y === selectedYear
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {y}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── SUMMARY STATS BAR ── */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Zap className="h-3.5 w-3.5 text-amber-400" />
            <span>Total XP</span>
          </div>
          <div className="mt-1 text-lg font-bold text-zinc-100">
            {stats.totalXp.toLocaleString()}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Trophy className="h-3.5 w-3.5 text-emerald-400" />
            <span>First ACs</span>
          </div>
          <div className="mt-1 text-lg font-bold text-zinc-100">
            {stats.totalAc.toLocaleString()}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <CheckCircle2 className="h-3.5 w-3.5 text-blue-400" />
            <span>Deadlines Cleared</span>
          </div>
          <div className="mt-1 text-lg font-bold text-zinc-100">
            {stats.totalDeadlines.toLocaleString()}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/50 p-3">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Flame className="h-3.5 w-3.5 text-rose-400" />
            <span>Active Days</span>
          </div>
          <div className="mt-1 text-lg font-bold text-zinc-100">
            {stats.activeDays}{" "}
            <span className="text-xs font-normal text-zinc-500">/ 365</span>
          </div>
        </div>
      </div>

      {/* ── 365-DAY GRID CONTAINER (DELEGATED EVENTS) ── */}
      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="relative overflow-x-auto pb-2 select-none"
      >
        {loading ? (
          <div className="flex h-32 items-center justify-center text-xs text-zinc-500">
            Đang tải dữ liệu Life Matrix...
          </div>
        ) : (
          <div className="flex min-w-max gap-2 pt-1">
            {/* Weekday indicator labels */}
            <div className="flex flex-col gap-1 pr-1 text-[10px] text-zinc-500 font-mono">
              {dayLabels.map((lbl, idx) => (
                <div key={idx} className="h-3 leading-3">
                  {lbl}
                </div>
              ))}
            </div>

            {/* Matrix columns (52 - 53 weeks) */}
            <div className="flex gap-1">
              {weekColumns.map((col) => (
                <div key={col.weekIndex} className="flex flex-col gap-1">
                  {col.days.map((day, dIdx) =>
                    day ? (
                      <MatrixCell
                        key={day.date}
                        date={day.date}
                        tier={day.state_tier}
                      />
                    ) : (
                      <div
                        key={`empty-${col.weekIndex}-${dIdx}`}
                        className="h-3 w-3 opacity-0"
                      />
                    )
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 3. SINGLE PERMANENT TOOLTIP (translate3d) ── */}
        <div
          aria-hidden={!tooltipState.visible}
          className={[
            "absolute top-0 left-0 z-30 pointer-events-none transition-opacity duration-150 ease-out",
            tooltipState.visible ? "opacity-100" : "opacity-0",
          ].join(" ")}
          style={{
            transform: `translate3d(${tooltipState.x + 10}px, ${tooltipState.y - 70}px, 0)`,
          }}
        >
          {tooltipState.record && (
            <div className="min-w-[180px] rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur-sm">
              <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-1.5 font-medium text-zinc-200">
                <span>{tooltipState.record.date}</span>
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                  Tier {tooltipState.record.state_tier}
                </span>
              </div>

              <div className="mt-1.5 space-y-1 text-zinc-400">
                <div className="flex justify-between">
                  <span>First ACs:</span>
                  <span className="font-semibold text-zinc-200">
                    {tooltipState.record.ac_count} (+{tooltipState.record.ac_count * 20} XP)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Deadlines:</span>
                  <span className="font-semibold text-zinc-200">
                    {tooltipState.record.deadlines_cleared}
                  </span>
                </div>
                <div className="flex justify-between pt-1 border-t border-zinc-800 text-zinc-300 font-semibold">
                  <span>Daily Total:</span>
                  <span className="text-amber-400">+{tooltipState.record.total_xp} XP</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 4. COLOR TOKENS LEGEND ── */}
      <div className="mt-4 flex flex-wrap items-center justify-between border-t border-zinc-900 pt-3 text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <Award className="h-3.5 w-3.5 text-zinc-400" />
          <span>Life Matrix Protocol v0.4 (Normalized to UTC+07:00 ICT)</span>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[11px] text-zinc-500">Less</span>
          <div className="flex items-center gap-1">
            <div
              className="h-3 w-3 rounded-sm bg-zinc-800"
              title={getTierLabel(0)}
            />
            <div
              className="h-3 w-3 rounded-sm bg-emerald-950"
              title={getTierLabel(1)}
            />
            <div
              className="h-3 w-3 rounded-sm bg-emerald-700"
              title={getTierLabel(2)}
            />
            <div
              className="h-3 w-3 rounded-sm bg-emerald-500"
              title={getTierLabel(3)}
            />
            <div
              className="h-3 w-3 rounded-sm bg-violet-600 shadow-[0_0_8px_rgba(139,92,246,0.6)]"
              title={getTierLabel(4)}
            />
          </div>
          <span className="text-[11px] text-zinc-500">God Mode</span>
        </div>
      </div>
    </div>
  );
}
