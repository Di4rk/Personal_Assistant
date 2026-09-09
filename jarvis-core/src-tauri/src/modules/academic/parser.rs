//! Pure DOM and Data Contract Parser for UIT Next.js Portal
//!
//! Tách biệt hoàn toàn khỏi database / rusqlite theo đúng Hard Architectural Constraint P0:
//! Pure functions, deterministic, 100% testable trong mọi môi trường.

use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

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
///
/// Thang điểm chuẩn UIT:
/// - >= 9.0: A+ (4.0)
/// - >= 8.5: A  (3.7)
/// - >= 8.0: B+ (3.5)
/// - >= 7.0: B  (3.0)
/// - >= 6.5: C+ (2.5)
/// - >= 5.5: C  (2.0)
/// - >= 5.0: D+ (1.5)
/// - >= 4.0: D  (1.0)
/// - < 4.0:  F  (0.0)
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

/// Parse DOM HTML fragment trích xuất từ Cổng Next.js UIT thành `Vec<ParsedSemester>`.
pub fn parse_portal_transcript(html_fragment: &str) -> Result<Vec<ParsedSemester>, String> {
    let document = Html::parse_fragment(html_fragment);
    let table_sel = Selector::parse("table").map_err(|e| e.to_string())?;
    let row_sel = Selector::parse("tbody tr").map_err(|e| e.to_string())?;
    let cell_sel = Selector::parse("td").map_err(|e| e.to_string())?;
    let header_sel = Selector::parse("h2, h3, h4, div.text-base, div.font-semibold, caption").map_err(|e| e.to_string())?;

    let tables: Vec<_> = document.select(&table_sel).collect();
    if tables.is_empty() {
        return Err("No transcript table discovered in DOM fragment".into());
    }

    let mut results = Vec::new();

    // Duyệt qua từng bảng điểm tìm thấy trong fragment
    for (idx, table) in tables.into_iter().enumerate() {
        let mut courses = Vec::new();

        for row in table.select(&row_sel) {
            let cells: Vec<String> = row
                .select(&cell_sel)
                .map(|td| td.text().collect::<Vec<_>>().join(" ").trim().to_string())
                .collect();

            // Cấu trúc bảng điểm UIT tối thiểu 8 cột:
            // [0: Mã môn, 1: Tên môn, 2: TC, 3: QT, 4: TH, 5: GK, 6: CK, 7: Điểm TB]
            if cells.len() < 8 {
                continue;
            }

            let raw_code = &cells[0];
            if raw_code.is_empty() || raw_code.contains("Mã môn") {
                continue;
            }

            let course_code = raw_code.trim().to_ascii_uppercase();
            let course_name = cells[1].trim().to_string();
            let credits: i64 = cells[2]
                .trim()
                .parse()
                .map_err(|_| format!("Invalid credits for {}", course_code))?;

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

            // Điểm tổng kết hệ 10
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

            // Policy check: nếu là môn miễn M thì không tính GPA
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
            // Tìm header học kỳ cho bảng này
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

            // Fallback nếu không có thẻ header riêng lẻ
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

    Ok(results)
}
