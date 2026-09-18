//! Moodle Course DOM Parser — Sprint v0.3.3
//!
//! Pure parser: không chạm DB, không chạm Tauri runtime.
//! Khóa selector theo HTML thực tế của UIT Moodle (`course/view.php`).
//!
//! ## Date format UIT Moodle
//! `"Thứ Sáu, 18 tháng 9 2026, 11:59 SA"` hoặc `"..., 11:59 CH"` (SA=AM, CH=PM)
//! Timezone: UTC+7 (Hồ Chí Minh). Parser dùng chrono chuẩn + offset cố định.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

// ============================================================
//  DATA CONTRACTS
// ============================================================

/// 1 deadline bài tập trích từ Moodle course page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScrapedDeadline {
    /// Format: `"{course_code}_{cmid}"` (e.g. `"SS009_11792"`)
    pub id: String,
    pub course_code: String,
    pub title: String,
    /// Unix epoch seconds (UTC)
    pub due_timestamp: i64,
    /// Raw string như hiển thị trên UI (e.g. `"18/09/2026 23:59"`)
    pub due_date_raw: String,
    pub source_url: String,
}

/// Kết quả parse 1 trang course.
#[derive(Debug, Serialize)]
pub struct CourseParseResult {
    pub course_code: String,
    pub course_title: String,
    pub deadlines: Vec<ScrapedDeadline>,
}

// ============================================================
//  HELPER: Course code extraction
// ============================================================

/// Trích mã môn từ header Moodle, ví dụ:
/// - `"Kỹ năng mềm - SS009.R12.250210"` → `"SS009"`
/// - `"IT003 - Cấu trúc dữ liệu"` → `"IT003"`
///
/// Regex-free: tìm token khớp pattern `[A-Z]{2,4}[0-9]{3}` sau phân tách bởi `-` hoặc space.
fn extract_course_code(raw_title: &str) -> String {
    // Thử tách bằng dấu `-` trước (format phổ biến Moodle UIT)
    let candidates: Vec<&str> = raw_title
        .split(['-', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();

    for part in &candidates {
        // Lấy phần trước dấu `.` (bỏ đuôi `.R12.250210`)
        let base = part.split('.').next().unwrap_or(part).trim();
        // Kiểm tra: bắt đầu bằng 2-4 ký tự in hoa, tiếp theo 3 chữ số
        let bytes = base.as_bytes();
        if bytes.len() >= 5
            && bytes.len() <= 7
            && bytes[..2].iter().all(|b| b.is_ascii_uppercase())
            && bytes[bytes.len() - 3..].iter().all(|b| b.is_ascii_digit())
        {
            return base.to_string();
        }
    }

    // Fallback: trả về token đầu tiên
    candidates
        .first()
        .map(|s| s.split('.').next().unwrap_or(s).trim().to_string())
        .unwrap_or_else(|| raw_title.trim().to_string())
}

// ============================================================
//  HELPER: Date parsing
// ============================================================

/// Parse chuỗi ngày Moodle UIT dạng tiếng Việt:
/// `"Thứ Sáu, 18 tháng 9 2026, 11:59 CH"` → Unix timestamp UTC
///
/// - `SA` = Sáng = AM, `CH` = Chiều = PM
/// - Timezone: UTC+7 cố định (không dùng chrono_tz để tránh dependency nặng)
pub(crate) fn parse_moodle_date(date_str: &str) -> Option<i64> {
    let clean = date_str.trim();

    // Split bằng dấu phẩy, bỏ phần thứ: "Thứ Sáu"
    let parts: Vec<&str> = clean.splitn(3, ',').collect();
    if parts.len() < 3 {
        return None;
    }

    // parts[1]: " 18 tháng 9 2026"
    let date_part = parts[1].trim();
    // parts[2]: " 11:59 CH"
    let time_part = parts[2].trim();

    // Parse ngày: "18 tháng 9 2026"
    let date_tokens: Vec<&str> = date_part.split_whitespace().collect();
    // Kỳ vọng: ["18", "tháng", "9", "2026"]
    if date_tokens.len() < 4 {
        return None;
    }
    let day: u32 = date_tokens[0].parse().ok()?;
    let month: u32 = date_tokens[2].parse().ok()?;
    let year: i32 = date_tokens[3].parse().ok()?;

    // Parse giờ: "11:59 CH" hoặc "11:59 SA"
    let time_tokens: Vec<&str> = time_part.split_whitespace().collect();
    if time_tokens.len() < 2 {
        return None;
    }
    let clock_parts: Vec<&str> = time_tokens[0].split(':').collect();
    if clock_parts.len() < 2 {
        return None;
    }
    let mut hour: u32 = clock_parts[0].parse().ok()?;
    let minute: u32 = clock_parts[1].parse().ok()?;

    // SA = AM, CH = PM (case-insensitive để xử lý cả "PM"/"AM" nếu locale đổi)
    let period = time_tokens[1].to_uppercase();
    let is_pm = period == "CH" || period == "PM";
    let is_am = period == "SA" || period == "AM";

    if is_pm && hour < 12 {
        hour += 12;
    } else if is_am && hour == 12 {
        hour = 0;
    }

    let naive_date = NaiveDate::from_ymd_opt(year, month, day)?;
    let naive_time = NaiveTime::from_hms_opt(hour, minute, 0)?;
    let naive_dt = NaiveDateTime::new(naive_date, naive_time);

    // UTC+7: subtract 7 hours để ra UTC epoch
    let utc_offset_secs: i64 = 7 * 3600;
    let utc_timestamp = naive_dt.and_utc().timestamp() - utc_offset_secs;

    Some(utc_timestamp)
}

// ============================================================
//  PURE PARSER
// ============================================================

/// Parse HTML của trang `course/view.php` Moodle UIT.
///
/// Selectors khóa theo DOM thực tế:
/// - Header: `header#page-header h1.h2`
/// - Assignment items: `li.activity.assign.modtype_assign`
/// - Title span: `div.activityname a.aalink span.instancename`
/// - Link: `div.activityname a.aalink`
/// - Date rows: `div[data-region='activity-dates'] div.date-item`
///
/// Trả lỗi nếu header không tìm thấy; deadline không parse được chỉ bị bỏ qua
/// (không phải lỗi fatal — môn học có thể chưa có deadline).
pub fn parse_moodle_course_view(html: &str) -> Result<CourseParseResult, String> {
    let doc = Html::parse_document(html);

    // --- 1. Header môn học ---
    let header_sel = Selector::parse("header#page-header h1.h2")
        .map_err(|e| format!("Invalid header selector: {e:?}"))?;

    let raw_header = doc
        .select(&header_sel)
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
        .ok_or_else(|| "Không tìm thấy tiêu đề môn học (header#page-header h1.h2)".to_string())?;

    if raw_header.is_empty() {
        return Err("Tiêu đề môn học trống — DOM có thể chưa hydrate xong".to_string());
    }

    let course_code = extract_course_code(&raw_header);

    // --- 2. Assignment activities ---
    let assign_sel = Selector::parse("li.activity.assign.modtype_assign")
        .map_err(|e| format!("Invalid assign selector: {e:?}"))?;
    let title_sel = Selector::parse("div.activityname a.aalink span.instancename")
        .map_err(|e| format!("Invalid title selector: {e:?}"))?;
    let link_sel = Selector::parse("div.activityname a.aalink")
        .map_err(|e| format!("Invalid link selector: {e:?}"))?;
    let date_region_sel =
        Selector::parse("div[data-region='activity-dates'] div.date-item")
            .map_err(|e| format!("Invalid date selector: {e:?}"))?;

    let mut deadlines = Vec::new();

    for item in doc.select(&assign_sel) {
        // cmid = data-id attribute trên li.activity
        let cmid = match item.value().attr("data-id") {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue, // không có cmid không thể tạo ID duy nhất
        };

        // Tiêu đề bài tập — bỏ suffix Moodle thêm như "Bài tập"
        let raw_title = item
            .select(&title_sel)
            .next()
            .map(|el| el.text().collect::<String>())
            .unwrap_or_default();
        let title = raw_title
            .replace("Bài tập", "")
            .replace('\u{00a0}', " ") // non-breaking space
            .trim()
            .to_string();

        if title.is_empty() {
            continue; // bài tập không tên → bỏ qua
        }

        let source_url = item
            .select(&link_sel)
            .next()
            .and_then(|el| el.value().attr("href"))
            .unwrap_or_default()
            .to_string();

        // Tìm date-item chứa "Due:"
        for date_item in item.select(&date_region_sel) {
            let text = date_item.text().collect::<String>();
            if !text.contains("Due:") && !text.contains("Hạn nộp:") {
                continue;
            }

            // Bỏ prefix "Due:" hoặc "Hạn nộp:"
            let due_text = text
                .replace("Due:", "")
                .replace("Hạn nộp:", "")
                .trim()
                .to_string();

            if due_text.is_empty() {
                continue;
            }

            let Some(timestamp) = parse_moodle_date(&due_text) else {
                // Log nhưng không abort — deadline format không nhận dạng được
                eprintln!(
                    "[moodle_parser] Không parse được date '{}' cho '{}' (cmid={})",
                    due_text, title, cmid
                );
                continue;
            };

            // due_date_raw: normalize sang format "DD/MM/YYYY HH:MM" để display
            let due_date_raw = format_display_date(timestamp);

            deadlines.push(ScrapedDeadline {
                id: format!("{}_{}", course_code, cmid),
                course_code: course_code.clone(),
                title: title.clone(),
                due_timestamp: timestamp,
                due_date_raw,
                source_url: source_url.clone(),
            });

            break; // Chỉ lấy 1 "Due" date mỗi activity
        }
    }

    Ok(CourseParseResult {
        course_code,
        course_title: raw_header,
        deadlines,
    })
}

/// Format Unix timestamp ra chuỗi display `"DD/MM/YYYY HH:MM"` (UTC+7).
fn format_display_date(ts: i64) -> String {
    let naive = chrono::DateTime::from_timestamp(ts + 7 * 3600, 0)
        .map(|dt| dt.naive_utc())
        .unwrap_or_default();
    naive.format("%d/%m/%Y %H:%M").to_string()
}

// ============================================================
//  UNIT TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Timelike};

    #[test]
    fn test_parse_moodle_date_ch_pm() {
        // "CH" = Chiều = PM
        let sample = "Thứ Sáu, 18 tháng 9 2026, 11:59 CH";
        let ts = parse_moodle_date(sample).expect("Parse date phải thành công");
        // 2026-09-18 23:59 UTC+7 = 2026-09-18 16:59 UTC
        let dt = DateTime::from_timestamp(ts, 0).unwrap();
        assert_eq!(dt.hour(), 16);
        assert_eq!(dt.minute(), 59);
        // Kiểm tra ts > 0 và trong khoảng hợp lý
        assert!(ts > 1_700_000_000, "timestamp phải lớn hơn 2023");
        assert!(ts < 2_000_000_000, "timestamp phải nhỏ hơn 2033");
    }

    #[test]
    fn test_parse_moodle_date_sa_am() {
        let sample = "Thứ Hai, 1 tháng 1 2026, 8:00 SA";
        let ts = parse_moodle_date(sample).expect("Parse phải thành công");
        assert!(ts > 0);
        // 08:00 SA UTC+7 = 01:00 UTC
        let dt = DateTime::from_timestamp(ts, 0).unwrap();
        assert_eq!(dt.hour(), 1); // 8 SA - 7h = 1 UTC
        assert_eq!(dt.minute(), 0);
    }

    #[test]
    fn test_parse_moodle_date_midnight_sa() {
        // 12:00 SA = 12:00 AM = 00:00
        let sample = "Thứ Tư, 15 tháng 6 2026, 12:00 SA";
        let ts = parse_moodle_date(sample).expect("Parse phải thành công");
        let dt = DateTime::from_timestamp(ts, 0).unwrap();
        // 00:00 local - 7h = 17:00 UTC ngày hôm trước
        assert_eq!(dt.hour(), 17);
        assert_eq!(dt.minute(), 0);
    }

    #[test]
    fn test_parse_moodle_date_returns_none_for_garbage() {
        assert!(parse_moodle_date("not a date").is_none());
        assert!(parse_moodle_date("").is_none());
        assert!(parse_moodle_date("18/09/2026").is_none());
    }

    #[test]
    fn test_extract_course_code_standard_moodle_format() {
        assert_eq!(extract_course_code("Kỹ năng mềm - SS009.R12.250210"), "SS009");
        assert_eq!(extract_course_code("IT003 - Cấu trúc dữ liệu và giải thuật"), "IT003");
        assert_eq!(extract_course_code("CS115.KHMT - Nhập môn lập trình"), "CS115");
    }

    #[test]
    fn test_parse_moodle_course_view_full_page() {
        let html = r#"
        <!DOCTYPE html>
        <html>
        <head><title>SS009</title></head>
        <body>
            <header id="page-header">
                <h1 class="h2">Kỹ năng mềm - SS009.R12.250210</h1>
            </header>
            <ul>
                <li class="activity assign modtype_assign" data-id="11792">
                    <div class="activityname">
                        <a class="aalink" href="https://courses.uit.edu.vn/mod/assign/view.php?id=11792">
                            <span class="instancename">ĐĂNG KÝ ĐỀ TÀI NHÓM<span class="accesshide">Bài tập</span></span>
                        </a>
                    </div>
                    <div data-region="activity-dates">
                        <div class="date-item">Due: Thứ Năm, 18 tháng 9 2026, 11:59 CH</div>
                    </div>
                </li>
                <li class="activity assign modtype_assign" data-id="11850">
                    <div class="activityname">
                        <a class="aalink" href="https://courses.uit.edu.vn/mod/assign/view.php?id=11850">
                            <span class="instancename">BÀI TẬP CUỐI KỲ<span class="accesshide">Bài tập</span></span>
                        </a>
                    </div>
                    <div data-region="activity-dates">
                        <div class="date-item">Due: Thứ Sáu, 3 tháng 1 2026, 11:59 CH</div>
                    </div>
                </li>
            </ul>
        </body>
        </html>
        "#;

        let result = parse_moodle_course_view(html).expect("Parse phải thành công");
        assert_eq!(result.course_code, "SS009");
        assert_eq!(result.deadlines.len(), 2);

        let d0 = &result.deadlines[0];
        assert_eq!(d0.id, "SS009_11792");
        assert_eq!(d0.title, "ĐĂNG KÝ ĐỀ TÀI NHÓM");
        assert!(d0.due_timestamp > 0);
        assert_eq!(d0.source_url, "https://courses.uit.edu.vn/mod/assign/view.php?id=11792");

        let d1 = &result.deadlines[1];
        assert_eq!(d1.id, "SS009_11850");
        assert_eq!(d1.title, "BÀI TẬP CUỐI KỲ");
    }

    #[test]
    fn test_parse_moodle_course_view_no_header_returns_error() {
        let html = "<html><body><p>No header here</p></body></html>";
        let result = parse_moodle_course_view(html);
        assert!(result.is_err(), "Thiếu header phải trả Err");
    }

    #[test]
    fn test_parse_moodle_course_view_no_deadlines_ok() {
        let html = r#"
        <html><body>
            <header id="page-header"><h1 class="h2">IT003 - Cấu trúc dữ liệu</h1></header>
        </body></html>
        "#;
        let result = parse_moodle_course_view(html).expect("Không có deadline vẫn phải Ok");
        assert_eq!(result.course_code, "IT003");
        assert!(result.deadlines.is_empty());
    }
}
