import { invoke } from "@tauri-apps/api/core";
import type { DailyStats, SubmissionRecord, LevelInfo, HeatmapDay } from "../types";
import type { PostMortemInput, PostMortemRecord, PostMortemSearchResult } from "../types/post_mortem";
import type {
  AcademicOverviewDto,
  AcademicCourseRecord,
  UpsertCourseDto,
  UpsertSemesterDto,
  RawPortalSemester,
} from "../features/academic/types";

/**
 * Wrapper mỏng quanh invoke() để:
 * 1. Có type-safety ở call site (React component không cần biết tên command string).
 * 2. Bắt lỗi tập trung 1 chỗ, dễ thêm toast/log sau này.
 */

// ============================================================
// Codeforces sync types — phải khớp với SyncCompletePayload
// trong src-tauri/src/commands/mod.rs (tên field snake_case vì
// Tauri serialize Rust struct thẳng không qua camelCase transform).
// ============================================================

export interface SyncCompletePayload {
  success: boolean;
  message: string;
  new_submissions_count: number;
}

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
 * Lấy CF handle đã lưu từ settings table. Trả về null nếu chưa được set.
 */
export async function getCfHandle(): Promise<string | null> {
  try {
    return await invoke<string | null>("get_cf_handle");
  } catch (err) {
    console.error("[tauri-client] getCfHandle lỗi:", err);
    return null;
  }
}

/**
 * Ghi CF handle vào settings table. Throw lỗi nếu handle rỗng (Rust validate).
 */
export async function setCfHandle(handle: string): Promise<void> {
  await invoke<void>("set_cf_handle", { handle });
}

/**
 * Trigger 1 sync cycle ngay lập tức — gọi trực tiếp từ CfSettingsPanel.
 * Trả về SyncCompletePayload ngay, không cần đợi event.
 * Lỗi sync được bọc trong payload (success: false), không throw.
 */
export async function triggerCfSync(): Promise<SyncCompletePayload> {
  try {
    return await invoke<SyncCompletePayload>("trigger_cf_sync");
  } catch (err) {
    // Rust trả về Err(String) khi lock đang bị giữ — ánh xạ về payload.
    const message = typeof err === "string" ? err : "Lỗi kết nối với backend";
    console.error("[tauri-client] triggerCfSync lỗi:", err);
    return { success: false, message, new_submissions_count: 0 };
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

/**
 * Xoá post-mortem theo problemId. Trả về true nếu có bản ghi bị xoá,
 * false nếu chưa từng có post-mortem cho problem đó (không phải lỗi).
 */
export async function deletePostMortem(problemId: string): Promise<boolean> {
  try {
    return await invoke<boolean>("delete_post_mortem", { problemId });
  } catch (err) {
    console.error("[tauri-client] deletePostMortem lỗi:", err);
    return false;
  }
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

// ============================================================
//  Academic Radar IPC wrappers
// ============================================================

/**
 * Lấy toàn bộ danh sách học kỳ kèm thống kê động (GPA hệ 10, GPA hệ 4, DRL, tín chỉ).
 */
export async function getAcademicOverview(): Promise<AcademicOverviewDto[]> {
  return invoke<AcademicOverviewDto[]>("get_academic_overview");
}

/**
 * Lấy danh sách các môn học trong 1 học kỳ cụ thể.
 */
export async function getSemesterCourses(semesterId: string): Promise<AcademicCourseRecord[]> {
  return invoke<AcademicCourseRecord[]>("get_semester_courses", { semesterId });
}

/**
 * Batch upsert danh sách môn học (tự động tính điểm tổng kết và quy đổi sang hệ 4).
 */
export async function upsertAcademicCourses(courses: UpsertCourseDto[]): Promise<void> {
  return invoke<void>("upsert_academic_courses", { courses });
}

/**
 * Tạo hoặc cập nhật metadata học kỳ (target GPA, target DRL, isCompleted).
 */
export async function upsertAcademicSemester(semester: UpsertSemesterDto): Promise<void> {
  return invoke<void>("upsert_academic_semester", { semester });
}

/**
 * Kích hoạt quy trình đồng bộ bảng điểm từ Cổng thông tin UIT (portal.uit.edu.vn).
 * Mở Webview popup SSO để sinh viên xác thực và tải bảng điểm.
 */
export async function syncPortalUitData(): Promise<AcademicOverviewDto> {
  return invoke<AcademicOverviewDto>("sync_portal_uit_data");
}

/**
 * Gửi payload bảng điểm trích xuất trực tiếp hoặc qua DOM fallback vào SQLite.
 */
export async function submitPortalTranscript(
  semesters: RawPortalSemester[]
): Promise<AcademicOverviewDto> {
  return invoke<AcademicOverviewDto>("submit_portal_transcript", { semesters });
}


