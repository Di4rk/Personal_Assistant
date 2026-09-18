// Phải khớp CHÍNH XÁC với struct Rust trong src-tauri/src/commands/mod.rs
// (serde serialize theo camelCase mặc định của Tauri v2 nếu không #[serde(rename_all)],
// nhưng ở đây field Rust đã là snake_case và không có rename, nên JSON trả về
// giữ nguyên snake_case - xem lưu ý ở tauri-client.ts)

export interface DailyStats {
  date: string; // "YYYY-MM-DD"
  total_xp: number;
  ac_count: number;
  wa_count: number;
  other_count: number;
}

export interface SubmissionRecord {
  id: number;
  problem_id: string;
  problem_name: string;
  verdict: string;
  language: string | null;
  contest_id: string | null;
  xp_awarded: number;
  submitted_at: string; // ISO 8601, parse bằng `new Date(submitted_at)`
}

export interface LevelInfo {
  level: number;
  total_xp: number;
  current_level_xp: number;
  xp_needed_for_level: number;
  progress_percent: number; // 0-100, dùng thẳng cho width % progress bar
}

export type HeatmapTier = "rest" | "productive" | "god_mode";

export interface HeatmapDay {
  date: string; // "YYYY-MM-DD"
  total_xp: number;
  ac_count: number;
  tier: HeatmapTier;
}

export type VerdictKind = "AC" | "WA" | "TLE" | "RE" | "OTHER";

/** Map verdict string thô từ Codeforces/CSES về nhóm để tô màu UI. */
export function classifyVerdict(verdict: string): VerdictKind {
  const v = verdict.toUpperCase();
  if (v.includes("ACCEPTED") || v === "OK" || v === "AC") return "AC";
  if (v.includes("WRONG")) return "WA";
  if (v.includes("TIME_LIMIT") || v.includes("TLE")) return "TLE";
  if (v.includes("RUNTIME") || v === "RE") return "RE";
  return "OTHER";
}
