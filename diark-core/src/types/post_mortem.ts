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

/**
 * Payload gửi lên khi tạo/sửa post-mortem, khớp PostMortemInput ở Rust.
 *
 * QUAN TRỌNG: Rust PostMortemInput dùng snake_case fields và Tauri IPC nhận
 * arguments dưới dạng camelCase object key từ JS (invoke argument mapping).
 * Nhưng struct này được gửi như 1 nested object `{ input: ... }` nên Tauri
 * sẽ deserialize theo snake_case. Giữ snake_case ở đây đúng với Rust struct.
 */
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

/**
 * Record đầy đủ nhận về từ Rust, khớp PostMortemRecord.
 *
 * Rust struct dùng `#[serde(rename_all = "camelCase")]` nên TẤT CẢ field
 * trong JSON response đều là camelCase: `problemId`, `problemName`, v.v.
 * Interface này PHẢI dùng camelCase để runtime data binding hoạt động đúng.
 */
export interface PostMortemRecord {
  id: number;
  problemId: string;
  problemName: string;
  platform: string;
  rootCause: RootCauseType;
  keyInsight: string;
  /** Comma-separated normalized tags, VD: "dp,tree,bitmask". */
  tags: string;
  /** Unix timestamp (giây) — dùng `new Date(createdAt * 1000)` để hiển thị. */
  createdAt: number;
  updatedAt: number;
}

/**
 * Kết quả search khớp SearchResultItem ở Rust. Điểm BM25 thô càng âm thì
 * kết quả càng liên quan; record được giữ lồng để phản ánh chính xác IPC payload.
 */
export interface PostMortemSearchResult {
  record: PostMortemRecord;
  rank: number;
}
