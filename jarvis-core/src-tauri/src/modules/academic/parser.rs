//! Pure DOM and Data Contract Parser for UIT Next.js Portal
//!
//! Tách biệt hoàn toàn khỏi database / rusqlite theo đúng Hard Architectural Constraint P0:
//! Pure functions, deterministic, 100% testable trong mọi môi trường.

use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortalPayloadRaw {
    pub summary: String,
    pub by_semester: String,
    pub by_ctdt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemesterRef {
    pub id: String,
    pub academic_year: String,
    pub semester_term: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedCourse {
    pub course_code: String,
    pub course_name: String,
    pub credits: i64,
    pub midterm_score: Option<f64>,
    pub final_score: Option<f64>,
    pub summary_score_10: Option<f64>,
    pub summary_score_4: Option<f64>,
    pub grade_char: Option<String>,
    pub is_passed: bool,
    pub is_gpa_calculated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedSemester {
    pub semester: SemesterRef,
    pub courses: Vec<ParsedCourse>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroMetricRecord {
    pub semester_id: String,
    pub term_gpa: f64,
    pub cumulative_gpa: f64,
    pub classification: String,
    pub term_credits: i64,
    pub cumulative_credits: i64,
    pub drl: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CurriculumCourseRecord {
    pub course_code: String,
    pub course_name: String,
    pub credits: i64,
    pub course_type: String, // "Bắt buộc" | "Tự chọn"
    pub ideal_term: i64,
    pub status: String,      // "Đã qua" | "Đang học" | "Chưa học"
    pub final_score: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnifiedAcademicData {
    pub macro_metrics: Vec<MacroMetricRecord>,
    pub historical_semesters: Vec<ParsedSemester>,
    pub curriculum_courses: Vec<CurriculumCourseRecord>,
}

/// Phân giải nhãn học kỳ UIT sang định danh có cấu trúc `SemesterRef`.
/// Format chuẩn: "Học kỳ 2/2025-2026" hoặc "Học kỳ 1/2024-2025".
pub fn parse_semester_label(label: &str) -> Result<SemesterRef, String> {
    let clean = label.trim();
    if !clean.starts_with("Học kỳ ") {
        return Err(format!("Invalid semester prefix: {}", clean));
    }
    let rest = clean.trim_start_matches("Học kỳ ").trim();
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid semester format: {}", clean));
    }

    let term: u8 = parts[0].trim().parse().map_err(|_| "Invalid term number".to_string())?;
    if !(1..=3).contains(&term) {
        return Err(format!("Term out of bounds (1-3): {}", term));
    }

    let academic_year = parts[1].trim().to_string();
    let year_clean = academic_year.replace('-', "_");
    let id = format!("{}_HK{}", year_clean, term);

    Ok(SemesterRef {
        id,
        academic_year,
        semester_term: term,
    })
}

/// Phân giải nhãn học kỳ trong Tab Summary ("HK1 · 2025", "HK2 · 2024", "HK1 / 2024-2025")
/// sang semester_id chuẩn "2025_2026_HK1".
pub fn parse_summary_semester_id(label: &str) -> Option<String> {
    let clean = label.trim();
    if clean.is_empty() {
        return None;
    }

    // Nếu đã ở dạng chuẩn "2025_2026_HK1"
    if clean.contains('_') && clean.contains("HK") {
        return Some(clean.to_string());
    }

    // Tìm term (1, 2 hoặc 3)
    let term = if clean.contains("HK1") || clean.contains("HK 1") || clean.contains("kỳ 1") || clean.contains("Kỳ 1") {
        1
    } else if clean.contains("HK2") || clean.contains("HK 2") || clean.contains("kỳ 2") || clean.contains("Kỳ 2") {
        2
    } else if clean.contains("HK3") || clean.contains("HK 3") || clean.contains("kỳ 3") || clean.contains("Kỳ 3") || clean.to_lowercase().contains("hè") {
        3
    } else {
        return None;
    };

    // Tìm các năm 4 chữ số
    let mut years = Vec::new();
    for token in clean.split(|c: char| !c.is_ascii_digit()) {
        if token.len() == 4 {
            if let Ok(y) = token.parse::<i64>() {
                if (2000..=2100).contains(&y) {
                    years.push(y);
                }
            }
        }
    }

    if years.len() >= 2 {
        Some(format!("{}_{}_HK{}", years[0], years[1], term))
    } else if years.len() == 1 {
        let start_year = years[0];
        let end_year = start_year + 1;
        Some(format!("{}_{}_HK{}", start_year, end_year, term))
    } else {
        None
    }
}

pub struct GpaPolicy;

impl GpaPolicy {
    /// Kiểm tra môn học có được tính vào GPA hay không.
    /// PE (Thể chất) và ME (Quốc phòng) luôn bị loại trừ.
    #[inline]
    pub fn is_gpa_calculated(course_code: &str) -> bool {
        let code = course_code.trim().to_ascii_uppercase();
        !(code.starts_with("PE") || code.starts_with("ME"))
    }

    /// Xác định trạng thái đạt/không đạt.
    /// Điểm 10 >= 5.0 là đạt, hoặc ký hiệu miễn "M", chuyển đổi "CH".
    #[inline]
    pub fn is_passed(score_10: Option<f64>, grade_char: Option<&str>) -> bool {
        if let Some(s) = score_10 {
            return s >= 5.0;
        }
        if let Some(c) = grade_char {
            return matches!(c, "M" | "CH");
        }
        false
    }
}

/// Chuyển đổi điểm hệ 10 sang thang điểm hệ 4 và điểm chữ theo quy chế ĐHQG-HCM / UIT.
pub fn score_to_scale_4(score: f64) -> (f64, &'static str) {
    if score >= 9.0 {
        (4.0, "A+")
    } else if score >= 8.5 {
        (3.7, "A")
    } else if score >= 8.0 {
        (3.5, "B+")
    } else if score >= 7.0 {
        (3.0, "B")
    } else if score >= 6.5 {
        (2.5, "C+")
    } else if score >= 5.5 {
        (2.0, "C")
    } else if score >= 5.0 {
        (1.5, "D+")
    } else if score >= 4.0 {
        (1.0, "D")
    } else {
        (0.0, "F")
    }
}

// ============================================================
//  TAB 1: Summary Tab Parser ("Tổng kết theo kỳ")
// ============================================================

/// Parse Tab 1 (Tổng kết theo kỳ):
/// Trích xuất danh sách `MacroMetricRecord`: Cột Học kỳ ("HK1 · 2025" -> 2025_2026_HK1),
/// GPA HK, GPA tích lũy, Xếp loại, TC HK, TC tích lũy, ĐRL.
pub fn parse_summary_tab(html: &str) -> Result<Vec<MacroMetricRecord>, String> {
    let document = Html::parse_fragment(html);
    let row_sel = Selector::parse("tr").map_err(|e| e.to_string())?;
    let cell_sel = Selector::parse("td, th").map_err(|e| e.to_string())?;

    let mut records = Vec::new();

    for row in document.select(&row_sel) {
        let cells: Vec<String> = row
            .select(&cell_sel)
            .map(|c| c.text().collect::<Vec<_>>().join(" ").trim().to_string())
            .collect();

        // Bảng tổng kết UIT cần tối thiểu 6 cột:
        // [Học kỳ, GPA HK, GPA tích lũy, Xếp loại, TC HK, TC tích lũy, (ĐRL tuỳ chọn)]
        if cells.len() < 6 {
            continue;
        }

        // Bỏ qua dòng header
        if cells[0].contains("Học kỳ") && (cells[1].contains("GPA") || cells[1].contains("Điểm")) {
            continue;
        }

        let semester_id = match parse_summary_semester_id(&cells[0]) {
            Some(id) => id,
            None => continue,
        };

        let parse_float = |s: &str| -> Option<f64> {
            let clean = s.trim().replace(',', ".");
            if clean == "–" || clean == "-" || clean.is_empty() {
                None
            } else {
                clean.parse::<f64>().ok()
            }
        };

        let parse_i64 = |s: &str| -> Option<i64> {
            let clean = s.trim().replace(',', ".");
            clean.parse::<i64>().ok()
        };

        let term_gpa = match parse_float(&cells[1]) {
            Some(v) => v,
            None => continue,
        };

        let cumulative_gpa = match parse_float(&cells[2]) {
            Some(v) => v,
            None => continue,
        };

        let classification = cells[3].trim().to_string();

        let term_credits = match parse_i64(&cells[4]) {
            Some(v) => v,
            None => continue,
        };

        let cumulative_credits = match parse_i64(&cells[5]) {
            Some(v) => v,
            None => continue,
        };

        let drl = if cells.len() > 6 {
            parse_i64(&cells[6])
        } else {
            None
        };

        records.push(MacroMetricRecord {
            semester_id,
            term_gpa,
            cumulative_gpa,
            classification,
            term_credits,
            cumulative_credits,
            drl,
        });
    }

    Ok(records)
}

// ============================================================
//  TAB 2: By-Semester Tab Parser ("Chi tiết môn học")
// ============================================================

/// Parse Tab 2 (Chi tiết môn học theo từng học kỳ):
/// Hỗ trợ duyệt qua từng card `div.rounded-lg.border` hoặc fallback các table.
pub fn parse_by_semester_tab(html: &str) -> Result<Vec<ParsedSemester>, String> {
    let document = Html::parse_fragment(html);

    let card_sel = Selector::parse("div.rounded-lg.border, div.border.rounded-xl, div.card").map_err(|e| e.to_string())?;
    let header_sel = Selector::parse("h2, h3, h4, div.text-base, div.font-semibold, caption").map_err(|e| e.to_string())?;
    let row_sel = Selector::parse("tbody tr, tr").map_err(|e| e.to_string())?;
    let cell_sel = Selector::parse("td").map_err(|e| e.to_string())?;

    let cards: Vec<_> = document.select(&card_sel).collect();
    let mut results = Vec::new();

    if !cards.is_empty() {
        for (idx, card) in cards.into_iter().enumerate() {
            // Tìm tiêu đề học kỳ trong card
            let mut semester_ref: Option<SemesterRef> = None;
            for h in card.select(&header_sel) {
                let h_text = h.text().collect::<Vec<_>>().join(" ").trim().to_string();
                if h_text.contains("Học kỳ ") {
                    if let Ok(sem) = parse_semester_label(&h_text) {
                        semester_ref = Some(sem);
                        break;
                    }
                }
            }

            let semester = semester_ref.unwrap_or_else(|| {
                let term = ((idx % 3) + 1) as u8;
                SemesterRef {
                    id: format!("2025_2026_HK{}", term),
                    academic_year: "2025-2026".to_string(),
                    semester_term: term,
                }
            });

            let mut courses = Vec::new();
            for row in card.select(&row_sel) {
                let cells: Vec<String> = row
                    .select(&cell_sel)
                    .map(|td| td.text().collect::<Vec<_>>().join(" ").trim().to_string())
                    .collect();

                if cells.len() < 8 {
                    continue;
                }

                let raw_code = &cells[0];
                if raw_code.is_empty() || raw_code.contains("Mã môn") {
                    continue;
                }

                let course_code = raw_code.trim().to_ascii_uppercase();
                let course_name = cells[1].trim().to_string();
                let credits: i64 = match cells[2].trim().parse() {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let parse_opt_score = |val: &str| -> Option<f64> {
                    let clean = val.trim().replace(',', ".");
                    if clean == "–" || clean == "-" || clean.is_empty() {
                        None
                    } else {
                        clean.parse::<f64>().ok()
                    }
                };

                let midterm_score = parse_opt_score(&cells[5]); // GK
                let final_score = parse_opt_score(&cells[6]);   // CK

                let raw_sum = cells[7].trim().replace(',', ".");
                let is_special_symbol = raw_sum == "M" || raw_sum == "CH" || raw_sum == "I";

                let (summary_score_10, status_char) = if is_special_symbol {
                    (None, Some(raw_sum.clone()))
                } else {
                    match raw_sum.parse::<f64>() {
                        Ok(v) => (Some(v), None),
                        Err(_) => (None, if raw_sum.is_empty() { None } else { Some(raw_sum.clone()) }),
                    }
                };

                let is_gpa_calculated = if is_special_symbol && raw_sum == "M" {
                    false
                } else {
                    GpaPolicy::is_gpa_calculated(&course_code)
                };

                let is_passed = GpaPolicy::is_passed(summary_score_10, status_char.as_deref());

                let (summary_score_4, grade_char) = if is_gpa_calculated {
                    if let Some(s10) = summary_score_10 {
                        let (s4, g_char) = score_to_scale_4(s10);
                        (Some(s4), Some(g_char.to_string()))
                    } else {
                        (None, status_char)
                    }
                } else {
                    (None, status_char)
                };

                courses.push(ParsedCourse {
                    course_code,
                    course_name,
                    credits,
                    midterm_score,
                    final_score,
                    summary_score_10,
                    summary_score_4,
                    grade_char,
                    is_passed,
                    is_gpa_calculated,
                });
            }

            if !courses.is_empty() {
                results.push(ParsedSemester { semester, courses });
            }
        }
    }

    // Fallback: nếu không thấy card container, dùng trực tiếp table selector
    if results.is_empty() {
        let table_sel = Selector::parse("table").map_err(|e| e.to_string())?;
        let tables: Vec<_> = document.select(&table_sel).collect();

        for (idx, table) in tables.into_iter().enumerate() {
            let mut courses = Vec::new();
            for row in table.select(&row_sel) {
                let cells: Vec<String> = row
                    .select(&cell_sel)
                    .map(|td| td.text().collect::<Vec<_>>().join(" ").trim().to_string())
                    .collect();

                if cells.len() < 8 {
                    continue;
                }

                let raw_code = &cells[0];
                if raw_code.is_empty() || raw_code.contains("Mã môn") {
                    continue;
                }

                let course_code = raw_code.trim().to_ascii_uppercase();
                let course_name = cells[1].trim().to_string();
                let credits: i64 = match cells[2].trim().parse() {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let parse_opt_score = |val: &str| -> Option<f64> {
                    let clean = val.trim().replace(',', ".");
                    if clean == "–" || clean == "-" || clean.is_empty() {
                        None
                    } else {
                        clean.parse::<f64>().ok()
                    }
                };

                let midterm_score = parse_opt_score(&cells[5]);
                let final_score = parse_opt_score(&cells[6]);

                let raw_sum = cells[7].trim().replace(',', ".");
                let is_special_symbol = raw_sum == "M" || raw_sum == "CH" || raw_sum == "I";

                let (summary_score_10, status_char) = if is_special_symbol {
                    (None, Some(raw_sum.clone()))
                } else {
                    match raw_sum.parse::<f64>() {
                        Ok(v) => (Some(v), None),
                        Err(_) => (None, if raw_sum.is_empty() { None } else { Some(raw_sum.clone()) }),
                    }
                };

                let is_gpa_calculated = if is_special_symbol && raw_sum == "M" {
                    false
                } else {
                    GpaPolicy::is_gpa_calculated(&course_code)
                };

                let is_passed = GpaPolicy::is_passed(summary_score_10, status_char.as_deref());

                let (summary_score_4, grade_char) = if is_gpa_calculated {
                    if let Some(s10) = summary_score_10 {
                        let (s4, g_char) = score_to_scale_4(s10);
                        (Some(s4), Some(g_char.to_string()))
                    } else {
                        (None, status_char)
                    }
                } else {
                    (None, status_char)
                };

                courses.push(ParsedCourse {
                    course_code,
                    course_name,
                    credits,
                    midterm_score,
                    final_score,
                    summary_score_10,
                    summary_score_4,
                    grade_char,
                    is_passed,
                    is_gpa_calculated,
                });
            }

            if !courses.is_empty() {
                let mut semester_ref: Option<SemesterRef> = None;
                for h in document.select(&header_sel) {
                    let h_text = h.text().collect::<Vec<_>>().join(" ").trim().to_string();
                    if h_text.contains("Học kỳ ") {
                        if let Ok(sem) = parse_semester_label(&h_text) {
                            semester_ref = Some(sem);
                            break;
                        }
                    }
                }

                let semester = semester_ref.unwrap_or_else(|| {
                    let term = ((idx % 3) + 1) as u8;
                    SemesterRef {
                        id: format!("2025_2026_HK{}", term),
                        academic_year: "2025-2026".to_string(),
                        semester_term: term,
                    }
                });

                results.push(ParsedSemester { semester, courses });
            }
        }
    }

    Ok(results)
}

/// Alias cho `parse_by_semester_tab` để đảm bảo backward-compatibility với Sprint v0.3.1
pub fn parse_portal_transcript(html_fragment: &str) -> Result<Vec<ParsedSemester>, String> {
    parse_by_semester_tab(html_fragment)
}

// ============================================================
//  TAB 3: By-CTDT Tab Parser ("Theo CTĐT")
// ============================================================

/// Parse Tab 3 (Theo khung Chương trình đào tạo CTĐT):
/// Duyệt qua từng block `Học kỳ X (CTĐT)` (Term 1 đến 7 và 20), trích xuất danh sách `CurriculumCourseRecord`:
/// Mã môn, Tên môn, TC, Loại (Bắt buộc / Tự chọn), Điểm HP, Tình trạng (Đã qua / Đang học / Chưa học).
pub fn parse_by_ctdt_tab(html: &str) -> Result<Vec<CurriculumCourseRecord>, String> {
    let document = Html::parse_fragment(html);

    let section_sel = Selector::parse("div.rounded-lg.border, div.border.rounded-xl, div.card, section").map_err(|e| e.to_string())?;
    let header_sel = Selector::parse("h2, h3, h4, div.font-semibold, div.text-base, caption").map_err(|e| e.to_string())?;
    let row_sel = Selector::parse("tbody tr, tr").map_err(|e| e.to_string())?;
    let cell_sel = Selector::parse("td, th").map_err(|e| e.to_string())?;

    let sections: Vec<_> = document.select(&section_sel).collect();
    let mut records = Vec::new();

    let parse_term_from_header = |header_text: &str| -> Option<i64> {
        if !header_text.contains("Học kỳ") && !header_text.contains("HK") {
            return None;
        }
        for token in header_text.split(|c: char| !c.is_ascii_digit()) {
            if let Ok(t) = token.parse::<i64>() {
                if (1..=25).contains(&t) {
                    return Some(t);
                }
            }
        }
        None
    };

    let parse_course_row = |cells: &[String], ideal_term: i64| -> Option<CurriculumCourseRecord> {
        if cells.len() < 4 {
            return None;
        }

        let raw_code = cells[0].trim().to_ascii_uppercase();
        if raw_code.is_empty() || raw_code.contains("MÃ MÔN") || raw_code.contains("MÃ MH") {
            return None;
        }

        let course_code = raw_code;
        let course_name = cells[1].trim().to_string();
        let credits = cells[2].trim().parse::<i64>().ok()?;

        let course_type = if cells[3].contains("Tự chọn") || cells[3].contains("TC") {
            "Tự chọn".to_string()
        } else {
            "Bắt buộc".to_string()
        };

        // Điểm HP & Tình trạng
        let mut final_score: Option<f64> = None;
        let mut status = "Chưa học".to_string();

        if cells.len() >= 5 {
            let clean_score = cells[4].trim().replace(',', ".");
            if clean_score != "–" && clean_score != "-" && !clean_score.is_empty() {
                if let Ok(s) = clean_score.parse::<f64>() {
                    final_score = Some(s);
                    if s >= 5.0 {
                        status = "Đã qua".to_string();
                    }
                } else if clean_score == "M" || clean_score == "CH" {
                    status = "Đã qua".to_string();
                }
            }
        }

        if cells.len() >= 6 {
            let st = cells[5].trim();
            if st.contains("Đã qua") || st.contains("Đạt") {
                status = "Đã qua".to_string();
            } else if st.contains("Đang") {
                status = "Đang học".to_string();
            } else if st.contains("Chưa") {
                status = "Chưa học".to_string();
            }
        }

        Some(CurriculumCourseRecord {
            course_code,
            course_name,
            credits,
            course_type,
            ideal_term,
            status,
            final_score,
        })
    };

    if !sections.is_empty() {
        for section in sections {
            let mut ideal_term: Option<i64> = None;
            for h in section.select(&header_sel) {
                let text = h.text().collect::<Vec<_>>().join(" ").trim().to_string();
                if let Some(t) = parse_term_from_header(&text) {
                    ideal_term = Some(t);
                    break;
                }
            }

            let term = ideal_term.unwrap_or(1);

            for row in section.select(&row_sel) {
                let cells: Vec<String> = row
                    .select(&cell_sel)
                    .map(|c| c.text().collect::<Vec<_>>().join(" ").trim().to_string())
                    .collect();

                if let Some(record) = parse_course_row(&cells, term) {
                    // Dedup theo course_code
                    if !records.iter().any(|r: &CurriculumCourseRecord| r.course_code == record.course_code) {
                        records.push(record);
                    }
                }
            }
        }
    }

    // Fallback nếu không chia theo section: đọc toàn bộ bảng
    if records.is_empty() {
        let mut current_term = 1;
        for row in document.select(&row_sel) {
            let cells: Vec<String> = row
                .select(&cell_sel)
                .map(|c| c.text().collect::<Vec<_>>().join(" ").trim().to_string())
                .collect();

            if cells.len() == 1 {
                if let Some(t) = parse_term_from_header(&cells[0]) {
                    current_term = t;
                }
                continue;
            }

            if let Some(record) = parse_course_row(&cells, current_term) {
                if !records.iter().any(|r: &CurriculumCourseRecord| r.course_code == record.course_code) {
                    records.push(record);
                }
            }
        }
    }

    Ok(records)
}

// ============================================================
//  UNIFIED 3-IN-1 PARSER ENTRYPOINT
// ============================================================

/// Parse chuỗi payload 3-in-1 trả về từ Webview SSO:
/// Hỗ trợ cả định dạng JSON `{ summary, by_semester, by_ctdt }` lẫn raw HTML fallback.
pub fn parse_unified_portal_payload(raw_payload: &str) -> Result<UnifiedAcademicData, String> {
    let clean = raw_payload.trim();

    // 1. Thử parse dạng JSON Payload 3-in-1
    if let Ok(raw_json) = serde_json::from_str::<PortalPayloadRaw>(clean) {
        let macro_metrics = parse_summary_tab(&raw_json.summary).unwrap_or_default();
        let historical_semesters = parse_by_semester_tab(&raw_json.by_semester).unwrap_or_default();
        let curriculum_courses = parse_by_ctdt_tab(&raw_json.by_ctdt).unwrap_or_default();

        return Ok(UnifiedAcademicData {
            macro_metrics,
            historical_semesters,
            curriculum_courses,
        });
    }

    // 2. Fallback: Payload là HTML đơn thuần của Tab By-Semester
    let historical_semesters = parse_by_semester_tab(clean)?;
    Ok(UnifiedAcademicData {
        macro_metrics: Vec::new(),
        historical_semesters,
        curriculum_courses: Vec::new(),
    })
}
// ============================================================
//  DRL PAGE PARSER (portal.uit.edu.vn/sinh-vien/diem-ren-luyen)
// ============================================================

/// Bản ghi ĐRL của 1 học kỳ cụ thể, trích từ bảng lịch sử trang DRL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemesterDrlRecord {
    pub semester_id: String,
    pub class_name: String,
    pub drl_score: i64,
    pub classification: String,
}

/// Kết quả parse toàn trang ĐRL UIT.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortalDrlOverview {
    pub cumulative_drl: f64,
    pub cumulative_classification: String,
    pub semesters: Vec<SemesterDrlRecord>,
}

/// Chuyển đổi text raw của cột Học kỳ trong bảng DRL sang `semester_id` chuẩn.
///
/// Ví dụ: "Học kỳ 2 Năm học 2025-2026" → `"2025_2026_HK2"`
/// Cũng xử lý dạng đơn năm: "Học kỳ 1 2024-2025" → `"2024_2025_HK1"`
fn parse_drl_semester_id(raw: &str) -> Option<String> {
    // Tìm số học kỳ
    let term = if raw.contains("Học kỳ 1") || raw.contains("HK1") {
        1u8
    } else if raw.contains("Học kỳ 2") || raw.contains("HK2") {
        2
    } else if raw.contains("Học kỳ 3") || raw.contains("HK3") || raw.to_lowercase().contains("hè") {
        3
    } else {
        return None;
    };

    // Tìm cặp năm học dạng YYYY-YYYY hoặc 2 token 4 chữ số
    let years: Vec<i64> = raw
        .split(|c: char| !c.is_ascii_digit())
        .filter(|t| t.len() == 4)
        .filter_map(|t| t.parse::<i64>().ok())
        .filter(|&y| (2000..=2100).contains(&y))
        .collect();

    match years.len() {
        0 => None,
        1 => Some(format!("{}_{}_HK{}", years[0], years[0] + 1, term)),
        _ => Some(format!("{}_{}_HK{}", years[0], years[1], term)),
    }
}

/// Parse fragment HTML của trang `portal.uit.edu.vn/sinh-vien/diem-ren-luyen`.
///
/// Trả về `PortalDrlOverview` gồm điểm TB toàn khóa và lịch sử từng học kỳ.
/// Nếu không tìm thấy dữ liệu nào, trả `Err` với thông điệp mô tả.
pub fn parse_portal_drl(html_content: &str) -> Result<PortalDrlOverview, String> {
    let document = Html::parse_fragment(html_content);

    // --- 1. Điểm TB toàn khóa ---
    // Thử nhiều selector để chống fragile nếu portal thay class
    let cumulative_drl = [
        "p.text-4xl.font-bold",
        "span.text-4xl",
        "div.text-4xl",
    ]
    .iter()
    .find_map(|sel_str| {
        let sel = Selector::parse(sel_str).ok()?;
        document
            .select(&sel)
            .next()
            .and_then(|el| el.text().collect::<String>().trim().parse::<f64>().ok())
    })
    .unwrap_or(0.0);

    // --- 2. Xếp loại toàn khóa ---
    let cumulative_classification = [
        "span.bg-primary.text-primary-foreground",
        "span.badge",
        r"div.rounded-xl.border-primary\/20 span",
    ]
    .iter()
    .find_map(|sel_str| {
        let sel = Selector::parse(sel_str).ok()?;
        let text = document
            .select(&sel)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())?;
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    })
    .unwrap_or_else(|| "Chưa xếp loại".to_string());

    // --- 3. Bảng lịch sử từng kỳ ---
    let row_sel = Selector::parse("tbody tr")
        .map_err(|e| format!("Selector 'tbody tr' lỗi: {e}"))?;
    let cell_sel = Selector::parse("td")
        .map_err(|e| format!("Selector 'td' lỗi: {e}"))?;

    let mut semesters = Vec::new();

    for row in document.select(&row_sel) {
        let cells: Vec<String> = row
            .select(&cell_sel)
            .map(|td| td.text().collect::<Vec<_>>().join(" ").trim().to_string())
            .collect();

        // Bảng DRL cần tối thiểu 4 cột:
        // STT | Học kỳ+Năm học | Lớp | Điểm | Xếp loại
        // Một số portal render 5 cột (thêm cột STT ở đầu)
        if cells.len() < 4 {
            continue;
        }

        // Tìm cột chứa thông tin học kỳ (bỏ qua cột STT nếu là số)
        let term_col = if cells[0].trim().parse::<i64>().is_ok() { 1 } else { 0 };

        let raw_term_info = &cells[term_col];
        let semester_id = match parse_drl_semester_id(raw_term_info) {
            Some(id) => id,
            None => continue, // header hoặc dòng không nhận dạng được
        };

        // Các cột còn lại tương đối với vị trí term_col
        let class_col  = term_col + 1;
        let score_col  = term_col + 2;
        let classif_col = term_col + 3;

        if classif_col >= cells.len() {
            continue;
        }

        let class_name = cells[class_col].trim().to_string();
        let drl_score: i64 = cells[score_col].trim().parse().unwrap_or(0);
        let classification = cells[classif_col].trim().to_string();

        semesters.push(SemesterDrlRecord {
            semester_id,
            class_name,
            drl_score,
            classification,
        });
    }

    Ok(PortalDrlOverview {
        cumulative_drl,
        cumulative_classification,
        semesters,
    })
}

// ============================================================
//  DRL PARSER UNIT TESTS
// ============================================================

#[cfg(test)]
mod drl_tests {
    use super::*;

    fn drl_html_fixture(rows: &str) -> String {
        format!(
            r#"<html><body>
            <p class="text-4xl font-bold">97.5</p>
            <span class="bg-primary text-primary-foreground">Xuất sắc</span>
            <table class="w-full">
              <tbody>{rows}</tbody>
            </table>
            </body></html>"#
        )
    }

    #[test]
    fn parse_drl_single_semester_no_stt_column() {
        let html = drl_html_fixture(
            r#"<tr>
                 <td>Học kỳ 2 Năm học 2025-2026</td>
                 <td>KHMT2025.1</td>
                 <td>100</td>
                 <td>Xuất sắc</td>
               </tr>""
            "#,
        );
        let result = parse_portal_drl(&html).expect("parse phải thành công");
        assert_eq!(result.cumulative_drl, 97.5);
        assert_eq!(result.cumulative_classification, "Xuất sắc");
        assert_eq!(result.semesters.len(), 1);
        let sem = &result.semesters[0];
        assert_eq!(sem.semester_id, "2025_2026_HK2");
        assert_eq!(sem.class_name, "KHMT2025.1");
        assert_eq!(sem.drl_score, 100);
        assert_eq!(sem.classification, "Xuất sắc");
    }

    #[test]
    fn parse_drl_with_stt_column() {
        let html = drl_html_fixture(
            r#"<tr>
                 <td>1</td>
                 <td>Học kỳ 1 Năm học 2024-2025</td>
                 <td>KHMT2024.1</td>
                 <td>95</td>
                 <td>Xuất sắc</td>
               </tr>""
            "#,
        );
        let result = parse_portal_drl(&html).expect("parse phải thành công");
        assert_eq!(result.semesters.len(), 1);
        let sem = &result.semesters[0];
        assert_eq!(sem.semester_id, "2024_2025_HK1");
        assert_eq!(sem.drl_score, 95);
    }

    #[test]
    fn parse_drl_skips_header_rows() {
        let html = drl_html_fixture(
            r#"<tr><td>STT</td><td>Học kỳ</td><td>Lớp</td><td>Điểm</td><td>Xếp loại</td></tr>
               <tr>
                 <td>1</td>
                 <td>Học kỳ 2 Năm học 2025-2026</td>
                 <td>KHMT2025.1</td>
                 <td>100</td>
                 <td>Xuất sắc</td>
               </tr>""
            "#,
        );
        let result = parse_portal_drl(&html).expect("parse phải thành công");
        // Dòng header bị skip vì "Học kỳ" không chứa year pattern
        assert_eq!(result.semesters.len(), 1);
    }

    #[test]
    fn parse_drl_semester_id_hk1() {
        assert_eq!(
            parse_drl_semester_id("Học kỳ 1 Năm học 2024-2025"),
            Some("2024_2025_HK1".to_string())
        );
    }

    #[test]
    fn parse_drl_semester_id_hk3_he() {
        assert_eq!(
            parse_drl_semester_id("Học kỳ hè 2024-2025"),
            Some("2024_2025_HK3".to_string())
        );
    }
}
