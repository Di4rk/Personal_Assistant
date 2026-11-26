use chrono::{Datelike, Duration as ChronoDuration, FixedOffset, Months, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc, Weekday};
use chrono_tz::Tz;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use crate::db::exam::AcademicExamRecord;
use crate::db::portal_extra::{CalendarEventRecord, PortalTimetableRecord};

const MAX_RRULE_INSTANCES: usize = 500;
const MAX_RRULE_SCAN_STEPS: usize = 5000;
const WINDOW_PAST_DAYS: i64 = 90;
const WINDOW_FUTURE_DAYS: i64 = 365;

/// Mở rộng các dòng bị gập theo RFC 5545 (CRLF/LF theo sau bởi khoảng trắng hoặc tab).
fn unfold_ics_lines(raw: &str) -> Vec<String> {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = Vec::new();
    for line in normalized.lines() {
        if let Some(rest) = line.strip_prefix(' ').or_else(|| line.strip_prefix('\t')) {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        lines.push(line.to_string());
    }
    lines
}

fn unescape_ics_text(input: &str) -> String {
    input
        .replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
}

fn extract_tzid_param(prop_part: &str) -> Option<String> {
    for param in prop_part.split(';').skip(1) {
        if let Some((k, v)) = param.split_once('=') {
            if k.trim().eq_ignore_ascii_case("TZID") {
                let cleaned = v.trim().trim_matches('"').trim();
                if !cleaned.is_empty() {
                    return Some(cleaned.to_string());
                }
            }
        }
    }
    None
}

fn resolve_local_datetime_with_tz(dt: NaiveDateTime, tzid_opt: Option<&str>) -> Option<i64> {
    if let Some(raw_tz) = tzid_opt {
        let upper = raw_tz.to_ascii_uppercase();
        if upper == "UTC" || upper == "GMT" || upper.starts_with("ETC/UTC") || upper.starts_with("ETC/GMT") {
            return Some(dt.and_utc().timestamp());
        }
        if let Ok(tz) = raw_tz.parse::<Tz>() {
            if let Some(resolved) = tz.from_local_datetime(&dt).earliest() {
                return Some(resolved.timestamp());
            }
            if let Some(resolved) = tz.from_local_datetime(&dt).latest() {
                return Some(resolved.timestamp());
            }
        }
    }

    let offset = FixedOffset::east_opt(7 * 3600)?;
    offset
        .from_local_datetime(&dt)
        .single()
        .map(|d| d.timestamp())
        .or_else(|| Some(dt.and_utc().timestamp() - 7 * 3600))
}

/// Phân tích chuỗi DTSTART/DTEND của RFC 5545 sang `(unix_ts, all_day)`.
fn parse_ics_datetime(prop_part: &str, value: &str) -> Option<(i64, bool)> {
    let clean = value.trim();
    let tzid = extract_tzid_param(prop_part);

    // All-day: YYYYMMDD
    if clean.len() == 8 && clean.chars().all(|c| c.is_ascii_digit()) {
        let date = NaiveDate::parse_from_str(clean, "%Y%m%d").ok()?;
        let dt = NaiveDateTime::new(date, NaiveTime::from_hms_opt(0, 0, 0)?);
        let offset = FixedOffset::east_opt(7 * 3600)?;
        let ts = offset
            .from_local_datetime(&dt)
            .single()
            .map(|d| d.timestamp())
            .unwrap_or_else(|| dt.and_utc().timestamp() - 7 * 3600);
        return Some((ts, true));
    }

    // UTC: YYYYMMDDTHHMMSSZ
    if clean.ends_with('Z') && clean.len() >= 16 {
        let core = clean.trim_end_matches('Z');
        let dt = NaiveDateTime::parse_from_str(core, "%Y%m%dT%H%M%S").ok()?;
        return Some((dt.and_utc().timestamp(), false));
    }

    // TZID hoặc floating local time: YYYYMMDDTHHMMSS
    if clean.len() >= 15 && clean.contains('T') {
        let dt = NaiveDateTime::parse_from_str(&clean[..15], "%Y%m%dT%H%M%S").ok()?;
        let ts = resolve_local_datetime_with_tz(dt, tzid.as_deref())?;
        return Some((ts, false));
    }

    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RruleFreq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
struct ParsedRrule {
    freq: RruleFreq,
    interval: u32,
    count: Option<usize>,
    until_ts: Option<i64>,
    byday: Vec<Weekday>,
}

fn parse_weekday_code(token: &str) -> Option<Weekday> {
    let trimmed = token.trim().to_ascii_uppercase();
    let suffix = if trimmed.len() >= 2 {
        &trimmed[trimmed.len() - 2..]
    } else {
        return None;
    };
    match suffix {
        "MO" => Some(Weekday::Mon),
        "TU" => Some(Weekday::Tue),
        "WE" => Some(Weekday::Wed),
        "TH" => Some(Weekday::Thu),
        "FR" => Some(Weekday::Fri),
        "SA" => Some(Weekday::Sat),
        "SU" => Some(Weekday::Sun),
        _ => None,
    }
}

fn parse_rrule(raw: &str, tzid_opt: Option<&str>) -> Option<ParsedRrule> {
    let mut freq: Option<RruleFreq> = None;
    let mut interval: u32 = 1;
    let mut count: Option<usize> = None;
    let mut until_ts: Option<i64> = None;
    let mut byday: Vec<Weekday> = Vec::new();

    for part in raw.trim().split(';') {
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        let key = k.trim().to_ascii_uppercase();
        let val = v.trim();
        match key.as_str() {
            "FREQ" => {
                freq = match val.to_ascii_uppercase().as_str() {
                    "DAILY" => Some(RruleFreq::Daily),
                    "WEEKLY" => Some(RruleFreq::Weekly),
                    "MONTHLY" => Some(RruleFreq::Monthly),
                    "YEARLY" => Some(RruleFreq::Yearly),
                    _ => None,
                };
            }
            "INTERVAL" => {
                if let Ok(n) = val.parse::<u32>() {
                    interval = n.max(1);
                }
            }
            "COUNT" => {
                if let Ok(n) = val.parse::<usize>() {
                    count = Some(n);
                }
            }
            "UNTIL" => {
                if let Some((ts, all_day)) = parse_ics_datetime(
                    tzid_opt
                        .map(|t| format!("UNTIL;TZID={t}"))
                        .as_deref()
                        .unwrap_or("UNTIL"),
                    val,
                ) {
                    // RFC 5545: UNTIL dạng DATE bao gồm trọn ngày đó
                    until_ts = Some(if all_day { ts + 86399 } else { ts });
                }
            }
            "BYDAY" => {
                for item in val.split(',') {
                    if let Some(wd) = parse_weekday_code(item) {
                        if !byday.contains(&wd) {
                            byday.push(wd);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    Some(ParsedRrule {
        freq: freq?,
        interval,
        count,
        until_ts,
        byday,
    })
}

fn to_local_naive_for_recurrence(ts: i64, tzid_opt: Option<&str>) -> NaiveDateTime {
    if let Some(raw_tz) = tzid_opt {
        if let Ok(tz) = raw_tz.parse::<Tz>() {
            if let Some(utc_dt) = chrono::DateTime::<Utc>::from_timestamp(ts, 0) {
                return utc_dt.with_timezone(&tz).naive_local();
            }
        }
    }
    if let Some(offset) = FixedOffset::east_opt(7 * 3600) {
        if let Some(utc_dt) = chrono::DateTime::<Utc>::from_timestamp(ts, 0) {
            return utc_dt.with_timezone(&offset).naive_local();
        }
    }
    chrono::DateTime::<Utc>::from_timestamp(ts + 7 * 3600, 0)
        .map(|d| d.naive_utc())
        .unwrap_or_default()
}

fn expand_rrule_occurrences(
    base_start_ts: i64,
    tzid_opt: Option<&str>,
    rrule: &ParsedRrule,
    now_ts: i64,
) -> Vec<i64> {
    let base_local = to_local_naive_for_recurrence(base_start_ts, tzid_opt);
    let base_time = base_local.time();
    let window_start = now_ts - WINDOW_PAST_DAYS * 86400;
    let window_end = now_ts + WINDOW_FUTURE_DAYS * 86400;
    let has_bounded_count = rrule.count.is_some();

    let mut out = Vec::new();
    let max_instances = rrule
        .count
        .map(|c| c.min(MAX_RRULE_INSTANCES))
        .unwrap_or(MAX_RRULE_INSTANCES);

    if max_instances == 0 {
        return out;
    }

    let mut push_candidate = |candidate_ts: i64| -> bool {
        if candidate_ts < base_start_ts {
            return true;
        }
        if let Some(until) = rrule.until_ts {
            if candidate_ts > until {
                return false;
            }
        }
        if !has_bounded_count && candidate_ts > window_end {
            return false;
        }
        if has_bounded_count || candidate_ts >= window_start {
            out.push(candidate_ts);
        }
        out.len() < max_instances
    };

    match rrule.freq {
        RruleFreq::Daily => {
            let interval_days = i64::from(rrule.interval);
            let mut step: i64 = 0;
            if !has_bounded_count && base_start_ts < window_start {
                let diff_days = (window_start - base_start_ts) / 86400;
                step = (diff_days / interval_days).max(0);
            }
            for _ in 0..MAX_RRULE_SCAN_STEPS {
                let target_date = base_local.date() + ChronoDuration::days(step * interval_days);
                let cand_dt = NaiveDateTime::new(target_date, base_time);
                if let Some(ts) = resolve_local_datetime_with_tz(cand_dt, tzid_opt) {
                    if !push_candidate(ts) {
                        break;
                    }
                }
                step += 1;
            }
        }
        RruleFreq::Weekly => {
            let interval_weeks = i64::from(rrule.interval);
            let base_monday_offset = i64::from(base_local.date().weekday().num_days_from_monday());
            let base_week_monday = base_local.date() - ChronoDuration::days(base_monday_offset);
            let mut days: Vec<Weekday> = if rrule.byday.is_empty() {
                vec![base_local.date().weekday()]
            } else {
                rrule.byday.clone()
            };
            days.sort_by_key(|wd| wd.num_days_from_monday());

            let mut week_step: i64 = 0;
            if !has_bounded_count && base_start_ts < window_start {
                let diff_weeks = (window_start - base_start_ts) / (7 * 86400);
                week_step = (diff_weeks / interval_weeks).max(0);
            }

            let mut keep_going = true;
            for _ in 0..MAX_RRULE_SCAN_STEPS {
                if !keep_going {
                    break;
                }
                let week_start = base_week_monday + ChronoDuration::weeks(week_step * interval_weeks);
                for wd in &days {
                    let target_date = week_start + ChronoDuration::days(i64::from(wd.num_days_from_monday()));
                    let cand_dt = NaiveDateTime::new(target_date, base_time);
                    if let Some(ts) = resolve_local_datetime_with_tz(cand_dt, tzid_opt) {
                        if !push_candidate(ts) {
                            keep_going = false;
                            break;
                        }
                    }
                }
                week_step += 1;
            }
        }
        RruleFreq::Monthly => {
            for month_step in 0..MAX_RRULE_SCAN_STEPS {
                let months_to_add = u32::try_from(month_step)
                    .unwrap_or(u32::MAX)
                    .saturating_mul(rrule.interval);
                let Some(target_date) = base_local.date().checked_add_months(Months::new(months_to_add)) else {
                    break;
                };
                if target_date.day() != base_local.date().day() {
                    continue;
                }
                let cand_dt = NaiveDateTime::new(target_date, base_time);
                if let Some(ts) = resolve_local_datetime_with_tz(cand_dt, tzid_opt) {
                    if !push_candidate(ts) {
                        break;
                    }
                }
            }
        }
        RruleFreq::Yearly => {
            for year_step in 0..MAX_RRULE_SCAN_STEPS {
                let months_to_add = u32::try_from(year_step)
                    .unwrap_or(u32::MAX)
                    .saturating_mul(rrule.interval)
                    .saturating_mul(12);
                let Some(target_date) = base_local.date().checked_add_months(Months::new(months_to_add)) else {
                    break;
                };
                if target_date.month() != base_local.date().month()
                    || target_date.day() != base_local.date().day()
                {
                    continue;
                }
                let cand_dt = NaiveDateTime::new(target_date, base_time);
                if let Some(ts) = resolve_local_datetime_with_tz(cand_dt, tzid_opt) {
                    if !push_candidate(ts) {
                        break;
                    }
                }
            }
        }
    }

    out
}

struct RawVEvent {
    uid: String,
    summary: String,
    description: String,
    location: String,
    start_opt: Option<(i64, bool)>,
    end_opt: Option<(i64, bool)>,
    start_tzid: Option<String>,
    rrule_raw: Option<String>,
    exdates: Vec<i64>,
    recurrence_id: Option<i64>,
}

/// Phân tích toàn bộ VEVENT từ nội dung file `.ics` (hỗ trợ `TZID`, `RRULE`, `EXDATE`, `RECURRENCE-ID`).
pub fn parse_ics_events(calendar_id: &str, ics_text: &str) -> Vec<CalendarEventRecord> {
    let lines = unfold_ics_lines(ics_text);
    let now_ts = Utc::now().timestamp();

    let mut raw_events: Vec<RawVEvent> = Vec::new();
    let mut in_event = false;
    let mut uid = String::new();
    let mut summary = String::new();
    let mut description = String::new();
    let mut location = String::new();
    let mut start_opt: Option<(i64, bool)> = None;
    let mut end_opt: Option<(i64, bool)> = None;
    let mut start_tzid: Option<String> = None;
    let mut rrule_raw: Option<String> = None;
    let mut exdates: Vec<i64> = Vec::new();
    let mut recurrence_id: Option<i64> = None;

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "BEGIN:VEVENT" {
            in_event = true;
            uid.clear();
            summary.clear();
            description.clear();
            location.clear();
            start_opt = None;
            end_opt = None;
            start_tzid = None;
            rrule_raw = None;
            exdates.clear();
            recurrence_id = None;
            continue;
        }
        if trimmed == "END:VEVENT" {
            if in_event && start_opt.is_some() {
                raw_events.push(RawVEvent {
                    uid: uid.trim().to_string(),
                    summary: summary.trim().to_string(),
                    description: description.trim().to_string(),
                    location: location.trim().to_string(),
                    start_opt,
                    end_opt,
                    start_tzid: start_tzid.take(),
                    rrule_raw: rrule_raw.take(),
                    exdates: std::mem::take(&mut exdates),
                    recurrence_id,
                });
            }
            in_event = false;
            continue;
        }

        if !in_event {
            continue;
        }

        let Some((raw_key, raw_val)) = line.split_once(':') else {
            continue;
        };
        let prop_name = raw_key
            .split(';')
            .next()
            .unwrap_or(raw_key)
            .trim()
            .to_ascii_uppercase();

        match prop_name.as_str() {
            "UID" => uid = raw_val.trim().to_string(),
            "SUMMARY" => summary = unescape_ics_text(raw_val),
            "DESCRIPTION" => description = unescape_ics_text(raw_val),
            "LOCATION" => location = unescape_ics_text(raw_val),
            "DTSTART" => {
                start_tzid = extract_tzid_param(raw_key);
                start_opt = parse_ics_datetime(raw_key, raw_val);
            }
            "DTEND" => end_opt = parse_ics_datetime(raw_key, raw_val),
            "RRULE" => rrule_raw = Some(raw_val.trim().to_string()),
            "EXDATE" => {
                for token in raw_val.split(',') {
                    if let Some((ts, _)) = parse_ics_datetime(raw_key, token) {
                        exdates.push(ts);
                    }
                }
            }
            "RECURRENCE-ID" => {
                recurrence_id = parse_ics_datetime(raw_key, raw_val).map(|(ts, _)| ts);
            }
            _ => {}
        }
    }

    // Gom danh sách timestamp bị RECURRENCE-ID ghi đè để loại bản gốc khỏi RRULE
    let mut overridden_timestamps: HashMap<String, HashSet<i64>> = HashMap::new();
    for ev in &raw_events {
        if !ev.uid.is_empty() {
            if let Some(rec_ts) = ev.recurrence_id {
                overridden_timestamps
                    .entry(ev.uid.clone())
                    .or_default()
                    .insert(rec_ts);
            }
        }
    }

    let mut events = Vec::new();
    let mut seq = 0usize;

    for ev in raw_events {
        let Some((start_ts, all_day)) = ev.start_opt else {
            continue;
        };
        let base_end_ts = ev
            .end_opt
            .map(|(ts, _)| ts)
            .unwrap_or_else(|| if all_day { start_ts + 86400 } else { start_ts + 3600 });
        let duration_secs = (base_end_ts - start_ts).max(0);

        let base_uid = if ev.uid.is_empty() {
            format!("generated-{start_ts}-{seq}")
        } else {
            ev.uid.clone()
        };
        let final_summary = if ev.summary.is_empty() {
            "(Không tiêu đề)".to_string()
        } else {
            ev.summary.clone()
        };

        if let Some(rec_ts) = ev.recurrence_id {
            events.push(CalendarEventRecord {
                uid: format!("{base_uid}#override#{rec_ts}"),
                calendar_id: calendar_id.to_string(),
                summary: final_summary,
                description: ev.description,
                location: ev.location,
                start_ts,
                end_ts: start_ts + duration_secs,
                all_day,
                updated_at: now_ts,
            });
            seq += 1;
            continue;
        }

        if let Some(rrule_str) = ev.rrule_raw.as_deref() {
            if let Some(parsed_rule) = parse_rrule(rrule_str, ev.start_tzid.as_deref()) {
                let mut excluded: HashSet<i64> = ev.exdates.into_iter().collect();
                if let Some(ov) = overridden_timestamps.get(&base_uid) {
                    excluded.extend(ov.iter().copied());
                }

                let occurrences = expand_rrule_occurrences(
                    start_ts,
                    ev.start_tzid.as_deref(),
                    &parsed_rule,
                    now_ts,
                );
                for occ_start in occurrences {
                    if excluded.contains(&occ_start) {
                        continue;
                    }
                    events.push(CalendarEventRecord {
                        uid: format!("{base_uid}#{occ_start}"),
                        calendar_id: calendar_id.to_string(),
                        summary: final_summary.clone(),
                        description: ev.description.clone(),
                        location: ev.location.clone(),
                        start_ts: occ_start,
                        end_ts: occ_start + duration_secs,
                        all_day,
                        updated_at: now_ts,
                    });
                }
                seq += 1;
                continue;
            }
        }

        events.push(CalendarEventRecord {
            uid: base_uid,
            calendar_id: calendar_id.to_string(),
            summary: final_summary,
            description: ev.description,
            location: ev.location,
            start_ts,
            end_ts: start_ts + duration_secs,
            all_day,
            updated_at: now_ts,
        });
        seq += 1;
    }

    events
}

fn validate_ics_envelope(body: &str) -> Result<(), String> {
    if !body.contains("BEGIN:VCALENDAR") || !body.contains("END:VCALENDAR") {
        return Err("Feed ICS không đầy đủ hoặc bị cắt cụt (thiếu BEGIN/END:VCALENDAR)".to_string());
    }
    Ok(())
}

/// Tải và parse feed ICS công khai/riêng tư từ Google Calendar (https:// hoặc webcal://).
pub async fn fetch_and_parse_ics(
    calendar_id: &str,
    ics_url: &str,
) -> Result<Vec<CalendarEventRecord>, String> {
    let trimmed = ics_url.trim();
    let normalized_url = if let Some(rest) = trimmed.strip_prefix("webcal://") {
        format!("https://{rest}")
    } else {
        trimmed.to_string()
    };

    if !normalized_url.starts_with("https://") {
        return Err("URL lịch ICS phải bắt đầu bằng https:// hoặc webcal://".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Không khởi tạo được HTTP client: {e}"))?;

    let resp = client
        .get(&normalized_url)
        .header("User-Agent", "Diark-OS/1.1")
        .send()
        .await
        .map_err(|e| format!("Lỗi tải ICS feed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Server lịch trả về HTTP {}", resp.status().as_u16()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Lỗi đọc nội dung ICS: {e}"))?;

    validate_ics_envelope(&body)?;

    Ok(parse_ics_events(calendar_id, &body))
}

/// Quy đổi số tiết UIT sang giờ bắt đầu / kết thúc (giờ địa phương UTC+7).
pub fn uit_period_time_bounds_public(tiet_start: i64, tiet_end: i64) -> ((u32, u32), (u32, u32)) {
    uit_period_time_bounds(tiet_start, tiet_end)
}

fn uit_period_time_bounds(tiet_start: i64, tiet_end: i64) -> ((u32, u32), (u32, u32)) {
    let start_hm = match tiet_start {
        1 => (7, 30),
        2 => (8, 15),
        3 => (9, 0),
        4 => (10, 0),
        5 => (10, 45),
        6 => (13, 0),
        7 => (13, 45),
        8 => (14, 30),
        9 => (15, 30),
        10 => (16, 15),
        11 => (17, 45),
        12 => (18, 30),
        13 => (19, 15),
        _ => (7, 30),
    };
    let end_hm = match tiet_end {
        1 => (8, 15),
        2 => (9, 0),
        3 => (9, 45),
        4 => (10, 45),
        5 => (11, 30),
        6 => (13, 45),
        7 => (14, 30),
        8 => (15, 15),
        9 => (16, 15),
        10 => (17, 0),
        11 => (18, 30),
        12 => (19, 15),
        13 => (20, 0),
        _ => (start_hm.0 + 1, start_hm.1),
    };
    (start_hm, end_hm)
}

fn escape_ics_field(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\r', "")
        .replace('\n', "\\n")
}

/// Xuất Thời khóa biểu & Lịch thi UIT sang chuẩn RFC 5545 `.ics` để người dùng nhập vào Google Calendar cá nhân.
pub fn export_uit_schedule_to_ics(
    timetable: &[PortalTimetableRecord],
    exams: &[AcademicExamRecord],
) -> String {
    let mut out = String::from(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Diark OS//UIT Schedule//VI\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:UIT Schedule (Diark OS)\r\nX-WR-TIMEZONE:Asia/Ho_Chi_Minh\r\n",
    );

    let dtstamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();

    for t in timetable {
        let Ok(date) = NaiveDate::parse_from_str(t.ngay.trim(), "%Y-%m-%d") else {
            continue;
        };
        let ((sh, sm), (eh, em)) = uit_period_time_bounds(t.tiet_bat_dau, t.tiet_ket_thuc);
        let ymd = date.format("%Y%m%d");
        let summary = format!("{} ({})", t.ten_mon_hoc, t.ma_lop);
        let desc = format!(
            "Hình thức: {} | Giảng viên: {} {} | Tiết {}-{}",
            t.hinh_thuc, t.lecturer_title, t.ten_giang_vien, t.tiet_bat_dau, t.tiet_ket_thuc
        );

        out.push_str("BEGIN:VEVENT\r\n");
        out.push_str(&format!("UID:diark-tkb-{}@diark.local\r\n", escape_ics_field(&t.id)));
        out.push_str(&format!("DTSTAMP:{dtstamp}\r\n"));
        out.push_str(&format!(
            "DTSTART;TZID=Asia/Ho_Chi_Minh:{ymd}T{sh:02}{sm:02}00\r\n"
        ));
        out.push_str(&format!(
            "DTEND;TZID=Asia/Ho_Chi_Minh:{ymd}T{eh:02}{em:02}00\r\n"
        ));
        out.push_str(&format!("SUMMARY:{}\r\n", escape_ics_field(&summary)));
        if !t.phong.trim().is_empty() {
            out.push_str(&format!("LOCATION:{}\r\n", escape_ics_field(&t.phong)));
        }
        out.push_str(&format!("DESCRIPTION:{}\r\n", escape_ics_field(desc.trim())));
        out.push_str("END:VEVENT\r\n");
    }

    for ex in exams {
        let date_opt = NaiveDate::parse_from_str(ex.date_str.trim(), "%d/%m/%Y")
            .or_else(|_| NaiveDate::parse_from_str(ex.date_str.trim(), "%Y-%m-%d"))
            .ok();
        let Some(date) = date_opt else {
            continue;
        };
        let start_t = NaiveTime::parse_from_str(ex.start_time.trim(), "%H:%M").unwrap_or_default();
        let end_t = NaiveTime::parse_from_str(ex.end_time.trim(), "%H:%M").unwrap_or(start_t);
        let ymd = date.format("%Y%m%d");
        let start_hms = start_t.format("%H%M%S");
        let end_hms = end_t.format("%H%M%S");
        let kind = if ex.examination == "midterm" {
            "Giữa kỳ"
        } else {
            "Cuối kỳ"
        };
        let summary = format!("[THI {}] {} - {}", kind, ex.subject_code, ex.subject_name);
        let desc = format!(
            "Lớp: {} | Ca: {} | Hình thức: {} | Ghi chú: {}",
            ex.section_class_code, ex.shift, ex.format, ex.note
        );

        out.push_str("BEGIN:VEVENT\r\n");
        out.push_str(&format!("UID:diark-exam-{}@diark.local\r\n", ex.id));
        out.push_str(&format!("DTSTAMP:{dtstamp}\r\n"));
        out.push_str(&format!(
            "DTSTART;TZID=Asia/Ho_Chi_Minh:{ymd}T{start_hms}\r\n"
        ));
        out.push_str(&format!(
            "DTEND;TZID=Asia/Ho_Chi_Minh:{ymd}T{end_hms}\r\n"
        ));
        out.push_str(&format!("SUMMARY:{}\r\n", escape_ics_field(&summary)));
        if !ex.room.trim().is_empty() {
            out.push_str(&format!("LOCATION:{}\r\n", escape_ics_field(&ex.room)));
        }
        out.push_str(&format!("DESCRIPTION:{}\r\n", escape_ics_field(desc.trim())));
        out.push_str("END:VEVENT\r\n");
    }

    out.push_str("END:VCALENDAR\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ics_unfolding_utc_tzid_and_all_day() {
        let sample = "\
BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
BEGIN:VEVENT\r\n\
UID:ev-1@google.com\r\n\
DTSTART:20261127T020000Z\r\n\
DTEND:20261127T033000Z\r\n\
SUMMARY:Họp team\\, dự án\r\n\
 LOCATION:Phòng B1.14\r\n\
DESCRIPTION:Line 1\\nLine 2\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:ev-2@google.com\r\n\
DTSTART;VALUE=DATE:20261128\r\n\
SUMMARY:Nghỉ lễ\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:ev-3@google.com\r\n\
DTSTART;TZID=Asia/Ho_Chi_Minh:20261129T073000\r\n\
DTEND;TZID=Asia/Ho_Chi_Minh:20261129T090000\r\n\
SUMMARY:Ôn tập IT004\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

        let parsed = parse_ics_events("personal", sample);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].summary, "Họp team, dự án");
        assert_eq!(parsed[0].description, "Line 1\nLine 2");
        assert!(!parsed[0].all_day);
        assert_eq!(parsed[0].end_ts - parsed[0].start_ts, 5400);

        assert!(parsed[1].all_day);
        assert_eq!(parsed[1].end_ts - parsed[1].start_ts, 86400);

        assert_eq!(parsed[2].summary, "Ôn tập IT004");
        assert_eq!(parsed[2].end_ts - parsed[2].start_ts, 5400);
    }

    #[test]
    fn test_parse_ics_foreign_tzid_converts_to_correct_utc_timestamp() {
        // 2026-11-27 09:00:00 America/New_York (EST = UTC-5) == 14:00:00Z == 21:00:00 +07:00
        let sample = "\
BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:ny-1\r\n\
DTSTART;TZID=America/New_York:20261127T090000\r\n\
DTEND;TZID=America/New_York:20261127T100000\r\n\
SUMMARY:Global Contest\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

        let parsed = parse_ics_events("gcal", sample);
        assert_eq!(parsed.len(), 1);
        let expected_utc = NaiveDateTime::parse_from_str("20261127T140000", "%Y%m%dT%H%M%S")
            .unwrap()
            .and_utc()
            .timestamp();
        assert_eq!(parsed[0].start_ts, expected_utc);
        assert_eq!(parsed[0].end_ts - parsed[0].start_ts, 3600);
    }

    #[test]
    fn test_parse_ics_rrule_with_exdate_and_recurrence_override() {
        let sample = "\
BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:club-sync\r\n\
DTSTART;TZID=Asia/Ho_Chi_Minh:20261123T180000\r\n\
DTEND;TZID=Asia/Ho_Chi_Minh:20261123T193000\r\n\
RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=4\r\n\
EXDATE;TZID=Asia/Ho_Chi_Minh:20261125T180000\r\n\
SUMMARY:Sinh hoạt CLB\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:club-sync\r\n\
RECURRENCE-ID;TZID=Asia/Ho_Chi_Minh:20261130T180000\r\n\
DTSTART;TZID=Asia/Ho_Chi_Minh:20261130T190000\r\n\
DTEND;TZID=Asia/Ho_Chi_Minh:20261130T203000\r\n\
SUMMARY:Sinh hoạt CLB (Dời giờ)\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

        let parsed = parse_ics_events("gcal", sample);
        // COUNT=4 produces Mon 23/11, Wed 25/11 (EXDATE), Mon 30/11 (overridden), Wed 02/12
        // Plus 1 override event -> 3 total events
        assert_eq!(parsed.len(), 3);
        let summaries: Vec<&str> = parsed.iter().map(|e| e.summary.as_str()).collect();
        assert!(summaries.contains(&"Sinh hoạt CLB (Dời giờ)"));
        // Check all UIDs are distinct so SQLite PK never collides
        let uids: HashSet<&str> = parsed.iter().map(|e| e.uid.as_str()).collect();
        assert_eq!(uids.len(), 3);
    }

    #[test]
    fn test_parse_ics_unbounded_rrule_is_capped() {
        let sample = "\
BEGIN:VCALENDAR\r\n\
BEGIN:VEVENT\r\n\
UID:daily-habit\r\n\
DTSTART;TZID=Asia/Ho_Chi_Minh:20200101T070000\r\n\
DTEND;TZID=Asia/Ho_Chi_Minh:20200101T073000\r\n\
RRULE:FREQ=DAILY\r\n\
SUMMARY:Morning Reading\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

        let parsed = parse_ics_events("gcal", sample);
        assert!(!parsed.is_empty());
        assert!(parsed.len() <= MAX_RRULE_INSTANCES);
    }

    #[test]
    fn test_validate_ics_envelope_rejects_truncated_feed() {
        let truncated = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\n";
        assert!(validate_ics_envelope(truncated).is_err());

        let complete = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
        assert!(validate_ics_envelope(complete).is_ok());
    }

    #[test]
    fn test_export_uit_schedule_to_ics() {
        let timetable = vec![PortalTimetableRecord {
            id: "tkb-1".to_string(),
            ma_lop: "IT004.R19".to_string(),
            ten_mon_hoc: "Cơ sở dữ liệu".to_string(),
            ngay: "2026-11-27".to_string(),
            thu: 6,
            tiet_bat_dau: 1,
            tiet_ket_thuc: 4,
            phong: "C314".to_string(),
            hinh_thuc: "LT".to_string(),
            ten_giang_vien: "Nguyễn Văn A".to_string(),
            lecturer_title: "TS".to_string(),
            subject_id: 1,
            trang_thai: "normal".to_string(),
            hoc_ky: 1,
            nam_hoc: 2026,
            updated_at: 0,
        }];
        let ics = export_uit_schedule_to_ics(&timetable, &[]);
        assert!(ics.contains("BEGIN:VCALENDAR"));
        assert!(ics.contains("DTSTART;TZID=Asia/Ho_Chi_Minh:20261127T073000"));
        assert!(ics.contains("DTEND;TZID=Asia/Ho_Chi_Minh:20261127T104500"));
        assert!(ics.contains("LOCATION:C314"));
        assert!(ics.contains("END:VCALENDAR"));
    }
}
