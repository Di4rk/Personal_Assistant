//! Degree Audit & Curriculum Engine — Diark OS
//!
//! Kiểm toán tiến độ tốt nghiệp chuẩn xác từng tín chỉ:
//! - Khấu trừ và chống tính trùng môn học lại / học cải thiện (Deduplication).
//! - Đối soát danh sách môn đã tích lũy với cây CTĐT chính thức (Mục 3.3-3.4).
//! - Thuật toán Greedy Elective Spillover: Tự chọn chuyên ngành dư thừa tự động tràn sang Tự chọn tự do.
//! - Kiểm toán 4 điều kiện tiên quyết phi tín chỉ (GDQP ME001, GDTC PE231/PE232, Tiếng Anh ENG03, ĐRL >= 65).

use crate::error::{AppError, AppResult};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditCourseItem {
    pub course_code: String,
    pub course_name: String,
    pub credits: f64,
    pub grade_10: Option<f64>,
    pub grade_char: Option<String>,
    pub semester_id: String,
    pub is_compulsory: bool,
    pub knowledge_block: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockAuditResult {
    pub knowledge_block: String,
    pub block_name_display: String,
    pub required_credits: f64,
    pub completed_credits: f64,
    pub is_fulfilled: bool,
    pub compulsory_fulfilled: bool,
    pub missing_compulsory_codes: Vec<String>,
    pub passed_courses: Vec<AuditCourseItem>,
    #[serde(default)]
    pub remaining_electives: Vec<AuditCourseItem>,
    pub overflow_credits: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NonCreditPrerequisites {
    pub has_gdtc: bool,
    pub has_gdqp: bool,
    pub has_english: bool,
    pub has_drl_65: bool,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DegreeAuditReport {
    pub slug: String,
    pub major_name: String,
    pub cohort_year: Option<i32>,
    pub total_degree_credits: f64,
    pub total_earned_credits: f64,
    pub total_required_credits: f64,
    pub completion_percent: f64,
    pub is_graduation_ready: bool,
    pub block_audits: Vec<BlockAuditResult>,
    pub non_credit_prerequisites: NonCreditPrerequisites,
    pub unmatched_passed_courses: Vec<AuditCourseItem>,
}

#[derive(Debug, Clone)]
struct StudentCourseRecord {
    course_code: String,
    course_name: String,
    credits: f64,
    summary_score_10: Option<f64>,
    grade_char: Option<String>,
    semester_id: String,
    is_passed: bool,
}

/// Lấy tên hiển thị thân thiện cho từng khối kiến thức
pub fn get_block_display_name(raw_block: &str) -> String {
    let norm = crate::services::curriculum_harvester::normalize_major_name(raw_block);
    if norm == "dc" || norm.contains("dai cuong") {
        "Đại cương".to_string()
    } else if norm == "csn" || norm == "co so nganh" {
        "Cơ sở ngành".to_string()
    } else if norm.starts_with("co so nganh (nhom") || norm.starts_with("csn (nhom") {
        raw_block.to_string()
    } else if norm == "cn" || norm == "chuyen nganh" {
        "Chuyên ngành".to_string()
    } else if norm == "tttn" || norm.contains("thuc tap") {
        "Thực tập tốt nghiệp".to_string()
    } else if norm.contains("do an") {
        raw_block.to_string()
    } else if norm.contains("tu do") || norm.contains("tu chon tu do") || norm == "tu_do" {
        "Tự chọn tự do".to_string()
    } else if norm == "kltn" || norm.contains("khoa luan") {
        "Khóa luận tốt nghiệp".to_string()
    } else {
        raw_block.to_string()
    }
}

/// Tính toán báo cáo kiểm toán tốt nghiệp chi tiết cho sinh viên.
pub fn run_degree_audit(conn: &Connection, preferred_slug: Option<&str>) -> AppResult<DegreeAuditReport> {
    // 1. Xác định curriculum slug
    let slug = resolve_active_curriculum_slug(conn, preferred_slug)?;

    // 2. Tải metadata và chỉ tiêu tốt nghiệp từ DB
    let (major_name, cohort_year, total_degree_credits) = conn.query_row(
        "SELECT major_name, cohort_year, COALESCE(total_credits, 126.0) FROM curriculum_index WHERE slug = ?1",
        params![slug],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?, row.get::<_, f64>(2)?)),
    ).map_err(|e| AppError::CurriculumParse(format!("Không tìm thấy CTĐT với slug {}: {}", slug, e)))?;

    // Tải rules
    let mut rules: Vec<(String, f64)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT knowledge_block, required_credits FROM curriculum_rules WHERE slug = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![slug], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })?;
        for r in rows {
            rules.push(r?);
        }
    }

    // Tải curriculum courses
    let mut curr_courses: Vec<crate::services::curriculum_harvester::CurriculumCourse> = Vec::new();
    {
        let mut stmt = conn.prepare(
            r#"
            SELECT course_code, course_name, credits, theory_credits, practical_credits,
                   knowledge_block, is_compulsory, recommended_semester
            FROM curriculum_courses
            WHERE slug = ?1
            ORDER BY id ASC
            "#,
        )?;
        let rows = stmt.query_map(params![slug], |row| {
            Ok(crate::services::curriculum_harvester::CurriculumCourse {
                course_code: row.get(0)?,
                course_name: row.get(1)?,
                credits: row.get(2)?,
                theory_credits: row.get(3)?,
                practical_credits: row.get(4)?,
                knowledge_block: row.get(5)?,
                is_compulsory: row.get::<_, i64>(6)? != 0,
                recommended_semester: row.get(7)?,
            })
        })?;
        for r in rows {
            curr_courses.push(r?);
        }
    }

    // 3. Tải danh sách môn học của sinh viên: Hợp nhất academic_courses (theo học kỳ) và academic_curriculum (theo CTĐT)
    let mut raw_student_courses: Vec<StudentCourseRecord> = Vec::new();
    {
        // 3.1 Nạp từ academic_courses
        let mut stmt = conn.prepare(
            r#"
            SELECT course_code, course_name, credits, summary_score_10, grade_char, semester_id, is_passed
            FROM academic_courses
            ORDER BY semester_id ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let code = row.get::<_, String>(0)?.trim().to_uppercase();
            let name = row.get::<_, String>(1)?;
            let mut credits = row.get::<_, f64>(2)?;
            let score_10 = row.get::<_, Option<f64>>(3)?;
            let grade_char = row.get::<_, Option<String>>(4)?;
            let sem_id = row.get::<_, String>(5)?;
            let is_passed_raw = row.get::<_, i64>(6)? != 0;

            // Đảm bảo môn phi tín chỉ (ME001, PE231, PE232) luôn giữ 0.0 TC để không phình tổng tín chỉ
            if code == "ME001" || code.starts_with("PE") {
                credits = 0.0;
            }

            let is_passed = is_passed_raw
                || score_10.map(|s| s >= 5.0).unwrap_or(false)
                || grade_char.as_ref().map(|g| g != "F" && !g.is_empty()).unwrap_or(false);

            Ok(StudentCourseRecord {
                course_code: code,
                course_name: name,
                credits,
                summary_score_10: score_10,
                grade_char,
                semester_id: sem_id,
                is_passed,
            })
        })?;
        for r in rows {
            raw_student_courses.push(r?);
        }

        // 3.2 Nạp từ academic_curriculum (Bảng điểm theo CTĐT)
        if let Ok(mut curr_stmt) = conn.prepare(
            r#"
            SELECT course_code, course_name, credits, course_type, ideal_term, status, final_score
            FROM academic_curriculum
            "#,
        ) {
            let curr_rows = curr_stmt.query_map([], |row| {
                let code = row.get::<_, String>(0)?.trim().to_uppercase();
                let name = row.get::<_, String>(1)?;
                let mut credits = row.get::<_, f64>(2)?;
                let _ctype = row.get::<_, Option<String>>(3)?;
                let ideal_term = row.get::<_, Option<i64>>(4)?;
                let status = row.get::<_, Option<String>>(5)?.unwrap_or_default();
                let final_score = row.get::<_, Option<f64>>(6)?;

                if code == "ME001" || code.starts_with("PE") {
                    credits = 0.0;
                }

                let status_lower = status.to_lowercase();
                let is_passed = status_lower.contains("qua")
                    || status_lower.contains("đạt")
                    || status_lower.contains("dat")
                    || status_lower.contains("miễn")
                    || status_lower.contains("mien")
                    || final_score.map(|s| s >= 5.0).unwrap_or(false);

                let grade_char = if is_passed {
                    if let Some(score) = final_score {
                        if score >= 9.0 { Some("A+".to_string()) }
                        else if score >= 8.5 { Some("A".to_string()) }
                        else if score >= 8.0 { Some("B+".to_string()) }
                        else if score >= 7.0 { Some("B".to_string()) }
                        else if score >= 6.5 { Some("C+".to_string()) }
                        else if score >= 5.5 { Some("C".to_string()) }
                        else if score >= 5.0 { Some("D+".to_string()) }
                        else if score >= 4.0 { Some("D".to_string()) }
                        else { Some("F".to_string()) }
                    } else {
                        Some("Đạt".to_string())
                    }
                } else {
                    None
                };

                let sem_id = ideal_term.map(|t| format!("HK{}", t)).unwrap_or_else(|| "CTĐT".to_string());

                Ok(StudentCourseRecord {
                    course_code: code,
                    course_name: name,
                    credits,
                    summary_score_10: final_score,
                    grade_char,
                    semester_id: sem_id,
                    is_passed,
                })
            })?;

            for r in curr_rows {
                raw_student_courses.push(r?);
            }
        }
    }

    // 4. Deduplication: Chỉ giữ điểm cao nhất của môn học lại / học cải thiện
    let mut deduplicated_passed_courses: HashMap<String, StudentCourseRecord> = HashMap::new();
    let mut all_taken_codes: HashSet<String> = HashSet::new();

    for mut course in raw_student_courses {
        all_taken_codes.insert(course.course_code.clone());
        if !course.is_passed {
            continue;
        }

        if course.course_code == "ME001" || course.course_code.starts_with("PE") {
            course.credits = 0.0;
        }

        match deduplicated_passed_courses.get_mut(&course.course_code) {
            Some(existing) => {
                let existing_score = existing.summary_score_10.unwrap_or(0.0);
                let current_score = course.summary_score_10.unwrap_or(0.0);
                if current_score > existing_score {
                    *existing = course;
                } else if existing.grade_char.is_none() && course.grade_char.is_some() {
                    existing.grade_char = course.grade_char;
                }
            }
            None => {
                deduplicated_passed_courses.insert(course.course_code.clone(), course);
            }
        }
    }

    // 5. Kiểm toán 4 điều kiện phi tín chỉ (GDQP, GDTC, Tiếng Anh, ĐRL >= 65)
    let non_credit_prerequisites = evaluate_non_credit_prerequisites(conn, &deduplicated_passed_courses)?;

    // 6. Ánh xạ các khối kiến thức và kiểm toán tín chỉ
    // Tạo cấu trúc phân bổ
    let mut block_map: HashMap<String, BlockAuditResult> = HashMap::new();
    let mut rule_blocks_order: Vec<String> = Vec::new();

    for (raw_block, req_credits) in &rules {
        let block_key = raw_block.clone();
        if !block_map.contains_key(&block_key) {
            rule_blocks_order.push(block_key.clone());
            block_map.insert(
                block_key.clone(),
                BlockAuditResult {
                    knowledge_block: block_key.clone(),
                    block_name_display: get_block_display_name(&block_key),
                    required_credits: *req_credits,
                    completed_credits: 0.0,
                    is_fulfilled: false,
                    compulsory_fulfilled: true,
                    missing_compulsory_codes: Vec::new(),
                    passed_courses: Vec::new(),
                    remaining_electives: Vec::new(),
                    overflow_credits: 0.0,
                },
            );
        }
    }

    // Bảo đảm luôn có khối "Tự chọn tự do" trong bảng kiểm toán nếu chưa có
    let tu_do_key = rule_blocks_order
        .iter()
        .find(|b| {
            let norm = crate::services::curriculum_harvester::normalize_major_name(b);
            norm.contains("tu do") || norm == "tu_do"
        })
        .cloned()
        .unwrap_or_else(|| {
            let key = "Tự chọn tự do".to_string();
            rule_blocks_order.push(key.clone());
            block_map.insert(
                key.clone(),
                BlockAuditResult {
                    knowledge_block: key.clone(),
                    block_name_display: "Tự chọn tự do".to_string(),
                    required_credits: 10.0,
                    completed_credits: 0.0,
                    is_fulfilled: false,
                    compulsory_fulfilled: true,
                    missing_compulsory_codes: Vec::new(),
                    passed_courses: Vec::new(),
                    remaining_electives: Vec::new(),
                    overflow_credits: 0.0,
                },
            );
            key
        });

    // Gom môn theo block trong curriculum
    let mut curr_courses_by_block: HashMap<String, Vec<crate::services::curriculum_harvester::CurriculumCourse>> = HashMap::new();
    let mut course_to_curr: HashMap<String, crate::services::curriculum_harvester::CurriculumCourse> = HashMap::new();

    for c in curr_courses {
        course_to_curr.insert(c.course_code.clone(), c.clone());
        curr_courses_by_block.entry(c.knowledge_block.clone()).or_default().push(c);
    }

    let mut remaining_passed_courses = deduplicated_passed_courses.clone();

    // BƯỚC 6.1: Khớp các môn Bắt buộc (Compulsory) trước
    for (block_key, block_result) in block_map.iter_mut() {
        if let Some(courses_in_block) = curr_courses_by_block.get(block_key) {
            for c in courses_in_block {
                if c.is_compulsory {
                    if let Some(student_course) = remaining_passed_courses.remove(&c.course_code) {
                        block_result.completed_credits += student_course.credits;
                        block_result.passed_courses.push(AuditCourseItem {
                            course_code: student_course.course_code,
                            course_name: student_course.course_name,
                            credits: student_course.credits,
                            grade_10: student_course.summary_score_10,
                            grade_char: student_course.grade_char,
                            semester_id: student_course.semester_id,
                            is_compulsory: true,
                            knowledge_block: block_key.clone(),
                        });
                    } else {
                        // Chưa đạt môn bắt buộc
                        block_result.compulsory_fulfilled = false;
                        block_result.missing_compulsory_codes.push(c.course_code.clone());
                    }
                }
            }
        }
    }

    // BƯỚC 6.2: Khớp các môn Tự chọn theo đúng khối kiến thức
    // Sắp xếp các môn tự chọn của sinh viên theo điểm số giảm dần để ưu tiên môn điểm cao
    let mut elective_candidates: Vec<StudentCourseRecord> = remaining_passed_courses.into_values().collect();
    elective_candidates.sort_by(|a, b| {
        let score_a = a.summary_score_10.unwrap_or(0.0);
        let score_b = b.summary_score_10.unwrap_or(0.0);
        score_b.partial_cmp(&score_a).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut unassigned_courses: Vec<StudentCourseRecord> = Vec::new();

    for student_course in elective_candidates {
        if let Some(curr) = course_to_curr.get(&student_course.course_code) {
            let target_block = &curr.knowledge_block;
            if let Some(block_result) = block_map.get_mut(target_block) {
                // Kiểm tra xem khối này đã đầy tín chỉ chưa
                if block_result.completed_credits < block_result.required_credits {
                    block_result.completed_credits += student_course.credits;
                    block_result.passed_courses.push(AuditCourseItem {
                        course_code: student_course.course_code,
                        course_name: student_course.course_name,
                        credits: student_course.credits,
                        grade_10: student_course.summary_score_10,
                        grade_char: student_course.grade_char,
                        semester_id: student_course.semester_id,
                        is_compulsory: false,
                        knowledge_block: target_block.clone(),
                    });
                    continue;
                }
            }
        }
        // Nếu không khớp khối hoặc khối đã đủ tín chỉ, đưa vào danh sách chờ tràn sang Tự chọn tự do
        unassigned_courses.push(student_course);
    }

    // BƯỚC 6.3: Thuật toán Greedy Spillover — Dồn tín chỉ dư thừa sang "Tự chọn tự do"
    let mut final_unmatched: Vec<AuditCourseItem> = Vec::new();
    if let Some(tu_do_block) = block_map.get_mut(&tu_do_key) {
        for student_course in unassigned_courses {
            let item = AuditCourseItem {
                course_code: student_course.course_code.clone(),
                course_name: student_course.course_name.clone(),
                credits: student_course.credits,
                grade_10: student_course.summary_score_10,
                grade_char: student_course.grade_char.clone(),
                semester_id: student_course.semester_id.clone(),
                is_compulsory: false,
                knowledge_block: tu_do_key.clone(),
            };

            if tu_do_block.completed_credits < tu_do_block.required_credits {
                tu_do_block.completed_credits += student_course.credits;
                tu_do_block.passed_courses.push(item);
            } else {
                tu_do_block.overflow_credits += student_course.credits;
                final_unmatched.push(item);
            }
        }
    }

    // BƯỚC 6.4: Thu thập danh sách các môn tự chọn chưa học của từng khối kiến thức
    for (block_key, block_result) in block_map.iter_mut() {
        if let Some(courses_in_block) = curr_courses_by_block.get(block_key) {
            for c in courses_in_block {
                if !c.is_compulsory && !deduplicated_passed_courses.contains_key(&c.course_code) {
                    block_result.remaining_electives.push(AuditCourseItem {
                        course_code: c.course_code.clone(),
                        course_name: c.course_name.clone(),
                        credits: c.credits,
                        grade_10: None,
                        grade_char: None,
                        semester_id: c.recommended_semester.map(|s| format!("HK{}", s)).unwrap_or_else(|| "Tự chọn".to_string()),
                        is_compulsory: false,
                        knowledge_block: block_key.clone(),
                    });
                }
            }
        }
    }

    // BƯỚC 6.5: Cập nhật cờ fulfilled và tổng hợp toàn diện
    let mut total_earned_credits = 0.0;
    let mut total_required_credits = 0.0;
    let mut all_compulsory_done = true;
    let mut all_blocks_fulfilled = true;

    let mut block_audits: Vec<BlockAuditResult> = Vec::new();
    for key in rule_blocks_order {
        if let Some(mut b) = block_map.remove(&key) {
            b.is_fulfilled = b.completed_credits >= b.required_credits;
            if !b.is_fulfilled {
                all_blocks_fulfilled = false;
            }
            if !b.compulsory_fulfilled {
                all_compulsory_done = false;
            }

            total_earned_credits += b.completed_credits;
            total_required_credits += b.required_credits;
            block_audits.push(b);
        }
    }

    if total_required_credits == 0.0 {
        total_required_credits = total_degree_credits;
    }

    let completion_percent = ((total_earned_credits / total_degree_credits) * 100.0).min(100.0);
    let is_graduation_ready = completion_percent >= 100.0
        && all_compulsory_done
        && all_blocks_fulfilled
        && non_credit_prerequisites.has_gdtc
        && non_credit_prerequisites.has_gdqp
        && non_credit_prerequisites.has_english
        && non_credit_prerequisites.has_drl_65;

    Ok(DegreeAuditReport {
        slug,
        major_name,
        cohort_year,
        total_degree_credits,
        total_earned_credits,
        total_required_credits,
        completion_percent: (completion_percent * 10.0).round() / 10.0,
        is_graduation_ready,
        block_audits,
        non_credit_prerequisites,
        unmatched_passed_courses: final_unmatched,
    })
}

/// Bóc tách mã CTĐT học vụ từ portal (ví dụ "KHMT-CQUI-D480101 K20") thành các thuộc tính
#[derive(Debug, Default, Clone)]
pub struct AcademicCurriculumCodeAnalysis {
    pub major_token: String,     // "KHMT", "KTPM", "ATTT", v.v.
    pub tot_code: String,        // "CQUI", "CLC", "CTTT", "BCU", "CQ-VN", "TX", "CNTN"
    pub major_code: String,      // "D480101", v.v.
    pub cohort_num: Option<i32>, // 20
    pub cohort_year: Option<i32>,// 2025
}

/// Phân tích cú pháp chuỗi curriculum_code lưu trong hồ sơ học vụ
pub fn parse_curriculum_code_hint(raw: &str) -> AcademicCurriculumCodeAnalysis {
    let mut analysis = AcademicCurriculumCodeAnalysis::default();
    let cleaned = raw.trim();
    if cleaned.is_empty() {
        return analysis;
    }

    // 1. Tìm cohort (K20 -> 2005 + 20 = 2025, hoặc 2025)
    let re_k = Regex::new(r"(?i)\bK(\d{1,2})\b").ok();
    let re_y = Regex::new(r"\b(20\d{2})\b").ok();

    if let Some(ref re) = re_k {
        if let Some(caps) = re.captures(cleaned) {
            if let Some(m) = caps.get(1).and_then(|c| c.as_str().parse::<i32>().ok()) {
                analysis.cohort_num = Some(m);
                analysis.cohort_year = Some(2005 + m);
            }
        }
    }
    if analysis.cohort_year.is_none() {
        if let Some(ref re) = re_y {
            if let Some(caps) = re.captures(cleaned) {
                if let Some(y) = caps.get(1).and_then(|c| c.as_str().parse::<i32>().ok()) {
                    analysis.cohort_year = Some(y);
                    analysis.cohort_num = Some(y - 2005);
                }
            }
        }
    }

    // 2. Tìm tot_code (CQUI, CLC, CTTT, BCU, CQ-VN, TX, CNTN)
    let upper = cleaned.to_uppercase();
    if upper.contains("CQUI") || upper.contains("-CQ-") || upper.contains("-CQ") {
        analysis.tot_code = "CQUI".to_string();
    } else if upper.contains("CLC") {
        analysis.tot_code = "CLC".to_string();
    } else if upper.contains("CTTT") || upper.contains("TIEN TIEN") {
        analysis.tot_code = "CTTT".to_string();
    } else if upper.contains("BCU") {
        analysis.tot_code = "BCU".to_string();
    } else if upper.contains("CQ-VN") || upper.contains("VIET NHAT") {
        analysis.tot_code = "CQ-VN".to_string();
    } else if upper.contains("TX") || upper.contains("TU XA") {
        analysis.tot_code = "TX".to_string();
    } else if upper.contains("TAI NANG") || upper.contains("CNTN") {
        analysis.tot_code = "CNTN".to_string();
    } else {
        analysis.tot_code = "CQUI".to_string();
    }

    // 3. Tìm major_token (KHMT, KTPM, ATTT, HTTT, MMT, KTMT, KHDL, TMDT, TTNT, TKVM, TTDPT, CNTT)
    for token in ["KHMT", "KTPM", "ATTT", "HTTT", "MMT", "KTMT", "KHDL", "TMDT", "TTNT", "TKVM", "TTDPT", "CNTT"] {
        if upper.contains(token) {
            analysis.major_token = token.to_string();
            break;
        }
    }

    // 4. Tìm major_code (D48.... hoặc D52....)
    if let Ok(re_code) = Regex::new(r"\b(D\d{6})\b") {
        if let Some(caps) = re_code.captures(&upper) {
            if let Some(m) = caps.get(1) {
                analysis.major_code = m.as_str().to_string();
            }
        }
    }

    analysis
}

/// Đối soát phân tích học vụ với danh mục CTĐT catalog.json để map chính xác 100% slug
pub fn match_slug_from_catalog(analysis: &AcademicCurriculumCodeAnalysis) -> Option<String> {
    let entries = crate::services::curriculum_harvester::get_catalog_entries();
    let target_year = analysis.cohort_year?;

    let major_keywords: &[&str] = match analysis.major_token.as_str() {
        "KHMT" => &["khoa hoc may tinh", "khoa-hoc-may-tinh"],
        "KTPM" => &["ky thuat phan mem", "phan-mem"],
        "ATTT" => &["an toan thong tin", "an-toan"],
        "HTTT" => &["he thong thong tin", "he-thong"],
        "MMT" => &["mang may tinh", "mang-may-tinh"],
        "KTMT" => &["ky thuat may tinh", "ky-thuat-may-tinh"],
        "KHDL" => &["khoa hoc du lieu", "du-lieu"],
        "TMDT" => &["thuong mai dien tu", "thuong-mai"],
        "TTNT" => &["tri tue nhan tao", "tri-tue"],
        "TKVM" => &["thiet ke vi mach", "vi-mach"],
        "TTDPT" => &["truyen thong da phuong tien", "truyen-thong"],
        "CNTT" => &["cong nghe thong tin", "cong-nghe-thong-tin"],
        _ => &[],
    };

    let mut best_entry = None;
    let mut best_score = -1;

    for entry in entries {
        if let Some(ref years) = entry.intake_years {
            if !years.contains(&target_year) {
                continue;
            }
        } else {
            continue;
        }

        let mut score = 0;

        if let Some(ref entry_tot) = entry.tot_code {
            if entry_tot.eq_ignore_ascii_case(&analysis.tot_code) {
                score += 20;
            } else if analysis.tot_code == "CQUI" && (entry_tot == "CQ" || entry.he_code.as_deref() == Some("CQ")) {
                score += 10;
            }
        } else if analysis.tot_code == "CQUI" && entry.he_code.as_deref() == Some("CQ") {
            score += 10;
        }

        let norm_slug = entry.slug.to_lowercase();
        let norm_name = crate::services::curriculum_harvester::normalize_major_name(&entry.name);
        for kw in major_keywords {
            if norm_slug.contains(kw) || norm_name.contains(kw) {
                score += 30;
                break;
            }
        }

        if analysis.tot_code == "CQUI" {
            if norm_slug.contains("tai-nang") || norm_slug.contains("chat-luong-cao") || norm_slug.contains("tu-xa") || norm_slug.contains("lien-ket") {
                score -= 15;
            }
        } else if analysis.tot_code == "CLC" {
            if norm_slug.contains("chat-luong-cao") {
                score += 25;
            }
        } else if analysis.tot_code == "CNTN" || analysis.tot_code == "TN" {
            if norm_slug.contains("tai-nang") {
                score += 25;
            }
        }

        if score > best_score {
            best_score = score;
            best_entry = Some(entry.slug.clone());
        }
    }

    if best_score >= 30 {
        best_entry
    } else {
        None
    }
}

/// Xác định active curriculum slug dựa trên ưu tiên truyền vào hoặc cơ sở dữ liệu settings.
fn resolve_active_curriculum_slug(conn: &Connection, preferred_slug: Option<&str>) -> AppResult<String> {
    // 0. Ưu tiên slug truyền vào trực tiếp nếu hợp lệ
    if let Some(s) = preferred_slug {
        if !s.trim().is_empty() {
            let exists: bool = conn.query_row(
                "SELECT COUNT(*) FROM curriculum_index WHERE slug = ?1",
                params![s],
                |row| row.get::<_, i64>(0),
            ).map(|c| c > 0).unwrap_or(false);
            if exists {
                return Ok(s.to_string());
            }
        }
    }

    // 1. Phân tích trực tiếp từ thông tin học vụ (curriculum_code, ví dụ "KHMT-CQUI-D480101 K20")
    let curriculum_code: Option<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'curriculum_code'",
        [],
        |row| row.get(0),
    ).ok();

    if let Some(ref ccode) = curriculum_code {
        let mut analysis = parse_curriculum_code_hint(ccode);

        // Bổ sung cohort từ student_id nếu mã học vụ chưa có năm
        if analysis.cohort_year.is_none() {
            let student_id: Option<String> = conn.query_row(
                "SELECT value FROM settings WHERE key = 'student_id'",
                [],
                |row| row.get(0),
            ).ok();
            if let Some(ref sid) = student_id {
                if sid.len() >= 2 {
                    if let Ok(prefix) = sid[..2].parse::<i32>() {
                        analysis.cohort_year = Some(2000 + prefix);
                    }
                }
            }
        }

        // Bổ sung major_token từ student_class hoặc user_major nếu thiếu
        if analysis.major_token.is_empty() {
            let student_class: Option<String> = conn.query_row(
                "SELECT value FROM settings WHERE key = 'student_class'",
                [],
                |row| row.get(0),
            ).ok();
            if let Some(ref sclass) = student_class {
                let upper = sclass.to_uppercase();
                for token in ["KHMT", "KTPM", "ATTT", "HTTT", "MMT", "KTMT", "KHDL", "TMDT", "TTNT", "TKVM", "TTDPT", "CNTT"] {
                    if upper.contains(token) {
                        analysis.major_token = token.to_string();
                        break;
                    }
                }
            }
        }

        if let Some(matched_slug) = match_slug_from_catalog(&analysis) {
            let _ = conn.execute(
                "INSERT INTO settings (key, value) VALUES ('curriculum_slug', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![matched_slug],
            );
            return Ok(matched_slug);
        }
    }

    // 2. Kiểm tra settings xem có curriculum_slug đã lưu trước đó không
    let saved_slug: Option<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'curriculum_slug'",
        [],
        |row| row.get(0),
    ).ok();
    if let Some(slug) = saved_slug {
        if !slug.trim().is_empty() {
            return Ok(slug);
        }
    }

    // 3. Fallback: Phân tích theo intro course trong academic_curriculum / user_major / student_class / student_id
    let student_id: Option<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'student_id'",
        [],
        |row| row.get(0),
    ).ok();

    let student_class: Option<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'student_class'",
        [],
        |row| row.get(0),
    ).ok();

    let user_major: Option<String> = conn.query_row(
        "SELECT value FROM settings WHERE key IN ('user_major', 'major_code') ORDER BY rowid DESC LIMIT 1",
        [],
        |row| row.get(0),
    ).ok();

    let mut detected_cohort_year = None;
    if let Some(ref sid) = student_id {
        if sid.len() >= 2 {
            if let Ok(prefix) = sid[..2].parse::<i32>() {
                detected_cohort_year = Some(2000 + prefix);
            }
        }
    }

    if detected_cohort_year.is_none() {
        if let Some(ref sclass) = student_class {
            if let Ok(re) = Regex::new(r"20\d{2}") {
                if let Some(m) = re.find(sclass) {
                    detected_cohort_year = m.as_str().parse::<i32>().ok();
                }
            }
        }
    }

    let cohort_year = detected_cohort_year.unwrap_or(2025);

    // Tìm major_token:
    let mut major_token = String::new();
    if let Some(ref sclass) = student_class {
        let norm = crate::services::curriculum_harvester::normalize_major_name(sclass);
        for (token, key) in [
            ("KHMT", "khmt"), ("KTPM", "ktpm"), ("ATTT", "attt"), ("HTTT", "httt"),
            ("MMT", "mmt"), ("KTMT", "ktmt"), ("KHDL", "khdl"), ("TMDT", "tmdt"),
            ("TTNT", "ttnt"), ("TKVM", "tkvm"), ("TTDPT", "ttdpt"), ("CNTT", "cntt"),
        ] {
            if norm.contains(key) {
                major_token = token.to_string();
                break;
            }
        }
    }

    if major_token.is_empty() {
        if let Some(ref m) = user_major {
            let m_upper = m.trim().to_uppercase();
            match m_upper.as_str() {
                "CS" | "KHMT" => major_token = "KHMT".to_string(),
                "SE" | "KTPM" => major_token = "KTPM".to_string(),
                "IS" | "HTTT" => major_token = "HTTT".to_string(),
                "CE" | "KTMT" => major_token = "KTMT".to_string(),
                "NT" | "ATTT" => major_token = "ATTT".to_string(),
                "NET" | "MMT" => major_token = "MMT".to_string(),
                "DS" | "KHDL" => major_token = "KHDL".to_string(),
                "AI" | "TTNT" => major_token = "TTNT".to_string(),
                "EC" | "TMDT" => major_token = "TMDT".to_string(),
                "IC" | "TKVM" => major_token = "TKVM".to_string(),
                _ => {}
            }
        }
    }

    // Nếu vẫn chưa có, kiểm tra môn Giới thiệu ngành trong academic_curriculum
    if major_token.is_empty() {
        let intro_code: Option<String> = conn.query_row(
            "SELECT course_code FROM academic_curriculum WHERE course_code IN ('CS005', 'SE005', 'IS005', 'CE005', 'NT015', 'DS005', 'EC005') LIMIT 1",
            [],
            |r| r.get(0),
        ).ok();
        if let Some(ref icode) = intro_code {
            match icode.as_str() {
                "CS005" => major_token = "KHMT".to_string(),
                "SE005" => major_token = "KTPM".to_string(),
                "IS005" => major_token = "HTTT".to_string(),
                "CE005" => major_token = "KTMT".to_string(),
                "NT015" => major_token = "ATTT".to_string(),
                "DS005" => major_token = "KHDL".to_string(),
                "EC005" => major_token = "TMDT".to_string(),
                _ => {}
            }
        }
    }

    if !major_token.is_empty() {
        let analysis = AcademicCurriculumCodeAnalysis {
            major_token: major_token.clone(),
            tot_code: "CQUI".to_string(),
            major_code: String::new(),
            cohort_num: Some(cohort_year - 2005),
            cohort_year: Some(cohort_year),
        };
        if let Some(matched_slug) = match_slug_from_catalog(&analysis) {
            let _ = conn.execute(
                "INSERT INTO settings (key, value) VALUES ('curriculum_slug', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![matched_slug],
            );
            return Ok(matched_slug);
        }
    }

    // 4. Default Fallback
    let default_slug: Option<String> = conn.query_row(
        "SELECT slug FROM curriculum_index ORDER BY is_cached DESC, cohort_year DESC LIMIT 1",
        [],
        |row| row.get(0),
    ).ok();

    Ok(default_slug.unwrap_or_else(|| "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025".to_string()))
}

/// Đánh giá 4 điều kiện tốt nghiệp phi tín chỉ
fn evaluate_non_credit_prerequisites(
    conn: &Connection,
    passed_courses: &HashMap<String, StudentCourseRecord>,
) -> AppResult<NonCreditPrerequisites> {
    let mut details = Vec::new();

    // 1. ME001 (GDQP)
    let gdqp_course = passed_courses.get("ME001");
    let has_gdqp = gdqp_course.is_some();
    if let Some(c) = gdqp_course {
        if let Some(score) = c.summary_score_10 {
            details.push(format!("GDQP: Đã hoàn thành (ME001 • {:.1} điểm)", score));
        } else {
            details.push("GDQP: Đã hoàn thành (ME001)".to_string());
        }
    } else {
        details.push("GDQP: Chưa hoàn thành chứng chỉ GDQP (ME001)".to_string());
    }

    // 2. PE231 & PE232 (GDTC)
    let has_pe231 = passed_courses.contains_key("PE231");
    let has_pe232 = passed_courses.contains_key("PE232");
    let gdtc_count = passed_courses.keys().filter(|k| k.starts_with("PE")).count();
    let has_gdtc = (has_pe231 && has_pe232) || gdtc_count >= 2;
    if has_gdtc {
        details.push(format!("GDTC: Đã hoàn thành {} học phần GDTC", gdtc_count));
    } else {
        details.push("GDTC: Chưa đủ 2 học phần GDTC (PE231 & PE232)".to_string());
    }

    // 3. Tiếng Anh (ENG03 hoặc chứng chỉ quốc tế trong settings)
    let english_exempt: bool = conn.query_row(
        "SELECT value FROM settings WHERE key = 'english_cert_verified'",
        [],
        |row| row.get::<_, String>(0),
    ).map(|v| v == "true" || v == "1").unwrap_or(false);

    let has_eng03 = passed_courses.contains_key("ENG03");
    let has_english = has_eng03 || english_exempt;
    if english_exempt {
        details.push("Ngoại ngữ: Đã xác thực chứng chỉ quốc tế (Miễn chuẩn đầu ra)".to_string());
    } else if has_eng03 {
        details.push("Ngoại ngữ: Đã hoàn thành Anh văn 3 (ENG03)".to_string());
    } else {
        details.push("Ngoại ngữ: Chưa đạt chuẩn đầu ra (Cần ENG03 hoặc nộp chứng chỉ quốc tế)".to_string());
    }

    // 4. Điểm rèn luyện tích lũy >= 65 (Loại Khá trở lên)
    let avg_drl: Option<f64> = conn.query_row(
        "SELECT AVG(drl) FROM academic_macro_metrics WHERE drl IS NOT NULL",
        [],
        |row| row.get(0),
    ).ok();

    let drl_val = avg_drl.unwrap_or(75.0);
    let has_drl_65 = drl_val >= 65.0;
    if has_drl_65 {
        details.push(format!("ĐRL: Trung bình {:.1}/100 (Đạt yêu cầu >= 65)", drl_val));
    } else {
        details.push(format!("ĐRL: Trung bình {:.1}/100 (Chưa đạt mức sàn 65)", drl_val));
    }

    Ok(NonCreditPrerequisites {
        has_gdtc,
        has_gdqp,
        has_english,
        has_drl_65,
        details,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_curriculum_and_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::schema::ensure_curriculum_schema(&conn).expect("schema");

        let fixture_path = std::path::Path::new("tests/fixtures/uit_curriculum_sample.rsc");
        let content = std::fs::read_to_string(fixture_path).expect("fixture");
        let parsed = crate::services::curriculum_harvester::parse_curriculum_stream(
            &content,
            "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025",
        ).expect("parse");

        crate::services::curriculum_harvester::save_parsed_curriculum(&conn, &parsed).expect("save");

        // Tạo bảng academic_courses và academic_macro_metrics
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS academic_courses (
                id TEXT PRIMARY KEY,
                semester_id TEXT NOT NULL,
                course_code TEXT NOT NULL,
                course_name TEXT NOT NULL,
                credits REAL NOT NULL,
                midterm_score REAL,
                final_score REAL,
                other_scores TEXT,
                summary_score_10 REAL,
                summary_score_4 REAL,
                grade_char TEXT,
                is_passed INTEGER NOT NULL DEFAULT 1,
                is_gpa_calculated INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS academic_macro_metrics (
                semester_id TEXT PRIMARY KEY,
                term_gpa REAL NOT NULL DEFAULT 0.0,
                cumulative_gpa REAL NOT NULL DEFAULT 0.0,
                classification TEXT NOT NULL DEFAULT '',
                term_credits INTEGER NOT NULL DEFAULT 0,
                cumulative_credits INTEGER NOT NULL DEFAULT 0,
                drl INTEGER
            );

            CREATE TABLE IF NOT EXISTS academic_curriculum (
                course_code TEXT PRIMARY KEY,
                course_name TEXT NOT NULL,
                credits REAL NOT NULL,
                course_type TEXT,
                ideal_term INTEGER,
                status TEXT,
                final_score REAL,
                updated_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        ).expect("tables");

        conn
    }

    #[test]
    fn test_deduplication_retaken_courses() {
        let conn = setup_test_curriculum_and_db();

        // Thêm môn IT001 học 2 lần: lần 1 được 4.0 (rớt/qua thấp), lần 2 được 8.5
        conn.execute(
            "INSERT INTO academic_courses (id, semester_id, course_code, course_name, credits, summary_score_10, is_passed)
             VALUES ('c1', 'sem1', 'IT001', 'Nhập môn lập trình', 4.0, 4.0, 0)",
            [],
        ).expect("insert c1");

        conn.execute(
            "INSERT INTO academic_courses (id, semester_id, course_code, course_name, credits, summary_score_10, is_passed)
             VALUES ('c2', 'sem2', 'IT001', 'Nhập môn lập trình', 4.0, 8.5, 1)",
            [],
        ).expect("insert c2");

        let report = run_degree_audit(&conn, Some("cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025")).expect("audit");

        let dc_block = report.block_audits.iter().find(|b| b.knowledge_block == "ĐC").expect("dc block");
        let it001_occurrences = dc_block.passed_courses.iter().filter(|c| c.course_code == "IT001").count();
        assert_eq!(it001_occurrences, 1, "Môn học lại chỉ được tính đúng 1 lần");
        assert_eq!(
            dc_block.passed_courses.iter().find(|c| c.course_code == "IT001").unwrap().grade_10,
            Some(8.5),
            "Phải lấy điểm cao nhất của môn học lại"
        );
    }

    #[test]
    fn test_compulsory_missing_detection() {
        let conn = setup_test_curriculum_and_db();

        // Học sinh chỉ học IT001, chưa học IT002 và IT003
        conn.execute(
            "INSERT INTO academic_courses (id, semester_id, course_code, course_name, credits, summary_score_10, is_passed)
             VALUES ('c1', 'sem1', 'IT001', 'Nhập môn lập trình', 4.0, 9.0, 1)",
            [],
        ).expect("insert");

        let report = run_degree_audit(&conn, Some("cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025")).expect("audit");

        let csn_block = report.block_audits.iter().find(|b| b.knowledge_block == "CSN").expect("csn block");
        assert!(!csn_block.compulsory_fulfilled, "CSN phải báo chưa hoàn thành bắt buộc");
        assert!(csn_block.missing_compulsory_codes.contains(&"IT003".to_string()));
        assert!(csn_block.missing_compulsory_codes.contains(&"IT002".to_string()));
        assert!(!report.is_graduation_ready);
    }

    #[test]
    fn test_elective_spillover_into_tu_do() {
        let conn = setup_test_curriculum_and_db();

        // Khối CN yêu cầu 16 TC. Cho học sinh học 5 môn CN = 20 TC (vượt 4 TC)
        // CS106 (4), CS114 (4), CS232 (4), CS105 (4), CS211 (4)
        let cn_courses = ["CS106", "CS114", "CS232", "CS105", "CS211"];
        for (i, code) in cn_courses.iter().enumerate() {
            conn.execute(
                "INSERT INTO academic_courses (id, semester_id, course_code, course_name, credits, summary_score_10, is_passed)
                 VALUES (?1, 'sem5', ?2, 'Chuyên ngành', 4.0, 8.0, 1)",
                params![format!("cn_{}", i), code],
            ).expect("insert cn");
        }

        let report = run_degree_audit(&conn, Some("cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025")).expect("audit");

        let cn_block = report.block_audits.iter().find(|b| b.knowledge_block == "CN").expect("cn block");
        assert_eq!(cn_block.completed_credits, 16.0, "CN chỉ nhận tối đa 16 TC yêu cầu");
        assert!(cn_block.is_fulfilled);

        let tu_do_block = report.block_audits.iter().find(|b| b.knowledge_block == "Tự chọn tự do").expect("tu do block");
        assert_eq!(tu_do_block.completed_credits, 4.0, "4 TC chuyên ngành dư phải tràn sang Tự chọn tự do");
    }

    #[test]
    fn test_non_credit_prerequisites_check() {
        let conn = setup_test_curriculum_and_db();

        // Thêm ME001, PE231, PE232, ENG03
        conn.execute(
            "INSERT INTO academic_courses (id, semester_id, course_code, course_name, credits, summary_score_10, is_passed)
             VALUES ('me', 'sem1', 'ME001', 'Giáo dục quốc phòng', 0.0, 8.0, 1),
                    ('pe1', 'sem2', 'PE231', 'Giáo dục thể chất 1', 0.0, 8.0, 1),
                    ('pe2', 'sem3', 'PE232', 'Giáo dục thể chất 2', 0.0, 8.0, 1),
                    ('eng', 'sem3', 'ENG03', 'Anh văn 3', 4.0, 8.0, 1)",
            [],
        ).expect("insert non credit");

        conn.execute(
            "INSERT INTO academic_macro_metrics (semester_id, term_gpa, cumulative_gpa, drl)
             VALUES ('sem1', 8.0, 8.0, 85)",
            [],
        ).expect("insert macro");

        let report = run_degree_audit(&conn, Some("cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025")).expect("audit");

        assert!(report.non_credit_prerequisites.has_gdqp);
        assert!(report.non_credit_prerequisites.has_gdtc);
        assert!(report.non_credit_prerequisites.has_english);
        assert!(report.non_credit_prerequisites.has_drl_65);
    }

    #[test]
    fn test_academic_curriculum_merge_and_gdqp() {
        let conn = setup_test_curriculum_and_db();

        // Môn ME001 (GDQP) chỉ có trong academic_curriculum với status 'Đã qua' và điểm 7.8
        conn.execute(
            "INSERT INTO academic_curriculum (course_code, course_name, credits, course_type, ideal_term, status, final_score)
             VALUES ('ME001', 'Giáo dục quốc phòng', 0.0, 'Bắt buộc', 1, 'Đã qua', 7.8)",
            [],
        ).expect("insert ME001 into academic_curriculum");

        // Một môn học kỳ bình thường IT001
        conn.execute(
            "INSERT INTO academic_courses (id, semester_id, course_code, course_name, credits, summary_score_10, is_passed)
             VALUES ('c1', 'sem1', 'IT001', 'Nhập môn lập trình', 4.0, 9.0, 1)",
            [],
        ).expect("insert IT001");

        let report = run_degree_audit(&conn, Some("cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025")).expect("audit");

        // GDQP phải được ghi nhận hoàn thành
        assert!(report.non_credit_prerequisites.has_gdqp, "ME001 từ academic_curriculum phải được ghi nhận hoàn thành");
        let gdqp_detail = report.non_credit_prerequisites.details.iter().find(|d| d.contains("GDQP")).unwrap();
        assert!(gdqp_detail.contains("7.8"), "GDQP detail phải hiển thị điểm 7.8: {gdqp_detail}");

        // Điểm tín chỉ toàn khóa không được bị phình vì ME001
        assert_eq!(report.total_earned_credits, 4.0, "ME001 không được làm phình tổng tín chỉ tích lũy (chỉ tính 4.0 TC của IT001)");
    }

    #[test]
    fn test_curriculum_code_parsing_and_slug_resolution() {
        let analysis = parse_curriculum_code_hint("KHMT-CQUI-D480101 K20");
        assert_eq!(analysis.major_token, "KHMT");
        assert_eq!(analysis.tot_code, "CQUI");
        assert_eq!(analysis.cohort_num, Some(20));
        assert_eq!(analysis.cohort_year, Some(2025));

        let slug = match_slug_from_catalog(&analysis);
        assert_eq!(slug, Some("cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025".to_string()));
    }

    #[test]
    fn test_remaining_electives_populated() {
        let conn = setup_test_curriculum_and_db();

        let report = run_degree_audit(&conn, Some("cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025")).expect("audit");
        for b in &report.block_audits {
            println!("Block: '{}' ({}) - remaining electives: {}", b.knowledge_block, b.block_name_display, b.remaining_electives.len());
        }

        // Tìm một khối kiến thức có môn tự chọn (ví dụ khối Chuyên ngành CN hoặc tự chọn)
        let has_any_electives = report.block_audits.iter().any(|b| !b.remaining_electives.is_empty());
        assert!(has_any_electives, "Phải có ít nhất một khối kiến thức có remaining_electives khi sinh viên chưa học");
    }
}
