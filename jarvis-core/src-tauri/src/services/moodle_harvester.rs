use rusqlite::Connection;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::db::moodle::{
    commit_moodle_payload, MoodleCourseRecord, MoodleMaterialRecord, MoodleSyncPayload,
    MoodleTaskRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct InstructorInfo {
    pub name: String,
    pub email: String,
    pub phone: String,
}

pub type ParsedCourseDetails = (
    Option<InstructorInfo>,
    Vec<MoodleTaskRecord>,
    Vec<MoodleMaterialRecord>,
);

pub struct MoodleIngestionEngine;

impl MoodleIngestionEngine {
    pub fn commit_moodle_sync(
        db: Arc<Mutex<Connection>>,
        payload: MoodleSyncPayload,
    ) -> Result<(usize, usize, usize), String> {
        let mut conn = db.lock().map_err(|e| format!("DB lock error: {e}"))?;
        commit_moodle_payload(&mut conn, payload)
    }
}

// ============================================================
//  JSON API PARSERS
// ============================================================

#[derive(Deserialize)]
struct RawEnrolledCourse {
    id: i64,
    fullname: String,
    #[serde(default)]
    shortname: String,
    #[serde(default)]
    idnumber: String,
    #[serde(default)]
    viewurl: String,
}

/// Parse danh sách môn học từ `core_course_get_enrolled_courses_by_timeline_classification`
pub fn parse_moodle_enrolled_courses_json(json_str: &str) -> Result<Vec<MoodleCourseRecord>, String> {
    let resp: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Invalid enrolled courses JSON: {e}"))?;

    let courses_val = if resp.is_array() {
        resp.get(0)
            .and_then(|first| first.get("data"))
            .and_then(|d| d.get("courses"))
            .unwrap_or(&serde_json::Value::Null)
    } else if let Some(data) = resp.get("data") {
        data.get("courses").unwrap_or(&serde_json::Value::Null)
    } else if let Some(courses) = resp.get("courses") {
        courses
    } else {
        &serde_json::Value::Null
    };

    let raw_courses: Vec<RawEnrolledCourse> = serde_json::from_value(courses_val.clone())
        .map_err(|e| format!("Cannot parse courses array: {e}"))?;

    let now_ts = chrono::Utc::now().timestamp();
    let mut results = Vec::new();

    for rc in raw_courses {
        // Trích xuất mã môn: ưu tiên shortname / idnumber (vd: 'SS009.R12') hoặc trích từ fullname
        let code = if !rc.shortname.is_empty() {
            rc.shortname.clone()
        } else if !rc.idnumber.is_empty() {
            rc.idnumber.clone()
        } else {
            extract_course_code_from_title(&rc.fullname)
        };

        results.push(MoodleCourseRecord {
            course_id: rc.id,
            course_code: code,
            fullname: rc.fullname,
            term: "HK2 2025-2026".to_string(), // Default semester
            instructor_name: String::new(),
            instructor_mail: String::new(),
            instructor_phone: String::new(),
            course_url: if rc.viewurl.is_empty() {
                format!("https://courses.uit.edu.vn/course/view.php?id={}", rc.id)
            } else {
                rc.viewurl
            },
            updated_at: now_ts,
        });
    }

    Ok(results)
}

#[derive(Deserialize)]
struct RawCalendarEvent {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    modulename: String,
    #[serde(default)]
    activityname: String,
    #[serde(default)]
    instance: i64,
    #[serde(default)]
    timesort: i64,
    #[serde(default)]
    timestart: i64,
    course: Option<RawEventCourse>,
    action: Option<RawEventAction>,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
struct RawEventCourse {
    id: i64,
    #[serde(default)]
    fullname: String,
    #[serde(default)]
    shortname: String,
}

#[derive(Deserialize)]
struct RawEventAction {
    #[serde(default)]
    name: String,
    #[serde(default)]
    url: String,
}

/// Parse danh sách deadline từ `core_calendar_get_action_events_by_timesort`
pub fn parse_moodle_calendar_events_json(json_str: &str) -> Result<Vec<MoodleTaskRecord>, String> {
    let resp: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| format!("Invalid calendar events JSON: {e}"))?;

    let events_val = if resp.is_array() {
        resp.get(0)
            .and_then(|first| first.get("data"))
            .and_then(|d| d.get("events"))
            .unwrap_or(&serde_json::Value::Null)
    } else if let Some(data) = resp.get("data") {
        data.get("events").unwrap_or(&serde_json::Value::Null)
    } else if let Some(events) = resp.get("events") {
        events
    } else {
        &serde_json::Value::Null
    };

    let raw_events: Vec<RawCalendarEvent> = serde_json::from_value(events_val.clone())
        .map_err(|e| format!("Cannot parse events array: {e}"))?;

    let now_ts = chrono::Utc::now().timestamp();
    let mut tasks = Vec::new();

    for ev in raw_events {
        let task_id = if ev.instance > 0 { ev.instance } else { ev.id };
        let course_id = ev.course.as_ref().map(|c| c.id).unwrap_or(0);
        let course_name = ev.course.as_ref().map(|c| c.fullname.clone());
        let course_code = ev.course.as_ref().map(|c| c.shortname.clone());

        let title = if !ev.activityname.is_empty() {
            ev.activityname.clone()
        } else {
            ev.name.replace("tới hạn", "").replace("is due", "").trim().to_string()
        };

        let due_date = if ev.timesort > 0 {
            ev.timesort
        } else {
            ev.timestart
        };

        let mut template_file_url = String::new();
        if !ev.description.is_empty() {
            if let Some(url) = extract_first_link_from_html(&ev.description) {
                template_file_url = url;
            }
        }

        let task_url = if !ev.url.is_empty() {
            ev.url
        } else if let Some(action) = &ev.action {
            action.url.clone()
        } else {
            format!("https://courses.uit.edu.vn/mod/{}/view.php?id={}", ev.modulename, task_id)
        };

        let is_submitted = ev
            .action
            .as_ref()
            .map(|a| a.name.contains("Đã nộp") || a.name.contains("Submitted"))
            .unwrap_or(false);

        let submission_status = ev
            .action
            .as_ref()
            .map(|a| a.name.clone())
            .unwrap_or_else(|| if is_submitted { "Đã nộp" } else { "Chưa nộp" }.to_string());

        tasks.push(MoodleTaskRecord {
            task_id,
            course_id,
            title,
            task_type: if !ev.modulename.is_empty() { ev.modulename } else { "assign".to_string() },
            due_date,
            is_submitted,
            submission_status,
            template_file_url,
            task_url,
            updated_at: now_ts,
            course_name,
            course_code,
        });
    }

    Ok(tasks)
}

// ============================================================
//  HTML COURSE VIEW PARSER
// ============================================================

/// Parse toàn bộ trang HTML `course/view.php?id={course_id}`
/// Trích xuất:
/// 1. Thông tin giảng viên từ Section Chung
/// 2. Danh mục bài tập (`modtype_assign`, `modtype_quiz`)
/// 3. Danh mục slide và tài liệu (`modtype_resource`, etc.)
pub fn parse_moodle_course_html(
    course_id: i64,
    html: &str,
) -> Result<ParsedCourseDetails, String> {
    let doc = Html::parse_document(html);

    // 1. Instructor Info Extraction
    let instructor = extract_instructor_info(&doc);

    // Selectors cho sections & activities
    let section_sel = Selector::parse("li.section.course-section")
        .map_err(|e| format!("Invalid section selector: {e:?}"))?;
    let title_sel = Selector::parse("div.activityname a.aalink span.instancename")
        .map_err(|e| format!("Invalid title selector: {e:?}"))?;
    let link_sel = Selector::parse("div.activityname a.aalink")
        .map_err(|e| format!("Invalid link selector: {e:?}"))?;
    let badge_sel = Selector::parse("span.activitybadge")
        .map_err(|e| format!("Invalid badge selector: {e:?}"))?;
    let date_region_sel = Selector::parse("div[data-region='activity-dates'] div.date-item")
        .map_err(|e| format!("Invalid date selector: {e:?}"))?;
    let desc_sel = Selector::parse("div.activity-description")
        .map_err(|e| format!("Invalid desc selector: {e:?}"))?;

    let now_ts = chrono::Utc::now().timestamp();
    let mut tasks = Vec::new();
    let mut materials = Vec::new();

    for sec in doc.select(&section_sel) {
        let sec_name = sec
            .value()
            .attr("data-sectionname")
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| {
                // Fallback qua h3.sectionname
                if let Ok(h3_sel) = Selector::parse("h3.sectionname") {
                    sec.select(&h3_sel)
                        .next()
                        .map(|el| el.text().collect::<String>().trim().to_string())
                        .unwrap_or_else(|| "Chung".to_string())
                } else {
                    "Chung".to_string()
                }
            });

        // Loop qua các li.activity bên trong section
        if let Ok(act_sel) = Selector::parse("li.activity") {
            for act in sec.select(&act_sel) {
                let cmid_str = act.value().attr("data-id").unwrap_or("0");
                let cmid: i64 = cmid_str.parse().unwrap_or(0);
                if cmid == 0 {
                    continue;
                }

                let classes = act.value().attr("class").unwrap_or("");
                let is_assign = classes.contains("modtype_assign");
                let is_quiz = classes.contains("modtype_quiz");
                let is_resource = classes.contains("modtype_resource");

                let raw_title = act
                    .select(&title_sel)
                    .next()
                    .map(|el| el.text().collect::<String>())
                    .unwrap_or_default();

                let clean_title = raw_title
                    .replace("Bài tập", "")
                    .replace("File", "")
                    .replace("Tập tin", "")
                    .replace('\u{00a0}', " ")
                    .trim()
                    .to_string();

                if clean_title.is_empty() {
                    continue;
                }

                let url = act
                    .select(&link_sel)
                    .next()
                    .and_then(|el| el.value().attr("href"))
                    .unwrap_or_default()
                    .to_string();

                if is_assign || is_quiz {
                    let mut due_date = 0;
                    for date_item in act.select(&date_region_sel) {
                        let text = date_item.text().collect::<String>();
                        if text.contains("Due:") || text.contains("Hạn nộp:") {
                            let clean_dt = text
                                .replace("Due:", "")
                                .replace("Hạn nộp:", "")
                                .trim()
                                .to_string();
                            if let Some(ts) = parse_flexible_moodle_date(&clean_dt) {
                                due_date = ts;
                                break;
                            }
                        }
                    }

                    let mut template_file_url = String::new();
                    if let Some(desc_el) = act.select(&desc_sel).next() {
                        let html_desc = desc_el.html();
                        if let Some(link) = extract_first_link_from_html(&html_desc) {
                            template_file_url = link;
                        }
                    }

                    tasks.push(MoodleTaskRecord {
                        task_id: cmid,
                        course_id,
                        title: clean_title,
                        task_type: if is_quiz { "quiz".to_string() } else { "assign".to_string() },
                        due_date,
                        is_submitted: false,
                        submission_status: "Chưa nộp".to_string(),
                        template_file_url,
                        task_url: url,
                        updated_at: now_ts,
                        course_name: None,
                        course_code: None,
                    });
                } else if is_resource {
                    let badge_text = act
                        .select(&badge_sel)
                        .next()
                        .map(|el| el.text().collect::<String>().trim().to_lowercase())
                        .unwrap_or_default();

                    let file_type = if badge_text.contains("pdf") || url.ends_with(".pdf") {
                        "pdf"
                    } else if badge_text.contains("powerpoint") || badge_text.contains("pptx") || url.ends_with(".pptx") {
                        "pptx"
                    } else if badge_text.contains("word") || badge_text.contains("docx") || url.ends_with(".docx") {
                        "docx"
                    } else {
                        "pdf" // default document type
                    };

                    materials.push(MoodleMaterialRecord {
                        id: 0,
                        course_id,
                        section_name: sec_name.clone(),
                        title: clean_title,
                        file_url: url,
                        file_type: file_type.to_string(),
                        created_at: now_ts,
                    });
                }
            }
        }
    }

    Ok((instructor, tasks, materials))
}

fn extract_instructor_info(doc: &Html) -> Option<InstructorInfo> {
    let mut name = String::new();
    let mut email = String::new();
    let mut phone = String::new();

    // 1. Quét qua các activity forum/description hoặc text trong section Chung
    if let Ok(desc_sel) = Selector::parse("div.activity-description, div.no-overflow") {
        for el in doc.select(&desc_sel) {
            let text = el.text().collect::<String>();
            if text.contains("Giảng viên:") || text.contains("Mail:") || text.contains("SĐT:") {
                for line in text.lines() {
                    let l = line.trim();
                    if (l.starts_with("Giảng viên:") || l.starts_with("GV:")) && name.is_empty() {
                        name = l.replace("Giảng viên:", "").replace("GV:", "").trim().to_string();
                    } else if (l.starts_with("Mail:") || l.starts_with("Email:")) && email.is_empty() {
                        email = l.replace("Mail:", "").replace("Email:", "").trim().to_string();
                    } else if (l.starts_with("SĐT:") || l.starts_with("Phone:") || l.starts_with("Điện thoại:")) && phone.is_empty() {
                        phone = l.replace("SĐT:", "").replace("Phone:", "").replace("Điện thoại:", "").trim().to_string();
                    }
                }
            }
        }
    }

    if !name.is_empty() || !email.is_empty() || !phone.is_empty() {
        Some(InstructorInfo { name, email, phone })
    } else {
        None
    }
}

fn extract_first_link_from_html(html: &str) -> Option<String> {
    let fragment = Html::parse_fragment(html);
    if let Ok(a_sel) = Selector::parse("a[href]") {
        for a in fragment.select(&a_sel) {
            if let Some(href) = a.value().attr("href") {
                if href.contains(".docx") || href.contains(".pdf") || href.contains(".zip") || href.contains("resource") {
                    return Some(href.to_string());
                }
            }
        }
        // Fallback: any link
        for a in fragment.select(&a_sel) {
            if let Some(href) = a.value().attr("href") {
                if !href.starts_with('#') {
                    return Some(href.to_string());
                }
            }
        }
    }
    None
}

fn extract_course_code_from_title(title: &str) -> String {
    for part in title.split(['-', ' ']) {
        let clean = part.trim();
        if clean.len() >= 5 && clean.contains('.') {
            return clean.to_string();
        }
    }
    title.trim().to_string()
}

pub fn parse_flexible_moodle_date(date_str: &str) -> Option<i64> {
    // 1. Thử parse qua hàm chuẩn UIT Moodle ("Thứ Sáu, 18 tháng 9 2026, 11:59 CH")
    if let Some(ts) = crate::modules::academic::moodle_parser::parse_moodle_date(date_str) {
        return Some(ts);
    }

    // 2. Thử parse định dạng tiếng Anh: "Friday, 18 September 2026, 11:59 PM"
    let clean = date_str.trim();
    let parts: Vec<&str> = clean.splitn(3, ',').collect();
    if parts.len() == 3 {
        let date_part = parts[1].trim();
        let time_part = parts[2].trim();
        let date_tokens: Vec<&str> = date_part.split_whitespace().collect();
        if date_tokens.len() >= 3 {
            let day: u32 = date_tokens[0].parse().ok()?;
            let month_str = date_tokens[1].to_lowercase();
            let month = match month_str.as_str() {
                "january" | "jan" => 1,
                "february" | "feb" => 2,
                "march" | "mar" => 3,
                "april" | "apr" => 4,
                "may" => 5,
                "june" | "jun" => 6,
                "july" | "jul" => 7,
                "august" | "aug" => 8,
                "september" | "sep" => 9,
                "october" | "oct" => 10,
                "november" | "nov" => 11,
                "december" | "dec" => 12,
                _ => return None,
            };
            let year: i32 = date_tokens[2].parse().ok()?;

            let time_tokens: Vec<&str> = time_part.split_whitespace().collect();
            if time_tokens.len() >= 2 {
                let clock_parts: Vec<&str> = time_tokens[0].split(':').collect();
                if clock_parts.len() == 2 {
                    let mut hour: u32 = clock_parts[0].parse().ok()?;
                    let minute: u32 = clock_parts[1].parse().ok()?;
                    let period = time_tokens[1].to_uppercase();
                    if period == "PM" && hour < 12 {
                        hour += 12;
                    } else if period == "AM" && hour == 12 {
                        hour = 0;
                    }

                    let naive_date = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
                    let naive_time = chrono::NaiveTime::from_hms_opt(hour, minute, 0)?;
                    let naive_dt = chrono::NaiveDateTime::new(naive_date, naive_time);
                    let utc_offset_secs: i64 = 7 * 3600;
                    return Some(naive_dt.and_utc().timestamp() - utc_offset_secs);
                }
            }
        }
    }

    None
}

// ============================================================
//  UNIT TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_enrolled_courses_json() {
        let sample_json = r#"{
            "data": {
                "courses": [
                    {
                        "id": 1289,
                        "fullname": "Chủ nghĩa xã hội khoa học - SS009.R12",
                        "shortname": "SS009.R12",
                        "idnumber": "SS009.R12",
                        "summary": "",
                        "viewurl": "https://courses.uit.edu.vn/course/view.php?id=1289"
                    },
                    {
                        "id": 941,
                        "fullname": "Cơ sở dữ liệu - IT004.R19",
                        "shortname": "IT004.R19",
                        "idnumber": "IT004.R19",
                        "summary": "",
                        "viewurl": "https://courses.uit.edu.vn/course/view.php?id=941"
                    }
                ]
            }
        }"#;

        let courses = parse_moodle_enrolled_courses_json(sample_json).unwrap();
        assert_eq!(courses.len(), 2);
        assert_eq!(courses[0].course_id, 1289);
        assert_eq!(courses[0].course_code, "SS009.R12");
        assert_eq!(courses[1].course_id, 941);
        assert_eq!(courses[1].course_code, "IT004.R19");
    }

    #[test]
    fn test_parse_calendar_events_json() {
        let sample_json = r#"{
            "data": {
                "events": [
                    {
                        "id": 1467,
                        "name": "ĐĂNG KÝ ĐỀ TÀI NHÓM tới hạn",
                        "description": "<ul><li>Chọn đề tài</li></ul>",
                        "modulename": "assign",
                        "activityname": "ĐĂNG KÝ ĐỀ TÀI NHÓM",
                        "instance": 11792,
                        "timesort": 1789750740,
                        "course": {
                            "id": 1289,
                            "fullname": "Chủ nghĩa xã hội khoa học - SS009.R12",
                            "shortname": "SS009.R12"
                        },
                        "action": {
                            "name": "Thêm bài nộp",
                            "url": "https://courses.uit.edu.vn/mod/assign/view.php?id=11792&action=editsubmission",
                            "actionable": true
                        },
                        "url": "https://courses.uit.edu.vn/mod/assign/view.php?id=11792"
                    }
                ]
            }
        }"#;

        let tasks = parse_moodle_calendar_events_json(sample_json).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_id, 11792);
        assert_eq!(tasks[0].course_id, 1289);
        assert_eq!(tasks[0].title, "ĐĂNG KÝ ĐỀ TÀI NHÓM");
        assert_eq!(tasks[0].due_date, 1789750740);
        assert_eq!(tasks[0].task_type, "assign");
    }

    #[test]
    fn test_parse_course_html_instructor_and_activities() {
        let sample_html = r#"
            <!DOCTYPE html>
            <html>
            <body>
                <ul class="topics section-list">
                    <li id="section-0" class="section course-section" data-sectionname="Chung">
                        <div class="activity-description">
                            <p>Giảng viên: ThS. Trịnh Bá Phương</p>
                            <p>Mail: phuongtbhcmue@gmail.com</p>
                            <p>SĐT: 0376 333 654</p>
                        </div>
                    </li>
                    <li id="section-1" class="section course-section" data-sectionname="TUẦN 1">
                        <ul class="section">
                            <li class="activity assign modtype_assign" data-id="11792">
                                <div class="activityname">
                                    <a class="aalink" href="https://courses.uit.edu.vn/mod/assign/view.php?id=11792">
                                        <span class="instancename">ĐĂNG KÝ ĐỀ TÀI NHÓM Bài tập</span>
                                    </a>
                                </div>
                                <div data-region="activity-dates">
                                    <div class="date-item">Due: Thứ Sáu, 18 tháng 9 2026, 11:59 CH</div>
                                </div>
                                <div class="activity-description">
                                    <a href="https://courses.uit.edu.vn/mau_dang_ky.docx">Tải mẫu đăng ký</a>
                                </div>
                            </li>
                        </ul>
                    </li>
                    <li id="section-2" class="section course-section" data-sectionname="Tuần 2">
                        <ul class="section">
                            <li class="activity resource modtype_resource" data-id="16726">
                                <div class="activityname">
                                    <a class="aalink" href="https://courses.uit.edu.vn/mod/resource/view.php?id=16726">
                                        <span class="instancename">C1_Slide BG File</span>
                                    </a>
                                </div>
                                <span class="activitybadge">PDF</span>
                            </li>
                        </ul>
                    </li>
                </ul>
            </body>
            </html>
        "#;

        let (instructor, tasks, materials) = parse_moodle_course_html(1289, sample_html).unwrap();
        assert!(instructor.is_some());
        let inst = instructor.unwrap();
        assert_eq!(inst.name, "ThS. Trịnh Bá Phương");
        assert_eq!(inst.email, "phuongtbhcmue@gmail.com");
        assert_eq!(inst.phone, "0376 333 654");

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_id, 11792);
        assert_eq!(tasks[0].title, "ĐĂNG KÝ ĐỀ TÀI NHÓM");
        assert_eq!(tasks[0].template_file_url, "https://courses.uit.edu.vn/mau_dang_ky.docx");

        assert_eq!(materials.len(), 1);
        assert_eq!(materials[0].title, "C1_Slide BG");
        assert_eq!(materials[0].file_type, "pdf");
        assert_eq!(materials[0].section_name, "Tuần 2");
    }
}
