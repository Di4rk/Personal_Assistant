use chrono::{Duration, Local, NaiveDate};
use rand::Rng;
use rusqlite::{params, Connection, Result as SqlResult};

use super::schema::calc_xp;

/// Prefix để đánh dấu record là mock - tuyệt đối không lẫn với data thật.
/// Mọi query "clear mock" dựa vào prefix này để xoá đúng và chỉ đúng data giả.
pub const MOCK_PREFIX: &str = "MOCK_";

const VERDICT_POOL: [(&str, u8); 4] = [
    ("OK", 55),                  // 55% AC - tỉ lệ hợp lý cho người đang luyện tập
    ("WRONG_ANSWER", 25),
    ("TIME_LIMIT_EXCEEDED", 12),
    ("RUNTIME_ERROR", 8),
];

fn pick_verdict(rng: &mut impl Rng) -> &'static str {
    let roll: u8 = rng.gen_range(0..100);
    let mut acc = 0u8;
    for (verdict, weight) in VERDICT_POOL {
        acc += weight;
        if roll < acc {
            return verdict;
        }
    }
    "OK"
}

/// Sinh dữ liệu giả cho `days_back` ngày gần nhất (tính cả hôm nay), ghi thẳng
/// vào submissions + daily_activity giống hệt luồng insert thật, để UI (heatmap,
/// stat card, recent submissions) render đúng như khi có data thật.
///
/// Mô phỏng thói quen thật: không phải ngày nào cũng cày - có ngày nghỉ (rest),
/// có ngày cày nhẹ, có ngày "God Mode" nhiều submission, giống pattern user thật.
pub fn seed_mock_data(conn: &mut Connection, days_back: i64) -> SqlResult<usize> {
    let mut rng = rand::thread_rng();
    let today = Local::now().date_naive();
    let mut total_inserted = 0usize;

    for offset in 0..days_back {
        let date: NaiveDate = today - Duration::days(offset);
        let date_str = date.format("%Y-%m-%d").to_string();

        // 25% khả năng là ngày nghỉ hoàn toàn - không insert gì, giữ ô Xám trên heatmap.
        if rng.gen_bool(0.25) {
            continue;
        }

        // Số submission trong ngày: đa số ngày nhẹ (1-3 bài), thi thoảng "God Mode" (8-15 bài).
        let is_god_mode_day = rng.gen_bool(0.1);
        let submission_count = if is_god_mode_day {
            rng.gen_range(8..=15)
        } else {
            rng.gen_range(1..=4)
        };

        let tx = conn.transaction()?;
        let mut day_xp = 0i64;
        let mut ac_count = 0i64;
        let mut wa_count = 0i64;
        let mut other_count = 0i64;

        for i in 0..submission_count {
            let problem_num: u32 = rng.gen_range(1000..2100);
            let problem_letter = (b'A' + rng.gen_range(0..6)) as char;
            let problem_id = format!("{MOCK_PREFIX}{problem_num}{problem_letter}");
            let verdict = pick_verdict(&mut rng);
            let xp = calc_xp(verdict);

            // Giờ submit rải trong ngày cho hợp lý (không phải tất cả cùng 1 giờ)
            let hour = rng.gen_range(6..24);
            let minute = rng.gen_range(0..60);
            let submitted_at = format!("{date_str}T{hour:02}:{minute:02}:00+07:00");

            tx.execute(
                "INSERT INTO submissions
                    (problem_id, problem_name, verdict, language, contest_id, xp_awarded, submitted_at, raw_payload)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    problem_id,
                    format!("Mock Problem {problem_num}{problem_letter}"),
                    verdict,
                    "GNU C++20",
                    format!("{MOCK_PREFIX}{problem_num}"),
                    xp,
                    submitted_at,
                    "{\"mock\": true}",
                ],
            )?;

            day_xp += xp;
            match verdict {
                "OK" => ac_count += 1,
                "WRONG_ANSWER" | "TIME_LIMIT_EXCEEDED" => wa_count += 1,
                _ => other_count += 1,
            }
            total_inserted += 1;
            let _ = i; // giữ biến cho rõ ràng vòng lặp, không dùng gì thêm
        }

        tx.execute(
            r#"
            INSERT INTO daily_activity (date, total_xp, ac_count, wa_count, other_count, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(date) DO UPDATE SET
                total_xp    = total_xp + excluded.total_xp,
                ac_count    = ac_count + excluded.ac_count,
                wa_count    = wa_count + excluded.wa_count,
                other_count = other_count + excluded.other_count,
                updated_at  = excluded.updated_at
            "#,
            params![date_str, day_xp, ac_count, wa_count, other_count, Local::now().to_rfc3339()],
        )?;

        tx.commit()?;
    }

    Ok(total_inserted)
}

/// Xoá sạch mọi record mock (nhận diện qua MOCK_PREFIX), tính lại daily_activity
/// từ đầu để tránh lệch số (không đơn giản trừ ngược, dễ sai nếu có data thật xen kẽ).
pub fn clear_mock_data(conn: &mut Connection) -> SqlResult<usize> {
    let tx = conn.transaction()?;

    let pattern = format!("{MOCK_PREFIX}%");
    let deleted = tx.execute(
        "DELETE FROM submissions WHERE problem_id LIKE ?1",
        params![pattern],
    )?;

    // Rebuild lại daily_activity từ bảng submissions còn lại (nguồn sự thật duy nhất),
    // an toàn hơn nhiều so với cộng/trừ thủ công.
    tx.execute("DELETE FROM daily_activity", [])?;
    tx.execute(
        r#"
        INSERT INTO daily_activity (date, total_xp, ac_count, wa_count, other_count, updated_at)
        SELECT
            substr(submitted_at, 1, 10) AS date,
            SUM(xp_awarded),
            SUM(CASE WHEN verdict = 'OK' THEN 1 ELSE 0 END),
            SUM(CASE WHEN verdict IN ('WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED') THEN 1 ELSE 0 END),
            SUM(CASE WHEN verdict NOT IN ('OK', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED') THEN 1 ELSE 0 END),
            datetime('now')
        FROM submissions
        GROUP BY date
        "#,
        [],
    )?;

    tx.commit()?;
    Ok(deleted)
}
