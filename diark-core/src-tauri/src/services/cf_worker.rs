use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::db::{get_setting, ingest_cf_submissions_with_result, SharedDb, SyncResult};
use crate::error::{AppError, AppResult};

const CF_API_BASE: &str = "https://codeforces.com/api/user.status";
/// Chỉ cần lấy N submission gần nhất mỗi cycle - đủ để bắt kịp hoạt động
/// thực tế (không ai submit quá 30 bài/phút), không cần kéo cả lịch sử.
const INITIAL_HISTORY_COUNT: u32 = 1_000;
const POLL_COUNT: u32 = 20;
const MIN_REQUEST_INTERVAL_SECS: u64 = 2;
/// Trần backoff - dù CF API sập bao lâu, worker cũng không ngủ quá 15 phút/lần,
/// để còn kịp phát hiện lúc server sống lại mà không cần restart app.
const MAX_BACKOFF_SECS: u64 = 15 * 60;

const EVENT_SYNC_COMPLETE: &str = "cf-sync-complete";
// Kept during the transition so the current dashboard listener continues to
// refresh until it moves to `cf-sync-complete`.
const LEGACY_EVENT_SYNC: &str = "cf://sync-event";
const SETTING_KEY_CF_HANDLE: &str = "cf_handle";

// ============================================================
// RAII Concurrency Lock — ngăn API thrashing khi user bấm
// "Sync" liên tục trong khi background worker đang chạy.
// AtomicBool thay vì Mutex<bool> vì: không cần giữ bất kỳ
// shared data nào bên trong — chỉ cần 1 cờ "đang chạy hay chưa".
// ============================================================

/// Handle dùng chung (clone tự do) để kiểm tra / yêu cầu lock sync.
#[derive(Clone)]
pub struct SyncLock(Arc<AtomicBool>);

impl SyncLock {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    /// Cố gắng chiếm lock. Trả về `Some(SyncGuard)` nếu thành công (lock còn trống),
    /// `None` nếu đã có luồng khác đang giữ lock.
    /// compare_exchange đảm bảo atomic test-and-set — không race condition.
    pub fn try_acquire(&self) -> Option<SyncGuard> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .ok()
            .map(|_| SyncGuard(Arc::clone(&self.0)))
    }
}

/// RAII guard: khi Drop, tự động clear cờ AtomicBool.
/// Không cần caller nhớ gọi "release" thủ công — Rust đảm bảo Drop luôn chạy,
/// kể cả khi hàm return sớm qua `?` hoặc `return Err(...)`.
pub struct SyncGuard(Arc<AtomicBool>);

impl Drop for SyncGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

// ============================================================
// Codeforces API types
// ============================================================

#[derive(Debug, Deserialize)]
pub struct CfApiResponse<T> {
    pub status: String,
    pub comment: Option<String>,
    pub result: Option<T>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CfSubmission {
    pub id: i64,
    #[serde(rename = "contestId")]
    pub contest_id: Option<i64>,
    #[serde(rename = "creationTimeSeconds")]
    pub creation_time_seconds: i64,
    pub problem: CfProblem,
    #[serde(rename = "programmingLanguage")]
    pub programming_language: String,
    pub verdict: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CfProblem {
    #[serde(rename = "contestId")]
    pub contest_id: Option<i64>,
    pub index: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

// ============================================================
// Background Worker
// ============================================================

/// Entry point của background worker - gọi 1 lần trong Tauri setup hook,
/// chạy cho tới khi nhận tín hiệu shutdown qua `shutdown_rx`.
///
/// `interval_secs` là chu kỳ sync BÌNH THƯỜNG (khi mọi thứ hoạt động ổn định) -
/// khi gặp lỗi tạm thời (429/503), worker tự nhân đôi thời gian chờ mỗi lần
/// (exponential backoff) thay vì giữ nguyên interval_secs cố định, tới khi
/// chạm trần MAX_BACKOFF_SECS hoặc sync thành công trở lại thì reset về
/// interval_secs ban đầu.
///
/// Dùng `tokio::select!` để đồng thời chờ 1 trong 2 việc: hết thời gian sleep
/// (tới lượt sync tiếp theo) HOẶC nhận tín hiệu shutdown - CPU idle gần như
/// bằng 0% trong lúc chờ vì `tokio::time::sleep` không busy-poll, chỉ đăng ký
/// timer với reactor rồi nhường CPU hoàn toàn.
pub async fn start_cf_sync_worker(
    app_handle: AppHandle,
    db: SharedDb,
    client: Client,
    sync_lock: SyncLock,
    interval_secs: u64,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let base_interval = interval_secs.max(MIN_REQUEST_INTERVAL_SECS);
    let mut backoff_secs = base_interval;

    // A configured user receives one bounded historical import before normal
    // polling begins. Missing handles remain a non-fatal idle state.
    // Acquire lock for initial sync — if already locked (race on startup), skip.
    if let Some(_guard) = sync_lock.try_acquire() {
        match perform_sync(&app_handle, &client, &db, INITIAL_HISTORY_COUNT).await {
            Ok(_) | Err(AppError::HandleNotConfigured) => {}
            Err(AppError::RateLimited) | Err(AppError::ServiceUnavailable) => {
                backoff_secs = (base_interval * 2).min(MAX_BACKOFF_SECS);
            }
            Err(error) => eprintln!("[cf-worker] Initial sync failed (will retry): {error}"),
        }
    }

    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {
                // Try to acquire the lock; skip cycle if IPC trigger_cf_sync already holds it.
                let Some(_guard) = sync_lock.try_acquire() else {
                    println!("[cf-worker] Sync cycle skipped — manual sync in progress.");
                    continue;
                };

                match perform_sync(&app_handle, &client, &db, POLL_COUNT).await {
                    Ok(_) => {
                        // Thành công (dù có data mới hay không) -> reset về interval bình thường.
                        backoff_secs = base_interval;
                    }
                    Err(AppError::RateLimited) | Err(AppError::ServiceUnavailable) => {
                        backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
                        eprintln!(
                            "[cf-worker] CF API tạm thời không khả dụng, backoff lên {backoff_secs}s."
                        );
                    }
                    Err(AppError::HandleNotConfigured) => {
                        // Không phải lỗi thật - user đơn giản là chưa nhập CF handle.
                        // Giữ interval bình thường, worker tự thử lại đều đặn, không cần restart.
                        backoff_secs = base_interval;
                    }
                    Err(e) => {
                        eprintln!("[cf-worker] Lỗi sync cycle (không fatal, sẽ retry): {e}");
                        backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF_SECS);
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    println!("[cf-worker] Nhận tín hiệu shutdown, thoát vòng lặp gọn gàng.");
                    break;
                }
                // Nếu changed() trả về nhưng giá trị vẫn false (hiếm gặp, VD sender gửi
                // false lần đầu) thì quay lại select! chờ tiếp, không thoát nhầm.
            }
        }
    }
}

pub fn build_http_client() -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("diark-personal-os/0.1 (+local-desktop-app)")
        .build()
        .map_err(AppError::Http)
}

// ============================================================
// Core Sync Logic (shared between worker loop and IPC command)
// ============================================================

/// Chạy đúng 1 vòng: đọc handle -> gọi CF API -> lọc submission mới -> insert -> emit.
///
/// Hàm này được gọi từ CẢ HAI nơi:
/// 1. Background worker (mỗi `backoff_secs`).
/// 2. IPC command `trigger_cf_sync` (khi user bấm "Save & Sync" từ UI).
///
/// Lock (SyncGuard) KHÔNG được acquire ở đây — caller chịu trách nhiệm
/// acquire trước khi gọi, đảm bảo logic lock rõ ràng và không bị double-acquire.
pub async fn perform_sync(
    app_handle: &AppHandle,
    client: &Client,
    db: &SharedDb,
    count: u32,
) -> AppResult<SyncResult> {
    let handle = read_cf_handle(db)?;

    let url = format!("{CF_API_BASE}?handle={handle}&from=1&count={count}");
    let response = client.get(&url).send().await?;

    match response.status().as_u16() {
        429 => return Err(AppError::RateLimited),
        503 => return Err(AppError::ServiceUnavailable),
        _ => {}
    }

    let body: CfApiResponse<Vec<CfSubmission>> = response.json().await?;

    if body.status != "OK" {
        let reason = body.comment.unwrap_or_else(|| "Không rõ nguyên nhân".to_string());
        if reason.to_lowercase().contains("call limit exceeded") {
            return Err(AppError::RateLimited);
        }
        return Err(AppError::CfApiError(reason));
    }

    let raw_submissions = body.result.unwrap_or_default();

    let (sync_result, affected_dates) = {
        let mut conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
        let res = ingest_cf_submissions_with_result(&mut conn, &raw_submissions)?;
        let dates = res.affected_dates.clone();
        (res, dates)
        // Guard conn tự động DROP tại đây. Không giữ lock sang bước async/spawn!
    };

    if !affected_dates.is_empty() {
        let db_arc = db.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for date_str in affected_dates {
                if let Ok(conn) = db_arc.lock() {
                    if let Err(e) = crate::db::matrix::recompute_daily_matrix_for_date(&conn, &date_str) {
                        eprintln!("[Matrix Sync Error] Failed date {date_str}: {e}");
                    }
                }
            }
        });
    }

    if sync_result.new_submissions_count > 0 {
        // Emit THẲNG SyncResult làm payload - không tạo struct payload riêng,
        // tránh việc 2 struct (kết quả DB và payload event) lệch nhau theo thời
        // gian khi 1 trong 2 chỗ bị sửa mà quên sửa chỗ còn lại.
        app_handle.emit(EVENT_SYNC_COMPLETE, &sync_result)?;
        app_handle.emit(LEGACY_EVENT_SYNC, &sync_result)?;

        println!(
            "[cf-worker] +{} submission mới, +{} XP hôm nay, {} First AC.",
            sync_result.new_submissions_count,
            sync_result.total_daily_xp,
            sync_result.first_ac_count
        );
    }

    Ok(sync_result)
}

fn read_cf_handle(db: &SharedDb) -> AppResult<String> {
    let conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
    get_setting(&conn, SETTING_KEY_CF_HANDLE)?.ok_or(AppError::HandleNotConfigured)
}
