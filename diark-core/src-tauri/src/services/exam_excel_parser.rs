use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};

use crate::db::exam::PortalExamItemDto;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExamExcelParsePreview {
    pub file_name: String,
    pub sheets_scanned: usize,
    pub total_rows_scanned: usize,
    pub matched_by: String,
    pub enrolled_classes_count: usize,
    pub matched_items: Vec<PortalExamItemDto>,
}

#[derive(Debug, Clone, Default)]
struct ColumnMap {
    class_code: Option<usize>,
    subject_code: Option<usize>,
    subject_name: Option<usize>,
    date: Option<usize>,
    weekday: Option<usize>,
    shift: Option<usize>,
    room: Option<usize>,
    term: Option<usize>,
    format: Option<usize>,
    note: Option<usize>,
}

#[derive(Debug, Clone)]
struct ParsedExamRow {
    subject_code: String,
    subject_name: String,
    section_class_code: String,
    date_str: String,
    weekday: String,
    shift: String,
    start_time: String,
    end_time: String,
    room: String,
    examination: String,
    format: String,
    note: String,
}

pub fn normalize_vn(input: &str) -> String {
    let mapped: String = input
        .chars()
        .map(|c| match c {
            'à' | 'á' | 'ạ' | 'ả' | 'ã' | 'â' | 'ầ' | 'ấ' | 'ậ' | 'ẩ' | 'ẫ' | 'ă' | 'ằ' | 'ắ'
            | 'ặ' | 'ẳ' | 'ẵ' | 'À' | 'Á' | 'Ạ' | 'Ả' | 'Ã' | 'Â' | 'Ầ' | 'Ấ' | 'Ậ' | 'Ẩ'
            | 'Ẫ' | 'Ă' | 'Ằ' | 'Ắ' | 'Ặ' | 'Ẳ' | 'Ẵ' => 'a',
            'è' | 'é' | 'ẹ' | 'ẻ' | 'ẽ' | 'ê' | 'ề' | 'ế' | 'ệ' | 'ể' | 'ễ' | 'È' | 'É' | 'Ẹ'
            | 'Ẻ' | 'Ẽ' | 'Ê' | 'Ề' | 'Ế' | 'Ệ' | 'Ể' | 'Ễ' => 'e',
            'ì' | 'í' | 'ị' | 'ỉ' | 'ĩ' | 'Ì' | 'Í' | 'Ị' | 'Ỉ' | 'Ĩ' => 'i',
            'ò' | 'ó' | 'ọ' | 'ỏ' | 'õ' | 'ô' | 'ồ' | 'ố' | 'ộ' | 'ổ' | 'ỗ' | 'ơ' | 'ờ' | 'ớ'
            | 'ợ' | 'ở' | 'ỡ' | 'Ò' | 'Ó' | 'Ọ' | 'Ỏ' | 'Õ' | 'Ô' | 'Ồ' | 'Ố' | 'Ộ' | 'Ổ'
            | 'Ỗ' | 'Ơ' | 'Ờ' | 'Ớ' | 'Ợ' | 'Ở' | 'Ỡ' => 'o',
            'ù' | 'ú' | 'ụ' | 'ủ' | 'ũ' | 'ư' | 'ừ' | 'ứ' | 'ự' | 'ử' | 'ữ' | 'Ù' | 'Ú' | 'Ụ'
            | 'Ủ' | 'Ũ' | 'Ư' | 'Ừ' | 'Ứ' | 'Ự' | 'Ử' | 'Ữ' => 'u',
            'ỳ' | 'ý' | 'ỵ' | 'ỷ' | 'ỹ' | 'Ỳ' | 'Ý' | 'Ỵ' | 'Ỷ' | 'Ỹ' => 'y',
            'đ' | 'Đ' => 'd',
            other => other,
        })
        .collect();

    mapped
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Rút gọn mã lớp thực hành có hậu tố số (VD: `IT007.R114.2` -> `IT007.R114`),
/// nhưng giữ nguyên hậu tố chương trình (`CS2134.R11.CTTT`, `MA003.R12.CTTA`).
pub fn base_class_code(code: &str) -> String {
    let trimmed = code.trim().to_ascii_uppercase();
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() >= 3 {
        if let Some(last) = parts.last() {
            if !last.is_empty() && last.chars().all(|c| c.is_ascii_digit()) {
                return parts[..parts.len() - 1].join(".");
            }
        }
    }
    trimmed
}

fn cell_to_clean_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => {
            if (*f - f.round()).abs() < 1e-6 {
                format!("{}", f.round() as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => {
            if let Some(d) = excel_serial_to_date(dt.as_f64()) {
                d.format("%d/%m/%Y").to_string()
            } else {
                format!("{}", dt.as_f64())
            }
        }
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.trim().to_string(),
        Data::Error(_) => String::new(),
    }
}

fn excel_serial_to_date(serial_days: f64) -> Option<NaiveDate> {
    if !(25_000.0..=80_000.0).contains(&serial_days) {
        return None;
    }
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30)?;
    let whole_days = serial_days.floor() as i64;
    epoch.checked_add_signed(Duration::days(whole_days))
}

fn parse_date_cell(cell: &Data) -> (String, Option<NaiveDate>) {
    match cell {
        Data::DateTime(dt) => {
            if let Some(d) = excel_serial_to_date(dt.as_f64()) {
                return (d.format("%d/%m/%Y").to_string(), Some(d));
            }
            (String::new(), None)
        }
        Data::Float(f) => {
            if let Some(d) = excel_serial_to_date(*f) {
                return (d.format("%d/%m/%Y").to_string(), Some(d));
            }
            (String::new(), None)
        }
        Data::Int(i) => {
            if let Some(d) = excel_serial_to_date(*i as f64) {
                return (d.format("%d/%m/%Y").to_string(), Some(d));
            }
            (String::new(), None)
        }
        Data::String(s) | Data::DateTimeIso(s) => parse_date_str(s),
        _ => (String::new(), None),
    }
}

pub fn parse_date_str(raw: &str) -> (String, Option<NaiveDate>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (String::new(), None);
    }

    let first_token = trimmed.split_whitespace().next().unwrap_or(trimmed);
    for fmt in ["%d/%m/%Y", "%-d/%-m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%-d-%-m-%Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(first_token, fmt) {
            return (d.format("%d/%m/%Y").to_string(), Some(d));
        }
    }

    if let Ok(serial) = first_token.parse::<f64>() {
        if let Some(d) = excel_serial_to_date(serial) {
            return (d.format("%d/%m/%Y").to_string(), Some(d));
        }
    }

    (trimmed.to_string(), None)
}

fn weekday_vi(date: NaiveDate) -> String {
    match date.weekday() {
        Weekday::Mon => "Thứ 2",
        Weekday::Tue => "Thứ 3",
        Weekday::Wed => "Thứ 4",
        Weekday::Thu => "Thứ 5",
        Weekday::Fri => "Thứ 6",
        Weekday::Sat => "Thứ 7",
        Weekday::Sun => "Chủ nhật",
    }
    .to_string()
}

pub fn parse_shift_and_times(raw_shift: &str) -> (String, String, String) {
    let clean = raw_shift.trim();
    let norm = normalize_vn(clean);

    // Trích khung giờ HH:MM nếu cột Ca thi / Giờ thi ghi thẳng giờ
    let time_tokens: Vec<String> = clean
        .split(|c: char| !c.is_ascii_digit() && c != ':')
        .filter(|tok| {
            let parts: Vec<&str> = tok.split(':').collect();
            parts.len() == 2
                && parts[0].len() <= 2
                && parts[1].len() == 2
                && parts[0].parse::<u32>().map(|h| h < 24).unwrap_or(false)
                && parts[1].parse::<u32>().map(|m| m < 60).unwrap_or(false)
        })
        .map(|tok| {
            let parts: Vec<&str> = tok.split(':').collect();
            format!(
                "{:02}:{}",
                parts[0].parse::<u32>().unwrap_or(7),
                parts[1]
            )
        })
        .collect();

    let shift_num = norm
        .chars()
        .find(|c| matches!(c, '1' | '2' | '3' | '4'))
        .map(|c| c.to_string())
        .unwrap_or_else(|| {
            if let Some(first_t) = time_tokens.first() {
                if first_t.as_str() < "09:15" {
                    "1".to_string()
                } else if first_t.as_str() < "12:30" {
                    "2".to_string()
                } else if first_t.as_str() < "15:15" {
                    "3".to_string()
                } else {
                    "4".to_string()
                }
            } else {
                "1".to_string()
            }
        });

    let (default_start, default_end) = match shift_num.as_str() {
        "1" => ("07:30", "09:00"),
        "2" => ("09:30", "11:00"),
        "3" => ("13:30", "15:00"),
        "4" => ("15:30", "17:00"),
        _ => ("07:30", "09:00"),
    };

    let start = time_tokens
        .first()
        .cloned()
        .unwrap_or_else(|| default_start.to_string());
    let end = time_tokens
        .get(1)
        .cloned()
        .unwrap_or_else(|| default_end.to_string());

    (shift_num, start, end)
}

fn detect_examination(term_text: &str, default_exam: &str) -> String {
    let norm = normalize_vn(term_text);
    if norm.contains("cuoi ky") || norm == "ck" || norm.contains("final") {
        return "final_term".to_string();
    }
    if norm.contains("giua ky") || norm == "gk" || norm.contains("midterm") {
        return "midterm".to_string();
    }
    default_exam.to_string()
}

fn detect_format(format_text: &str, default_fmt: &str) -> String {
    let norm = normalize_vn(format_text);
    if norm.contains("trac nghiem") || norm == "tn" {
        return "tn".to_string();
    }
    if norm.contains("thuc hanh") || norm.contains("phong may") || norm == "th" {
        return "practical".to_string();
    }
    if norm.contains("van dap") || norm == "vd" {
        return "oral".to_string();
    }
    if norm.contains("tu luan") || norm == "tl" || norm.contains("ly thuyet") {
        return "tl".to_string();
    }
    default_fmt.to_string()
}

fn detect_header_row(rows: &[&[Data]]) -> Option<(usize, ColumnMap, String, String)> {
    let mut default_exam = "midterm".to_string();
    let mut default_format = "tl".to_string();

    for (row_idx, row) in rows.iter().take(35).enumerate() {
        let mut map = ColumnMap::default();
        let mut row_banner = String::new();

        for (col_idx, cell) in row.iter().enumerate() {
            let raw = cell_to_clean_string(cell);
            if raw.is_empty() {
                continue;
            }
            if !row_banner.is_empty() {
                row_banner.push(' ');
            }
            row_banner.push_str(&raw);

            let norm = normalize_vn(&raw);
            if norm == "ma lop"
                || norm == "malop"
                || norm == "lop hoc phan"
                || norm == "ma lhp"
                || norm == "lop"
            {
                map.class_code.get_or_insert(col_idx);
            } else if norm == "ma mh"
                || norm == "mamh"
                || norm == "ma mon"
                || norm == "ma hp"
                || norm == "ma hoc phan"
                || norm == "ma mon hoc"
            {
                map.subject_code.get_or_insert(col_idx);
            } else if norm == "ten mh"
                || norm == "tenmh"
                || norm == "ten mon"
                || norm == "ten mon hoc"
                || norm == "ten hoc phan"
                || norm == "mon thi"
            {
                map.subject_name.get_or_insert(col_idx);
            } else if norm == "ngay thi" || norm == "ngay" {
                map.date.get_or_insert(col_idx);
            } else if norm == "thu" {
                map.weekday.get_or_insert(col_idx);
            } else if norm == "ca thi"
                || norm == "ca"
                || norm == "gio thi"
                || norm == "thoi gian thi"
            {
                map.shift.get_or_insert(col_idx);
            } else if norm == "phong thi" || norm == "phong" {
                map.room.get_or_insert(col_idx);
            } else if norm == "lan thi" || norm == "ky thi" || norm == "dot thi" {
                if norm != "dot thi" {
                    map.term.get_or_insert(col_idx);
                }
            } else if norm.contains("hinh thuc") {
                map.format.get_or_insert(col_idx);
            } else if norm == "ghi chu" {
                map.note.get_or_insert(col_idx);
            }
        }

        let banner_norm = normalize_vn(&row_banner);
        if banner_norm.contains("cuoi ky") {
            default_exam = "final_term".to_string();
        } else if banner_norm.contains("giua ky") {
            default_exam = "midterm".to_string();
        }
        if banner_norm.contains("thuc hanh") {
            default_format = "practical".to_string();
        }

        let has_course_col = map.class_code.is_some() || map.subject_code.is_some();
        let has_schedule_col = map.date.is_some() && (map.shift.is_some() || map.room.is_some());
        if has_course_col && has_schedule_col {
            return Some((row_idx, map, default_exam, default_format));
        }
    }

    None
}

fn cell_at(row: &[Data], col_opt: Option<usize>) -> String {
    col_opt
        .and_then(|idx| row.get(idx))
        .map(cell_to_clean_string)
        .unwrap_or_default()
}

pub fn parse_exam_excel_for_student(
    file_path: &Path,
    enrolled_class_codes: &[String],
    enrolled_subject_codes: &[String],
) -> Result<ExamExcelParsePreview, String> {
    let mut workbook = open_workbook_auto(file_path)
        .map_err(|e| format!("Không thể mở file Excel {}: {e}", file_path.display()))?;

    let file_name = file_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "exam.xlsx".to_string());

    let sheet_names = workbook.sheet_names();
    let mut sheets_scanned = 0usize;
    let mut total_rows_scanned = 0usize;
    let mut all_rows: Vec<ParsedExamRow> = Vec::new();

    for sheet_name in sheet_names {
        let Ok(range) = workbook.worksheet_range(&sheet_name) else {
            continue;
        };
        let rows: Vec<&[Data]> = range.rows().collect();
        if rows.is_empty() {
            continue;
        }
        sheets_scanned += 1;

        let Some((header_idx, map, default_exam, default_format)) = detect_header_row(&rows) else {
            continue;
        };

        for row in rows.iter().skip(header_idx + 1) {
            total_rows_scanned += 1;

            let raw_class = cell_at(row, map.class_code).to_ascii_uppercase();
            let mut raw_subject = cell_at(row, map.subject_code).to_ascii_uppercase();
            if raw_subject.is_empty() && !raw_class.is_empty() {
                raw_subject = raw_class
                    .split('.')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
            }

            if raw_class.is_empty() && raw_subject.is_empty() {
                continue;
            }

            let Some(date_col) = map.date else {
                continue;
            };
            let Some(date_cell) = row.get(date_col) else {
                continue;
            };
            let (date_str, parsed_date) = parse_date_cell(date_cell);
            if date_str.is_empty() || parsed_date.is_none() {
                continue;
            }

            let mut weekday = cell_at(row, map.weekday);
            if weekday.is_empty() {
                if let Some(d) = parsed_date {
                    weekday = weekday_vi(d);
                }
            }

            let raw_shift = cell_at(row, map.shift);
            let (shift, start_time, end_time) = parse_shift_and_times(&raw_shift);
            let room = cell_at(row, map.room);
            let subject_name = cell_at(row, map.subject_name);
            let term_raw = cell_at(row, map.term);
            let format_raw = cell_at(row, map.format);
            let note_raw = cell_at(row, map.note);

            let examination = detect_examination(&term_raw, &default_exam);
            let format = detect_format(
                if !format_raw.is_empty() {
                    &format_raw
                } else {
                    &note_raw
                },
                &default_format,
            );

            all_rows.push(ParsedExamRow {
                subject_code: raw_subject,
                subject_name,
                section_class_code: if raw_class.is_empty() {
                    cell_at(row, map.subject_code).to_ascii_uppercase()
                } else {
                    raw_class
                },
                date_str,
                weekday,
                shift,
                start_time,
                end_time,
                room,
                examination,
                format,
                note: note_raw,
            });
        }
    }

    let exact_classes: HashSet<String> = enrolled_class_codes
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty())
        .collect();
    let base_classes: HashSet<String> = enrolled_class_codes
        .iter()
        .map(|s| base_class_code(s))
        .filter(|s| !s.is_empty())
        .collect();
    let subject_set: HashSet<String> = enrolled_subject_codes
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty())
        .collect();

    let mut matched_by = "none".to_string();
    let mut matched_rows: Vec<ParsedExamRow> = Vec::new();

    if !exact_classes.is_empty() {
        for r in &all_rows {
            let class_upper = r.section_class_code.trim().to_ascii_uppercase();
            let class_base = base_class_code(&class_upper);
            if exact_classes.contains(&class_upper) || base_classes.contains(&class_base) {
                matched_rows.push(r.clone());
            }
        }
        if !matched_rows.is_empty() {
            matched_by = "class".to_string();
        }
    }

    if matched_rows.is_empty() && !subject_set.is_empty() {
        for r in &all_rows {
            if subject_set.contains(&r.subject_code.trim().to_ascii_uppercase()) {
                matched_rows.push(r.clone());
            }
        }
        if !matched_rows.is_empty() {
            matched_by = "subject".to_string();
        }
    }

    // Gom nhóm theo (section_class_code, date_str, shift, examination) để gộp các dòng chia phòng
    let mut grouped: BTreeMap<(String, String, String, String), Vec<ParsedExamRow>> =
        BTreeMap::new();
    for r in matched_rows {
        let key = (
            r.section_class_code.clone(),
            r.date_str.clone(),
            r.shift.clone(),
            r.examination.clone(),
        );
        grouped.entry(key).or_default().push(r);
    }

    let mut matched_items: Vec<PortalExamItemDto> = Vec::new();
    for (_key, group) in grouped {
        let Some(first) = group.first() else {
            continue;
        };

        let mut rooms: Vec<String> = Vec::new();
        for item in &group {
            let clean_room = item.room.trim();
            if !clean_room.is_empty() && !rooms.iter().any(|r| r.eq_ignore_ascii_case(clean_room)) {
                rooms.push(clean_room.to_string());
            }
        }

        let joined_room = rooms.join(", ");
        let mut notes: Vec<String> = Vec::new();
        for item in &group {
            let n = item.note.trim();
            if !n.is_empty() && !notes.iter().any(|x| x == n) {
                notes.push(n.to_string());
            }
        }
        if rooms.len() > 1 {
            notes.push(format!(
                "Nhiều phòng thi ({joined_room}) - kiểm tra danh sách phòng theo MSSV"
            ));
        }

        matched_items.push(PortalExamItemDto {
            id: None,
            subject_code: first.subject_code.clone(),
            subject_name: if first.subject_name.is_empty() {
                first.subject_code.clone()
            } else {
                first.subject_name.clone()
            },
            section_class_id: Some(first.section_class_code.clone()),
            section_class_code: Some(first.section_class_code.clone()),
            format: Some(first.format.clone()),
            examination: Some(first.examination.clone()),
            shift: Some(first.shift.clone()),
            start_time: Some(first.start_time.clone()),
            end_time: Some(first.end_time.clone()),
            weekday: Some(first.weekday.clone()),
            date: Some(first.date_str.clone()),
            room: Some(joined_room),
            seat_number: Some(String::new()),
            absent: Some("Không".to_string()),
            note: Some(notes.join(" · ")),
        });
    }

    Ok(ExamExcelParsePreview {
        file_name,
        sheets_scanned,
        total_rows_scanned,
        matched_by,
        enrolled_classes_count: exact_classes.len(),
        matched_items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_vn_and_base_class_code() {
        assert_eq!(normalize_vn("  Ngày   Thi  "), "ngay thi");
        assert_eq!(normalize_vn("LỊCH THI GIỮA KỲ"), "lich thi giua ky");
        assert_eq!(base_class_code("IT007.R114.2"), "IT007.R114");
        assert_eq!(base_class_code("CS2134.R11.CTTT"), "CS2134.R11.CTTT");
        assert_eq!(base_class_code("MA003.R117"), "MA003.R117");
    }

    #[test]
    fn test_parse_shift_and_date() {
        assert_eq!(
            parse_shift_and_times("2"),
            ("2".to_string(), "09:30".to_string(), "11:00".to_string())
        );
        assert_eq!(
            parse_shift_and_times("Ca 3 (13:30 - 15:00)"),
            ("3".to_string(), "13:30".to_string(), "15:00".to_string())
        );

        let (formatted, parsed) = parse_date_str("02/11/2026");
        assert_eq!(formatted, "02/11/2026");
        assert_eq!(weekday_vi(parsed.unwrap()), "Thứ 2");
    }

    #[test]
    fn test_parse_real_uit_sample_exam_excel_if_present() {
        // Bỏ qua nếu chạy trên máy khác không có file mẫu trong scratch
        let sample = Path::new(
            r"C:\Users\gia\.gemini\antigravity\brain\82c81b5b-741b-4c34-bdfd-4c6eaf7e6072\scratch\sample_exam.xlsx",
        );
        if !sample.exists() {
            return;
        }
        let preview = parse_exam_excel_for_student(
            sample,
            &["MA003.R117".to_string(), "CS2134.R11.CTTT".to_string()],
            &["MA003".to_string(), "CS2134".to_string()],
        )
        .unwrap();
        assert_eq!(preview.matched_by, "class");
        assert_eq!(preview.matched_items.len(), 2);
        let ma = preview
            .matched_items
            .iter()
            .find(|x| x.section_class_code.as_deref() == Some("MA003.R117"))
            .unwrap();
        assert_eq!(ma.room.as_deref(), Some("B7.04, B7.06"));
        assert!(ma.note.as_deref().unwrap_or("").contains("Nhiều phòng thi"));
    }
}
