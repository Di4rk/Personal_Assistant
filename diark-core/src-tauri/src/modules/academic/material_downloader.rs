//! Material Offline Mirror Service for Moodle course resources.
//!
//! Downloads lecture slides, documents, and attachments from Moodle to the
//! structured course vault directory: `{vault_root}/{semester_dir}/{course_folder}/Slides/{filename}`.
//!
//! Enforces:
//! - Strict filename sanitization (Windows & POSIX safe).
//! - Atomic stream writing via temporary `.tmp` files before final rename.
//! - Zero unwrap() in production paths.

use std::path::{Path, PathBuf};
use rusqlite::{params, Connection};
use tokio::io::AsyncWriteExt;

/// Known document extensions recognized by Moodle and the desktop reader.
const RECOGNIZED_EXTENSIONS: &[&str] = &[
    ".pdf", ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls", ".zip", ".rar",
    ".7z", ".txt", ".cpp", ".c", ".py", ".java", ".html",
];

/// Sanitizes document title and URL into a safe, valid filesystem filename.
///
/// Strips forbidden Windows characters `< > : " / \ | ? *`, collapses whitespace,
/// trims surrounding dots and spaces, and ensures a proper file extension.
pub fn sanitize_material_filename(title: &str, file_type: &str, url: &str) -> String {
    // 1. Replace forbidden characters with underscore
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            other => other,
        })
        .collect();

    // 2. Collapse consecutive whitespace and consecutive underscores
    let mut collapsed = String::with_capacity(cleaned.len());
    let mut prev_char = '\0';
    for c in cleaned.trim().chars() {
        if c == ' ' {
            if prev_char != ' ' {
                collapsed.push(' ');
                prev_char = ' ';
            }
        } else if c == '_' {
            if prev_char != '_' {
                collapsed.push('_');
                prev_char = '_';
            }
        } else {
            collapsed.push(c);
            prev_char = c;
        }
    }

    let mut base_name = collapsed
        .trim_matches(|c| c == ' ' || c == '.' || c == '_')
        .to_string();
    if base_name.is_empty() {
        base_name = "unnamed_material".to_string();
    }

    // 3. Determine if base_name already contains a recognized extension
    let lower_base = base_name.to_lowercase();
    let has_ext = RECOGNIZED_EXTENSIONS
        .iter()
        .any(|ext| lower_base.ends_with(ext));

    if has_ext {
        return base_name;
    }

    // 4. Derive extension from file_type or url
    let ext: String = match file_type.to_lowercase().trim() {
        "pdf" => ".pdf".to_string(),
        "pptx" | "powerpoint" | "presentation" => ".pptx".to_string(),
        "ppt" => ".ppt".to_string(),
        "docx" | "word" | "document" => ".docx".to_string(),
        "doc" => ".doc".to_string(),
        "xlsx" | "excel" | "spreadsheet" => ".xlsx".to_string(),
        "xls" => ".xls".to_string(),
        "zip" | "archive" => ".zip".to_string(),
        "rar" => ".rar".to_string(),
        _ => {
            let lower_url = url.to_lowercase();
            if let Some(pos) = lower_url.rfind('.') {
                let candidate = &lower_url[pos..];
                let pure_ext = candidate.split(|c| c == '?' || c == '#' || c == '&').next().unwrap_or("");
                if RECOGNIZED_EXTENSIONS.contains(&pure_ext) {
                    pure_ext.to_string()
                } else {
                    ".pdf".to_string()
                }
            } else {
                ".pdf".to_string()
            }
        }
    };

    format!("{base_name}{ext}")
}

/// Resolves the filesystem target directory `{vault_root}/{semester_dir}/{course_folder}/Slides`.
///
/// Creates all parent folders idempotently if they do not exist.
pub fn resolve_course_slides_dir(
    vault_root: &Path,
    course_id: i64,
    conn: &Connection,
) -> Result<PathBuf, String> {
    if !vault_root.exists() {
        return Err(format!(
            "Thư mục Vault không tồn tại trên đĩa: {}",
            vault_root.display()
        ));
    }

    crate::db::schema::ensure_moodle_schema(conn)
        .map_err(|e| format!("Lỗi khởi tạo moodle schema: {e}"))?;

    let mut stmt = conn
        .prepare(
            r#"
            SELECT course_code, fullname, term
            FROM moodle_courses
            WHERE course_id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Lỗi prepare truy vấn khóa học {course_id}: {e}"))?;

    let (course_code, fullname, term): (String, String, String) = stmt
        .query_row(params![course_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("Không tìm thấy thông tin khóa học id {course_id}: {e}"))?;

    drop(stmt);

    let active_term = if term.trim().is_empty() {
        "HK2 2025-2026"
    } else {
        term.trim()
    };

    let semester_dir_name = crate::modules::vault::scaffolder::format_semester_dir_name(active_term);
    let course_base_code = course_code.split('.').next().unwrap_or(&course_code).trim();
    let fullname_clean = fullname.split(" - ").next().unwrap_or(&fullname).trim();
    let folder_name = crate::modules::vault::scaffolder::sanitize_folder_name(&format!(
        "{}_{}",
        course_base_code, fullname_clean
    ));

    let slides_dir = vault_root
        .join(semester_dir_name)
        .join(folder_name)
        .join("Slides");

    if !slides_dir.exists() {
        std::fs::create_dir_all(&slides_dir).map_err(|e| {
            format!(
                "Không thể tạo thư mục Slides tại {}: {}",
                slides_dir.display(),
                e
            )
        })?;
    }

    Ok(slides_dir)
}

/// Atomically downloads a single material from Moodle to target_path.
///
/// Writes to a temporary `.tmp` file and renames it upon completion to avoid corrupt files.
/// Returns the total downloaded byte count.
pub async fn download_single_material(
    client: &reqwest::Client,
    cookie_header: &str,
    download_url: &str,
    target_path: &Path,
) -> Result<u64, String> {
    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                format!(
                    "Không thể tạo thư mục đích {}: {}",
                    parent.display(),
                    e
                )
            })?;
        }
    }

    let mut req = client.get(download_url).header(
        reqwest::header::USER_AGENT,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    let trimmed_cookie = cookie_header.trim();
    if !trimmed_cookie.is_empty() {
        let cookie_val = if trimmed_cookie.contains('=') {
            trimmed_cookie.to_string()
        } else {
            format!("MoodleSession={trimmed_cookie}")
        };
        req = req.header(reqwest::header::COOKIE, cookie_val);
    }

    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("Lỗi kết nối tới URL tải tài liệu: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!(
            "Moodle từ chối truy cập (HTTP {status}). Vui lòng đồng bộ lại phiên đăng nhập Moodle."
        ));
    }

    // Check if redirected to login page
    let final_url = resp.url().as_str();
    if final_url.contains("login/index.php") {
        return Err("Phiên đăng nhập Moodle đã hết hạn (chuyển hướng về login). Vui lòng đăng nhập lại.".to_string());
    }

    if !status.is_success() {
        return Err(format!("Tải tài liệu thất bại với mã HTTP {status}"));
    }

    // Atomic download: write to temporary file first
    let tmp_ext = format!("tmp_{}", uuid::Uuid::new_v4().simple());
    let temp_path = target_path.with_extension(tmp_ext);

    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Không thể tạo file tạm {}: {}", temp_path.display(), e))?;

    let mut total_bytes: u64 = 0;

    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Lỗi khi đọc luồng dữ liệu mạng: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Lỗi ghi vào file tạm: {e}"))?;
        total_bytes += chunk.len() as u64;
    }

    file.flush()
        .await
        .map_err(|e| format!("Lỗi hoàn tất ghi file: {e}"))?;
    drop(file);

    // Atomically rename temp file to final target
    if target_path.exists() {
        let _ = tokio::fs::remove_file(target_path).await;
    }

    tokio::fs::rename(&temp_path, target_path)
        .await
        .map_err(|e| {
            format!(
                "Không thể đổi tên file tạm {} thành {}: {}",
                temp_path.display(),
                target_path.display(),
                e
            )
        })?;

    Ok(total_bytes)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    pub fn test_sanitize_material_filename() {
        // Test 1: Forbidden Windows characters removal
        let title1 = "Slide 1: Giới thiệu <CS115>? / * | \"";
        let res1 = sanitize_material_filename(title1, "pdf", "https://courses.uit.edu.vn/resource/1");
        assert_eq!(res1, "Slide 1_ Giới thiệu _CS115.pdf");

        // Test 2: Existing extension not duplicated
        let title2 = "Chuong_02_Tree_Graph.pptx";
        let res2 = sanitize_material_filename(title2, "pdf", "https://courses.uit.edu.vn/resource/2");
        assert_eq!(res2, "Chuong_02_Tree_Graph.pptx");

        // Test 3: Whitespace collapsing and dot trimming
        let title3 = "   Bai Tap   Nhom ..  ";
        let res3 = sanitize_material_filename(title3, "docx", "https://courses.uit.edu.vn/resource/3");
        assert_eq!(res3, "Bai Tap Nhom.docx");

        // Test 4: Empty title fallback
        let title4 = "  ";
        let res4 = sanitize_material_filename(title4, "zip", "https://courses.uit.edu.vn/resource/4");
        assert_eq!(res4, "unnamed_material.zip");

        // Test 5: Fallback from URL extension
        let title5 = "Source Code";
        let res5 = sanitize_material_filename(title5, "unknown", "https://courses.uit.edu.vn/test.cpp?token=123");
        assert_eq!(res5, "Source Code.cpp");
    }
}
