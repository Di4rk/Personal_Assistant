use regex::Regex;
use reqwest::header::{HeaderMap, COOKIE, SET_COOKIE, USER_AGENT};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

const DRL_BASE_URL: &str = "https://drl.uit.edu.vn";
const DRL_VIEW_URL: &str = "https://drl.uit.edu.vn/sinhvien/renluyensinhvien/diemrenluyen";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DrlSemesterScore {
    pub semester_id: String,
    pub semester_label: String,
    pub option_value: String,
    pub raw_score: i64,
    pub capped_score: i64,
    pub grade_text: String,
}

#[derive(Debug, Clone)]
pub struct ParsedDrlPage {
    pub form_build_id: String,
    pub form_token: String,
    pub form_id: String,
    pub selected_option: Option<String>,
    pub available_options: Vec<String>,
    pub raw_score: Option<i64>,
    pub is_login_page: bool,
}

pub fn classify_drl_rank(score: i64) -> String {
    if score >= 90 {
        "Xuất sắc".to_string()
    } else if score >= 80 {
        "Tốt".to_string()
    } else if score >= 65 {
        "Khá".to_string()
    } else if score >= 50 {
        "Trung bình".to_string()
    } else {
        "Yếu".to_string()
    }
}

/// Chuyển option value dạng `SV-1-2026-2027` -> (`2026-2027.1`, `Học kỳ 1/2026-2027`).
pub fn parse_drl_option_to_semester(option_val: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = option_val.trim().split('-').collect();
    if parts.len() != 4 || parts[0] != "SV" {
        return None;
    }
    let sem = parts[1];
    let y1 = parts[2];
    let y2 = parts[3];
    if sem.is_empty()
        || y1.len() != 4
        || y2.len() != 4
        || !sem.chars().all(|c| c.is_ascii_digit())
        || !y1.chars().all(|c| c.is_ascii_digit())
        || !y2.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some((
        format!("{y1}-{y2}.{sem}"),
        format!("Học kỳ {sem}/{y1}-{y2}"),
    ))
}

fn select_input_value(doc: &Html, selector_str: &str) -> Result<Option<String>, String> {
    let selector = Selector::parse(selector_str)
        .map_err(|e| format!("Selector '{selector_str}' không hợp lệ: {e:?}"))?;
    Ok(doc
        .select(&selector)
        .next()
        .and_then(|el| el.value().attr("value"))
        .map(|s| s.to_string()))
}

/// Bóc tách `form_build_id` và `form_id` từ form đăng nhập Drupal trên `https://drl.uit.edu.vn/`.
pub fn parse_login_form_fields(html: &str) -> Result<(String, String), String> {
    let doc = Html::parse_document(html);
    let form_sel = Selector::parse("form#user-login")
        .map_err(|e| format!("Selector form#user-login lỗi: {e:?}"))?;
    if doc.select(&form_sel).next().is_none() {
        return Err("Không tìm thấy form đăng nhập (form#user-login) trên drl.uit.edu.vn".to_string());
    }

    let form_build_id = select_input_value(&doc, "form#user-login input[name=\"form_build_id\"]")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Thiếu trường form_build_id trên form đăng nhập drl.uit.edu.vn".to_string())?;

    let form_id = select_input_value(&doc, "form#user-login input[name=\"form_id\"]")?
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "user_login".to_string());

    Ok((form_build_id, form_id))
}

/// Bóc tách token CSRF, danh sách học kỳ (`SV-*`), kỳ đang chọn và `Tổng điểm rèn luyện`.
pub fn parse_drl_page_html(html: &str) -> Result<ParsedDrlPage, String> {
    let doc = Html::parse_document(html);

    let login_sel = Selector::parse("form#user-login")
        .map_err(|e| format!("Selector login lỗi: {e:?}"))?;
    let is_login_page = doc.select(&login_sel).next().is_some();

    let form_build_id = select_input_value(&doc, "form#renluyensinhvien-xemdiem input[name=\"form_build_id\"]")?
        .unwrap_or_default();
    let form_token = select_input_value(&doc, "form#renluyensinhvien-xemdiem input[name=\"form_token\"]")?
        .unwrap_or_default();
    let form_id = select_input_value(&doc, "form#renluyensinhvien-xemdiem input[name=\"form_id\"]")?
        .unwrap_or_else(|| "renluyensinhvien_xemdiem".to_string());

    let opt_sel = Selector::parse("select#edit-xemdiem-bangdiem option")
        .map_err(|e| format!("Selector option lỗi: {e:?}"))?;
    let mut available_options = Vec::new();
    let mut selected_option = None;

    for opt in doc.select(&opt_sel) {
        if let Some(val) = opt.value().attr("value") {
            let trimmed = val.trim();
            if trimmed.starts_with("SV-") {
                available_options.push(trimmed.to_string());
                if opt.value().attr("selected").is_some() {
                    selected_option = Some(trimmed.to_string());
                }
            }
        }
    }

    if selected_option.is_none() && !available_options.is_empty() {
        selected_option = available_options.first().cloned();
    }

    let score_re = Regex::new(r"Tổng\s*điểm\s*rèn\s*luyện\s*:\s*(\d+)")
        .map_err(|e| format!("Regex điểm rèn luyện lỗi: {e}"))?;

    let p_sel = Selector::parse("#renluyensinhvien-xemdiem p, p")
        .map_err(|e| format!("Selector p lỗi: {e:?}"))?;
    let mut raw_score = None;

    for p in doc.select(&p_sel) {
        let text = p.text().collect::<String>();
        if let Some(caps) = score_re.captures(&text) {
            if let Some(m) = caps.get(1) {
                if let Ok(val) = m.as_str().parse::<i64>() {
                    raw_score = Some(val);
                    break;
                }
            }
        }
    }

    if raw_score.is_none() {
        if let Some(caps) = score_re.captures(html) {
            if let Some(m) = caps.get(1) {
                if let Ok(val) = m.as_str().parse::<i64>() {
                    raw_score = Some(val);
                }
            }
        }
    }

    Ok(ParsedDrlPage {
        form_build_id,
        form_token,
        form_id,
        selected_option,
        available_options,
        raw_score,
        is_login_page,
    })
}

fn absorb_set_cookies(headers: &HeaderMap, jar: &mut HashMap<String, String>) {
    for val in headers.get_all(SET_COOKIE) {
        if let Ok(raw) = val.to_str() {
            let first_part = raw.split(';').next().unwrap_or("");
            if let Some((name, cookie_val)) = first_part.split_once('=') {
                let k = name.trim();
                let v = cookie_val.trim();
                if k.is_empty() {
                    continue;
                }
                if v.is_empty() || v.eq_ignore_ascii_case("deleted") {
                    jar.remove(k);
                } else {
                    jar.insert(k.to_string(), v.to_string());
                }
            }
        }
    }
}

fn build_cookie_header(jar: &HashMap<String, String>) -> String {
    jar.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn encode_form_pairs(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Đăng nhập trực tiếp `https://drl.uit.edu.vn/` và kéo điểm rèn luyện tất cả học kỳ (gồm kỳ đang học).
pub async fn fetch_all_semester_drl(
    username: &str,
    password: &str,
) -> Result<Vec<DrlSemesterScore>, String> {
    let clean_user = username.trim();
    if clean_user.is_empty() || password.is_empty() {
        return Err("Chưa có tài khoản hoặc mật khẩu UIT để đồng bộ drl.uit.edu.vn".to_string());
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Lỗi khởi tạo HTTP client đồng bộ ĐRL: {e}"))?;

    let mut cookie_jar: HashMap<String, String> = HashMap::new();
    let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    // Bước 1: GET trang chủ để lấy form_build_id và cookie phiên đầu
    let get_login_resp = client
        .get(DRL_BASE_URL)
        .header(USER_AGENT, user_agent)
        .send()
        .await
        .map_err(|e| format!("Không thể kết nối drl.uit.edu.vn: {e}"))?;
    absorb_set_cookies(get_login_resp.headers(), &mut cookie_jar);
    let login_html = get_login_resp
        .text()
        .await
        .map_err(|e| format!("Lỗi đọc trang đăng nhập drl.uit.edu.vn: {e}"))?;
    let (login_build_id, login_form_id) = parse_login_form_fields(&login_html)?;

    // Bước 2: POST đăng nhập
    let login_body = encode_form_pairs(&[
        ("name", clean_user),
        ("pass", password),
        ("form_build_id", &login_build_id),
        ("form_id", &login_form_id),
        ("op", "Đăng nhập"),
    ]);

    let mut post_req = client
        .post(DRL_BASE_URL)
        .header(USER_AGENT, user_agent)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(login_body);
    if !cookie_jar.is_empty() {
        post_req = post_req.header(COOKIE, build_cookie_header(&cookie_jar));
    }

    let post_login_resp = post_req
        .send()
        .await
        .map_err(|e| format!("Lỗi gửi thông tin đăng nhập drl.uit.edu.vn: {e}"))?;
    absorb_set_cookies(post_login_resp.headers(), &mut cookie_jar);

    if !post_login_resp.status().is_redirection() {
        return Err(
            "Đăng nhập drl.uit.edu.vn thất bại — vui lòng kiểm tra lại MSSV hoặc mật khẩu".to_string(),
        );
    }

    // Bước 3: GET bảng điểm ĐRL (mặc định trả về học kỳ mới nhất / đang học)
    let view_resp = client
        .get(DRL_VIEW_URL)
        .header(USER_AGENT, user_agent)
        .header(COOKIE, build_cookie_header(&cookie_jar))
        .send()
        .await
        .map_err(|e| format!("Lỗi tải trang bảng điểm drl.uit.edu.vn: {e}"))?;
    absorb_set_cookies(view_resp.headers(), &mut cookie_jar);
    let first_html = view_resp
        .text()
        .await
        .map_err(|e| format!("Lỗi đọc HTML bảng điểm ĐRL: {e}"))?;

    let first_page = parse_drl_page_html(&first_html)?;
    if first_page.is_login_page {
        return Err("Phiên đăng nhập drl.uit.edu.vn không hợp lệ sau khi chuyển hướng".to_string());
    }

    let mut results: Vec<DrlSemesterScore> = Vec::new();
    let mut seen_options: HashMap<String, bool> = HashMap::new();

    if let (Some(ref opt), Some(raw_score)) = (&first_page.selected_option, first_page.raw_score) {
        if let Some((semester_id, semester_label)) = parse_drl_option_to_semester(opt) {
            let capped = raw_score.clamp(0, 100);
            results.push(DrlSemesterScore {
                semester_id,
                semester_label,
                option_value: opt.clone(),
                raw_score,
                capped_score: capped,
                grade_text: classify_drl_rank(capped),
            });
            seen_options.insert(opt.clone(), true);
        }
    }

    // Bước 4: Kéo các học kỳ còn lại trong dropdown SV-*
    let mut curr_build_id = first_page.form_build_id;
    let mut curr_token = first_page.form_token;
    let mut curr_form_id = first_page.form_id;

    for opt in &first_page.available_options {
        if seen_options.contains_key(opt) {
            continue;
        }
        if curr_build_id.is_empty() || curr_token.is_empty() {
            break;
        }

        let body = encode_form_pairs(&[
            ("xemdiem_loaibangdiem", "SV"),
            ("xemdiem_bangdiem", opt),
            ("form_build_id", &curr_build_id),
            ("form_token", &curr_token),
            ("form_id", &curr_form_id),
            ("op", "Xem điểm"),
        ]);

        let resp = client
            .post(DRL_VIEW_URL)
            .header(USER_AGENT, user_agent)
            .header(COOKIE, build_cookie_header(&cookie_jar))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("Lỗi chuyển học kỳ ĐRL '{opt}': {e}"))?;
        absorb_set_cookies(resp.headers(), &mut cookie_jar);

        if resp.status().is_redirection() {
            break;
        }

        let page_html = resp
            .text()
            .await
            .map_err(|e| format!("Lỗi đọc HTML ĐRL học kỳ '{opt}': {e}"))?;
        let parsed = parse_drl_page_html(&page_html)?;
        if parsed.is_login_page {
            break;
        }

        if !parsed.form_build_id.is_empty() {
            curr_build_id = parsed.form_build_id;
        }
        if !parsed.form_token.is_empty() {
            curr_token = parsed.form_token;
        }
        if !parsed.form_id.is_empty() {
            curr_form_id = parsed.form_id;
        }

        if let Some(raw_score) = parsed.raw_score {
            if let Some((semester_id, semester_label)) = parse_drl_option_to_semester(opt) {
                let capped = raw_score.clamp(0, 100);
                results.push(DrlSemesterScore {
                    semester_id,
                    semester_label,
                    option_value: opt.clone(),
                    raw_score,
                    capped_score: capped,
                    grade_text: classify_drl_rank(capped),
                });
                seen_options.insert(opt.clone(), true);
            }
        }
    }

    results.sort_by(|a, b| a.semester_id.cmp(&b.semester_id));
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_login_form_fields_extracts_drupal_tokens() {
        let html = r#"
            <html><body>
              <form id="user-login" action="/" method="post">
                <input type="text" id="edit-name" name="name" value="" />
                <input type="password" id="edit-pass" name="pass" />
                <input type="hidden" name="form_build_id" value="form-abc123XYZ" />
                <input type="hidden" name="form_id" value="user_login" />
                <input type="submit" id="edit-submit" name="op" value="Đăng nhập" />
              </form>
            </body></html>
        "#;

        let (build_id, form_id) = parse_login_form_fields(html).unwrap();
        assert_eq!(build_id, "form-abc123XYZ");
        assert_eq!(form_id, "user_login");
    }

    #[test]
    fn test_parse_drl_option_to_semester_mapping() {
        assert_eq!(
            parse_drl_option_to_semester("SV-1-2026-2027"),
            Some(("2026-2027.1".to_string(), "Học kỳ 1/2026-2027".to_string()))
        );
        assert_eq!(
            parse_drl_option_to_semester("SV-2-2025-2026"),
            Some(("2025-2026.2".to_string(), "Học kỳ 2/2025-2026".to_string()))
        );
        assert_eq!(parse_drl_option_to_semester("DV-1-2025-2026"), None);
    }

    #[test]
    fn test_parse_drl_page_html_ongoing_and_uncapped_scores() {
        let html_ongoing = r#"
            <form id="renluyensinhvien-xemdiem" method="post">
              <select id="edit-xemdiem-bangdiem" name="xemdiem_bangdiem">
                <option value="SV-1-2026-2027" selected="selected">ĐRL HK1 (2026-2027)</option>
                <option value="SV-2-2025-2026">ĐRL HK2 (2025-2026)</option>
              </select>
              <input type="hidden" name="form_build_id" value="form-view-1" />
              <input type="hidden" name="form_token" value="tok-view-1" />
              <input type="hidden" name="form_id" value="renluyensinhvien_xemdiem" />
              <p style="color:red; font-size:200%;">Tổng điểm rèn luyện : 70</p>
            </form>
        "#;

        let parsed = parse_drl_page_html(html_ongoing).unwrap();
        assert!(!parsed.is_login_page);
        assert_eq!(parsed.selected_option.as_deref(), Some("SV-1-2026-2027"));
        assert_eq!(parsed.raw_score, Some(70));
        assert_eq!(parsed.raw_score.unwrap().clamp(0, 100), 70);
        assert_eq!(classify_drl_rank(70), "Khá");

        let html_uncapped = r#"
            <form id="renluyensinhvien-xemdiem" method="post">
              <p style="color:red; font-size:200%;">Tổng điểm rèn luyện : 115</p>
            </form>
        "#;
        let parsed_uncapped = parse_drl_page_html(html_uncapped).unwrap();
        assert_eq!(parsed_uncapped.raw_score, Some(115));
        assert_eq!(parsed_uncapped.raw_score.unwrap().clamp(0, 100), 100);
        assert_eq!(classify_drl_rank(100), "Xuất sắc");
    }
}
