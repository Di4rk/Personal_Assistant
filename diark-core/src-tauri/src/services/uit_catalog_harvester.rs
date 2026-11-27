use crate::db::SharedDb;
use crate::error::{AppError, AppResult};
use regex::Regex;
use rusqlite::{params, Connection};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;

const UIT_COURSE_CATALOG_URL: &str = "https://portal.uit.edu.vn/danh-muc-mon-hoc";
const UIT_CURRICULUM_CATALOG_URL: &str = "https://portal.uit.edu.vn/chuong-trinh-dao-tao";
const CATALOG_TTL_SECS: i64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CourseCatalogItem {
    pub course_code: String,
    pub name_vi: String,
    pub name_en: String,
    pub is_open: bool,
    pub department_code: String,
    pub department_name: String,
    pub course_type: String,
    pub old_code: String,
    pub equivalent_codes: String,
    pub replacement_codes: String,
    pub prerequisite_codes: String,
    pub prior_codes: String,
    pub theory_credits: i64,
    pub practice_credits: i64,
    pub total_credits: i64,
}

#[derive(Debug, Clone)]
pub struct ParsedCourseCatalogPage {
    pub current_page: usize,
    pub total_pages: usize,
    pub total_courses: usize,
    pub items: Vec<CourseCatalogItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredCurriculum {
    pub slug: String,
    pub major_name: String,
    pub degree_level: String,
    pub cohort_year: i32,
    pub cohort_num: Option<i32>,
    pub training_form: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UitCatalogSyncSummary {
    pub curricula_synced: usize,
    pub courses_synced: usize,
    pub skipped_by_ttl: bool,
}

fn clean_text(raw: &str) -> String {
    raw.replace('\u{00a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Phân tích HTML 1 trang của `/danh-muc-mon-hoc` (14 cột + thông tin phân trang).
pub fn parse_course_catalog_page_html(html: &str) -> AppResult<ParsedCourseCatalogPage> {
    let doc = Html::parse_document(html);

    let re_pages = Regex::new(r"(?i)Trang\s+(\d+)\s*/\s*(\d+)")
        .map_err(|e| AppError::CurriculumParse(format!("Regex trang lỗi: {e}")))?;
    let re_total = Regex::new(r"(?i)tổng\s+(\d+)\s+môn")
        .map_err(|e| AppError::CurriculumParse(format!("Regex tổng môn lỗi: {e}")))?;

    let mut current_page = 1usize;
    let mut total_pages = 1usize;
    let mut total_courses = 0usize;

    let nav_sel = Selector::parse("nav, p, div")
        .map_err(|e| AppError::CurriculumParse(format!("Selector nav lỗi: {e:?}")))?;
    for el in doc.select(&nav_sel) {
        let txt = clean_text(&el.text().collect::<String>());
        if txt.len() > 200 {
            continue;
        }
        if let Some(caps) = re_pages.captures(&txt) {
            current_page = caps
                .get(1)
                .and_then(|m| m.as_str().parse::<usize>().ok())
                .unwrap_or(1);
            total_pages = caps
                .get(2)
                .and_then(|m| m.as_str().parse::<usize>().ok())
                .unwrap_or(1);
        }
        if let Some(caps) = re_total.captures(&txt) {
            total_courses = caps
                .get(1)
                .and_then(|m| m.as_str().parse::<usize>().ok())
                .unwrap_or(0);
        }
    }

    let row_sel = Selector::parse("table.w-full.border-collapse tbody tr")
        .map_err(|e| AppError::CurriculumParse(format!("Selector bảng môn học lỗi: {e:?}")))?;
    let fallback_row_sel = Selector::parse("table tbody tr")
        .map_err(|e| AppError::CurriculumParse(format!("Selector fallback bảng lỗi: {e:?}")))?;
    let td_sel = Selector::parse("td")
        .map_err(|e| AppError::CurriculumParse(format!("Selector td lỗi: {e:?}")))?;
    let div_sel = Selector::parse("div")
        .map_err(|e| AppError::CurriculumParse(format!("Selector div lỗi: {e:?}")))?;
    let span_sel = Selector::parse("span[title], [title]")
        .map_err(|e| AppError::CurriculumParse(format!("Selector span[title] lỗi: {e:?}")))?;

    let mut rows_vec: Vec<_> = doc.select(&row_sel).collect();
    if rows_vec.is_empty() {
        rows_vec = doc.select(&fallback_row_sel).collect();
    }

    let mut items = Vec::new();
    for tr in rows_vec {
        let tds: Vec<_> = tr.select(&td_sel).collect();
        if tds.len() < 14 {
            continue;
        }

        let course_code = clean_text(&tds[1].text().collect::<String>()).to_uppercase();
        if course_code.is_empty() || course_code.starts_with("MÃ") {
            continue;
        }

        let name_vi = clean_text(&tds[2].text().collect::<String>());
        let name_en = clean_text(&tds[3].text().collect::<String>());

        let open_txt = clean_text(&tds[4].text().collect::<String>());
        let open_title = tds[4]
            .select(&span_sel)
            .next()
            .and_then(|s| s.value().attr("title"))
            .map(clean_text)
            .unwrap_or_default();
        let is_open = open_txt.contains('✅')
            || open_title.to_lowercase().contains("mở lớp");

        let department_code = clean_text(&tds[5].text().collect::<String>());
        let department_name = tds[5]
            .select(&span_sel)
            .next()
            .and_then(|s| s.value().attr("title"))
            .or_else(|| tds[5].value().attr("title"))
            .map(clean_text)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| department_code.clone());

        let course_type = clean_text(&tds[6].text().collect::<String>());
        let old_code = clean_text(&tds[7].text().collect::<String>());

        let extract_multi = |cell: scraper::ElementRef<'_>| -> String {
            let parts: Vec<String> = cell
                .select(&div_sel)
                .map(|d| clean_text(&d.text().collect::<String>()))
                .filter(|s| !s.is_empty())
                .collect();
            if parts.is_empty() {
                clean_text(&cell.text().collect::<String>())
            } else {
                parts.join(", ")
            }
        };

        let equivalent_codes = extract_multi(tds[8]);
        let replacement_codes = extract_multi(tds[9]);
        let prerequisite_codes = clean_text(&tds[10].text().collect::<String>());
        let prior_codes = clean_text(&tds[11].text().collect::<String>());

        let theory_credits = clean_text(&tds[12].text().collect::<String>())
            .parse::<i64>()
            .unwrap_or(0);
        let practice_credits = clean_text(&tds[13].text().collect::<String>())
            .parse::<i64>()
            .unwrap_or(0);

        items.push(CourseCatalogItem {
            course_code,
            name_vi,
            name_en,
            is_open,
            department_code,
            department_name,
            course_type,
            old_code,
            equivalent_codes,
            replacement_codes,
            prerequisite_codes,
            prior_codes,
            theory_credits,
            practice_credits,
            total_credits: theory_credits + practice_credits,
        });
    }

    if total_courses == 0 {
        total_courses = items.len();
    }

    Ok(ParsedCourseCatalogPage {
        current_page,
        total_pages: total_pages.max(1),
        total_courses,
        items,
    })
}

/// Rút trích tất cả các năm khóa tuyển sinh (`2026`, `2025`, ...) từ HTML trang `/chuong-trinh-dao-tao`.
pub fn parse_curriculum_catalog_cohorts(html: &str) -> AppResult<Vec<i32>> {
    let doc = Html::parse_document(html);
    let sel = Selector::parse("div[role=\"group\"] button, div[role=\"group\"] a, select option")
        .map_err(|e| AppError::CurriculumParse(format!("Selector cohort lỗi: {e:?}")))?;
    let re_year = Regex::new(r"\b(20\d{2})\b")
        .map_err(|e| AppError::CurriculumParse(format!("Regex năm khóa lỗi: {e}")))?;

    let mut seen = HashSet::new();
    let mut years = Vec::new();
    for el in doc.select(&sel) {
        let mut candidates = Vec::new();
        if let Some(val) = el.value().attr("value") {
            candidates.push(val.to_string());
        }
        candidates.push(clean_text(&el.text().collect::<String>()));

        for cand in candidates {
            if let Some(caps) = re_year.captures(&cand) {
                if let Some(y) = caps.get(1).and_then(|m| m.as_str().parse::<i32>().ok()) {
                    if seen.insert(y) {
                        years.push(y);
                    }
                }
            }
        }
    }

    years.sort_by(|a, b| b.cmp(a));
    Ok(years)
}

/// Bóc tách danh sách CTĐT từ HTML `?hedt=<CQ|TX>&khoa=<YYYY>`.
pub fn parse_curriculum_catalog_items(
    html: &str,
    he_code: &str,
    cohort_year: i32,
) -> AppResult<Vec<DiscoveredCurriculum>> {
    let doc = Html::parse_document(html);
    let link_sel = Selector::parse("li a[href^=\"/chuong-trinh-dao-tao/\"]")
        .map_err(|e| AppError::CurriculumParse(format!("Selector CTĐT link lỗi: {e:?}")))?;
    let re_cohort = Regex::new(r"(?i)kh[oó]a\s+(\d+)")
        .map_err(|e| AppError::CurriculumParse(format!("Regex khóa lỗi: {e}")))?;

    let mut seen = HashSet::new();
    let mut items = Vec::new();

    for a in doc.select(&link_sel) {
        let Some(href) = a.value().attr("href") else {
            continue;
        };
        let slug = href
            .trim_start_matches("/chuong-trinh-dao-tao/")
            .split('?')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if slug.is_empty() || !seen.insert(slug.clone()) {
            continue;
        }

        let badge_text = clean_text(&a.text().collect::<String>());
        let aria_label = a.value().attr("aria-label").map(clean_text).unwrap_or_default();
        let major_name = if !aria_label.is_empty() {
            aria_label
        } else {
            badge_text.clone()
        };
        if major_name.is_empty() {
            continue;
        }

        let lower_name = major_name.to_lowercase();
        let degree_level = if lower_name.contains("kỹ sư") || lower_name.contains("ky su") {
            "Kỹ sư".to_string()
        } else {
            "Cử nhân".to_string()
        };

        let cohort_num = re_cohort
            .captures(&major_name)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse::<i32>().ok())
            .or_else(|| {
                if he_code == "CQ" && cohort_year >= 2006 {
                    Some(cohort_year - 2005)
                } else {
                    None
                }
            });

        let training_form = if !badge_text.is_empty() && badge_text != major_name {
            format!("{he_code} · {badge_text}")
        } else {
            he_code.to_string()
        };

        items.push(DiscoveredCurriculum {
            slug,
            major_name,
            degree_level,
            cohort_year,
            cohort_num,
            training_form,
        });
    }

    Ok(items)
}

pub fn should_refresh_catalog(
    conn: &Connection,
    setting_key: &str,
    ttl_secs: i64,
    force: bool,
) -> bool {
    if force {
        return true;
    }
    let last_sync = crate::db::get_setting(conn, setting_key)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(0);
    if last_sync <= 0 {
        return true;
    }
    let now = chrono::Utc::now().timestamp();
    (now - last_sync) >= ttl_secs
}

fn build_portal_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(AppError::Http)
}

/// Kéo toàn bộ 1.000+ môn học từ `https://portal.uit.edu.vn/danh-muc-mon-hoc`.
pub async fn sync_live_course_catalog(db: &SharedDb, force: bool) -> AppResult<usize> {
    {
        let conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
        crate::db::schema::ensure_curriculum_schema(&conn)?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM uit_course_catalog", [], |r| r.get(0))
            .unwrap_or(0);
        if count > 0 && !should_refresh_catalog(&conn, "uit_course_catalog_synced_at", CATALOG_TTL_SECS, force) {
            return Ok(0);
        }
    }

    let client = build_portal_client()?;
    let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    let first_resp = client
        .get(format!("{UIT_COURSE_CATALOG_URL}?trang=1"))
        .header("User-Agent", user_agent)
        .send()
        .await
        .map_err(AppError::Http)?;
    if !first_resp.status().is_success() {
        return Err(AppError::CurriculumParse(format!(
            "HTTP {} khi tải danh mục môn học",
            first_resp.status()
        )));
    }

    let first_html = first_resp.text().await.map_err(AppError::Http)?;
    let first_page = parse_course_catalog_page_html(&first_html)?;
    let total_pages = first_page.total_pages.min(50);

    let mut all_items = first_page.items;
    for page_num in 2..=total_pages {
        let resp = client
            .get(format!("{UIT_COURSE_CATALOG_URL}?trang={page_num}"))
            .header("User-Agent", user_agent)
            .send()
            .await
            .map_err(AppError::Http)?;
        if !resp.status().is_success() {
            continue;
        }
        let page_html = resp.text().await.map_err(AppError::Http)?;
        if let Ok(parsed) = parse_course_catalog_page_html(&page_html) {
            all_items.extend(parsed.items);
        }
    }

    if all_items.is_empty() {
        return Ok(0);
    }

    let saved_count = all_items.len();
    let now = chrono::Utc::now().timestamp();
    let conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO uit_course_catalog (
                course_code, name_vi, name_en, is_open, department_code, department_name,
                course_type, old_code, equivalent_codes, replacement_codes,
                prerequisite_codes, prior_codes, theory_credits, practice_credits, total_credits, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(course_code) DO UPDATE SET
                name_vi = excluded.name_vi,
                name_en = excluded.name_en,
                is_open = excluded.is_open,
                department_code = excluded.department_code,
                department_name = excluded.department_name,
                course_type = excluded.course_type,
                old_code = excluded.old_code,
                equivalent_codes = excluded.equivalent_codes,
                replacement_codes = excluded.replacement_codes,
                prerequisite_codes = excluded.prerequisite_codes,
                prior_codes = excluded.prior_codes,
                theory_credits = excluded.theory_credits,
                practice_credits = excluded.practice_credits,
                total_credits = excluded.total_credits,
                updated_at = excluded.updated_at",
        )?;

        for item in &all_items {
            stmt.execute(params![
                item.course_code,
                item.name_vi,
                item.name_en,
                if item.is_open { 1 } else { 0 },
                item.department_code,
                item.department_name,
                item.course_type,
                item.old_code,
                item.equivalent_codes,
                item.replacement_codes,
                item.prerequisite_codes,
                item.prior_codes,
                item.theory_credits,
                item.practice_credits,
                item.total_credits,
                now,
            ])?;
        }
    }
    tx.commit()?;
    let _ = crate::db::set_setting(&conn, "uit_course_catalog_synced_at", &now.to_string());

    Ok(saved_count)
}

/// Tự động khám phá toàn bộ ngành & khóa Chính quy (`CQ`) + Từ xa (`TX`) từ `portal.uit.edu.vn/chuong-trinh-dao-tao`.
pub async fn sync_live_curriculum_catalog(db: &SharedDb, force: bool) -> AppResult<usize> {
    {
        let conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
        crate::db::schema::ensure_curriculum_schema(&conn)?;
        if !should_refresh_catalog(&conn, "uit_curriculum_catalog_synced_at", CATALOG_TTL_SECS, force) {
            return Ok(0);
        }
    }

    let client = build_portal_client()?;
    let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    let mut discovered: Vec<DiscoveredCurriculum> = Vec::new();
    let mut seen_slugs: HashSet<String> = HashSet::new();

    for he_code in ["CQ", "TX"] {
        let base_url = format!("{UIT_CURRICULUM_CATALOG_URL}?hedt={he_code}");
        let Ok(resp) = client.get(&base_url).header("User-Agent", user_agent).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(base_html) = resp.text().await else {
            continue;
        };

        let years = parse_curriculum_catalog_cohorts(&base_html).unwrap_or_default();
        for year in years {
            let year_url = format!("{UIT_CURRICULUM_CATALOG_URL}?hedt={he_code}&khoa={year}");
            let Ok(yr_resp) = client.get(&year_url).header("User-Agent", user_agent).send().await else {
                continue;
            };
            if !yr_resp.status().is_success() {
                continue;
            }
            let Ok(yr_html) = yr_resp.text().await else {
                continue;
            };
            if let Ok(items) = parse_curriculum_catalog_items(&yr_html, he_code, year) {
                for item in items {
                    if seen_slugs.insert(item.slug.clone()) {
                        discovered.push(item);
                    }
                }
            }
        }
    }

    if discovered.is_empty() {
        return Ok(0);
    }

    let synced_count = discovered.len();
    let now = chrono::Utc::now().timestamp();
    let conn = db.lock().map_err(|_| AppError::PoisonedLock)?;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO curriculum_index (
                slug, major_name, degree_level, cohort_year, cohort_num, training_form, is_cached, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
             ON CONFLICT(slug) DO UPDATE SET
                major_name = excluded.major_name,
                degree_level = excluded.degree_level,
                cohort_year = COALESCE(excluded.cohort_year, curriculum_index.cohort_year),
                cohort_num = COALESCE(excluded.cohort_num, curriculum_index.cohort_num),
                training_form = excluded.training_form",
        )?;

        for item in &discovered {
            stmt.execute(params![
                item.slug,
                item.major_name,
                item.degree_level,
                item.cohort_year,
                item.cohort_num,
                item.training_form,
                now,
            ])?;
        }
    }
    tx.commit()?;
    let _ = crate::db::set_setting(&conn, "uit_curriculum_catalog_synced_at", &now.to_string());

    Ok(synced_count)
}

/// Chạy đồng bộ cả danh mục CTĐT + danh mục môn học UIT.
pub async fn sync_uit_training_catalog(db: &SharedDb, force: bool) -> AppResult<UitCatalogSyncSummary> {
    let (curricula_res, courses_res) = tokio::join!(
        sync_live_curriculum_catalog(db, force),
        sync_live_course_catalog(db, force)
    );

    let curricula_synced = curricula_res?;
    let courses_synced = courses_res?;
    let skipped_by_ttl = !force && curricula_synced == 0 && courses_synced == 0;

    Ok(UitCatalogSyncSummary {
        curricula_synced,
        courses_synced,
        skipped_by_ttl,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_course_catalog_page_html_14_columns() {
        let html = r#"
            <html><body>
              <nav>Trang 2/11 — tổng 1066 môn</nav>
              <table class="w-full border-collapse text-sm">
                <tbody>
                  <tr>
                    <td>1</td>
                    <td>CE105</td>
                    <td>Thiết kế vi mạch số</td>
                    <td>Digital IC Design</td>
                    <td><span title="Còn mở lớp">✅</span></td>
                    <td><span title="Kỹ thuật Máy tính">KTMT</span></td>
                    <td>CN</td>
                    <td>CE101</td>
                    <td><div>CE201</div><div>CE202</div></td>
                    <td><div>CE104</div></td>
                    <td>CE103, IT001</td>
                    <td>IT006</td>
                    <td>3</td>
                    <td>1</td>
                  </tr>
                  <tr>
                    <td>2</td>
                    <td>OLD99</td>
                    <td>Môn đã đóng</td>
                    <td>Legacy Course</td>
                    <td></td>
                    <td><span title="Khoa học Máy tính">KHMT</span></td>
                    <td>TC</td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td></td>
                    <td>2</td>
                    <td>0</td>
                  </tr>
                </tbody>
              </table>
            </body></html>
        "#;

        let parsed = parse_course_catalog_page_html(html).unwrap();
        assert_eq!(parsed.current_page, 2);
        assert_eq!(parsed.total_pages, 11);
        assert_eq!(parsed.total_courses, 1066);
        assert_eq!(parsed.items.len(), 2);

        let ce105 = &parsed.items[0];
        assert_eq!(ce105.course_code, "CE105");
        assert!(ce105.is_open);
        assert_eq!(ce105.department_code, "KTMT");
        assert_eq!(ce105.department_name, "Kỹ thuật Máy tính");
        assert_eq!(ce105.equivalent_codes, "CE201, CE202");
        assert_eq!(ce105.prerequisite_codes, "CE103, IT001");
        assert_eq!(ce105.prior_codes, "IT006");
        assert_eq!(ce105.theory_credits, 3);
        assert_eq!(ce105.practice_credits, 1);
        assert_eq!(ce105.total_credits, 4);

        assert!(!parsed.items[1].is_open);
    }

    #[test]
    fn test_parse_curriculum_catalog_cohorts_and_items() {
        let html = r#"
            <html><body>
              <div role="group" aria-label="Chọn khoá — CTĐT Chính quy">
                <button>2026 (19)</button>
                <button>2025 (19)</button>
                <select aria-label="Khoá cũ hơn">
                  <option value="2020">2020 (12)</option>
                  <option value="2019">2019 (10)</option>
                </select>
              </div>
              <ul>
                <li>
                  <h3>Khoa học Máy tính</h3>
                  <a href="/chuong-trinh-dao-tao/cu-nhan-nganh-khoa-hoc-may-tinh-khoa-21-2026"
                     aria-label="Cử nhân ngành Khoa học Máy tính (Khoá 21, 2026)">Chính quy</a>
                  <a href="/chuong-trinh-dao-tao/cu-nhan-tai-nang-nganh-khoa-hoc-may-tinh-khoa-21-2026"
                     aria-label="Cử nhân tài năng ngành Khoa học Máy tính (Khoá 21, 2026)">Cử nhân tài năng</a>
                </li>
              </ul>
            </body></html>
        "#;

        let cohorts = parse_curriculum_catalog_cohorts(html).unwrap();
        assert_eq!(cohorts, vec![2026, 2025, 2020, 2019]);

        let items = parse_curriculum_catalog_items(html, "CQ", 2026).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].slug, "cu-nhan-nganh-khoa-hoc-may-tinh-khoa-21-2026");
        assert_eq!(items[0].cohort_num, Some(21));
        assert_eq!(items[0].degree_level, "Cử nhân");
        assert!(items[1].training_form.contains("Cử nhân tài năng"));
    }
}
