use crate::error::{AppError, AppResult};
use regex::Regex;
use rusqlite::{params, Connection};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const CURRICULUM_PARSER_VERSION: &str = "3";

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
        if ('\u{0300}'..='\u{036f}').contains(&c) {
            continue;
        }
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
    } else if norm.contains("an toan thong tin") || norm.contains("an ninh mang") {
        Some("ATTT".to_string())
    } else if norm.contains("he thong thong tin") {
        Some("HTTT".to_string())
    } else if norm.contains("truyen thong da phuong tien") {
        Some("TTDPT".to_string())
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
    } else if norm.contains("thiet ke vi mach") {
        Some("TKVM".to_string())
    } else if norm.contains("cong nghe thong tin") {
        Some("CNTT".to_string())
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
    } else if norm.starts_with("co so nganh (nhom") || norm.starts_with("csn (nhom") {
        trimmed.to_string()
    } else if norm == "csn" || norm.contains("co so nganh") {
        "CSN".to_string()
    } else if norm == "cn" || norm.contains("chuyen nganh") {
        "CN".to_string()
    } else if norm.contains("tu do") || norm.contains("tu chon tu do") {
        "TU_DO".to_string()
    } else if norm == "kltn" || norm.contains("khoa luan") || norm.contains("tot nghiep") {
        "KLTN".to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub id: Option<i64>,
    pub slug: String,
    pub name: String,
    pub he_code: Option<String>,
    pub tot_code: Option<String>,
    pub intake_years: Option<Vec<i32>>,
    pub major: Option<String>,
}

/// Nạp danh mục CTĐT chính thức từ catalog.json tĩnh (không phụ thuộc file IO runtime)
pub fn get_catalog_entries() -> &'static [CatalogEntry] {
    static ENTRIES: LazyLock<Vec<CatalogEntry>> = LazyLock::new(|| {
        let raw = include_str!("../../resources/default_curriculum_catalog.json");
        serde_json::from_str(raw).unwrap_or_default()
    });
    &ENTRIES
}

/// Tra cứu tên tiếng Việt chuẩn có dấu trực tiếp từ catalog.json theo slug
pub fn lookup_catalog_name_by_slug(slug: &str) -> Option<String> {
    static MAP: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
        let mut map = HashMap::new();
        for entry in get_catalog_entries() {
            map.insert(entry.slug.clone(), entry.name.clone());
        }
        map
    });
    MAP.get(slug).cloned()
}

use std::sync::LazyLock;

static H1_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("h1").map_err(|e| format!("Invalid selector 'h1': {e:?}")));
static H3_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("h3").map_err(|e| format!("Invalid selector 'h3': {e:?}")));
#[allow(dead_code)]
static H4_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("h4").map_err(|e| format!("Invalid selector 'h4': {e:?}")));
static TR_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("tr").map_err(|e| format!("Invalid selector 'tr': {e:?}")));
#[allow(dead_code)]
static TH_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("th").map_err(|e| format!("Invalid selector 'th': {e:?}")));
static TD_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("td").map_err(|e| format!("Invalid selector 'td': {e:?}")));
static B_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("b").map_err(|e| format!("Invalid selector 'b': {e:?}")));
static P_SEL: LazyLock<Result<Selector, String>> =
    LazyLock::new(|| Selector::parse("p").map_err(|e| format!("Invalid selector 'p': {e:?}")));

static HEADING_OR_TABLE_SEL: LazyLock<Result<Selector, String>> = LazyLock::new(|| {
    Selector::parse("h2, h3, h4, h5, table")
        .map_err(|e| format!("Invalid selector 'h2, h3, h4, h5, table': {e:?}"))
});
static CELL_SEL: LazyLock<Result<Selector, String>> = LazyLock::new(|| {
    Selector::parse("th, td").map_err(|e| format!("Invalid selector 'th, td': {e:?}"))
});

static RE_YEAR: LazyLock<Result<Regex, String>> =
    LazyLock::new(|| Regex::new(r"20\d{2}").map_err(|e| format!("Invalid regex 'RE_YEAR': {e:?}")));
static RE_COHORT: LazyLock<Result<Regex, String>> =
    LazyLock::new(|| Regex::new(r"(?i)kh[oó][aá][\s\-]+(\d+)").map_err(|e| format!("Invalid regex 'RE_COHORT': {e:?}")));
static RE_CREDITS: LazyLock<Result<Regex, String>> =
    LazyLock::new(|| Regex::new(r"(?i)Số\s+tín\s+chỉ\s+đào\s+tạo:\s*(?:tối\s+thiểu\s*)?([0-9]+(?:\.[0-9]+)?)").map_err(|e| format!("Invalid regex 'RE_CREDITS': {e:?}")));
static RE_SEM: LazyLock<Result<Regex, String>> =
    LazyLock::new(|| Regex::new(r"Học kỳ\s+(\d+)").map_err(|e| format!("Invalid regex 'RE_SEM': {e:?}")));
static RE_MAJOR: LazyLock<Result<Regex, String>> =
    LazyLock::new(|| Regex::new(r"(?i)ngành\s+([^(]+)").map_err(|e| format!("Invalid regex 'RE_MAJOR': {e:?}")));
static RE_COURSE_CODE: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"^([A-Z]{2,6}\d{1,4}(?:\.[A-Z]{1,4})?)$")
        .map_err(|e| format!("Invalid regex 'RE_COURSE_CODE': {e:?}"))
});
static RE_CREDIT_NUM: LazyLock<Result<Regex, String>> =
    LazyLock::new(|| Regex::new(r"([0-9]+(?:\.[0-9]+)?)").map_err(|e| format!("Invalid regex 'RE_CREDIT_NUM': {e:?}")));

static RE_RSC_H1: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r#"\["\$","h1",null,\{[^}]*?"children":"([^"]+)""#)
        .map_err(|e| format!("Invalid regex 'RE_RSC_H1': {e:?}"))
});
static RE_RSC_TITLE: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r#""children":"([^"]+?)\s*—\s*Cổng thông tin UIT""#)
        .map_err(|e| format!("Invalid regex 'RE_RSC_TITLE': {e:?}"))
});

fn clean_cell_text(raw: &str) -> String {
    raw.replace('\u{00a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Trải bảng HTML có `rowspan` / `colspan` thành ma trận 2D phẳng, bỏ qua bảng lồng bên trong ô.
fn expand_table_grid(table_elem: ElementRef<'_>, cell_sel: &Selector) -> Vec<Vec<String>> {
    let mut raw_rows: Vec<ElementRef<'_>> = Vec::new();
    for child in table_elem.children() {
        let Some(el) = ElementRef::wrap(child) else {
            continue;
        };
        let name = el.value().name();
        if name == "tr" {
            raw_rows.push(el);
        } else if matches!(name, "thead" | "tbody" | "tfoot") {
            for sub in el.children() {
                if let Some(sub_el) = ElementRef::wrap(sub) {
                    if sub_el.value().name() == "tr" {
                        raw_rows.push(sub_el);
                    }
                }
            }
        }
    }

    let mut occupied: HashMap<(usize, usize), String> = HashMap::new();
    let mut grid: Vec<Vec<String>> = Vec::new();

    for (r_idx, tr) in raw_rows.into_iter().enumerate() {
        let mut row_cells: Vec<String> = Vec::new();
        let mut c_idx = 0usize;

        for cell in tr.select(cell_sel) {
            while let Some(spanned_val) = occupied.remove(&(r_idx, c_idx)) {
                row_cells.push(spanned_val);
                c_idx += 1;
            }

            let text = clean_cell_text(&cell.text().collect::<String>());
            let rowspan = cell
                .value()
                .attr("rowspan")
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(1)
                .clamp(1, 50);
            let colspan = cell
                .value()
                .attr("colspan")
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(1)
                .clamp(1, 20);

            for dc in 0..colspan {
                row_cells.push(text.clone());
                for dr in 1..rowspan {
                    occupied.insert((r_idx + dr, c_idx + dc), text.clone());
                }
            }
            c_idx += colspan;
        }

        while let Some(spanned_val) = occupied.remove(&(r_idx, c_idx)) {
            row_cells.push(spanned_val);
            c_idx += 1;
        }

        if !row_cells.is_empty() {
            grid.push(row_cells);
        }
    }

    grid
}

fn parse_numeric_credits(raw: &str, re_credit: &Regex) -> Option<f64> {
    let cleaned = raw
        .replace('\u{00a0}', " ")
        .replace(['≥', '>', '=', '+'], " ");
    re_credit
        .captures(&cleaned)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
}

fn extract_semantic_block_from_heading(heading_text: &str) -> Option<String> {
    let trimmed = clean_cell_text(heading_text);
    let norm = normalize_major_name(&trimmed);
    if norm.contains("nhom") && norm.contains("co so nganh") {
        return Some(trimmed);
    }
    if norm.contains("dai cuong") {
        return Some("ĐC".to_string());
    }
    if norm.contains("co so nganh") {
        return Some("CSN".to_string());
    }
    if norm.contains("chuyen nganh") {
        return Some("CN".to_string());
    }
    if norm.contains("tu chon tu do") || norm.contains("nhom mon hoc khac") {
        return Some("Tự chọn tự do".to_string());
    }
    if norm.contains("do an tot nghiep tai doanh nghiep") {
        return Some("Đồ án tốt nghiệp tại doanh nghiệp".to_string());
    }
    if norm.contains("khoa luan tot nghiep") || norm.contains("tot nghiep") {
        return Some("KLTN".to_string());
    }
    if norm == "dc" || norm == "csn" || norm == "cn" || norm == "kltn" {
        return Some(canonicalize_block_name(&trimmed));
    }
    None
}

/// Phân giải Next.js RSC payload của Cổng thông tin UIT thành cấu trúc dữ liệu CTĐT.
/// Áp dụng thuật toán Heading-to-Grid Traversal tổng quát cho mọi khóa (K19/K20/K21/Từ xa).
pub fn parse_curriculum_stream(rsc_content: &str, slug: &str) -> AppResult<ParsedCurriculum> {
    let h1_sel = H1_SEL.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let h3_sel = H3_SEL.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let heading_or_table_sel = HEADING_OR_TABLE_SEL
        .as_ref()
        .map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let tr_sel = TR_SEL.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let td_sel = TD_SEL.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let cell_sel = CELL_SEL.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let b_sel = B_SEL.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let p_sel = P_SEL.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;

    let re_year = RE_YEAR.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_cohort = RE_COHORT.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_credits = RE_CREDITS.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_sem = RE_SEM.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_major = RE_MAJOR.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_rsc_h1 = RE_RSC_H1.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_rsc_title = RE_RSC_TITLE.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_course_code = RE_COURSE_CODE.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;
    let re_credit_num = RE_CREDIT_NUM.as_ref().map_err(|e| AppError::CurriculumParse(e.clone()))?;

    let document = Html::parse_document(rsc_content);

    // 1. Phân giải tiêu đề & khóa từ catalog.json hoặc RSC payload
    let catalog_name = lookup_catalog_name_by_slug(slug);

    let mut page_title = String::new();
    if let Some(h1) = document.select(h1_sel).next() {
        page_title = clean_cell_text(&h1.text().collect::<String>());
    }
    if page_title.is_empty() {
        if let Some(caps) = re_rsc_h1.captures(rsc_content) {
            if let Some(m) = caps.get(1) {
                page_title = clean_cell_text(m.as_str());
            }
        }
    }
    if page_title.is_empty() {
        if let Some(caps) = re_rsc_title.captures(rsc_content) {
            if let Some(m) = caps.get(1) {
                page_title = clean_cell_text(m.as_str());
            }
        }
    }

    let cohort_year = {
        re_year
            .find_iter(&page_title)
            .filter_map(|m| m.as_str().parse::<i32>().ok())
            .last()
            .or_else(|| {
                re_year
                    .find_iter(slug)
                    .filter_map(|m| m.as_str().parse::<i32>().ok())
                    .last()
            })
    };

    let cohort_num = {
        re_cohort
            .captures(&page_title)
            .or_else(|| re_cohort.captures(slug))
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<i32>().ok())
    };

    // 2. Phân giải tổng tín chỉ từ phần Giới thiệu / Hình thức đào tạo nếu có
    let mut total_credits_opt = None;
    if let Some(caps) = re_credits.captures(rsc_content) {
        if let Some(m) = caps.get(1) {
            total_credits_opt = m.as_str().parse::<f64>().ok();
        }
    }

    // 3. Phân giải bảng "Tỷ lệ các khối kiến thức" (không phụ thuộc số mục 3.1 / 5.1 / 6.1)
    let mut rules: Vec<CurriculumRule> = Vec::new();
    for h in document.select(heading_or_table_sel) {
        let tag = h.value().name();
        if tag != "h2" && tag != "h3" && tag != "h4" {
            continue;
        }
        let heading_txt = clean_cell_text(&h.text().collect::<String>());
        let heading_norm = normalize_major_name(&heading_txt);
        if !heading_norm.contains("ty le cac khoi kien thuc") && !heading_txt.contains("3.1") {
            continue;
        }

        for sibling in h.next_siblings() {
            let Some(sibling_elem) = ElementRef::wrap(sibling) else {
                continue;
            };
            let s_tag = sibling_elem.value().name();
            if s_tag == "table" {
                let grid = expand_table_grid(sibling_elem, cell_sel);
                let mut header_rows = 0usize;
                let mut credits_col: Option<usize> = None;
                let mut percent_col: Option<usize> = None;

                for (r_idx, row) in grid.iter().take(2).enumerate() {
                    let mut matched_row = false;
                    for (c_idx, cell) in row.iter().enumerate() {
                        let cn = normalize_major_name(cell);
                        if cn.contains("tong so tin chi") || cn == "tong tc" || cn == "so tin chi" {
                            credits_col = Some(c_idx);
                            matched_row = true;
                        } else if cn == "%" || cn.contains("ty le") {
                            percent_col = Some(c_idx);
                            matched_row = true;
                        } else if cn == "khoi kien thuc" || cn == "khoi luong" {
                            matched_row = true;
                        }
                    }
                    if matched_row {
                        header_rows = r_idx + 1;
                    }
                }

                let c_col = credits_col.unwrap_or(1);
                let mut rule_acc: HashMap<String, (f64, Option<f64>)> = HashMap::new();
                let mut rule_order: Vec<String> = Vec::new();

                for row in grid.iter().skip(header_rows) {
                    if row.len() <= c_col {
                        continue;
                    }
                    let mut labels: Vec<&str> = Vec::new();
                    for cell in row.iter().take(c_col) {
                        let t = cell.trim();
                        if !t.is_empty() && labels.last().copied() != Some(t) {
                            labels.push(t);
                        }
                    }
                    if labels.is_empty() {
                        continue;
                    }

                    let joined_norm = normalize_major_name(&labels.join(" "));
                    let Some(credits) = parse_numeric_credits(&row[c_col], re_credit_num) else {
                        continue;
                    };

                    if joined_norm.contains("tong so tin chi tich luy")
                        || joined_norm.contains("tich luy toi thieu toan khoa")
                        || joined_norm == "tong"
                        || joined_norm == "tong cong"
                    {
                        if total_credits_opt.is_none() {
                            total_credits_opt = Some(credits);
                        }
                        continue;
                    }

                    let outer_norm = normalize_major_name(labels[0]);
                    let inner_raw = *labels.last().unwrap_or(&labels[0]);
                    let inner_norm = normalize_major_name(inner_raw);

                    let block_key = if labels.len() >= 2 && outer_norm.contains("dai cuong") {
                        "ĐC".to_string()
                    } else if inner_norm.contains("nhom") && inner_norm.contains("co so nganh") {
                        inner_raw.to_string()
                    } else if inner_norm.contains("do an tot nghiep tai doanh nghiep") {
                        "Đồ án tốt nghiệp tại doanh nghiệp".to_string()
                    } else if inner_norm.contains("co so nganh") || inner_norm == "csn" {
                        "CSN".to_string()
                    } else if inner_norm.contains("chuyen nganh") || inner_norm == "cn" {
                        "CN".to_string()
                    } else if inner_norm.contains("tu do") || inner_norm.contains("tu chon tu do") {
                        "Tự chọn tự do".to_string()
                    } else if inner_norm.contains("khoa luan") || inner_norm.contains("tot nghiep") || inner_norm == "kltn" {
                        "KLTN".to_string()
                    } else if outer_norm.contains("dai cuong") || inner_norm == "dc" {
                        "ĐC".to_string()
                    } else {
                        inner_raw.to_string()
                    };

                    let pct = percent_col.and_then(|pc| {
                        row.get(pc).and_then(|s| parse_numeric_credits(s, re_credit_num))
                    });

                    if !rule_acc.contains_key(&block_key) {
                        rule_order.push(block_key.clone());
                        rule_acc.insert(block_key, (credits, pct));
                    } else if let Some(entry) = rule_acc.get_mut(&block_key) {
                        entry.0 += credits;
                        if let (Some(prev), Some(curr)) = (entry.1, pct) {
                            entry.1 = Some(prev + curr);
                        }
                    }
                }

                for k in rule_order {
                    if let Some((req, pct)) = rule_acc.remove(&k) {
                        rules.push(CurriculumRule {
                            knowledge_block: k,
                            required_credits: req,
                            percent: pct,
                        });
                    }
                }
                break;
            }
            if s_tag == "h3" || s_tag == "h2" || s_tag == "h1" {
                break;
            }
        }

        if !rules.is_empty() {
            break;
        }
    }

    // Fallback giữ tương thích hoàn toàn nếu bảng dùng <th> cũ không khớp 3.1 text
    if rules.is_empty() {
        for h3 in document.select(h3_sel) {
            if h3.text().collect::<String>().contains("3.1") {
                for sibling in h3.next_siblings() {
                    if let Some(sibling_elem) = ElementRef::wrap(sibling) {
                        if sibling_elem.value().name() == "table" {
                            for tr in sibling_elem.select(tr_sel) {
                                let tds: Vec<_> = tr.select(td_sel).collect();
                                if tds.len() >= 2 {
                                    let block_raw = clean_cell_text(&tds[0].text().collect::<String>());
                                    if let Some(credits) = parse_numeric_credits(&tds[1].text().collect::<String>(), re_credit_num) {
                                        let pct = tds.get(2).and_then(|t| parse_numeric_credits(&t.text().collect::<String>(), re_credit_num));
                                        rules.push(CurriculumRule {
                                            knowledge_block: block_raw,
                                            required_credits: credits,
                                            percent: pct,
                                        });
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
                break;
            }
        }
    }

    // 4. Phân giải Kế hoạch giảng dạy mẫu để mapping recommended_semester cho từng môn học
    let mut course_to_semester: HashMap<String, i32> = HashMap::new();
    for p in document.select(p_sel) {
        if let Some(b) = p.select(b_sel).next() {
            let b_text = b.text().collect::<String>();
            if b_text.contains("Học kỳ") {
                if let Some(caps) = re_sem.captures(&b_text) {
                    if let Some(sem_val) = caps.get(1).and_then(|m| m.as_str().parse::<i32>().ok()) {
                        for sibling in p.next_siblings() {
                            if let Some(sibling_elem) = ElementRef::wrap(sibling) {
                                let tag = sibling_elem.value().name();
                                if tag == "table" {
                                    for tr in sibling_elem.select(tr_sel) {
                                        let tds: Vec<_> = tr.select(td_sel).collect();
                                        if !tds.is_empty() {
                                            let code = clean_cell_text(&tds[0].text().collect::<String>())
                                                .replace('*', " ")
                                                .trim()
                                                .to_uppercase();
                                            if re_course_code.is_match(&code) {
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
    // Hỗ trợ bảng Kế hoạch giảng dạy gộp 1 bảng lớn theo cột Học kỳ 1..8 (chuẩn K20+)
    for elem in document.select(heading_or_table_sel) {
        if elem.value().name() != "table" {
            continue;
        }
        let grid = expand_table_grid(elem, cell_sel);
        if grid.len() < 2 {
            continue;
        }
        let Some(c_idx) = grid[0].iter().position(|col| {
            let t = normalize_major_name(col);
            t.contains("ma mh") || t.contains("ma mon")
        }) else {
            continue;
        };
        let has_sem_rows = grid.iter().skip(1).any(|r| {
            !r.is_empty()
                && (re_sem.is_match(&r[0])
                    || normalize_major_name(&r.join(" ")).contains("tong so tin chi hoc ky"))
        });
        if !has_sem_rows {
            continue;
        }
        let mut active_sem: Option<i32> = None;
        for row in grid.iter().skip(1) {
            if !row.is_empty() {
                if let Some(caps) = re_sem.captures(&row[0]) {
                    if let Some(s) = caps.get(1).and_then(|m| m.as_str().parse::<i32>().ok()) {
                        active_sem = Some(s);
                    }
                }
            }
            let Some(sem_val) = active_sem else {
                continue;
            };
            if let Some(raw_code) = row.get(c_idx) {
                let code = raw_code.replace('*', " ").trim().to_uppercase();
                if re_course_code.is_match(&code) {
                    course_to_semester.entry(code).or_insert(sem_val);
                }
            }
        }
    }

    // 5. Phân giải Danh sách học phần theo khối qua traversal tuần tự h2/h3/h4/h5/table
    let mut courses: Vec<CurriculumCourse> = Vec::new();
    let mut seen_course_keys: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();

    let mut current_block: Option<String> = None;
    let mut in_skip_section = false;

    for elem in document.select(heading_or_table_sel) {
        let tag = elem.value().name();
        if tag != "table" {
            let h_txt = clean_cell_text(&elem.text().collect::<String>());
            if h_txt.is_empty() {
                continue;
            }
            let norm = normalize_major_name(&h_txt);

            if tag == "h2" || tag == "h3" {
                if norm.contains("gioi thieu")
                    || norm.contains("muc tieu")
                    || norm.contains("chuan dau ra")
                    || norm.contains("vi tri")
                    || norm.contains("quan diem")
                    || norm.contains("hinh thuc")
                    || norm.contains("ke hoach giang day")
                    || norm.contains("tuong duong")
                    || norm.contains("quy doi")
                    || norm.contains("ty le cac khoi kien thuc")
                    || norm.contains("phan bo cac khoi kien thuc")
                {
                    in_skip_section = true;
                    continue;
                }
                if norm.contains("chuong trinh dao tao") || norm.contains("danh sach hoc phan") || norm.contains("chuyen nghiep") {
                    in_skip_section = false;
                }
                if let Some(blk) = extract_semantic_block_from_heading(&h_txt) {
                    in_skip_section = false;
                    current_block = Some(blk);
                }
            } else if tag == "h4" {
                if norm.contains("tuong duong") || norm.contains("quy doi") {
                    in_skip_section = true;
                    continue;
                }
                in_skip_section = false;
                if let Some(blk) = extract_semantic_block_from_heading(&h_txt) {
                    current_block = Some(blk);
                } else {
                    current_block = Some(h_txt);
                }
            } else if tag == "h5" {
                // Giữ block hiện tại (ví dụ các hướng chuyên ngành 5.3.2.1 thuộc CN)
                if let Some(blk) = extract_semantic_block_from_heading(&h_txt) {
                    if blk != "CN" || current_block.as_deref() != Some("CN") {
                        current_block = Some(blk);
                    }
                }
            }
            continue;
        }

        if in_skip_section {
            continue;
        }
        let Some(ref active_block) = current_block else {
            continue;
        };

        let grid = expand_table_grid(elem, cell_sel);
        if grid.len() < 2 {
            continue;
        }

        let header = &grid[0];
        let mut code_col: Option<usize> = None;
        let mut name_col: Option<usize> = None;
        let mut tc_col: Option<usize> = None;
        let mut lt_col: Option<usize> = None;
        let mut th_col: Option<usize> = None;
        let mut type_col: Option<usize> = None;

        for (idx, col_name) in header.iter().enumerate() {
            let txt = normalize_major_name(col_name);
            if txt.contains("ma mh") || txt.contains("ma mon") {
                code_col = Some(idx);
            } else if txt.contains("ten mon") || txt.contains("ten mh") {
                name_col = Some(idx);
            } else if txt == "tc" || txt == "so tc" || txt.contains("tin chi") {
                tc_col = Some(idx);
            } else if txt == "lt" || txt.contains("ly thuyet") {
                lt_col = Some(idx);
            } else if txt == "th" || txt.contains("thuc hanh") {
                th_col = Some(idx);
            } else if txt == "loai" || txt.contains("bat buoc") || txt.contains("chon") {
                type_col = Some(idx);
            }
        }

        // Bỏ qua bảng layout tổng quan (ví dụ 6.2 không có cột Mã môn & TC)
        let (Some(c_idx), Some(t_idx)) = (code_col, tc_col) else {
            continue;
        };

        // Bỏ qua bảng Kế hoạch giảng dạy mẫu (Học kỳ 1..8) để không tràn vào khối KLTN
        let is_semester_plan_table = grid.iter().skip(1).any(|r| {
            (!r.is_empty() && re_sem.is_match(&r[0]))
                || normalize_major_name(&r.join(" ")).contains("tong so tin chi hoc ky")
        });
        if is_semester_plan_table {
            continue;
        }

        let mut section_row_compulsory: Option<bool> = None;

        for row in grid.iter().skip(1) {
            if row.is_empty() {
                continue;
            }
            let row_joined_norm = normalize_major_name(&row.join(" "));
            if row_joined_norm.contains("tong so tin chi")
                || row_joined_norm.contains("cac mon hoc khac theo de nghi")
                || row_joined_norm.contains("danh sach cac mon chuyen de")
            {
                continue;
            }

            // Nhận diện dòng sub-header nội bộ (VD: "Bắt buộc:", "Tự chọn: sinh viên tích lũy...")
            let first_cell_norm = normalize_major_name(&row[0]);
            if row.len() > c_idx && row[c_idx] == row[0] && row.len() >= 3 && row[2] == row[0] {
                if first_cell_norm.starts_with("bat buoc") {
                    section_row_compulsory = Some(true);
                } else if first_cell_norm.starts_with("tu chon") || first_cell_norm.starts_with("hoac") {
                    section_row_compulsory = Some(false);
                }
                continue;
            }
            if first_cell_norm.starts_with("bat buoc:") {
                section_row_compulsory = Some(true);
                continue;
            }
            if first_cell_norm.starts_with("tu chon:") {
                section_row_compulsory = Some(false);
                continue;
            }

            if c_idx >= row.len() {
                continue;
            }
            let raw_code_cell = row[c_idx].replace('*', " ").trim().to_uppercase();
            if raw_code_cell.is_empty()
                || raw_code_cell.len() > 20
                || raw_code_cell.starts_with("MÃ")
                || raw_code_cell.contains("STT")
            {
                continue;
            }
            let Some(caps) = re_course_code.captures(&raw_code_cell) else {
                continue;
            };
            let course_code = caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_default();
            if course_code.is_empty() {
                continue;
            }

            let course_name = name_col
                .and_then(|idx| row.get(idx))
                .cloned()
                .unwrap_or_default();

            let is_non_credit = course_code == "ME001" || course_code.starts_with("PE");
            let credits = if is_non_credit {
                0.0
            } else {
                row.get(t_idx)
                    .and_then(|s| parse_numeric_credits(s, re_credit_num))
                    .unwrap_or(0.0)
            };

            let theory_credits = if is_non_credit {
                Some(0.0)
            } else {
                lt_col.and_then(|idx| row.get(idx).and_then(|s| parse_numeric_credits(s, re_credit_num)))
            };
            let practical_credits = if is_non_credit {
                Some(0.0)
            } else {
                th_col.and_then(|idx| row.get(idx).and_then(|s| parse_numeric_credits(s, re_credit_num)))
            };

            let block_norm = normalize_major_name(active_block);
            let default_compulsory = section_row_compulsory
                .unwrap_or_else(|| block_norm == "dc" || block_norm == "csn");

            let is_compulsory = match type_col.and_then(|idx| row.get(idx)) {
                Some(raw_type) => {
                    let tn = normalize_major_name(raw_type);
                    if tn == "bb" || tn == "b" || tn.contains("bat buoc") {
                        true
                    } else if tn == "tc" || tn.contains("tu chon") || tn.contains("chon") {
                        false
                    } else {
                        default_compulsory
                    }
                }
                None => default_compulsory,
            };

            let key = (course_code.clone(), active_block.clone());
            if seen_course_keys.insert(key) {
                let recommended_sem = course_to_semester.get(&course_code).copied();
                courses.push(CurriculumCourse {
                    course_code,
                    course_name,
                    credits,
                    theory_credits,
                    practical_credits,
                    knowledge_block: active_block.clone(),
                    is_compulsory,
                    recommended_semester: recommended_sem,
                });
            }
        }
    }

    let total_credits = total_credits_opt.unwrap_or_else(|| {
        rules
            .iter()
            .filter(|r| {
                let norm = normalize_major_name(&r.knowledge_block);
                norm == "dc"
                    || norm == "csn"
                    || norm == "cn"
                    || norm.contains("tu do")
                    || norm.contains("kltn")
                    || norm.contains("tot nghiep")
            })
            .map(|r| r.required_credits)
            .sum()
    });

    let major_name = if let Some(cat_name) = catalog_name {
        cat_name
    } else if !page_title.is_empty() {
        if let Some(caps) = re_major.captures(&page_title) {
            caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or(page_title)
        } else {
            page_title
        }
    } else {
        "Chương trình đào tạo UIT".to_string()
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

/// Chuẩn hóa lại toàn bộ major_name trong curriculum_index theo catalog.json có dấu tiếng Việt
pub fn sync_curriculum_catalog_names(conn: &Connection) -> AppResult<usize> {
    let entries = get_catalog_entries();
    let tx = conn.unchecked_transaction()?;
    let mut updated = 0;
    {
        let mut stmt = tx.prepare(
            "UPDATE curriculum_index SET major_name = ?1 WHERE slug = ?2"
        )?;
        for entry in entries {
            let affected = stmt.execute(params![entry.name, entry.slug])?;
            updated += affected;
        }
    }
    tx.commit()?;
    println!("[CurriculumHarvester] Synchronized {} curriculum display names with accents", updated);
    Ok(updated)
}

/// Nạp danh mục CTĐT mặc định vào cơ sở dữ liệu nếu bảng curriculum_index còn rỗng.
pub fn seed_curriculum_catalog_if_empty(conn: &Connection) -> AppResult<usize> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM curriculum_index", [], |row| row.get(0))?;
    if count > 0 {
        // Luôn đồng bộ tên chuẩn có dấu cho các bản ghi đã có
        let _ = sync_curriculum_catalog_names(conn);
        return Ok(0);
    }

    let entries = get_catalog_entries();
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
        for item in entries {
            let slug = &item.slug;
            let display_name = if !item.name.is_empty() {
                item.name.as_str()
            } else {
                item.major.as_deref().unwrap_or("Công nghệ thông tin")
            };
            let he_code = item.he_code.as_deref().unwrap_or("CQ");

            let cohort_year = item.intake_years.as_ref().and_then(|arr| arr.first()).copied();

            let cohort_num = {
                let re = Regex::new(r"(?i)kh[oó]a\s+(\d+)").map_err(|e| AppError::CurriculumParse(e.to_string()))?;
                re.captures(&item.name)
                    .and_then(|c| c.get(1))
                    .and_then(|m| m.as_str().parse::<i32>().ok())
            };

            let degree_level = if item.name.contains("Kỹ sư") { "Kỹ sư" } else { "Cử nhân" };

            stmt.execute(params![
                slug,
                display_name,
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

    let has_settings_table: bool = tx
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='settings'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if has_settings_table {
        let ver_key = format!("curriculum_parser_ver:{}", parsed.slug);
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![ver_key, CURRICULUM_PARSER_VERSION],
        )?;
    }

    tx.commit()?;
    Ok(())
}

/// Tải và đồng bộ CTĐT từ Portal UIT theo slug qua HTTP GET RSC stream và lưu qua DbPools.
pub async fn sync_curriculum_by_slug_with_pools(pools: &crate::db::schema::DbPools, slug: &str) -> AppResult<ParsedCurriculum> {
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

    let parsed_clone = parsed.clone();
    pools
        .write(move |conn| save_parsed_curriculum(conn, &parsed_clone))
        .await?;

    Ok(parsed)
}

/// Tải và đồng bộ CTĐT từ Portal UIT theo slug qua HTTP GET RSC stream (backward-compat với SharedDb).
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
        // Assertion 4: Parse duration < 100ms
        assert!(
            elapsed.as_millis() < 100,
            "Parse duration must be under 100ms, took {:?}",
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

    #[test]
    fn test_curriculum_harvester_static_patterns_validity() {
        assert!(H1_SEL.is_ok(), "H1_SEL must parse successfully");
        assert!(H3_SEL.is_ok(), "H3_SEL must parse successfully");
        assert!(H4_SEL.is_ok(), "H4_SEL must parse successfully");
        assert!(TR_SEL.is_ok(), "TR_SEL must parse successfully");
        assert!(TH_SEL.is_ok(), "TH_SEL must parse successfully");
        assert!(TD_SEL.is_ok(), "TD_SEL must parse successfully");
        assert!(B_SEL.is_ok(), "B_SEL must parse successfully");
        assert!(P_SEL.is_ok(), "P_SEL must parse successfully");

        assert!(RE_YEAR.is_ok(), "RE_YEAR must compile successfully");
        assert!(RE_COHORT.is_ok(), "RE_COHORT must compile successfully");
        assert!(RE_CREDITS.is_ok(), "RE_CREDITS must compile successfully");
        assert!(RE_SEM.is_ok(), "RE_SEM must compile successfully");
        assert!(RE_MAJOR.is_ok(), "RE_MAJOR must compile successfully");
        assert!(RE_RSC_H1.is_ok(), "RE_RSC_H1 must compile successfully");
        assert!(RE_RSC_TITLE.is_ok(), "RE_RSC_TITLE must compile successfully");
    }

    #[test]
    fn test_parse_universal_k20_k21_k19_curriculum_variants() {
        let html_k20_nfd = r#"
            <h1>Cử nhân ngành Khoa học Máy tính (Khoá 20 - 2025)</h1>
            <h3>5.1 Tỷ lệ các khối kiến thức</h3>
            <table>
              <tbody>
                <tr><td colspan="2"><strong>Khối kiến thức</strong></td><td><strong>Tổng số tín chỉ</strong></td></tr>
                <tr><td rowspan="2">Khối kiến thức giáo dục đại cương</td><td>Lý luận chính trị</td><td>13</td></tr>
                <tr><td>Toán - Tin - Ngoại ngữ - Kỹ năng</td><td>32</td></tr>
                <tr><td rowspan="4">Khối kiến thức giáo dục chuyên nghiệp</td><td>Cơ sở ngành</td><td>&ge; 45</td></tr>
                <tr><td>Chuyên ngành</td><td>&ge; 16</td></tr>
                <tr><td>Tự chọn tự do</td><td>&ge; 10</td></tr>
                <tr><td>Tốt nghiệp</td><td>&ge; 10</td></tr>
                <tr><td colspan="2"><strong>Tổng số tín chỉ tích lũy tối thiểu toàn khóa</strong></td><td>&ge; 126</td></tr>
              </tbody>
            </table>
            <h3>5.2 Giáo dục đại cương</h3>
            <table>
              <tbody>
                <tr><td><strong>STT</strong></td><td><strong>Mã môn học</strong></td><td><strong>Tên môn học</strong></td><td><strong>Bắt buộc/Chọn</strong></td><td><strong>TC</strong></td><td><strong>LT</strong></td><td><strong>TH</strong></td></tr>
                <tr><td>1</td><td>IT001</td><td>Nhập môn lập trình</td><td>BB</td><td>4</td><td>3</td><td>1</td></tr>
                <tr><td>2</td><td>PE231</td><td>Giáo dục thể chất 1</td><td>BB</td></tr>
              </tbody>
            </table>
            <h4>5.3.1 Các môn học cơ sở ngành Khoa học Máy tính</h4>
            <table>
              <tbody>
                <tr><td><strong>STT</strong></td><td><strong>Mã môn học</strong></td><td><strong>Tên môn học</strong></td><td><strong>Bắt buộc/Chọn</strong></td><td><strong>TC</strong></td><td><strong>LT</strong></td><td><strong>TH</strong></td></tr>
                <tr><td>1</td><td>CS115</td><td>Toán cho KHMT</td><td>BB</td><td>4</td><td>4</td><td>0</td></tr>
                <tr><td>2</td><td>SE104</td><td>Nhập môn CNPM</td><td rowspan="2">Chọn 1/2</td><td>4</td><td>3</td><td>1</td></tr>
                <tr><td>3</td><td>CS111</td><td>Nguyên lý LT</td><td>4</td><td>3</td><td>1</td></tr>
              </tbody>
            </table>
        "#;

        let parsed = parse_curriculum_stream(html_k20_nfd, "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025").unwrap();
        assert_eq!(parsed.total_credits, 126.0);
        assert_eq!(parsed.rules.iter().find(|r| r.knowledge_block == "ĐC").unwrap().required_credits, 45.0);
        assert_eq!(parsed.rules.iter().find(|r| r.knowledge_block == "CSN").unwrap().required_credits, 45.0);
        assert_eq!(parsed.rules.iter().find(|r| r.knowledge_block == "CN").unwrap().required_credits, 16.0);

        let cs115 = parsed.courses.iter().find(|c| c.course_code == "CS115").unwrap();
        assert_eq!(cs115.knowledge_block, "CSN");
        assert!(cs115.is_compulsory);
        assert_eq!(cs115.credits, 4.0);

        let se104 = parsed.courses.iter().find(|c| c.course_code == "SE104").unwrap();
        assert!(!se104.is_compulsory);
        let cs111 = parsed.courses.iter().find(|c| c.course_code == "CS111").unwrap();
        assert!(!cs111.is_compulsory);

        let pe231 = parsed.courses.iter().find(|c| c.course_code == "PE231").unwrap();
        assert_eq!(pe231.credits, 0.0);

        // K19/K21: nested layout table + empty <ol><li> STT + Tính riêng
        let html_k19_k21 = r#"
            <h1>Cử nhân ngành Kỹ thuật Phần mềm (Khoá 19 - 2024)</h1>
            <h3>6.2 Phân bố các khối kiến thức</h3>
            <table><tbody><tr><td><table><tbody><tr><td>1. Lập trình hướng đối tượng: 4,3,1</td></tr></tbody></table></td></tr></tbody></table>
            <h3>3.3 Giáo dục đại cương</h3>
            <table>
              <tbody>
                <tr><th><strong>STT</strong></th><th><strong>Mã môn</strong></th><th><strong>Tên môn</strong></th><th><strong>TC</strong></th><th><strong>LT</strong></th><th><strong>TH</strong></th></tr>
                <tr><td><ol><li></li></ol></td><td>ME001</td><td>Giáo dục Quốc phòng</td><td colspan="3">Tính riêng</td></tr>
                <tr><td><ol><li></li></ol></td><td>SS006</td><td>Pháp luật đại cương</td><td>2</td><td>2</td><td>0</td></tr>
              </tbody>
            </table>
        "#;
        let parsed2 = parse_curriculum_stream(html_k19_k21, "cu-nhan-nganh-ky-thuat-phan-mem-khoa-19-2024").unwrap();
        assert!(parsed2.courses.iter().any(|c| c.course_code == "ME001" && c.credits == 0.0));
        assert!(parsed2.courses.iter().any(|c| c.course_code == "SS006" && c.credits == 2.0));
    }

    #[test]
    fn test_live_k20_khmt_summary_notes_and_semester_plan_isolation() {
        let html = r#"
            <h1>Cử nhân ngành Khoa học Máy tính (Khoá 20 - 2025)</h1>
            <h3>5.1 Tỷ lệ các khối kiến thức</h3>
            <table><tbody>
                <tr><td>Khối kiến thức</td><td colspan="2">Tổng số tín chỉ</td></tr>
                <tr><td rowspan="4">Khối kiến thức giáo dục đại cương (45 TC)</td><td>Lý luận chính trị và pháp luật</td><td>13</td></tr>
                <tr><td>Toán -Tin học - Khoa học tự nhiên</td><td>18</td></tr>
                <tr><td>Ngoại ngữ</td><td>12</td></tr>
                <tr><td>Kỹ năng nghề nghiệp</td><td>2</td></tr>
                <tr><td rowspan="3">Khối kiến thức giáo dục chuyên nghiệp (71 TC)</td><td>Cơ sở ngành</td><td>≥ 45</td></tr>
                <tr><td>Chuyên ngành</td><td>≥ 16</td></tr>
                <tr><td>Môn học tự chọn tự do</td><td>≥ 10</td></tr>
                <tr><td>Tốt nghiệp (10 TC)</td><td>Sinh viên chọn 1 trong 3 hình thức</td><td>≥ 10</td></tr>
                <tr><td colspan="2">Tổng số tín chỉ tích lũy tối thiểu toàn khóa</td><td>≥ 126</td></tr>
            </tbody></table>
            <h3>5.2 Khối kiến thức giáo dục đại cương</h3>
            <table><tbody>
                <tr><td>STT</td><td>Mã môn học</td><td>Tên môn học</td><td>Bắt buộc/Chọn</td><td>TC</td><td>LT</td><td>TH</td></tr>
                <tr><td>1.</td><td>IT001</td><td>Nhập môn Lập trình</td><td>BB</td><td>4</td><td>3</td><td>1</td></tr>
                <tr><td>2.</td><td>MA006</td><td>Giải tích</td><td>BB</td><td>4</td><td>4</td><td>0</td></tr>
                <tr><td>3.</td><td>SS007</td><td>Triết học Mác – Lênin</td><td>BB</td><td>3</td><td>3</td><td>0</td></tr>
            </tbody></table>
            <h4>5.3.1 Các môn học cơ sở ngành Khoa học Máy tính</h4>
            <table><tbody>
                <tr><td>STT</td><td>Mã môn học</td><td>Tên môn học</td><td>Bắt buộc/Chọn</td><td>TC</td><td>LT</td><td>TH</td></tr>
                <tr><td colspan="7">Toán cho KHMT (4 TC)</td></tr>
                <tr><td>1.</td><td>CS115</td><td>Toán cho KHMT</td><td>BB</td><td>4</td><td>4</td><td>0</td></tr>
                <tr><td colspan="7">Lập trình và Kỹ thuật phần mềm (12 TC)</td></tr>
                <tr><td>2.</td><td>IT002</td><td>Lập trình hướng đối tượng</td><td>BB</td><td>4</td><td>3</td><td>1</td></tr>
                <tr><td>3.</td><td>IT003</td><td>Cấu trúc dữ liệu và giải thuật</td><td>BB</td><td>4</td><td>3</td><td>1</td></tr>
            </tbody></table>
            <h4>5.3.2 Các môn học chuyên ngành</h4>
            <table><tbody>
                <tr><td>STT</td><td>Mã môn học</td><td>Tên môn học chuyên ngành</td><td>TC</td><td>LT</td><td>TH</td><td></td></tr>
                <tr><td>1.</td><td>CS106</td><td>Trí tuệ nhân tạo</td><td>4</td><td>3</td><td>1</td><td></td></tr>
                <tr><td colspan="7">Và các môn học khác theo đề nghị của Khoa</td></tr>
            </tbody></table>
            <h4>5.3.3 Các môn học tự chọn tự do</h4>
            <table><tbody>
                <tr><td>STT</td><td>Mã môn học</td><td>Tên môn học tự chọn tự do</td><td>TC</td><td>LT</td><td>TH</td><td></td></tr>
                <tr><td>1.</td><td>CS551 *</td><td>Thực tập</td><td>2</td><td>2</td><td></td><td></td></tr>
                <tr><td colspan="7">Và các môn học khác theo đề nghị của Khoa.</td></tr>
            </tbody></table>
            <h3>5.4 Khối kiến thức tốt nghiệp</h3>
            <table><tbody>
                <tr><td>STT</td><td>Mã môn học</td><td>Tên môn học</td><td>TC</td><td>LT</td><td>TH</td></tr>
                <tr><td colspan="6">Hoặc: thực hiện Khóa luận tốt nghiệp</td></tr>
                <tr><td>1.</td><td>CS505</td><td>Khóa luận tốt nghiệp</td><td>10</td><td></td><td></td></tr>
            </tbody></table>
            <table><tbody>
                <tr><td></td><td>Mã MH</td><td>Tên môn học</td><td>TC</td><td>LT</td><td>TH</td></tr>
                <tr><td rowspan="3">Học kỳ 1</td><td>IT001</td><td>Nhập môn Lập trình</td><td>4</td><td>3</td><td>1</td></tr>
                <tr><td>MA006</td><td>Giải tích</td><td>4</td><td>4</td><td>0</td></tr>
                <tr><td>IT012</td><td>Tổ chức và cấu trúc máy tính 2</td><td>4</td><td>3</td><td>1</td></tr>
                <tr><td></td><td>Tổng số tín chỉ Học kỳ 1</td><td>12</td><td>10</td><td>2</td><td></td></tr>
                <tr><td rowspan="2">Học kỳ 2</td><td>IT002</td><td>Lập trình hướng đối tượng</td><td>4</td><td>3</td><td>1</td></tr>
                <tr><td>IT003</td><td>Cấu trúc dữ liệu và giải thuật</td><td>4</td><td>3</td><td>1</td></tr>
            </tbody></table>
        "#;

        let parsed = parse_curriculum_stream(html, "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-20-2025").unwrap();
        assert_eq!(parsed.rules.len(), 5, "Phải có đúng 5 khối chuẩn, không chứa dòng Tổng số tín chỉ");
        assert_eq!(parsed.total_credits, 126.0);
        assert!(!parsed.courses.iter().any(|c| c.course_code.contains("VÀ CÁC")));
        assert!(!parsed.courses.iter().any(|c| c.course_code.contains("TOÁN")));

        // IT001 và IT002 không được phép rò vào KLTN từ bảng kế hoạch giảng dạy
        assert_eq!(parsed.courses.iter().filter(|c| c.course_code == "IT001").count(), 1);
        assert_eq!(parsed.courses.iter().find(|c| c.course_code == "IT001").unwrap().knowledge_block, "ĐC");
        assert_eq!(parsed.courses.iter().find(|c| c.course_code == "IT001").unwrap().recommended_semester, Some(1));
        assert_eq!(parsed.courses.iter().find(|c| c.course_code == "IT002").unwrap().recommended_semester, Some(2));
        assert!(!parsed.courses.iter().any(|c| c.knowledge_block == "KLTN" && c.course_code == "IT012"));
        assert!(parsed.courses.iter().any(|c| c.course_code == "CS551" && c.knowledge_block == "Tự chọn tự do"));
    }
}
