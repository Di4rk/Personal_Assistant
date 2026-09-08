use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::db::{batch_insert_new_submissions, get_setting, NewSubmission, SharedDb};
use crate::error::{AppError, AppResult};

const CF_API_BASE: &str = "https://codeforces.com/api/user.status";
/// Chỉ cần lấy N submission gần nhất mỗi cycle - đủ để bắt kịp hoạt động
/// thực tế (không ai submit quá 30 bài/phút), không cần kéo cả lịch sử.
const FETCH_COUNT: u32 = 30;
/// Trần backoff - dù CF API sập bao lâu, worker cũng không ngủ quá 15 phút/lần,
/// để còn kịp phát hiện lúc server sống lại mà không cần restart app.
const MAX_BACKOFF_SECS: u64 = 15 * 60;

const EVENT_SYNC: &str = "cf://sync-event";
const SETTING_KEY_CF_HANDLE: &str = "cf_handle";

#[derive(Debug, Deserialize)]
struct CfApiResponse {
    status: String,
    result: Option<Vec<CfSubmission>>,
    comment: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfSubmission {
    id: i64,
    creation_time_seconds: i64,
    verdict: Option<String>,
    programming_language: String,
    problem: CfProblem,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfProblem {
    contest_id: Option<i64>,
    index: String,
    name: String,
}

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
    interval_secs: u64,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let client = match build_http_client() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[cf-worker] Không tạo được HTTP client: {e}. Worker dừng vĩnh viễn.");
            return;
        }
    };

    let base_interval = interval_secs.max(5); // sàn 5s, tránh cấu hình nhầm 0 gây spam API
    let mut backoff_secs = base_interval;

    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {
                match run_sync_cycle(&client, &db, &app_handle).await {
                    Ok(()) => {
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

fn build_http_client() -> AppResult<Client> {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("jarvis-personal-os/0.1 (+local-desktop-app)")
        .build()
        .map_err(AppError::Http)
}

/// Chạy đúng 1 vòng: đọc handle -> gọi CF API -> lọc submission mới -> insert -> emit.
/// Trả về AppResult<()> để caller (vòng lặp worker) quyết định backoff phù hợp
/// dựa theo LOẠI lỗi cụ thể, thay vì backoff mù quáng cho mọi trường hợp.
async fn run_sync_cycle(client: &Client, db: &SharedDb, app_handle: &AppHandle) -> AppResult<()> {
    let handle = read_cf_handle(db)?;

    let url = format!("{CF_API_BASE}?handle={handle}&from=1&count={FETCH_COUNT}");
    let response = client.get(&url).send().await?;

    match response.status().as_u16() {
        429 => return Err(AppError::RateLimited),
        503 => return Err(AppError::ServiceUnavailable),
        _ => {}
    }

    let body: CfApiResponse = response.json().await?;

    if body.status != "OK" {
        let reason = body.comment.unwrap_or_else(|| "Không rõ nguyên nhân".to_string());
        return Err(AppError::CfApiError(reason));
    }

    let raw_submissions = body.result.unwrap_or_default();
    let new_submissions = filter_and_convert(raw_submissions);

    if new_submissions.is_empty() {
        return Ok(());
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    let sync_result = {
        let mut conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
        batch_insert_new_submissions(&mut conn, &new_submissions, &today)?
    };

    if sync_result.new_submissions_count > 0 {
        // Emit THẲNG SyncResult làm payload - không tạo struct payload riêng,
        // tránh việc 2 struct (kết quả DB và payload event) lệch nhau theo thời
        // gian khi 1 trong 2 chỗ bị sửa mà quên sửa chỗ còn lại.
        app_handle.emit(EVENT_SYNC, &sync_result)?;

        println!(
            "[cf-worker] +{} submission mới, +{} XP hôm nay, {} First AC.",
            sync_result.new_submissions_count,
            sync_result.total_daily_xp,
            sync_result.first_ac_count
        );
    }

    Ok(())
}

fn read_cf_handle(db: &SharedDb) -> AppResult<String> {
    let conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
    get_setting(&conn, SETTING_KEY_CF_HANDLE)?.ok_or(AppError::HandleNotConfigured)
}

/// Chuyển raw CfSubmission (JSON API) -> NewSubmission (DB layer), đồng thời
/// LỌC BỎ submission chưa có verdict cuối cùng ("TESTING" hoặc null - đang chấm
/// dở). Lần fetch kế tiếp sẽ tự bắt được verdict cuối khi đã chấm xong, vì
/// user.status luôn trả về trạng thái mới nhất của mọi submission.
fn filter_and_convert(raw: Vec<CfSubmission>) -> Vec<NewSubmission> {
    raw.into_iter()
        .filter_map(|s| {
            let verdict = s.verdict?;
            if verdict == "TESTING" {
                return None;
            }

            let contest_id = s.problem.contest_id.map(|id| id.to_string());
            let problem_id = match &contest_id {
                Some(cid) => format!("{cid}{}", s.problem.index),
                None => s.problem.index.clone(),
            };

            let submitted_at = chrono::DateTime::from_timestamp(s.creation_time_seconds, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| chrono::Local::now().to_rfc3339());

            Some(NewSubmission {
                cf_submission_id: s.id,
                problem_id,
                problem_name: s.problem.name,
                verdict,
                language: s.programming_language,
                contest_id,
                submitted_at,
            })
        })
        .collect()
}
