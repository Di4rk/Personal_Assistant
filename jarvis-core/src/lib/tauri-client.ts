import { invoke } from "@tauri-apps/api/core";
import type { DailyStats, SubmissionRecord, LevelInfo, HeatmapDay } from "../types";
import type { PostMortemInput, PostMortemRecord, PostMortemSearchResult } from "../types/post_mortem";
import type {
  AcademicOverviewDto,
  AcademicCourseRecord,
  UpsertCourseDto,
  UpsertSemesterDto,
  RawPortalSemester,
  AcademicMacroMetricSSOT,
  FullPortalIngestionRequest,
} from "../features/academic/types";
import type { LifeMatrixEntryDto } from "../features/life-matrix/types";
import type { CreateStructuredNoteDto, VaultSearchResultDto, VaultStatsDto } from "../features/vault/types";

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

/**
 * Quy trình đồng bộ SSO cô lập và an toàn (P0 Zero-Trust) cho Cổng UIT.
 * Mở Webview không cấp quyền IPC, Rust tự động điều phối và trích xuất qua DOM.
 */
export async function syncUitPortal(): Promise<AcademicOverviewDto> {
  return invoke<AcademicOverviewDto>("sync_uit_portal");
}

/**
 * Lấy danh sách macro metrics theo chuẩn SSOT (academic_macro_metrics).
 * Tự động seed dữ liệu mẫu chuẩn nếu DB đang trống.
 */
export async function getAcademicMacroMetricsSsot(): Promise<AcademicMacroMetricSSOT[]> {
  return invoke<AcademicMacroMetricSSOT[]>("get_academic_macro_metrics_ssot");
}

/**
 * Nạp payload bảng điểm và DRL trực tiếp từ JSON portal vào SQLite.
 */
export async function ingestFullAcademicPayload(
  payload?: FullPortalIngestionRequest | null
): Promise<void> {
  return invoke<void>("ingest_full_academic_payload", { payload });
}

/**
 * Xóa sạch dữ liệu mock cũ và nạp lại chính xác 100% dữ liệu UIT canonical.
 */
export async function purgeAndSeedCanonicalAcademicData(): Promise<void> {
  return invoke<void>("purge_and_seed_canonical_academic_data");
}

/**
 * Nạp payload bảng điểm và DRL dạng JSON linh hoạt từ portal UIT vào SQLite.
 */
export async function ingestDynamicAcademicData(
  payloadJson: string
): Promise<void> {
  return invoke<void>("ingest_dynamic_academic_data", {
    payloadJson,
  });
}

/**
 * Lấy dải dữ liệu Life Matrix liên tục 364 ngày qua SQLite CTE.
 */
export async function getLifeMatrixRange(
  startDate: string,
  endDate: string
): Promise<LifeMatrixEntryDto[]> {
  return invoke<LifeMatrixEntryDto[]>("get_life_matrix_range", {
    startDate,
    endDate,
  });
}

// ============================================================
//  Native Vault IPC Wrappers (Module 5)
// ============================================================

/**
 * Trigger manual sync of markdown vault directory.
 */
export async function scanVault(vaultPath: string): Promise<VaultStatsDto> {
  return invoke<VaultStatsDto>("scan_vault", { vaultPath });
}

/**
 * Search vault notes using SQLite FTS5 with snippet highlights.
 */
export async function searchVault(query: string): Promise<VaultSearchResultDto[]> {
  return invoke<VaultSearchResultDto[]>("search_vault", { query });
}

/**
 * Retrieve summary metrics of the current vault.
 */
export async function getVaultStats(): Promise<VaultStatsDto> {
  return invoke<VaultStatsDto>("get_vault_stats");
}

/**
 * Tạo note có cấu trúc và đồng bộ ngay vào vault_notes & vault_fts.
 */
export async function createStructuredNote(dto: CreateStructuredNoteDto): Promise<string> {
  return invoke<string>("create_structured_note", { dto });
}

/**
 * Mở link OneNote an toàn sau khi validate scheme & ký tự.
 */
export async function openOnenoteLink(uri: string): Promise<void> {
  return invoke<void>("open_onenote_link", { uri });
}

/**
 * Trả về sync token hiện tại (hoặc sinh mới nếu chưa có).
 * Dùng trong SyncTokenDisplay để hiển thị token cho người dùng dán vào Tampermonkey.
 */
export async function getSyncToken(): Promise<string> {
  return invoke<string>("get_sync_token");
}

/**
 * Lưu đường dẫn thư mục vault vào bảng settings.
 */
export async function setVaultPath(path: string): Promise<void> {
  return invoke<void>("set_vault_path", { path });
}

/**
 * Lấy đường dẫn thư mục vault hiện tại từ bảng settings.
 */
export async function getVaultPath(): Promise<string | null> {
  try {
    return await invoke<string | null>("get_vault_path");
  } catch (err) {
    console.error("[tauri-client] getVaultPath lỗi:", err);
    return null;
  }
}

/**
 * Ẩn cửa sổ HUD xuống khay hệ thống.
 */
export async function hideHud(): Promise<void> {
  return invoke<void>("hide_hud");
}

/**
 * Xóa sạch dữ liệu Codeforces (submissions, post_mortems, handle) và tính lại matrix,
 * nhưng BẢO TOÀN 100% dữ liệu deadline Moodle.
 */
export async function purgeCfData(): Promise<void> {
  return invoke<void>("purge_cf_data");
}

export interface UserProfileDto {
  nickname: string;
  major: string;
  is_initialized: boolean;
}

export async function getUserProfile(): Promise<UserProfileDto> {
  return invoke<UserProfileDto>("get_user_profile");
}

export async function saveUserProfile(nickname: string, major: string): Promise<void> {
  return invoke<void>("save_user_profile", { nickname, major });
}

export async function resetIdentityState(): Promise<void> {
  return invoke<void>("reset_identity_state");
}

export interface StudentProfilePayload {
  student_id: string;
  full_name: string;
  faculty: string;
  major_code: string;
  specialization: string;
  student_class: string;
  curriculum_code: string;
  cohort: string;
}

export async function getStudentProfile(): Promise<StudentProfilePayload | null> {
  try {
    return await invoke<StudentProfilePayload | null>("get_student_profile");
  } catch (err) {
    console.error("[tauri-client] getStudentProfile lỗi:", err);
    return null;
  }
}

/**
 * Khởi chạy cửa sổ SSO UIT cô lập để xác thực và bóc tách dữ liệu zero-cookie.
 */
export async function launchPortalSsoSync(): Promise<void> {
  return invoke<void>("launch_portal_sso_sync");
}

export interface CurriculumResolution {
  major_code: string;
  total_credits: number;
  matched_via: string;
}

/**
 * Lấy kết quả phân giải chương trình đào tạo đa ngành từ settings (hoặc fallback).
 */
export async function getResolvedCurriculum(): Promise<CurriculumResolution> {
  return invoke<CurriculumResolution>("get_resolved_curriculum");
}




