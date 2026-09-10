//! Native Vault IPC Commands
//!
//! Provides Tauri IPC commands for scanning, full-text searching, and retrieving
//! metrics from the Native Vault.

use std::path::PathBuf;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::SharedDb;
use crate::modules::vault::{scan_and_sync_vault, VaultStatsDto};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearchResultDto {
    pub id: String,
    pub title: String,
    pub snippet: String,
}

/// Triggers manual recursive scan of the vault directory and incremental sync with SQLite FTS5.
#[tauri::command]
pub async fn scan_vault(
    vault_path: String,
    db: tauri::State<'_, SharedDb>,
) -> Result<VaultStatsDto, String> {
    let path = PathBuf::from(vault_path);
    if !path.exists() {
        return Err(format!("Đường dẫn vault không tồn tại: {}", path.display()));
    }

    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;
        scan_and_sync_vault(&mut conn, &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Lỗi runtime worker scan_vault: {e}"))?
}

/// Fast FTS5 snippet full-text search across all notes in the vault.
#[tauri::command]
pub async fn search_vault(
    query: String,
    db: tauri::State<'_, SharedDb>,
) -> Result<Vec<VaultSearchResultDto>, String> {
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Clean query to avoid syntax crash with raw FTS5 operators like unclosed quotes
    // Sanitize query by wrapping words or escaping quotes
    let sanitized_query = trimmed.replace('"', "\"\"");
    let fts_query = format!("\"{}\"*", sanitized_query);

    let db_arc = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db_arc
            .lock()
            .map_err(|_| "DB mutex bị poisoned".to_string())?;

        let mut stmt = conn
            .prepare(
                r#"
                SELECT n.id, n.title, snippet(vault_fts, 1, '<b>', '</b>', '...', 10)
                FROM vault_fts f
                JOIN vault_notes n ON f.rowid = n.rowid_key
                WHERE vault_fts MATCH ?1
                ORDER BY rank
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
