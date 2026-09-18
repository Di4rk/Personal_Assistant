//! Vault Auto-Scaffolding Service
//!
//! Automatically creates organized semester directory structures and course index notes
//! from Moodle active courses, with strictly idempotent filesystem operations and
//! immediate SQLite FTS5 synchronization.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::modules::vault::scanner::scan_and_sync_vault;

/// Result summary of the semester vault scaffolding operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldResultDto {
    pub created_folders: usize,
    pub created_notes: usize,
    pub skipped_notes: usize,
    pub semester_folder: String,
}

/// Sanitizes a string for use as a folder or file name across Windows and POSIX systems.
///
/// Strips characters: `< > : " / \ | ? *`
/// Collapses repeated whitespace and trims surrounding spaces/dots.
pub fn sanitize_folder_name(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            other => other,
        })
        .collect();

    let mut result = String::with_capacity(cleaned.len());
    let mut prev_space = false;
    for c in cleaned.trim().chars() {
        if c == ' ' {
            if !prev_space {
                result.push(' ');
                prev_space = true;
            }
        } else {
            result.push(c);
            prev_space = false;
        }
    }

    let trimmed = result.trim_matches(|c| c == ' ' || c == '.').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

/// Formats semester name like "HK2 2025-2026" into a filesystem-friendly folder name "2025-2026_HK2".
pub fn format_semester_dir_name(semester: &str) -> String {
    let trimmed = semester.trim();
    if let Some((hk, year)) = trimmed.split_once(' ') {
        if hk.to_uppercase().starts_with("HK") {
            return sanitize_folder_name(&format!("{}_{}", year, hk));
        }
    }
    sanitize_folder_name(trimmed)
}

/// Generates standard course index markdown template with YAML frontmatter.
pub fn generate_course_index_template(
    course_code: &str,
    course_name: &str,
    semester: &str,
    instructor_name: &str,
    instructor_mail: &str,
    instructor_phone: &str,
    course_url: &str,
) -> String {
    let instr_name = if instructor_name.trim().is_empty() {
        "Đang cập nhật"
    } else {
        instructor_name.trim()
    };
    let instr_mail = if instructor_mail.trim().is_empty() {
        "Chưa có email"
    } else {
        instructor_mail.trim()
    };
    let instr_phone = if instructor_phone.trim().is_empty() {
        "Chưa có SĐT"
    } else {
        instructor_phone.trim()
    };
    let url_moodle = if course_url.trim().is_empty() {
        "https://courses.uit.edu.vn"
    } else {
        course_url.trim()
    };

    format!(
        r#"---
course_code: "{course_code}"
course_name: "{course_name}"
semester: "{semester}"
tags:
  - course
  - uit
---

# {course_name} ({course_code})

> [!info] THÔNG TIN MÔN HỌC
> - **Giảng viên:** {instr_name}
> - **Email:** {instr_mail} | **SĐT:** {instr_phone}
> - 🌐 [Moodle UIT ↗]({url_moodle})
> - 📂 [Thư mục Google Drive ↗]()
> - 🧠 [Không gian ôn thi NotebookLM ↗]()

---

## 📝 Nhật Ký Bài Giảng
- 

## 💡 Công Thức & Kiến Thức Cốt Lõi
- 
"#
    )
}

#[derive(Debug, Clone)]
struct CourseInfo {
    course_code: String,
    fullname: String,
    term: String,
    instructor_name: String,
    instructor_mail: String,
    instructor_phone: String,
    course_url: String,
}

/// Scaffolds course folders and initial notes for a given semester in the Vault directory.
///
/// Invariant: strictly idempotent. Existing files are NEVER overwritten (`skipped_notes += 1`).
pub fn scaffold_semester_courses(
    conn: &mut Connection,
    vault_root: &Path,
    semester_name: Option<&str>,
) -> Result<ScaffoldResultDto, String> {
    if !vault_root.exists() {
        return Err(format!(
            "Thư mục Vault không tồn tại trên đĩa: {}",
            vault_root.display()
        ));
    }

    crate::db::schema::ensure_moodle_schema(conn)
        .map_err(|e| format!("Lỗi khởi tạo moodle schema: {e}"))?;

    let default_sem = "HK2 2025-2026";
    let active_semester = semester_name.unwrap_or(default_sem);
    let semester_dir_name = format_semester_dir_name(active_semester);
    let semester_dir = vault_root.join(&semester_dir_name);

    if !semester_dir.exists() {
        std::fs::create_dir_all(&semester_dir).map_err(|e| {
            format!(
                "Không thể tạo thư mục học kỳ {}: {}",
                semester_dir.display(),
                e
            )
        })?;
    }

    // 1. Fetch courses from moodle_courses
    let mut stmt = conn
        .prepare(
            r#"
            SELECT course_code, fullname, term, instructor_name, instructor_mail, instructor_phone, course_url
            FROM moodle_courses
            ORDER BY course_code ASC
            "#,
        )
        .map_err(|e| format!("Lỗi prepare query courses: {e}"))?;

    let course_rows = stmt
        .query_map([], |row| {
            Ok(CourseInfo {
                course_code: row.get(0)?,
                fullname: row.get(1)?,
                term: row.get(2)?,
                instructor_name: row.get(3)?,
                instructor_mail: row.get(4)?,
                instructor_phone: row.get(5)?,
                course_url: row.get(6)?,
            })
        })
        .map_err(|e| format!("Lỗi truy vấn danh sách môn học Moodle: {e}"))?;

    let mut all_courses = Vec::new();
    for r in course_rows {
        all_courses.push(r.map_err(|e| format!("Lỗi đọc dòng môn học: {e}"))?);
    }
    drop(stmt);

    // Filter courses matching active_semester if any matches, or fallback to all courses
    let matching_courses: Vec<&CourseInfo> = all_courses
        .iter()
        .filter(|c| {
            c.term.trim().is_empty()
                || c.term.eq_ignore_ascii_case(active_semester)
                || c.term.contains("HK2")
        })
        .collect();

    let target_courses = if matching_courses.is_empty() {
        all_courses.iter().collect::<Vec<_>>()
    } else {
        matching_courses
    };

    let mut created_folders = 0;
    let mut created_notes = 0;
    let mut skipped_notes = 0;

    for course in target_courses {
        let course_code = course.course_code.trim();
        let course_base_code = course_code.split('.').next().unwrap_or(course_code).trim();

        // Extract clean course name (strip trailing " - CS115.R11" if present)
        let fullname_clean = course.fullname.split(" - ").next().unwrap_or(&course.fullname).trim();

        let folder_name = sanitize_folder_name(&format!("{}_{}", course_base_code, fullname_clean));
        let course_dir = semester_dir.join(&folder_name);

        if !course_dir.exists() {
            std::fs::create_dir_all(&course_dir).map_err(|e| {
                format!(
                    "Không thể tạo thư mục môn học {}: {}",
                    course_dir.display(),
                    e
                )
            })?;
            created_folders += 1;
        }

        let index_filename = format!("00_{}_Index.md", course_base_code);
        let index_file = course_dir.join(&index_filename);

        if index_file.exists() {
            // Idempotent guarantee: NEVER overwrite existing user notes!
            skipped_notes += 1;
        } else {
            let note_content = generate_course_index_template(
                course_code,
                fullname_clean,
                &semester_dir_name,
                &course.instructor_name,
                &course.instructor_mail,
                &course.instructor_phone,
                &course.course_url,
            );

            std::fs::write(&index_file, &note_content).map_err(|e| {
                format!(
                    "Không thể ghi tệp ghi chú {}: {}",
                    index_file.display(),
                    e
                )
            })?;
            created_notes += 1;
        }
    }

    // 2. Trigger immediate SQLite FTS5 re-indexing
    let _ = scan_and_sync_vault(conn, vault_root);

    Ok(ScaffoldResultDto {
        created_folders,
        created_notes,
        skipped_notes,
        semester_folder: semester_dir_name,
    })
}

/// Searches the vault directory for a folder corresponding to a given course code.
///
/// Matches prefixes like `{base_code}_` or folder names containing `{course_code}`.
pub fn find_course_folder(vault_root: &Path, course_code: &str) -> Option<PathBuf> {
    if !vault_root.exists() || !vault_root.is_dir() {
        return None;
    }

    let trimmed_code = course_code.trim().to_uppercase();
    let base_code = trimmed_code
        .split('.')
        .next()
        .unwrap_or(&trimmed_code)
        .trim();

    // Helper recursive search (max depth 3)
    fn search_recursive(dir: &Path, base_code: &str, full_code: &str, depth: usize) -> Option<PathBuf> {
        if depth > 3 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(folder_name) = path.file_name().and_then(|n| n.to_str()) {
                    let upper = folder_name.to_uppercase();
                    if upper.starts_with(&format!("{}_", base_code))
                        || upper == base_code
                        || upper.contains(full_code)
                    {
                        return Some(path);
                    }
                    if let Some(found) = search_recursive(&path, base_code, full_code, depth + 1) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }

    search_recursive(vault_root, base_code, &trimmed_code, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_sanitize_folder_name() {
        assert_eq!(
            sanitize_folder_name("CS115: Toán cho KHMT / Kỳ 2?"),
            "CS115_ Toán cho KHMT _ Kỳ 2_"
        );
        assert_eq!(sanitize_folder_name("  Test...Folder...  "), "Test...Folder");
        assert_eq!(sanitize_folder_name("Normal Folder"), "Normal Folder");
        assert_eq!(sanitize_folder_name(""), "untitled");
    }

    #[test]
    fn test_format_semester_dir_name() {
        assert_eq!(format_semester_dir_name("HK2 2025-2026"), "2025-2026_HK2");
        assert_eq!(format_semester_dir_name("hk1 2024-2025"), "2024-2025_hk1");
        assert_eq!(format_semester_dir_name("Summer_2026"), "Summer_2026");
    }

    #[test]
    fn test_template_generation() {
        let template = generate_course_index_template(
            "CS115.R11",
            "Toán cho khoa học máy tính",
            "2025-2026_HK2",
            "TS. Nguyễn Văn A",
            "anv@uit.edu.vn",
            "0901234567",
            "https://courses.uit.edu.vn/course/view.php?id=101",
        );

        assert!(template.contains("course_code: \"CS115.R11\""));
        assert!(template.contains("# Toán cho khoa học máy tính (CS115.R11)"));
        assert!(template.contains("TS. Nguyễn Văn A"));
        assert!(template.contains("anv@uit.edu.vn"));
        assert!(template.contains("https://courses.uit.edu.vn/course/view.php?id=101"));
    }

    #[test]
    fn test_scaffold_idempotency() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_root = temp_dir.path();

        let mut conn = Connection::open_in_memory().expect("sqlite memory db");
        crate::db::schema::ensure_moodle_schema(&conn).expect("moodle schema");
        crate::db::vault_schema::init_vault_tables(&conn).expect("vault schema");

        // Insert test moodle course
        conn.execute(
            r#"
            INSERT INTO moodle_courses (course_id, course_code, fullname, term, instructor_name, instructor_mail, instructor_phone, course_url, updated_at)
            VALUES (101, 'CS115.R11', 'Toán cho khoa học máy tính - CS115.R11', 'HK2 2025-2026', 'TS. Nguyễn Văn A', 'a@uit.edu.vn', '090', 'http://uit', 100)
            "#,
            [],
        ).expect("insert course");

        // Run 1: Should create 1 folder and 1 note
        let res1 = scaffold_semester_courses(&mut conn, vault_root, Some("HK2 2025-2026"))
            .expect("scaffold 1");
        assert_eq!(res1.created_folders, 1);
        assert_eq!(res1.created_notes, 1);
        assert_eq!(res1.skipped_notes, 0);

        let note_path = vault_root
            .join("2025-2026_HK2")
            .join("CS115_Toán cho khoa học máy tính")
            .join("00_CS115_Index.md");
        assert!(note_path.exists());

        // Modify note content to simulate user edits
        std::fs::write(&note_path, "# User custom edited notes").expect("write custom note");

        // Run 2: Idempotent run. Must NOT overwrite custom user note!
        let res2 = scaffold_semester_courses(&mut conn, vault_root, Some("HK2 2025-2026"))
            .expect("scaffold 2");
        assert_eq!(res2.created_folders, 0); // Already exists
        assert_eq!(res2.created_notes, 0);
        assert_eq!(res2.skipped_notes, 1);

        let read_back = std::fs::read_to_string(&note_path).expect("read back note");
        assert_eq!(read_back, "# User custom edited notes");

        // Test find course folder
        let found = find_course_folder(vault_root, "CS115.R11");
        assert!(found.is_some());
        assert!(found
            .unwrap()
            .ends_with("2025-2026_HK2/CS115_Toán cho khoa học máy tính"));
    }
}
