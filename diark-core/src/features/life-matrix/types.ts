export type StateTier = 0 | 1 | 2 | 3 | 4;

export interface LifeMatrixEntryDto {
  date: string; // 'YYYY-MM-DD'
  ac_count: number;
  deadlines_cleared: number;
  total_xp: number;
  state_tier: number;
}

export interface LifeMatrixCellData {
  date: string;
  acCount: number;
  deadlinesCleared: number;
  totalXp: number;
  stateTier: StateTier;
}

export interface HoveredCellState {
  data: LifeMatrixCellData;
  x: number;
  y: number;
}
