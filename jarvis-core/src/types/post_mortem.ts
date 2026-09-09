/**
 * Khớp CHÍNH XÁC với enum RootCause trong src-tauri/src/db/post_mortem.rs
 * (#[serde(rename_all = "SCREAMING_SNAKE_CASE")]) và CHECK constraint trong
 * schema.rs. Đổi 1 chỗ phải đổi cả 3 - không có cách nào share type tự động
 * giữa Rust và TS trong setup hiện tại, nên đây LÀ nguồn sự thật phía frontend.
 */
export type RootCauseType =
  | "LOGIC_BUG"
  | "CORNER_CASE"
  | "TIME_COMPLEXITY"
  | "IMPLEMENTATION"
  | "MISREAD";

export const ROOT_CAUSE_LABELS: Record<RootCauseType, string> = {
  LOGIC_BUG: "Sai logic",
  CORNER_CASE: "Bỏ sót corner case",
  TIME_COMPLEXITY: "Sai độ phức tạp thời gian",
  IMPLEMENTATION: "Lỗi khi cài đặt",
  MISREAD: "Đọc sai đề",
};

/** Payload gửi lên khi tạo/sửa post-mortem, khớp PostMortemInput ở Rust. */
export interface PostMortemInput {
  problem_id: string;
  problem_name: string;
  /** Optional ở phía Rust (default "codeforces" qua serde), nhưng nên set tường minh ở frontend. */
  platform?: string;
  root_cause: RootCauseType;
  key_insight: string;
  /** Comma-separated tag string, normalized by the Rust persistence layer. */
  tags: string;
}

/** Record đầy đủ nhận về từ Rust, khớp PostMortemRecord. */
export interface PostMortemRecord {
  id: number;
  problem_id: string;
  problem_name: string;
  platform: string;
  root_cause: RootCauseType;
  key_insight: string;
  tags: string;
  created_at: number; // unix timestamp (giây) - dùng new Date(created_at * 1000)
  updated_at: number;
}

/**
 * Kết quả search khớp SearchResultItem ở Rust. Điểm BM25 thô càng âm thì
 * kết quả càng liên quan; record được giữ lồng để phản ánh chính xác IPC payload.
 */
export interface PostMortemSearchResult {
  record: PostMortemRecord;
  rank: number;
}
