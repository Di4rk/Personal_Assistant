import React from 'react';
import { StateTier } from '../types';

export interface HeatmapCellProps {
  date: string;
  tier: StateTier;
  xp?: number;
  acCount?: number;
  deadlinesCleared?: number;
}

const TIER_STYLE_MAP = {
  0: 'bg-zinc-900 border-zinc-800/60',
  1: 'bg-emerald-950/70 border-emerald-900/50',
  2: 'bg-emerald-800/80 border-emerald-700/60',
  3: 'bg-emerald-600 border-emerald-500/70',
  4: 'bg-emerald-400 border-emerald-300 shadow-[0_0_6px_rgba(52,211,153,0.4)]',
} as const;

export const HeatmapCell = React.memo<HeatmapCellProps>(({
  date,
  tier,
  xp = 0,
  acCount = 0,
  deadlinesCleared = 0,
}) => {
  return (
    <div
      data-matrix-cell="true"
      data-date={date}
      data-tier={tier}
      data-xp={xp}
      data-ac={acCount}
      data-deadlines={deadlinesCleared}
      className={`w-3 h-3 rounded-[2px] border transition-colors duration-75 ${TIER_STYLE_MAP[tier]}`}
    />
  );
});

HeatmapCell.displayName = 'HeatmapCell';
