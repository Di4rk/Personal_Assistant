//! Archive Ritual Service for Semester Lifecycle Transition.
//!
//! The Archive Ritual finalizes an active academic term by recording official exam grades
//! into markdown frontmatters, archiving database states, and migrating working folders to an archive directory.
//! It guarantees idempotent zero-data-loss transitions while immediately refreshing FTS5 indexes for seamless search continuity.

use std::path::Path;
use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::modules::vault::scaffolder::format_semester_dir_name;
use crate::modules::vault::scanner::scan_and_sync_vault;

/// DTO returned to frontend upon successful semester archive ritual completion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSemesterResultDto {
    pub semester_id: String,
    pub semester_dir_name: String,
    pub archived_courses_count: usize,
    pub updated_index_files: Vec<String>,
    pub moved_from: String,
    pub moved_to: String,
    pub summary_gpa_10: Option<f64>,
    pub summary_gpa_4: Option<f64>,
}

#[derive(Debug, Clone)]
struct CourseFinalGrade {
    course_code: String,
    course_name: String,
    credits: i64,
    score_10: Option<f64>,
    score_4: Option<f64>,
    grade_char: Option<String>,
}

/// Updates or injects YAML frontmatter in a course index markdown note with the official final grade.
///
/// Preserves all existing tags, metadata, and markdown body without corruption.
pub fn update_course_index_frontmatter(
    file_path: &Path,
    score_10: f64,
    score_4: f64,
    grade_char: &str,
    archived_at: &str,
) -> Result<bool, String> {
    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("Không thể đọc file {}: {}", file_path.display(), e))?;

    let trimmed = content.trim_start();
    let (new_content, modified) = if trimmed.starts_with("---") {
        // Find the second "---" closing delimiter
        let rest = &trimmed[3..];
        let end_opt = rest.find("\n---").or_else(|| rest.find("\r\n---"));

        if let Some(end_idx) = end_opt {
            let frontmatter_body = &rest[..end_idx];
            let after_delimiter = if rest[end_idx..].starts_with("\r\n---") {
                &rest[end_idx + 5..]
            } else {
                &rest[end_idx + 4..]
            };

            // Filter out existing archive/score lines
            let mut lines: Vec<String> = frontmatter_body
                .lines()
                .filter(|line| {
                    let l = line.trim();
                    !l.starts_with("final_score_10:")
                        && !l.starts_with("final_score_4:")
                        && !l.starts_with("grade_char:")
                        && !l.starts_with("status:")
                        && !l.starts_with("archived_at:")
                })
                .map(|l| l.to_string())
                .collect();

            // Append updated score & archive status keys
            lines.push(format!("final_score_10: {:.2}", score_10));
            lines.push(format!("final_score_4: {:.2}", score_4));
            lines.push(format!("grade_char: \"{}\"", grade_char));
            lines.push("status: \"archived\"".to_string());
            lines.push(format!("archived_at: \"{}\"", archived_at));

            let new_fm = lines.join("\n");
            let reconstructed = format!("---\n{}\n---{}", new_fm, after_delimiter);
            (reconstructed, true)
        } else {
            // Malformed frontmatter: prepend a valid frontmatter block
            let fm_block = format!(
                "---\nfinal_score_10: {:.2}\nfinal_score_4: {:.2}\ngrade_char: \"{}\"\nstatus: \"archived\"\narchived_at: \"{}\"\n---\n\n",
                score_10, score_4, grade_char, archived_at
            );
            (format!("{}{}", fm_block, content), true)
        }
    } else {
        // No frontmatter: prepend frontmatter block
        let fm_block = format!(
            "---\nfinal_score_10: {:.2}\nfinal_score_4: {:.2}\ngrade_char: \"{}\"\nstatus: \"archived\"\narchived_at: \"{}\"\n---\n\n",
            score_10, score_4, grade_char, archived_at
        );
        (format!("{}{}", fm_block, content), true)
    };

    if modified {
        std::fs::write(file_path, new_content)
            .map_err(|e| format!("Không thể ghi file {}: {}", file_path.display(), e))?;
    }

    Ok(modified)
}

/// Recursively moves all contents from `src` to `dst` and removes `src`.
fn move_dir_contents(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let target_path = dst.join(entry.file_name());

        if entry_path.is_dir() {
            move_dir_contents(&entry_path, &target_path)?;
        } else {
            if target_path.exists() {
                std::fs::remove_file(&target_path)?;
            }
            std::fs::rename(&entry_path, &target_path)?;
        }
    }

    let _ = std::fs::remove_dir(src);
    Ok(())
}

/// Executes the full Archive Ritual for a semester:
/// 1. Queries course final scores from `academic_courses`.
/// 2. Updates YAML frontmatter of `00_Index.md` in each course folder.
/// 3. Updates SQLite: `academic_courses.status = 'archived'`, `academic_semesters.is_completed = 1`, `moodle_courses.status = 'archived'`.
/// 4. Relocates semester folder from `00_Current_Semester` / `{semester_dir}` to `01_Archive/{semester_dir}/`.
/// 5. Triggers `scan_and_sync_vault` to synchronize FTS5.
pub fn execute_archive_ritual(
    conn: &mut Connection,
    vault_root: &Path,
    semester_id: &str,
) -> Result<ArchiveSemesterResultDto, String> {
    if !vault_root.exists() {
        return Err(format!("Thư mục Vault không tồn tại: {}", vault_root.display()));
    }

    crate::db::academic::ensure_academic_schema(conn)
        .map_err(|e| format!("Lỗi khởi tạo academic schema: {e}"))?;
    crate::db::schema::ensure_moodle_schema(conn)
        .map_err(|e| format!("Lỗi khởi tạo moodle schema: {e}"))?;

    let clean_semester_id = semester_id.trim();
    let semester_dir_name = format_semester_dir_name(clean_semester_id);
    let today_str = Local::now().format("%Y-%m-%d").to_string();

    // 1. Fetch courses and final grades
    let mut stmt = conn
        .prepare(
            r#"
            SELECT course_code, course_name, credits,
                   summary_score_10, summary_score_4, grade_char
            FROM academic_courses
            WHERE semester_id = ?1
            ORDER BY course_code ASC
            "#,
        )
        .map_err(|e| format!("Lỗi prepare query courses: {e}"))?;

    let course_rows = stmt
        .query_map(params![clean_semester_id], |row| {
            Ok(CourseFinalGrade {
                course_code: row.get(0)?,
                course_name: row.get(1)?,
                credits: row.get(2)?,
                score_10: row.get(3)?,
                score_4: row.get(4)?,
                grade_char: row.get(5)?,
            })
        })
        .map_err(|e| format!("Lỗi truy vấn điểm môn học: {e}"))?;

    let mut courses = Vec::new();
    for r in course_rows {
        courses.push(r.map_err(|e| format!("Lỗi đọc bản ghi môn học: {e}"))?);
    }
    drop(stmt);

    // Compute semester summary GPA
    let mut total_points_10 = 0.0;
    let mut total_points_4 = 0.0;
    let mut total_credits = 0;
    for c in &courses {
        if let Some(s10) = c.score_10 {
            total_points_10 += s10 * (c.credits as f64);
            if let Some(s4) = c.score_4 {
                total_points_4 += s4 * (c.credits as f64);
            }
            total_credits += c.credits;
        }
    }
    let summary_gpa_10 = if total_credits > 0 {
        Some((total_points_10 / total_credits as f64 * 100.0).round() / 100.0)
    } else {
        None
    };
    let summary_gpa_4 = if total_credits > 0 {
        Some((total_points_4 / total_credits as f64 * 100.0).round() / 100.0)
    } else {
        None
    };

    // 2. Identify candidate source directory in vault_root
    let candidate_current = vault_root.join("00_Current_Semester");
    let candidate_named = vault_root.join(&semester_dir_name);
    let archive_parent = vault_root.join("01_Archive");
    let candidate_already_archived = archive_parent.join(&semester_dir_name);

    let (source_dir, is_already_in_archive) = if candidate_current.is_dir() {
        (candidate_current, false)
    } else if candidate_named.is_dir() {
        (candidate_named, false)
    } else if candidate_already_archived.is_dir() {
        (candidate_already_archived.clone(), true)
    } else {
        // Create directory in vault if neither exists yet
        std::fs::create_dir_all(&candidate_named).map_err(|e| {
            format!(
                "Không tìm thấy và không thể tạo thư mục học kỳ {}: {}",
                candidate_named.display(),
                e
            )
        })?;
        (candidate_named, false)
    };

    let moved_from_str = source_dir.to_string_lossy().to_string();

    // 3. Update frontmatter for each course in the source folder
    let mut updated_index_files = Vec::new();
    if source_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&source_dir) {
            for entry in entries.flatten() {
                let sub_path = entry.path();
                if sub_path.is_dir() {
                    let folder_name = sub_path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();

                    // Match folder to one of the courses
                    for course in &courses {
                        let base_code = course
                            .course_code
                            .split('.')
                            .next()
                            .unwrap_or(&course.course_code);

                        if folder_name.contains(base_code)
                            || folder_name.starts_with(&course.course_code)
                        {
                            // Find index file: 00_Index.md, 00_{base_code}_Index.md, etc.
                            let mut index_file_opt = None;
                            let possible_names = [
                                "00_Index.md".to_string(),
                                format!("00_{}_Index.md", base_code),
                                format!("{}_Index.md", base_code),
                                "Index.md".to_string(),
                            ];

                            for name in &possible_names {
                                let cand = sub_path.join(name);
                                if cand.exists() {
                                    index_file_opt = Some(cand);
                                    break;
                                }
                            }

                            // If not found, create 00_Index.md
                            let index_file = match index_file_opt {
                                Some(p) => p,
                                None => {
                                    let new_index = sub_path.join(format!("00_{}_Index.md", base_code));
                                    let _ = std::fs::write(
                                        &new_index,
                                        format!("# {}\n\n", course.course_name),
                                    );
                                    new_index
                                }
                            };

                            let s10 = course.score_10.unwrap_or(0.0);
                            let s4 = course.score_4.unwrap_or(0.0);
                            let gc = course.grade_char.as_deref().unwrap_or("P");

                            if let Ok(true) = update_course_index_frontmatter(
                                &index_file,
                                s10,
                                s4,
                                gc,
                                &today_str,
                            ) {
                                updated_index_files.push(
                                    index_file.to_string_lossy().replace('\\', "/"),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Update SQLite database statuses
    let tx = conn
        .transaction()
        .map_err(|e| format!("Lỗi khởi tạo DB transaction: {e}"))?;

    // A. academic_courses: status -> 'archived'
    tx.execute(
        r#"
        UPDATE academic_courses
        SET status = 'archived', updated_at = strftime('%s', 'now')
        WHERE semester_id = ?1
        "#,
        params![clean_semester_id],
    )
    .map_err(|e| format!("Lỗi cập nhật trạng thái academic_courses: {e}"))?;

    // B. academic_semesters: is_completed -> 1
    tx.execute(
        r#"
        UPDATE academic_semesters
        SET is_completed = 1, updated_at = strftime('%s', 'now')
        WHERE id = ?1
        "#,
        params![clean_semester_id],
    )
    .map_err(|e| format!("Lỗi cập nhật trạng thái academic_semesters: {e}"))?;

    // C. moodle_courses: status -> 'archived'
    let term_pattern = format!("%{}%", clean_semester_id);
    tx.execute(
        r#"
        UPDATE moodle_courses
        SET status = 'archived', updated_at = strftime('%s', 'now')
        WHERE term = ?1 OR term LIKE ?2
        "#,
        params![clean_semester_id, term_pattern],
    )
    .map_err(|e| format!("Lỗi cập nhật trạng thái moodle_courses: {e}"))?;

    tx.commit()
        .map_err(|e| format!("Lỗi commit DB transaction: {e}"))?;

    // 5. Relocate folder to 01_Archive/{semester_dir_name}
    if !archive_parent.exists() {
        std::fs::create_dir_all(&archive_parent)
            .map_err(|e| format!("Không thể tạo thư mục 01_Archive: {e}"))?;
    }

    let target_archive_dir = archive_parent.join(&semester_dir_name);
    let moved_to_str = target_archive_dir.to_string_lossy().to_string();

    if !is_already_in_archive && source_dir.exists() {
        if target_archive_dir.exists() {
            // Target exists: merge contents into archive
            move_dir_contents(&source_dir, &target_archive_dir)
                .map_err(|e| format!("Không thể gộp thư mục học kỳ vào archive: {e}"))?;
        } else {
            // Standard atomic directory rename
            if let Err(err) = std::fs::rename(&source_dir, &target_archive_dir) {
                // Cross-device fallback: copy & remove
                move_dir_contents(&source_dir, &target_archive_dir).map_err(|e| {
                    format!(
                        "Không thể di chuyển thư mục {} sang {}: rename err: {}, copy err: {}",
                        source_dir.display(),
                        target_archive_dir.display(),
                        err,
                        e
                    )
                })?;
            }
        }
    }

    // 6. Re-index Vault in SQLite FTS5 to update note paths & frontmatter
    if let Err(e) = scan_and_sync_vault(conn, vault_root) {
        eprintln!("[archive_ritual] Cảnh báo quét lại vault FTS5: {e}");
    }

    Ok(ArchiveSemesterResultDto {
        semester_id: clean_semester_id.to_string(),
        semester_dir_name,
        archived_courses_count: courses.len(),
        updated_index_files,
        moved_from: moved_from_str,
        moved_to: moved_to_str,
        summary_gpa_10,
        summary_gpa_4,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    pub fn test_update_course_index_frontmatter_existing() {
        let temp_dir = std::env::temp_dir().join(format!("test_archive_fm_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("00_Index.md");

        let initial_content = r#"---
course_code: "IT004"
course_name: "Cơ sở dữ liệu"
semester: "2025-2026_HK2"
tags:
  - course
---

# Cơ sở dữ liệu (IT004)

> [!info] Giảng viên: TS. Nguyễn Văn A
"#;
        std::fs::write(&file_path, initial_content).unwrap();

        let res = update_course_index_frontmatter(&file_path, 8.5, 3.7, "A", "2026-09-18");
        assert!(res.is_ok());
        assert!(res.unwrap());

        let updated = std::fs::read_to_string(&file_path).unwrap();
        assert!(updated.contains("final_score_10: 8.50"));
        assert!(updated.contains("final_score_4: 3.70"));
        assert!(updated.contains("grade_char: \"A\""));
        assert!(updated.contains("status: \"archived\""));
        assert!(updated.contains("archived_at: \"2026-09-18\""));
        assert!(updated.contains("course_code: \"IT004\""));
        assert!(updated.contains("# Cơ sở dữ liệu (IT004)"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    pub fn test_update_course_index_frontmatter_no_frontmatter() {
        let temp_dir = std::env::temp_dir().join(format!("test_archive_no_fm_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("00_Index.md");

        let initial_content = "# Hệ điều hành (IT007)\n\nNội dung ghi chú...";
        std::fs::write(&file_path, initial_content).unwrap();

        let res = update_course_index_frontmatter(&file_path, 8.0, 3.5, "B+", "2026-09-18");
        assert!(res.is_ok());

        let updated = std::fs::read_to_string(&file_path).unwrap();
        assert!(updated.starts_with("---"));
        assert!(updated.contains("final_score_10: 8.00"));
        assert!(updated.contains("status: \"archived\""));
        assert!(updated.contains("# Hệ điều hành (IT007)"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    pub fn test_archive_ritual_full_flow() {
        let temp_dir = std::env::temp_dir().join(format!("test_vault_ritual_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        let db_path = temp_dir.join("test.sqlite3");
        let mut conn = Connection::open(&db_path).unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        // 1. Seed semester & course in SQLite
        conn.execute(
            r#"
            INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
            VALUES ('2025-2026_HK2', '2025-2026', 2, 0, 100, 100)
            "#,
            [],
        ).unwrap();

        conn.execute(
            r#"
            INSERT INTO academic_courses (
                id, semester_id, course_code, course_name, credits,
                summary_score_10, summary_score_4, grade_char, status,
                is_passed, is_gpa_calculated, created_at, updated_at
            ) VALUES (
                'course-uuid-1', '2025-2026_HK2', 'IT004', 'Cơ sở dữ liệu', 4,
                8.5, 3.7, 'A', 'normal',
                1, 1, 100, 100
            )
            "#,
            [],
        ).unwrap();

        // 2. Create simulated 00_Current_Semester directory structure
        let current_sem_dir = temp_dir.join("00_Current_Semester");
        let course_dir = current_sem_dir.join("IT004_Co_so_du_lieu");
        std::fs::create_dir_all(&course_dir).unwrap();

        let index_file = course_dir.join("00_IT004_Index.md");
        std::fs::write(
            &index_file,
            "---\ncourse_code: \"IT004\"\ntags:\n  - course\n---\n# Ghi chú môn học\n",
        ).unwrap();

        // 3. Execute Archive Ritual
        let result = execute_archive_ritual(&mut conn, &temp_dir, "2025-2026_HK2").unwrap();

        assert_eq!(result.semester_id, "2025-2026_HK2");
        assert_eq!(result.archived_courses_count, 1);
        assert_eq!(result.summary_gpa_10, Some(8.5));
        assert_eq!(result.summary_gpa_4, Some(3.7));

        // 4. Verify SQLite status
        let course_status: String = conn.query_row(
            "SELECT status FROM academic_courses WHERE id = 'course-uuid-1'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(course_status, "archived");

        let sem_completed: i64 = conn.query_row(
            "SELECT is_completed FROM academic_semesters WHERE id = '2025-2026_HK2'",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(sem_completed, 1);

        // 5. Verify filesystem migration
        let archived_target = temp_dir.join("01_Archive").join("2025-2026_HK2");
        assert!(archived_target.exists(), "01_Archive/2025-2026_HK2 should exist");
        assert!(!current_sem_dir.exists(), "00_Current_Semester should have been moved");

        let moved_index = archived_target.join("IT004_Co_so_du_lieu").join("00_IT004_Index.md");
        assert!(moved_index.exists(), "Index file should exist in archive target");

        let content = std::fs::read_to_string(&moved_index).unwrap();
        assert!(content.contains("status: \"archived\""));
        assert!(content.contains("final_score_10: 8.50"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
