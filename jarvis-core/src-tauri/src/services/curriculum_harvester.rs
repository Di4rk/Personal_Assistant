use crate::error::{AppError, AppResult};
use regex::Regex;
use rusqlite::{params, Connection};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CurriculumRule {
    pub knowledge_block: String,
    pub required_credits: f64,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CurriculumCourse {
    pub course_code: String,
    pub course_name: String,
    pub credits: f64,
    pub theory_credits: Option<f64>,
    pub practical_credits: Option<f64>,
    pub knowledge_block: String,
    pub is_compulsory: bool,
    pub recommended_semester: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParsedCurriculum {
    pub slug: String,
    pub major_name: String,
    pub cohort_year: Option<i32>,
    pub cohort_num: Option<i32>,
    pub total_credits: f64,
    pub rules: Vec<CurriculumRule>,
    pub courses: Vec<CurriculumCourse>,
}

/// Chuẩn hóa chuỗi tiếng Việt: chữ thường, bỏ dấu thanh, bỏ khoảng trắng thừa.
pub fn normalize_major_name(raw: &str) -> String {
    let mut normalized = String::with_capacity(raw.len());
    for c in raw.trim().to_lowercase().chars() {
        let mapped = match c {
            'à' | 'á' | 'ạ' | 'ả' | 'ã' | 'â' | 'ầ' | 'ấ' | 'ậ' | 'ẩ' | 'ẫ' | 'ă' | 'ằ' | 'ắ' | 'ặ' | 'ẳ' | 'ẵ' => 'a',
            'è' | 'é' | 'ẹ' | 'ẻ' | 'ẽ' | 'ê' | 'ề' | 'ế' | 'ệ' | 'ể' | 'ễ' => 'e',
            'ì' | 'í' | 'ị' | 'ỉ' | 'ĩ' => 'i',
            'ò' | 'ó' | 'ọ' | 'ỏ' | 'õ' | 'ô' | 'ồ' | 'ố' | 'ộ' | 'ổ' | 'ỗ' | 'ơ' | 'ờ' | 'ớ' | 'ợ' | 'ở' | 'ỡ' => 'o',
            'ù' | 'ú' | 'ụ' | 'ủ' | 'ũ' | 'ư' | 'ừ' | 'ứ' | 'ự' | 'ử' | 'ữ' => 'u',
            'ỳ' | 'ý' | 'ỵ' | 'ỷ' | 'ỹ' => 'y',
            'đ' => 'd',
            other => other,
        };
        normalized.push(mapped);
    }
    // Gộp nhiều khoảng trắng liên tiếp
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Trích xuất mã ngành rút gọn hoặc token từ tên ngành
pub fn major_name_to_code(major_name: &str) -> Option<String> {
    let norm = normalize_major_name(major_name);
    if norm.contains("khoa hoc may tinh") {
        Some("KHMT".to_string())
    } else if norm.contains("ky thuat phan mem") {
        Some("KTPM".to_string())
    } else if norm.contains("an toan thong tin") {
        Some("ATTT".to_string())
    } else if norm.contains("he thong thong tin") {
        Some("HTTT".to_string())
    } else if norm.contains("mang may tinh") || norm.contains("truyen thong") {
        Some("MMT".to_string())
    } else if norm.contains("ky thuat may tinh") {
        Some("KTMT".to_string())
    } else if norm.contains("tri tue nhan tao") {
        Some("TTNT".to_string())
    } else if norm.contains("khoa hoc du lieu") {
        Some("KHDL".to_string())
    } else if norm.contains("thuong mai dien tu") {
        Some("TMDT".to_string())
    } else {
        None
    }
}

/// Trích xuất khối kiến thức chuẩn hóa (ĐC, CSN, CN, TU_DO, KLTN)
pub fn canonicalize_block_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let norm = normalize_major_name(trimmed);
    if norm == "dc" || norm.contains("dai cuong") {
        "ĐC".to_string()
    } else if norm == "csn" || norm == "co so nganh" {
        "CSN".to_string()
    } else if norm.starts_with("co so nganh (nhom") || norm.starts_with("csn (nhom") {
        trimmed.to_string()
    } else if norm == "cn" || norm == "chuyen nganh" {
        "CN".to_string()
    } else if norm.contains("tu do") || norm.contains("tu chon tu do") {
        "TU_DO".to_string()
    } else if norm == "kltn" || norm.contains("khoa luan") || norm.contains("tot nghiep") {
        "KLTN".to_string()
    } else {
        trimmed.to_string()
    }
}

use std::sync::LazyLock;

static H1_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("h1").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));
static H3_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("h3").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));
static H4_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("h4").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));
static TR_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("tr").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));
static TH_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("th").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));
static TD_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("td").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));
static B_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("b").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));
static P_SEL: LazyLock<Selector> = LazyLock::new(|| Selector::parse("p").unwrap_or_else(|_| Selector::parse("*").expect("valid selector")));

static RE_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"20\d{2}").unwrap_or_else(|_| Regex::new(".*").expect("valid regex")));
static RE_COHORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)kh[oó][aá][\s\-]+(\d+)").unwrap_or_else(|_| Regex::new(".*").expect("valid regex")));
static RE_CREDITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Số\s+tín\s+chỉ\s+đào\s+tạo:\s*(?:tối\s+thiểu\s*)?([0-9]+(?:\.[0-9]+)?)").unwrap_or_else(|_| Regex::new(".*").expect("valid regex")));
static RE_SEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Học kỳ\s+(\d+)").unwrap_or_else(|_| Regex::new(".*").expect("valid regex")));
static RE_MAJOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)ngành\s+([^(]+)").unwrap_or_else(|_| Regex::new(".*").expect("valid regex")));

/// Phân giải Next.js RSC payload của Cổng thông tin UIT thành cấu trúc dữ liệu CTĐT.
/// Áp dụng thuật toán Heading-to-Sibling Traversal để tìm table.table-bordered kế tiếp.
pub fn parse_curriculum_stream(rsc_content: &str, slug: &str) -> AppResult<ParsedCurriculum> {
    let document = Html::parse_document(rsc_content);

    // 1. Phân giải tiêu đề & khóa từ h1
    let mut page_title = String::new();
    if let Some(h1) = document.select(&H1_SEL).next() {
        page_title = h1.text().collect::<String>().trim().to_string();
    }

    let cohort_year = {
        RE_YEAR.find_iter(&page_title)
            .filter_map(|m| m.as_str().parse::<i32>().ok())
            .last()
            .or_else(|| {
                RE_YEAR.find_iter(slug).filter_map(|m| m.as_str().parse::<i32>().ok()).last()
            })
    };

    let cohort_num = {
        RE_COHORT.captures(&page_title)
            .or_else(|| RE_COHORT.captures(slug))
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<i32>().ok())
    };

    // 2. Phân giải tổng tín chỉ từ Mục 1.4 nếu có
    let mut total_credits_opt = None;
    if let Some(caps) = RE_CREDITS.captures(rsc_content) {
        if let Some(m) = caps.get(1) {
            total_credits_opt = m.as_str().parse::<f64>().ok();
        }
    }

    // 3. Phân giải Bảng 3.1: Chỉ tiêu các khối kiến thức qua Heading-to-Sibling Traversal
    let mut rules: Vec<CurriculumRule> = Vec::new();
    for h3 in document.select(&H3_SEL) {
        let h3_text = h3.text().collect::<String>();
        if h3_text.contains("3.1") {
            // Traversal tìm table kế tiếp
            for sibling in h3.next_siblings() {
                if let Some(sibling_elem) = ElementRef::wrap(sibling) {
                    let tag = sibling_elem.value().name();
                    if tag == "table" {
                        for tr in sibling_elem.select(&TR_SEL) {
                            let tds: Vec<_> = tr.select(&TD_SEL).collect();
                            if tds.len() >= 2 {
                                let block_raw = tds[0].text().collect::<String>().trim().to_string();
                                let credits_str = tds[1].text().collect::<String>().trim().to_string();
                                let percent = if tds.len() >= 3 {
                                    tds[2].text().collect::<String>().trim().parse::<f64>().ok()
                                } else {
                                    None
                                };
                                if let Ok(credits) = credits_str.parse::<f64>() {
                                    rules.push(CurriculumRule {
                                        knowledge_block: block_raw,
                                        required_credits: credits,
                                        percent,
                                    });
                                }
                            }
                        }
                        break;
                    }
                    if tag == "h3" || tag == "h2" || tag == "h1" {
                        break;
                    }
                }
            }
            break;
        }
    }

    // 4. Phân giải Kế hoạch giảng dạy mẫu (Mục 4.2) để mapping recommended_semester cho từng môn học
    let mut course_to_semester: HashMap<String, i32> = HashMap::new();
    for p in document.select(&P_SEL) {
        if let Some(b) = p.select(&B_SEL).next() {
            let b_text = b.text().collect::<String>();
            if b_text.contains("Học kỳ") {
                if let Some(caps) = RE_SEM.captures(&b_text) {
                    if let Some(sem_val) = caps.get(1).and_then(|m| m.as_str().parse::<i32>().ok()) {
                        for sibling in p.next_siblings() {
                            if let Some(sibling_elem) = ElementRef::wrap(sibling) {
                                let tag = sibling_elem.value().name();
                                if tag == "table" {
                                    for tr in sibling_elem.select(&TR_SEL) {
                                        let tds: Vec<_> = tr.select(&TD_SEL).collect();
                                        if !tds.is_empty() {
                                            let code = tds[0].text().collect::<String>().trim().to_uppercase();
                                            if !code.is_empty() && !code.starts_with("MÃ") {
                                                course_to_semester.entry(code).or_insert(sem_val);
                                            }
                                        }
                                    }
                                    break;
                                }
                                if tag == "p" || tag == "h3" || tag == "h4" {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 5. Phân giải Mục 3.3-3.4: Danh sách học phần theo khối (h4 headings)
    let mut courses: Vec<CurriculumCourse> = Vec::new();
    let mut seen_course_keys: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    for h4 in document.select(&H4_SEL) {
        let block_name = h4.text().collect::<String>().trim().to_string();
        if block_name.is_empty() {
            continue;
        }

        // Tìm table.table-bordered ngay sau h4
        for sibling in h4.next_siblings() {
            if let Some(sibling_elem) = ElementRef::wrap(sibling) {
                let tag = sibling_elem.value().name();
                if tag == "table" {
                    // Xác định cột động theo header th
                    let mut code_col = None;
                    let mut name_col = None;
                    let mut tc_col = None;
                    let mut lt_col = None;
                    let mut th_col = None;
                    let mut type_col = None;

                    if let Some(header_tr) = sibling_elem.select(&TR_SEL).next() {
                        for (idx, th) in header_tr.select(&TH_SEL).enumerate() {
                            let txt = th.text().collect::<String>().trim().to_lowercase();
                            if txt.contains("mã mh") || txt.contains("mã môn") {
                                code_col = Some(idx);
                            } else if txt.contains("tên môn") || txt.contains("tên mh") {
                                name_col = Some(idx);
                            } else if txt == "tc" || txt.contains("tín chỉ") {
                                tc_col = Some(idx);
                            } else if txt == "lt" || txt.contains("lý thuyết") {
                                lt_col = Some(idx);
                            } else if txt == "th" || txt.contains("thực hành") {
                                th_col = Some(idx);
                            } else if txt == "loại" {
                                type_col = Some(idx);
                            }
                        }
                    }

                    // Duyệt các dòng dữ liệu
                    for tr in sibling_elem.select(&TR_SEL) {
                        let tds: Vec<_> = tr.select(&TD_SEL).collect();
                        if tds.is_empty() {
                            continue;
                        }

                        let code_idx = match code_col {
                            Some(idx) if idx < tds.len() => idx,
                            _ => {
                                if tds.len() >= 2 && tds[1].text().collect::<String>().trim().len() <= 10 {
                                    1
                                } else {
                                    0
                                }
                            }
                        };

                        let course_code = tds[code_idx].text().collect::<String>().trim().to_uppercase();
                        if course_code.is_empty() || course_code.starts_with("MÃ") || course_code.contains("STT") {
                            continue;
                        }

                        let course_name = match name_col {
                            Some(idx) if idx < tds.len() => tds[idx].text().collect::<String>().trim().to_string(),
                            _ => {
                                if code_idx == 1 && tds.len() > 2 {
                                    tds[2].text().collect::<String>().trim().to_string()
                                } else if tds.len() > 1 {
                                    tds[1].text().collect::<String>().trim().to_string()
                                } else {
                                    "".to_string()
                                }
                            }
                        };

                        let credits = match tc_col {
                            Some(idx) if idx < tds.len() => {
                                tds[idx].text().collect::<String>().trim().parse::<f64>().unwrap_or(0.0)
                            }
                            _ => {
                                if tds.len() > 3 {
                                    tds[3].text().collect::<String>().trim().parse::<f64>().unwrap_or(0.0)
                                } else {
                                    0.0
                                }
                            }
                        };

                        let theory_credits = lt_col.and_then(|idx| {
                            if idx < tds.len() {
                                tds[idx].text().collect::<String>().trim().parse::<f64>().ok()
                            } else {
                                None
                            }
                        });

                        let practical_credits = th_col.and_then(|idx| {
                            if idx < tds.len() {
                                tds[idx].text().collect::<String>().trim().parse::<f64>().ok()
                            } else {
                                None
                            }
                        });

                        let is_compulsory = match type_col {
                            Some(idx) if idx < tds.len() => {
                                let t = tds[idx].text().collect::<String>().trim().to_lowercase();
                                t.contains("bắt buộc")
                            }
                            _ => {
                                let norm_block = normalize_major_name(&block_name);
                                norm_block == "dc" || norm_block == "csn"
                            }
                        };

                        let key = (course_code.clone(), block_name.clone());
                        if !seen_course_keys.contains(&key) {
                            seen_course_keys.insert(key);
                            let recommended_sem = course_to_semester.get(&course_code).copied();
                            courses.push(CurriculumCourse {
                                course_code,
                                course_name,
                                credits,
                                theory_credits,
                                practical_credits,
                                knowledge_block: block_name.clone(),
                                is_compulsory,
                                recommended_semester: recommended_sem,
                            });
                        }
                    }
                    break;
                }
                if tag == "h4" || tag == "h3" || tag == "h2" {
                    break;
                }
            }
        }
    }

    let total_credits = total_credits_opt.unwrap_or_else(|| {
        rules
            .iter()
            .filter(|r| {
                let norm = normalize_major_name(&r.knowledge_block);
                norm == "dc" || norm == "csn" || norm == "cn" || norm.contains("tu do") || norm.contains("kltn")
            })
            .map(|r| r.required_credits)
            .sum()
    });

    let major_name = if !page_title.is_empty() {
        if let Some(caps) = RE_MAJOR.captures(&page_title) {
            caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or(page_title)
        } else {
            page_title
        }
    } else {
        slug.replace('-', " ")
    };

    Ok(ParsedCurriculum {
        slug: slug.to_string(),
        major_name,
        cohort_year,
        cohort_num,
        total_credits,
        rules,
        courses,
    })
}

/// Nạp danh mục CTĐT mặc định vào cơ sở dữ liệu nếu bảng curriculum_index còn rỗng.
pub fn seed_curriculum_catalog_if_empty(conn: &Connection) -> AppResult<usize> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM curriculum_index", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(0);
    }

    let catalog_json_paths = [
        std::path::PathBuf::from("resources/default_curriculum_catalog.json"),
        std::path::PathBuf::from("src-tauri/resources/default_curriculum_catalog.json"),
        std::path::PathBuf::from("../src-tauri/resources/default_curriculum_catalog.json"),
    ];

    let mut found_path = None;
    for p in &catalog_json_paths {
        if p.exists() {
            found_path = Some(p.clone());
            break;
        }
    }

    let path = match found_path {
        Some(p) => p,
        None => {
            eprintln!("[CurriculumHarvester] default_curriculum_catalog.json not found, skipping seeding");
            return Ok(0);
        }
    };

    let content = std::fs::read_to_string(&path)?;
    let items: serde_json::Value = serde_json::from_str(&content)?;
    let arr = match items.as_array() {
        Some(a) => a,
        None => return Ok(0),
    };

    let tx = conn.unchecked_transaction()?;
    let mut inserted = 0;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT OR IGNORE INTO curriculum_index (
                slug, major_name, degree_level, cohort_year, cohort_num, training_form, is_cached, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
            "#,
        )?;

        let now = chrono::Local::now().timestamp();
        for item in arr {
            let slug = match item.get("slug").and_then(|v| v.as_str()) {
                Some(s) => s,
                None => continue,
            };
            let major = item.get("major").and_then(|v| v.as_str()).unwrap_or("Công nghệ thông tin");
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let he_code = item.get("he_code").and_then(|v| v.as_str()).unwrap_or("CQ");

            let cohort_year = item.get("intake_years")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .and_then(|y| y.as_i64())
                .map(|y| y as i32);

            let cohort_num = {
                let re = Regex::new(r"(?i)kh[oó]a\s+(\d+)").map_err(|e| AppError::CurriculumParse(e.to_string()))?;
                re.captures(name)
                    .and_then(|c| c.get(1))
                    .and_then(|m| m.as_str().parse::<i32>().ok())
            };

            let degree_level = if name.contains("Kỹ sư") { "Kỹ sư" } else { "Cử nhân" };

            stmt.execute(params![
                slug,
                major,
                degree_level,
                cohort_year,
                cohort_num,
                he_code,
                now
            ])?;
            inserted += 1;
        }
    }
    tx.commit()?;

    println!("[CurriculumHarvester] Seeded {} curricula into curriculum_index", inserted);
    Ok(inserted)
}

/// Lưu kết quả parse CTĐT vào SQLite một cách nguyên tử (Atomic Transaction).
pub fn save_parsed_curriculum(conn: &Connection, parsed: &ParsedCurriculum) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let now = chrono::Local::now().timestamp();

    // 1. Cập nhật curriculum_index
    tx.execute(
        r#"
        INSERT INTO curriculum_index (
            slug, major_name, cohort_year, cohort_num, total_credits, is_cached, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
        ON CONFLICT(slug) DO UPDATE SET
            major_name = excluded.major_name,
            cohort_year = COALESCE(excluded.cohort_year, curriculum_index.cohort_year),
            cohort_num = COALESCE(excluded.cohort_num, curriculum_index.cohort_num),
            total_credits = excluded.total_credits,
            is_cached = 1,
            updated_at = excluded.updated_at
        "#,
        params![
            parsed.slug,
            parsed.major_name,
            parsed.cohort_year,
            parsed.cohort_num,
            parsed.total_credits,
            now
        ],
    )?;

    // 2. Xóa và chèn lại curriculum_rules
    tx.execute("DELETE FROM curriculum_rules WHERE slug = ?1", params![parsed.slug])?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO curriculum_rules (slug, knowledge_block, required_credits, percent)
            VALUES (?1, ?2, ?3, ?4)
            "#,
        )?;
        for rule in &parsed.rules {
            stmt.execute(params![
                parsed.slug,
                rule.knowledge_block,
                rule.required_credits,
                rule.percent
            ])?;
        }
    }

    // 3. Xóa và chèn lại curriculum_courses
    tx.execute("DELETE FROM curriculum_courses WHERE slug = ?1", params![parsed.slug])?;
    {
        let mut stmt = tx.prepare(
            r#"
            INSERT INTO curriculum_courses (
                slug, course_code, course_name, credits, theory_credits, practical_credits,
                knowledge_block, is_compulsory, recommended_semester
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
        )?;
        for course in &parsed.courses {
            stmt.execute(params![
                parsed.slug,
                course.course_code,
                course.course_name,
                course.credits,
                course.theory_credits,
                course.practical_credits,
                course.knowledge_block,
                if course.is_compulsory { 1 } else { 0 },
                course.recommended_semester
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

/// Tải và đồng bộ CTĐT từ Portal UIT theo slug qua HTTP GET RSC stream
pub async fn sync_curriculum_by_slug(conn_pool: &crate::db::schema::SharedDb, slug: &str) -> AppResult<ParsedCurriculum> {
    let url = format!("https://portal.uit.edu.vn/chuong-trinh-dao-tao/{}", slug);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(AppError::Http)?;

    let res = client
        .get(&url)
        .header("RSC", "1")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .send()
        .await
        .map_err(AppError::Http)?;

    if !res.status().is_success() {
        return Err(AppError::CurriculumParse(format!(
            "Portal trả về mã lỗi HTTP {} cho slug {}",
            res.status(),
            slug
        )));
    }

    let payload = res.text().await.map_err(AppError::Http)?;
    let parsed = parse_curriculum_stream(&payload, slug)?;

    {
        let conn = conn_pool.lock().map_err(|_| AppError::PoisonedLock)?;
        save_parsed_curriculum(&conn, &parsed)?;
    }

    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn test_parse_curriculum_stream_by_heading() {
        let fixture_path = std::path::Path::new("tests/fixtures/uit_curriculum_sample.rsc");
        assert!(fixture_path.exists(), "Test fixture uit_curriculum_sample.rsc must exist");

        let content = std::fs::read_to_string(fixture_path).expect("Failed to read fixture file");

        // Warm-up static LazyLocks (Selector and Regex initialization)
        let _ = parse_curriculum_stream(&content, "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025");

        let start = Instant::now();
        let parsed = parse_curriculum_stream(&content, "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025")
            .expect("Failed to parse curriculum stream");
        let elapsed = start.elapsed();

        println!("Parsed in {:?}", elapsed);
        // Assertion 4: Parse duration < 50ms
        assert!(
            elapsed.as_millis() < 50,
            "Parse duration must be under 50ms, took {:?}",
            elapsed
        );

        // Assertion 1: Bóc đúng chỉ tiêu Table 3.1 (ĐC: 45 TC, CSN: 45 TC, CN: 16 TC, KLTN: 10 TC)
        let dc_rule = parsed.rules.iter().find(|r| r.knowledge_block == "ĐC");
        assert!(dc_rule.is_some(), "Must have ĐC rule");
        assert_eq!(dc_rule.unwrap().required_credits, 45.0);

        let csn_rule = parsed.rules.iter().find(|r| r.knowledge_block == "CSN");
        assert!(csn_rule.is_some(), "Must have CSN rule");
        assert_eq!(csn_rule.unwrap().required_credits, 45.0);

        let cn_rule = parsed.rules.iter().find(|r| r.knowledge_block == "CN");
        assert!(cn_rule.is_some(), "Must have CN rule");
        assert_eq!(cn_rule.unwrap().required_credits, 16.0);

        let kltn_rule = parsed.rules.iter().find(|r| r.knowledge_block == "KLTN");
        assert!(kltn_rule.is_some(), "Must have KLTN rule");
        assert_eq!(kltn_rule.unwrap().required_credits, 10.0);

        // Assertion 2: Bóc đúng các môn CSN cốt lõi (IT003, IT002, CS112) đúng loại Bắt buộc (is_compulsory = true)
        let it003 = parsed.courses.iter().find(|c| c.course_code == "IT003");
        assert!(it003.is_some(), "Must contain IT003 (Cấu trúc dữ liệu và giải thuật)");
        assert!(it003.unwrap().is_compulsory, "IT003 must be compulsory");
        assert_eq!(it003.unwrap().knowledge_block, "CSN");

        let it002 = parsed.courses.iter().find(|c| c.course_code == "IT002");
        assert!(it002.is_some(), "Must contain IT002 (Lập trình hướng đối tượng)");
        assert!(it002.unwrap().is_compulsory, "IT002 must be compulsory");
        assert_eq!(it002.unwrap().knowledge_block, "CSN");

        let cs112 = parsed.courses.iter().find(|c| c.course_code == "CS112");
        assert!(cs112.is_some(), "Must contain CS112 (Phân tích và thiết kế thuật toán)");
        assert!(cs112.unwrap().is_compulsory, "CS112 must be compulsory");
        assert_eq!(cs112.unwrap().knowledge_block, "CSN");

        // Assertion 3: Bóc đúng các môn ĐC tiên quyết kiểm toán (ME001 - GDQP, PE231/PE232 - GDTC, ENG03 - Ngoại ngữ)
        let me001 = parsed.courses.iter().find(|c| c.course_code == "ME001");
        assert!(me001.is_some(), "Must contain ME001 (GDQP)");
        assert_eq!(me001.unwrap().knowledge_block, "ĐC");
        assert!(me001.unwrap().is_compulsory);

        let pe231 = parsed.courses.iter().find(|c| c.course_code == "PE231");
        assert!(pe231.is_some(), "Must contain PE231 (GDTC 1)");
        assert_eq!(pe231.unwrap().knowledge_block, "ĐC");

        let pe232 = parsed.courses.iter().find(|c| c.course_code == "PE232");
        assert!(pe232.is_some(), "Must contain PE232 (GDTC 2)");
        assert_eq!(pe232.unwrap().knowledge_block, "ĐC");

        let eng03 = parsed.courses.iter().find(|c| c.course_code == "ENG03");
        assert!(eng03.is_some(), "Must contain ENG03 (Anh văn 3)");
        assert_eq!(eng03.unwrap().knowledge_block, "ĐC");
        assert!(eng03.unwrap().is_compulsory);

        // Verify total credits
        assert_eq!(parsed.total_credits, 126.0);
        assert_eq!(parsed.cohort_year, Some(2025));
        assert_eq!(parsed.cohort_num, Some(20));
    }
}
