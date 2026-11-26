//! Native Vault IPC Commands
//!
//! Provides Tauri IPC commands for scanning, full-text searching, quick capture of
//! structured notes, and opening OneNote URIs with security validation.

use std::path::{Component, Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::db::SharedDb;
use crate::modules::vault::scanner::{
    extract_frontmatter_and_content, extract_wikilinks, parse_note_type_and_uri_from_json,
    resolve_unresolved_links, split_prose_and_code,
};
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
pub struct VaultNoteSummaryDto {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub note_type: String,
    pub updated_at: i64,
    pub external_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultBacklinkDto {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultNoteDetailDto {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub note_type: String,
    pub content: String,
    pub external_uri: String,
    pub updated_at: i64,
    pub backlinks: Vec<VaultBacklinkDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVaultNoteDto {
    pub id: Option<String>,
    pub folder: Option<String>,
    pub title: String,
    pub note_type: String,
    pub tags: Vec<String>,
    pub content: String,
    pub external_uri: Option<String>,
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
            // Delete old FTS5 entry directly by rowid
            let _ = tx.execute(
                "DELETE FROM vault_fts WHERE rowid = ?1",
                params![old_rowid],
            );

            tx.execute(
                r#"
                UPDATE vault_notes
                SET title = ?1, tags = ?2, frontmatter_json = ?3, file_mtime = ?4,
                    updated_at = ?5, note_type = ?6, external_uri = ?7
                WHERE rowid_key = ?8
                "#,
                params![
                    dto.title,
                    tags_yaml,
                    frontmatter_json,
                    now_ts,
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
                INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, updated_at, note_type, external_uri)
                VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    relative_path,
                    dto.title,
                    tags_yaml,
                    frontmatter_json,
                    now_ts,
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
                SELECT n.id, n.title, snippet(vault_fts, 1, char(1), char(2), '...', 15)
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

/// Starts real-time incremental watcher on the vault directory.
#[tauri::command]
pub async fn start_vault_watcher(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
    watcher_state: tauri::State<'_, crate::modules::vault::VaultWatcherState>,
    vault_path: String,
) -> Result<bool, String> {
    crate::modules::vault::start_vault_watcher(
        app,
        vault_path,
        &watcher_state,
        db.inner().clone(),
    )
    .await
}

/// Stops the real-time incremental watcher on the vault directory.
#[tauri::command]
pub async fn stop_vault_watcher(
    watcher_state: tauri::State<'_, crate::modules::vault::VaultWatcherState>,
) -> Result<(), String> {
    crate::modules::vault::stop_vault_watcher(&watcher_state).await
}

/// Queries whether the real-time vault watcher is currently running.
#[tauri::command]
pub async fn get_vault_watcher_status(
    watcher_state: tauri::State<'_, crate::modules::vault::VaultWatcherState>,
) -> Result<bool, String> {
    Ok(crate::modules::vault::get_vault_watcher_status(&watcher_state).await)
}

/// Executes the Archive Ritual for a semester.
///
/// Updates YAML frontmatter with official final grades, marks courses & semester as archived in SQLite,
/// moves active folder into `01_Archive/{semester_dir}/`, and re-syncs FTS5.
#[tauri::command]
pub async fn archive_semester(
    db: tauri::State<'_, SharedDb>,
    semester_id: String,
    vault_root: Option<String>,
) -> Result<crate::modules::vault::ArchiveSemesterResultDto, String> {
    let db_arc = db.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;

        let active_path = if let Some(ref p) = vault_root {
            if !p.trim().is_empty() {
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

        let root_path = PathBuf::from(&active_path);
        crate::modules::vault::execute_archive_ritual(&mut conn, &root_path, &semester_id)
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker archive_semester: {e}"))?
}

fn normalize_relative_note_id(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("Mã ghi chú không được để trống.".to_string());
    }
    let path = Path::new(&normalized);
    let mut parts = Vec::new();
    for comp in path.components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.is_empty() {
                    continue;
                }
                parts.push(s.to_string());
            }
            _ => {
                return Err(format!("Đường dẫn ghi chú không hợp lệ: {raw}"));
            }
        }
    }
    if parts.is_empty() {
        return Err(format!("Đường dẫn ghi chú không hợp lệ: {raw}"));
    }
    Ok(parts.join("/"))
}

fn normalize_folder_name(folder: Option<&str>) -> String {
    let raw = folder.unwrap_or("notes").trim().replace('\\', "/");
    let parts: Vec<String> = Path::new(&raw)
        .components()
        .filter_map(|comp| match comp {
            Component::Normal(seg) => {
                let cleaned: String = seg
                    .to_string_lossy()
                    .chars()
                    .filter(|c| !WINDOWS_RESERVED_CHARS.contains(c))
                    .collect();
                let trimmed = cleaned.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        "notes".to_string()
    } else {
        parts.join("/")
    }
}

fn folder_from_note_id(note_id: &str) -> String {
    match note_id.rsplit_once('/') {
        Some((dir, _)) if !dir.is_empty() => dir.to_string(),
        _ => "root".to_string(),
    }
}

fn stem_from_note_id(note_id: &str) -> String {
    Path::new(note_id)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| note_id.to_string())
}

fn parse_tags_json(tags_str: Option<String>) -> Vec<String> {
    match tags_str {
        Some(raw) => serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default(),
        None => Vec::new(),
    }
}

fn escape_yaml_double_quoted(val: &str) -> String {
    val.replace('\\', "\\\\").replace('"', "\\\"")
}

fn ensure_vault_path_with_default(
    conn: &mut Connection,
    default_dir: &Path,
) -> Result<PathBuf, String> {
    crate::db::vault_schema::init_vault_tables(conn).map_err(|e| e.to_string())?;

    if let Some(saved) = crate::db::settings::get_setting(conn, "vault_path")
        .map_err(|e| format!("Lỗi đọc vault_path: {e}"))?
    {
        let trimmed = saved.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if !p.exists() {
                std::fs::create_dir_all(&p)
                    .map_err(|e| format!("Không thể tạo thư mục ghi chú {}: {e}", p.display()))?;
            }
            return Ok(p);
        }
    }

    std::fs::create_dir_all(default_dir)
        .map_err(|e| format!("Không thể khởi tạo thư mục ghi chú mặc định: {e}"))?;
    let path_str = default_dir.to_string_lossy().to_string();
    crate::db::settings::set_setting(conn, "vault_path", &path_str)
        .map_err(|e| format!("Lỗi lưu vault_path mặc định: {e}"))?;
    Ok(default_dir.to_path_buf())
}

fn has_markdown_files(root: &Path) -> bool {
    walkdir::WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
        })
}

fn query_backlinks(conn: &Connection, note_id: &str, title: &str) -> Result<Vec<VaultBacklinkDto>, String> {
    let stem = stem_from_note_id(note_id);
    let mut stmt = conn
        .prepare(
            r#"
            SELECT DISTINCT vn.id, vn.title
            FROM vault_links vl
            JOIN vault_notes vn ON vn.id = vl.source_id
            WHERE vl.source_id != ?1
              AND (
                vl.target_id = ?1
                OR lower(vl.unresolved_target) = lower(?2)
                OR lower(vl.unresolved_target) = lower(?3)
              )
            ORDER BY vn.title ASC
            "#,
        )
        .map_err(|e| format!("Lỗi truy vấn backlinks: {e}"))?;

    let rows = stmt
        .query_map(params![note_id, title, stem], |row| {
            Ok(VaultBacklinkDto {
                id: row.get(0)?,
                title: row.get(1)?,
            })
        })
        .map_err(|e| format!("Lỗi đọc backlinks: {e}"))?;

    let mut backlinks = Vec::new();
    for r in rows {
        backlinks.push(r.map_err(|e| e.to_string())?);
    }
    Ok(backlinks)
}

pub(crate) fn list_vault_notes_blocking(
    conn: &mut Connection,
    default_dir: &Path,
) -> Result<Vec<VaultNoteSummaryDto>, String> {
    let vault_root = ensure_vault_path_with_default(conn, default_dir)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM vault_notes", [], |r| r.get(0))
        .unwrap_or(0);
    if count == 0 && has_markdown_files(&vault_root) {
        let _ = scan_and_sync_vault(conn, &vault_root);
    }

    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, title, tags, note_type, updated_at, external_uri
            FROM vault_notes
            ORDER BY updated_at DESC, title ASC
            "#,
        )
        .map_err(|e| format!("Lỗi đọc danh sách ghi chú: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let tags_json: Option<String> = row.get(2)?;
            let note_type: Option<String> = row.get(3)?;
            let updated_at: i64 = row.get(4)?;
            let external_uri: Option<String> = row.get(5)?;
            Ok(VaultNoteSummaryDto {
                folder: folder_from_note_id(&id),
                id,
                title,
                tags: parse_tags_json(tags_json),
                note_type: note_type.unwrap_or_else(|| "GENERAL".to_string()),
                updated_at,
                external_uri: external_uri.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("Lỗi đọc dòng ghi chú: {e}"))?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| e.to_string())?);
    }
    Ok(list)
}

pub(crate) fn read_vault_note_blocking(
    conn: &mut Connection,
    default_dir: &Path,
    note_id: &str,
) -> Result<VaultNoteDetailDto, String> {
    let vault_root = ensure_vault_path_with_default(conn, default_dir)?;
    let rel_id = normalize_relative_note_id(note_id)?;
    let full_path = vault_root.join(&rel_id);
    if !full_path.exists() {
        return Err(format!("Không tìm thấy file ghi chú: {rel_id}"));
    }

    let raw_text = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Không thể đọc file {}: {e}", full_path.display()))?;
    let (fm_json, fm_tags, body) = extract_frontmatter_and_content(&raw_text);
    let (fm_type, fm_uri) = parse_note_type_and_uri_from_json(&fm_json);
    let fm_title = fm_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(|s| s.to_string()));

    let db_meta: Option<(String, Option<String>, Option<String>, Option<String>, i64)> = conn
        .query_row(
            "SELECT title, tags, note_type, external_uri, updated_at FROM vault_notes WHERE id = ?1",
            params![rel_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| format!("Lỗi đọc metadata ghi chú: {e}"))?;

    let (title, tags, note_type, external_uri, updated_at) = match db_meta {
        Some((t, tg, nt, eu, upd)) => {
            let merged_tags = if fm_tags.is_empty() {
                parse_tags_json(tg)
            } else {
                fm_tags
            };
            (
                fm_title.unwrap_or(t),
                merged_tags,
                if fm_type != "GENERAL" {
                    fm_type
                } else {
                    nt.unwrap_or(fm_type)
                },
                if fm_uri.is_empty() {
                    eu.unwrap_or_default()
                } else {
                    fm_uri
                },
                upd,
            )
        }
        None => (
            fm_title.unwrap_or_else(|| stem_from_note_id(&rel_id)),
            fm_tags,
            fm_type,
            fm_uri,
            chrono::Utc::now().timestamp(),
        ),
    };

    let backlinks = query_backlinks(conn, &rel_id, &title)?;

    Ok(VaultNoteDetailDto {
        id: rel_id.clone(),
        title,
        folder: folder_from_note_id(&rel_id),
        tags,
        note_type,
        content: body,
        external_uri,
        updated_at,
        backlinks,
    })
}

pub(crate) fn save_vault_note_blocking(
    conn: &mut Connection,
    default_dir: &Path,
    payload: SaveVaultNoteDto,
) -> Result<VaultNoteDetailDto, String> {
    let vault_root = ensure_vault_path_with_default(conn, default_dir)?;
    let title_trimmed = payload.title.trim();
    let final_title = if title_trimmed.is_empty() {
        "Ghi chú chưa đặt tên".to_string()
    } else {
        title_trimmed.to_string()
    };

    let note_type = if payload.note_type.trim().is_empty() {
        "GENERAL".to_string()
    } else {
        payload.note_type.trim().to_string()
    };

    let clean_tags: Vec<String> = payload
        .tags
        .iter()
        .map(|t| t.trim().trim_start_matches('#').to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let ext_uri = payload.external_uri.unwrap_or_default().trim().to_string();

    let relative_path = if let Some(existing_id) = payload
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        normalize_relative_note_id(existing_id)?
    } else {
        let folder = normalize_folder_name(payload.folder.as_deref());
        let target_dir = vault_root.join(&folder);
        std::fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Không thể tạo thư mục {}: {e}", target_dir.display()))?;
        let base_slug = slugify_title(&final_title);
        let mut candidate_slug = base_slug.clone();
        let mut counter = 2;
        loop {
            let rel = format!("{folder}/{candidate_slug}.md");
            if !vault_root.join(&rel).exists() {
                break rel;
            }
            candidate_slug = format!("{base_slug}-{counter}");
            counter += 1;
        }
    };

    let full_path = vault_root.join(&relative_path);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Không thể tạo thư mục {}: {e}", parent.display()))?;
    }

    let now_ts = chrono::Utc::now().timestamp();
    let tags_json = serde_json::to_string(&clean_tags).unwrap_or_else(|_| "[]".to_string());
    let body_trimmed = payload.content.trim_start_matches('\n');
    let markdown_file = format!(
        "---\ntitle: \"{}\"\nnote_type: \"{}\"\ntags: {}\nexternal_uri: \"{}\"\nupdated_at: {}\n---\n\n{}",
        escape_yaml_double_quoted(&final_title),
        escape_yaml_double_quoted(&note_type),
        tags_json,
        escape_yaml_double_quoted(&ext_uri),
        now_ts,
        body_trimmed
    );

    std::fs::write(&full_path, &markdown_file)
        .map_err(|e| format!("Không thể ghi file {}: {e}", full_path.display()))?;

    let frontmatter_json = serde_json::json!({
        "title": final_title,
        "note_type": note_type,
        "tags": clean_tags,
        "external_uri": ext_uri,
        "updated_at": now_ts,
    })
    .to_string();

    let (prose, code) = split_prose_and_code(body_trimmed);
    let wikilinks = extract_wikilinks(body_trimmed);

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let existing_rowid: Option<i64> = tx
        .query_row(
            "SELECT rowid_key FROM vault_notes WHERE id = ?1",
            params![relative_path],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let rowid_key = if let Some(old_rowid) = existing_rowid {
        let _ = tx.execute("DELETE FROM vault_fts WHERE rowid = ?1", params![old_rowid]);
        tx.execute(
            r#"
            UPDATE vault_notes
            SET title = ?1, tags = ?2, frontmatter_json = ?3, file_mtime = ?4,
                updated_at = ?5, note_type = ?6, external_uri = ?7
            WHERE rowid_key = ?8
            "#,
            params![
                final_title,
                tags_json,
                frontmatter_json,
                now_ts,
                now_ts,
                note_type,
                ext_uri,
                old_rowid
            ],
        )
        .map_err(|e| e.to_string())?;
        old_rowid
    } else {
        tx.execute(
            r#"
            INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, updated_at, note_type, external_uri)
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                relative_path,
                final_title,
                tags_json,
                frontmatter_json,
                now_ts,
                now_ts,
                note_type,
                ext_uri
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.last_insert_rowid()
    };

    tx.execute(
        "INSERT INTO vault_fts(rowid, title, prose, code) VALUES(?1, ?2, ?3, ?4)",
        params![rowid_key, final_title, prose, code],
    )
    .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM vault_links WHERE source_id = ?1", params![relative_path])
        .map_err(|e| e.to_string())?;

    for target in wikilinks {
        let target_md = format!("{target}.md");
        let resolved_id: Option<String> = tx
            .query_row(
                r#"
                SELECT id FROM vault_notes
                WHERE lower(id) = lower(?1)
                   OR lower(id) = lower(?2)
                   OR lower(title) = lower(?1)
                   OR lower(id) LIKE '%/' || lower(?2)
                LIMIT 1
                "#,
                params![target, target_md],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT OR REPLACE INTO vault_links(source_id, target_id, unresolved_target) VALUES(?1, ?2, ?3)",
            params![relative_path, resolved_id, target],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    let _ = resolve_unresolved_links(conn);

    let backlinks = query_backlinks(conn, &relative_path, &final_title)?;

    Ok(VaultNoteDetailDto {
        id: relative_path.clone(),
        title: final_title,
        folder: folder_from_note_id(&relative_path),
        tags: clean_tags,
        note_type,
        content: body_trimmed.to_string(),
        external_uri: ext_uri,
        updated_at: now_ts,
        backlinks,
    })
}

pub(crate) fn delete_vault_note_blocking(
    conn: &mut Connection,
    default_dir: &Path,
    note_id: &str,
) -> Result<(), String> {
    let vault_root = ensure_vault_path_with_default(conn, default_dir)?;
    let rel_id = normalize_relative_note_id(note_id)?;
    let full_path = vault_root.join(&rel_id);

    if full_path.exists() {
        std::fs::remove_file(&full_path)
            .map_err(|e| format!("Không thể xóa file {}: {e}", full_path.display()))?;
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let existing_rowid: Option<i64> = tx
        .query_row(
            "SELECT rowid_key FROM vault_notes WHERE id = ?1",
            params![rel_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(old_rowid) = existing_rowid {
        let _ = tx.execute("DELETE FROM vault_fts WHERE rowid = ?1", params![old_rowid]);
    }

    tx.execute("DELETE FROM vault_links WHERE source_id = ?1", params![rel_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE vault_links SET target_id = NULL WHERE target_id = ?1",
        params![rel_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM vault_notes WHERE id = ?1", params![rel_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn default_vault_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("diark-notes"))
        .map_err(|e| format!("Không xác định được thư mục dữ liệu ứng dụng: {e}"))
}

#[tauri::command]
pub async fn ensure_default_vault_path(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<String, String> {
    let default_dir = default_vault_dir(&app)?;
    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        let path = ensure_vault_path_with_default(&mut conn, &default_dir)?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker ensure_default_vault_path: {e}"))?
}

#[tauri::command]
pub async fn list_vault_notes(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<VaultNoteSummaryDto>, String> {
    let default_dir = default_vault_dir(&app)?;
    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        list_vault_notes_blocking(&mut conn, &default_dir)
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker list_vault_notes: {e}"))?
}

#[tauri::command]
pub async fn read_vault_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
    note_id: String,
) -> Result<VaultNoteDetailDto, String> {
    let default_dir = default_vault_dir(&app)?;
    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        read_vault_note_blocking(&mut conn, &default_dir, &note_id)
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker read_vault_note: {e}"))?
}

#[tauri::command]
pub async fn save_vault_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
    payload: SaveVaultNoteDto,
) -> Result<VaultNoteDetailDto, String> {
    let default_dir = default_vault_dir(&app)?;
    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        save_vault_note_blocking(&mut conn, &default_dir, payload)
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker save_vault_note: {e}"))?
}

#[tauri::command]
pub async fn delete_vault_note(
    app: tauri::AppHandle,
    db: tauri::State<'_, SharedDb>,
    note_id: String,
) -> Result<(), String> {
    let default_dir = default_vault_dir(&app)?;
    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc.lock().map_err(|_| "DB mutex bị poisoned".to_string())?;
        delete_vault_note_blocking(&mut conn, &default_dir, &note_id)
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker delete_vault_note: {e}"))?
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

    #[test]
    fn test_vault_crud_backlinks_fts_and_delete() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let mut conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .expect("settings table");
        crate::db::vault_schema::init_vault_tables(&conn).expect("vault schema");

        let note_a = save_vault_note_blocking(
            &mut conn,
            temp_dir.path(),
            SaveVaultNoteDto {
                id: None,
                folder: Some("notes".to_string()),
                title: "Segment Tree".to_string(),
                note_type: "GENERAL".to_string(),
                tags: vec!["algo".to_string(), "ds".to_string()],
                content: "# Định nghĩa\n\nCấu trúc dữ liệu cây phân đoạn.".to_string(),
                external_uri: None,
            },
        )
        .expect("save note A");
        assert_eq!(note_a.id, "notes/segment-tree.md");

        let note_b = save_vault_note_blocking(
            &mut conn,
            temp_dir.path(),
            SaveVaultNoteDto {
                id: None,
                folder: Some("notes".to_string()),
                title: "Ôn tập CTDL".to_string(),
                note_type: "GENERAL".to_string(),
                tags: vec!["exam".to_string()],
                content: "Xem thêm [[Segment Tree]] để làm bài tập.".to_string(),
                external_uri: None,
            },
        )
        .expect("save note B");

        let read_a = read_vault_note_blocking(&mut conn, temp_dir.path(), &note_a.id)
            .expect("read note A");
        assert_eq!(read_a.backlinks.len(), 1);
        assert_eq!(read_a.backlinks[0].id, note_b.id);

        let list = list_vault_notes_blocking(&mut conn, temp_dir.path()).expect("list notes");
        assert_eq!(list.len(), 2);

        let fts_hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vault_fts WHERE vault_fts MATCH '\"phân\" \"đoạn\"*'",
                [],
                |r| r.get(0),
            )
            .expect("fts query");
        assert_eq!(fts_hits, 1);

        delete_vault_note_blocking(&mut conn, temp_dir.path(), &note_b.id).expect("delete note B");
        let after_del = list_vault_notes_blocking(&mut conn, temp_dir.path()).expect("list after del");
        assert_eq!(after_del.len(), 1);
    }
}
