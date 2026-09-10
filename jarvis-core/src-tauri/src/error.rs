use thiserror::Error;

/// Error type tập trung cho toàn bộ backend logic (DB, HTTP, worker).
/// Mọi hàm có thể fail đều trả AppResult<T> thay vì unwrap/expect - panic
/// trong 1 background worker sẽ kill cả app, tuyệt đối không chấp nhận được
/// cho 1 process chạy ngầm không ai theo dõi trực tiếp.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("Lỗi database: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Lỗi HTTP khi gọi Codeforces API: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Codeforces API trả về lỗi: {0}")]
    CfApiError(String),

    #[error("Bị Codeforces rate-limit (HTTP 429)")]
    RateLimited,

    #[error("Codeforces API tạm thời không khả dụng (HTTP 503/bảo trì)")]
    ServiceUnavailable,

    #[error("DB mutex bị poisoned - có thread trước đó panic khi giữ lock")]
    PoisonedLock,

    #[error("Chưa cấu hình CF handle trong settings - gọi set_cf_handle trước")]
    HandleNotConfigured,

    #[error("Lỗi emit Tauri event: {0}")]
    EventEmit(#[from] tauri::Error),

    #[error("root_cause không hợp lệ: '{0}' - phải là 1 trong LOGIC_BUG/CORNER_CASE/TIME_COMPLEXITY/IMPLEMENTATION/MISREAD")]
    InvalidRootCause(String),

    #[error("Lỗi (de)serialize dữ liệu: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Không tìm thấy post-mortem cho problem_id: {0}")]
    PostMortemNotFound(String),

    #[error("Lỗi đồng bộ Cổng thông tin UIT: {0}")]
    PortalSync(String),

    #[error("Lỗi phân giải bảng điểm UIT: {0}")]
    TranscriptParse(String),

    #[error("Lỗi I/O: {0}")]
    Io(#[from] std::io::Error),

    #[error("Lỗi Vault: {0}")]
    Vault(String),
}

pub type AppResult<T> = Result<T, AppError>;
