import { invoke } from "@tauri-apps/api/core";
import type { DailyStats, SubmissionRecord, LevelInfo, HeatmapDay } from "../types";
import type { PostMortemInput, PostMortemRecord, PostMortemSearchResult } from "../types/post_mortem";

/**
 * Wrapper mỏng quanh invoke() để:
 * 1. Có type-safety ở call site (React component không cần biết tên command string).
 * 2. Bắt lỗi tập trung 1 chỗ, dễ thêm toast/log sau này.
 */

export async function fetchTodayStats(): Promise<DailyStats> {
  try {
    return await invoke<DailyStats>("get_today_stats");
  } catch (err) {
    console.error("[tauri-client] fetchTodayStats lỗi:", err);
    // Trả về giá trị an toàn thay vì throw, để UI không bị crash trắng màn hình
    // khi DB có vấn đề - dashboard vẫn hiển thị được (dạng "0 hôm nay").
    const today = new Date().toISOString().slice(0, 10);
    return { date: today, total_xp: 0, ac_count: 0, wa_count: 0, other_count: 0 };
  }
}

export async function fetchRecentSubmissions(
  limit: number = 20
): Promise<SubmissionRecord[]> {
  try {
    return await invoke<SubmissionRecord[]>("get_recent_submissions", { limit });
  } catch (err) {
    console.error("[tauri-client] fetchRecentSubmissions lỗi:", err);
    return [];
  }
}

export async function fetchLevelInfo(): Promise<LevelInfo | null> {
  try {
    return await invoke<LevelInfo>("get_level_info");
  } catch (err) {
    console.error("[tauri-client] fetchLevelInfo lỗi:", err);
    return null;
  }
}

export async function fetchYearlyHeatmap(year: number): Promise<HeatmapDay[]> {
  try {
    return await invoke<HeatmapDay[]>("get_yearly_heatmap", { year });
  } catch (err) {
    console.error("[tauri-client] fetchYearlyHeatmap lỗi:", err);
    return [];
  }
}

/**
 * Chỉ hoạt động trong dev build (Rust command bị cfg(debug_assertions) strip
 * khỏi release) - gọi trong production sẽ reject với lỗi "command not found",
 * không crash app, chỉ là no-op an toàn.
 */
export async function devSeedMockData(daysBack: number = 90): Promise<number> {
  try {
    const result = await invoke<{ inserted: number }>("dev_seed_mock_data", {
      daysBack,
    });
    return result.inserted;
  } catch (err) {
    console.error("[tauri-client] devSeedMockData lỗi (bình thường nếu đang chạy release build):", err);
    return 0;
  }
}

export async function devClearMockData(): Promise<number> {
  try {
    return await invoke<number>("dev_clear_mock_data");
  } catch (err) {
    console.error("[tauri-client] devClearMockData lỗi:", err);
    return 0;
  }
}

/**
 * Lưu ý: khác các fetch* khác ở trên, save/get post-mortem KHÔNG nuốt lỗi
 * thành giá trị mặc định - lỗi ghi post-mortem (VD: root_cause không hợp lệ)
 * cần hiển thị rõ cho user biết, không thể âm thầm coi như "không có gì".
 */
export async function savePostMortem(input: PostMortemInput): Promise<PostMortemRecord> {
  return invoke<PostMortemRecord>("save_post_mortem", { input });
}

export async function getPostMortem(problemId: string): Promise<PostMortemRecord | null> {
  return invoke<PostMortemRecord | null>("get_post_mortem", { problemId });
}

export async function searchPostMortems(
  query: string,
  limit: number = 20
): Promise<PostMortemSearchResult[]> {
  try {
    return await invoke<PostMortemSearchResult[]>("search_post_mortems", { query, limit });
  } catch (err) {
    console.error("[tauri-client] searchPostMortems lỗi:", err);
    return [];
  }
}

/**
 * Poll định kỳ - dùng trong useEffect của Dashboard component.
 * Trả về hàm cleanup để clear interval khi component unmount.
 *
 * Ví dụ dùng:
 *   useEffect(() => startPolling(setStats, setSubs), []);
 */
export function startPolling(
  onStats: (stats: DailyStats) => void,
  onSubmissions: (subs: SubmissionRecord[]) => void,
  intervalMs: number = 5000
): () => void {
  const tick = async () => {
    const [stats, subs] = await Promise.all([
      fetchTodayStats(),
      fetchRecentSubmissions(20),
    ]);
    onStats(stats);
    onSubmissions(subs);
  };

  tick(); // chạy ngay lần đầu, không đợi interval đầu tiên
  const id = setInterval(tick, intervalMs);
  return () => clearInterval(id);
}
