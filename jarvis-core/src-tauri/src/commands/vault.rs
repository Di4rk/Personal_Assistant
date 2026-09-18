//! Native Vault IPC Commands
//!
//! Provides Tauri IPC commands for scanning, full-text searching, quick capture of
//! structured notes, and opening OneNote URIs with security validation.

use std::path::PathBuf;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::SharedDb;
use crate::modules::vault::{
    find_course_folder, scaffold_semester_courses, scan_and_sync_vault, ScaffoldResultDto,
    VaultStatsDto,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearchResultDto {
    pub id: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStructuredNoteDto {
    pub title: String,
    #[serde(alias = "note_type")]
    pub note_type: String, // "ALGO_TRICK" | "ACADEMIC_SUMMARY" | "TEACHING_SHEET" | "ONENOTE_LINK" | "GENERAL"
    pub tags: Vec<String>,
    pub prose: String, // Insight, ghi chú chính, giải thích bài tập
    #[serde(alias = "code_snippet")]
    pub code_snippet: Option<String>,
    #[serde(alias = "external_uri")]
    pub external_uri: Option<String>,
    #[serde(alias = "vault_path")]
    pub vault_path: Option<String>,
}

const WINDOWS_RESERVED_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

pub fn slugify_title(title: &str) -> String {
    let stripped: String = title
        .chars()
        .filter(|c| !WINDOWS_RESERVED_CHARS.contains(c))
        .collect();

    let mut slug = stripped
        .trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");

    slug = slug.trim_end_matches(['.', ' ']).to_string();
    if slug.is_empty() {
        slug = "untitled".to_string();
    }

    if WINDOWS_RESERVED_NAMES.contains(&slug.to_uppercase().as_str()) {
        format!("{slug}-note")
    } else {
        slug
    }
}

/// Opens a verified OneNote URI safely through the OS shell handler.
#[tauri::command]
pub async fn open_onenote_link(uri: String) -> Result<(), String> {
    crate::modules::vault::validate_onenote_uri(&uri)?;
    open::that(&uri).map_err(|e| format!("Không thể mở OneNote URI: {}", e))?;
    Ok(())
}

/// Triggers manual recursive scan of the vault directory and incremental sync with SQLite FTS5.
#[tauri::command]
pub async fn scan_vault(
    vault_path: String,
    db: tauri::State<'_, SharedDb>,
) -> Result<VaultStatsDto, String> {
    let path = PathBuf::from(&vault_path);
    if !path.exists() {
        return Err(format!("Đường dẫn vault không tồn tại: {}", path.display()));
    }

    let db_arc = db.inner().clone();
    let vault_path_clone = vault_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;
        let _ = crate::db::settings::set_setting(&conn, "vault_path", &vault_path_clone);
        scan_and_sync_vault(&mut conn, &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker scan_vault: {e}"))?
}

/// Sets the active vault path in the settings table.
#[tauri::command]
pub fn set_vault_path(path: String, db: tauri::State<'_, SharedDb>) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Đường dẫn vault không được để trống".to_string());
    }
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::settings::set_setting(&conn, "vault_path", trimmed)
        .map_err(|e| format!("Lỗi lưu vault_path: {e}"))
}

/// Retrieves the active vault path from the settings table.
#[tauri::command]
pub fn get_vault_path(db: tauri::State<'_, SharedDb>) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
    crate::db::settings::get_setting(&conn, "vault_path")
        .map_err(|e| format!("Lỗi đọc vault_path: {e}"))
}

/// Creates a new structured note, writes markdown file to disk, and updates FTS5 immediately.
#[tauri::command]
pub async fn create_structured_note(
    dto: CreateStructuredNoteDto,
    db: tauri::State<'_, SharedDb>,
) -> Result<String, String> {
    // 1. Chỉ validate OneNote URI khi external_uri có giá trị thực
    if let Some(ref uri) = dto.external_uri {
        let trimmed = uri.trim();
        if !trimmed.is_empty() {
            crate::modules::vault::validate_onenote_uri(trimmed)?;
        }
    }

    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;

        // 2. Xác định vault_path: từ payload hoặc từ settings
        let vault_path_str = if let Some(ref p) = dto.vault_path {
            if !p.trim().is_empty() {
                let _ = crate::db::settings::set_setting(&conn, "vault_path", p.trim());
                p.trim().to_string()
            } else {
                crate::db::settings::get_setting(&conn, "vault_path")
                    .map_err(|e| format!("Lỗi đọc cài đặt vault_path: {e}"))?
                    .ok_or_else(|| {
                        "Chưa cấu hình thư mục Vault. Hãy chọn thư mục trước!".to_string()
                    })?
            }
        } else {
            crate::db::settings::get_setting(&conn, "vault_path")
                .map_err(|e| format!("Lỗi đọc cài đặt vault_path: {e}"))?
                .ok_or_else(|| {
                    "Chưa cấu hình thư mục Vault. Hãy chọn thư mục trước!".to_string()
                })?
        };

        let vault_root = PathBuf::from(&vault_path_str);
        if !vault_root.exists() {
            return Err(format!(
                "Thư mục Vault không tồn tại trên đĩa: {}",
                vault_root.display()
            ));
        }

        // 3. Chuẩn hóa thư mục & file slug
        let folder = match dto.note_type.as_str() {
            "ALGO_TRICK" => "algo",
            "ACADEMIC_SUMMARY" => "academic",
            "TEACHING_SHEET" => "teaching",
            "ONENOTE_LINK" => "onenote",
            _ => "notes",
        };

        let target_dir = vault_root.join(folder);
        std::fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Không thể tạo thư mục {}: {}", target_dir.display(), e))?;

        let base_slug = slugify_title(&dto.title);
        let mut candidate_slug = base_slug.clone();
        let mut counter = 2;
        let (relative_path, full_path) = loop {
            let rel = format!("{}/{}.md", folder, candidate_slug);
            let full = vault_root.join(&rel);
            if !full.exists() {
                break (rel, full);
            }
            candidate_slug = format!("{}-{}", base_slug, counter);
            counter += 1;
        };

        // 4. Sinh nội dung Markdown chuẩn
        let tags_yaml = serde_json::to_string(&dto.tags).unwrap_or_else(|_| "[]".to_string());
        let ext_uri = dto.external_uri.as_deref().unwrap_or("");

        let mut md_content = format!(
            "---\ntitle: \"{}\"\nnote_type: \"{}\"\ntags: {}\nexternal_uri: \"{}\"\n---\n\n# Insight\n\n{}\n",
            dto.title.replace('"', "\\\""),
            dto.note_type,
            tags_yaml,
            ext_uri,
            dto.prose.trim()
        );

        if let Some(ref code) = dto.code_snippet {
            let code_trimmed = code.trim();
            if !code_trimmed.is_empty() {
                md_content.push_str("\n# Code Snippet\n\n```\n");
                md_content.push_str(code_trimmed);
                md_content.push_str("\n```\n");
            }
        }

        // 5. Ghi file ra đĩa (không clobber file cũ)
        std::fs::write(&full_path, &md_content)
            .map_err(|e| format!("Không thể ghi file {}: {}", full_path.display(), e))?;

        let now_ts = chrono::Utc::now().timestamp();
        let frontmatter_json = serde_json::json!({
            "title": dto.title,
            "note_type": dto.note_type,
            "tags": dto.tags,
            "external_uri": ext_uri
        })
        .to_string();

        let code_for_fts = dto.code_snippet.as_deref().unwrap_or("");

        // 6. Giao dịch cập nhật vault_notes & vault_fts
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // Check if note already exists
        let existing_rowid: Option<i64> = tx
            .query_row(
                "SELECT rowid_key FROM vault_notes WHERE id = ?1",
                params![relative_path],
                |r| r.get(0),
            )
            .ok();

        let rowid_key = if let Some(old_rowid) = existing_rowid {
            // Delete old FTS5 entry
            let old_cached: String = tx
                .query_row(
                    "SELECT content_cache FROM vault_notes WHERE rowid_key = ?1",
                    params![old_rowid],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            let (old_prose, old_code) =
                crate::modules::vault::scanner::split_prose_and_code(&old_cached);
            let old_title: String = tx
                .query_row(
                    "SELECT title FROM vault_notes WHERE rowid_key = ?1",
                    params![old_rowid],
                    |r| r.get(0),
                )
                .unwrap_or_else(|_| dto.title.clone());

            let _ = tx.execute(
                "INSERT INTO vault_fts(vault_fts, rowid, title, prose, code) VALUES('delete', ?1, ?2, ?3, ?4)",
                params![old_rowid, old_title, old_prose, old_code],
            );

            tx.execute(
                r#"
                UPDATE vault_notes
                SET title = ?1, tags = ?2, frontmatter_json = ?3, file_mtime = ?4,
                    content_cache = ?5, updated_at = ?6, note_type = ?7, external_uri = ?8
                WHERE rowid_key = ?9
                "#,
                params![
                    dto.title,
                    tags_yaml,
                    frontmatter_json,
                    now_ts,
                    md_content,
                    now_ts,
                    dto.note_type,
                    ext_uri,
                    old_rowid
                ],
            )
            .map_err(|e| e.to_string())?;

            old_rowid
        } else {
            tx.execute(
                r#"
                INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at, note_type, external_uri)
                VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    relative_path,
                    dto.title,
                    tags_yaml,
                    frontmatter_json,
                    now_ts,
                    md_content,
                    now_ts,
                    dto.note_type,
                    ext_uri
                ],
            )
            .map_err(|e| e.to_string())?;
            tx.last_insert_rowid()
        };

        // Insert directly into vault_fts without YAML frontmatter
        tx.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES(?1, ?2, ?3, ?4)",
            params![rowid_key, dto.title, dto.prose, code_for_fts],
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;

        Ok(relative_path)
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker create_structured_note: {e}"))?
}

/// Fast FTS5 snippet full-text search across all notes in the vault.
/// Uses BM25 weights: 10.0 (title), 5.0 (prose), 1.0 (code).
/// Extracts snippet from column 1 (prose).
#[tauri::command]
pub async fn search_vault(
    query: String,
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<VaultSearchResultDto>, String> {
    let fts_query = match crate::modules::vault::build_safe_fts5_query(&query) {
        Some(q) => q,
        None => return Ok(Vec::new()),
    };

    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;

        let mut stmt = conn
            .prepare(
                r#"
                SELECT n.id, n.title, snippet(vault_fts, 1, '<b>', '</b>', '...', 15)
                FROM vault_fts f
                JOIN vault_notes n ON f.rowid = n.rowid_key
                WHERE vault_fts MATCH ?1
                ORDER BY bm25(vault_fts, 10.0, 5.0, 1.0)
                LIMIT 20
                "#,
            )
            .map_err(|e| format!("Lỗi prepare FTS5 query: {e}"))?;

        let rows = stmt
            .query_map(params![fts_query], |row| {
                Ok(VaultSearchResultDto {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    snippet: row.get(2)?,
                })
            })
            .map_err(|e| format!("Lỗi query FTS5: {e}"))?;

        let mut results = Vec::new();
        for r in rows {
            results.push(r.map_err(|e| format!("Lỗi đọc kết quả FTS5: {e}"))?);
        }

        Ok(results)
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker search_vault: {e}"))?
}

/// Retrieves aggregated metrics for the Native Vault dashboard.
#[tauri::command]
pub async fn get_vault_stats(
    db: tauri::State<'_, SharedDb>,
) -> Result<VaultStatsDto, String> {
    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;
        crate::modules::vault::scanner::query_vault_stats(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker get_vault_stats: {e}"))?
}

/// Scaffolds course folders and initial notes for an active semester from Moodle courses.
#[tauri::command]
pub async fn scaffold_semester_vault(
    vault_root: Option<String>,
    semester_name: Option<String>,
    db: tauri::State<'_, SharedDb>,
) -> Result<ScaffoldResultDto, String> {
    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;

        let active_path = if let Some(ref p) = vault_root {
            if !p.trim().is_empty() {
                let _ = crate::db::settings::set_setting(&conn, "vault_path", p.trim());
                p.trim().to_string()
            } else {
                crate::db::settings::get_setting(&conn, "vault_path")
                    .map_err(|e| format!("Lỗi đọc cài đặt vault_path: {e}"))?
                    .ok_or_else(|| {
                        "Chưa cấu hình thư mục Vault. Hãy chọn thư mục Vault trước!".to_string()
                    })?
            }
        } else {
            crate::db::settings::get_setting(&conn, "vault_path")
                .map_err(|e| format!("Lỗi đọc cài đặt vault_path: {e}"))?
                .ok_or_else(|| {
                    "Chưa cấu hình thư mục Vault. Hãy chọn thư mục Vault trước!".to_string()
                })?
        };

        let path = PathBuf::from(&active_path);
        if !path.exists() {
            return Err(format!(
                "Thư mục Vault không tồn tại trên đĩa: {}",
                path.display()
            ));
        }

        scaffold_semester_courses(&mut conn, &path, semester_name.as_deref())
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker scaffold_semester_vault: {e}"))?
}

/// Opens the note folder for a course in the default OS file explorer.
#[tauri::command]
pub async fn open_vault_course_folder(
    course_code: String,
    db: tauri::State<'_, SharedDb>,
) -> Result<(), String> {
    let db_arc = db.inner().clone();
    let folder_to_open = tauri::async_runtime::spawn_blocking(move || {
        let conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;

        let active_path = crate::db::settings::get_setting(&conn, "vault_path")
            .map_err(|e| format!("Lỗi đọc cài đặt vault_path: {e}"))?
            .ok_or_else(|| {
                "Chưa cấu hình thư mục Vault. Hãy chọn thư mục Vault trước!".to_string()
            })?;

        let root_path = PathBuf::from(&active_path);
        if !root_path.exists() {
            return Err(format!(
                "Thư mục Vault không tồn tại trên đĩa: {}",
                root_path.display()
            ));
        }

        let found = find_course_folder(&root_path, &course_code);
        Ok(found.unwrap_or(root_path))
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker open_vault_course_folder: {e}"))??;

    open::that(&folder_to_open)
        .map_err(|e| format!("Không thể mở thư mục {}: {}", folder_to_open.display(), e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_windows_slug_sanitization() {
        assert_eq!(slugify_title("ICPC: Cặp ghép cực đại"), "icpc-cặp-ghép-cực-đại");
        assert_eq!(slugify_title("Con"), "con-note");
        assert_eq!(slugify_title("CON"), "con-note");
        assert_eq!(slugify_title("test..."), "test");
        assert_eq!(slugify_title(""), "untitled");
        assert_eq!(slugify_title("   AUX   "), "aux-note");
        assert_eq!(slugify_title("note*with?invalid<chars>|"), "notewithinvalidchars");
    }

    #[test]
    fn test_auto_disambiguation_avoids_clobbering() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let vault_root = temp_dir.path();
        let folder = "algo";
        let target_dir = vault_root.join(folder);
        std::fs::create_dir_all(&target_dir).expect("create dir");

        let title = "Segment Tree";
        let base_slug = slugify_title(title);
        assert_eq!(base_slug, "segment-tree");

        // Simulate creating first note
        let mut candidate_slug = base_slug.clone();
        let mut counter = 2;
        let (rel1, full1) = loop {
            let rel = format!("{}/{}.md", folder, candidate_slug);
            let full = vault_root.join(&rel);
            if !full.exists() {
                break (rel, full);
            }
            candidate_slug = format!("{}-{}", base_slug, counter);
            counter += 1;
        };
        assert_eq!(rel1, "algo/segment-tree.md");
        std::fs::write(&full1, "Note 1 content").expect("write note 1");

        // Simulate creating second note with identical title
        candidate_slug = base_slug.clone();
        counter = 2;
        let (rel2, full2) = loop {
            let rel = format!("{}/{}.md", folder, candidate_slug);
            let full = vault_root.join(&rel);
            if !full.exists() {
                break (rel, full);
            }
            candidate_slug = format!("{}-{}", base_slug, counter);
            counter += 1;
        };
        assert_eq!(rel2, "algo/segment-tree-2.md");
        std::fs::write(&full2, "Note 2 content").expect("write note 2");

        // Both files must exist on disk with separate content
        assert!(full1.exists());
        assert!(full2.exists());
        assert_eq!(
            std::fs::read_to_string(&full1).expect("read full1"),
            "Note 1 content"
        );
        assert_eq!(
            std::fs::read_to_string(&full2).expect("read full2"),
            "Note 2 content"
        );
    }
}
