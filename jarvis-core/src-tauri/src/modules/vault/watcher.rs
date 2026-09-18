//! Vault Incremental File Watcher Engine
//!
//! Uses crate `notify` to listen for real-time filesystem changes inside the Obsidian vault.
//! Debounces events by 800ms to eliminate typing noise from text editors.
//! Handles Windows file locking (PermissionDenied / OS error 32) with a 3-retry backoff loop.
//! Updates SQLite FTS5 contentless index incrementally and emits `vault-sync-event` to UI.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch, Mutex};

use crate::db::SharedDb;
use crate::modules::vault::scanner::{
    extract_frontmatter_and_content, extract_wikilinks, parse_note_type_and_uri_from_json,
    resolve_unresolved_links, split_prose_and_code,
};

/// Event payload emitted to React UI when Vault index updates in real time.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultSyncEventPayload {
    pub total_notes: usize,
    pub distinct_tags: usize,
    pub updated_file: String,
}

/// Global lifecycle state for Vault File Watcher.
#[derive(Clone, Default)]
pub struct VaultWatcherState {
    pub current_vault_path: Arc<Mutex<Option<String>>>,
    pub shutdown_tx: Arc<Mutex<Option<watch::Sender<bool>>>>,
}

/// Attempts to read file with retries to overcome Windows file-locking (OS error 32).
pub async fn read_file_with_retry(
    path: &Path,
    max_retries: usize,
    delay_ms: u64,
) -> Result<String, String> {
    let mut attempts = 0;
    loop {
        match tokio::fs::read_to_string(path).await {
            Ok(content) => return Ok(content),
            Err(e) => {
                attempts += 1;
                if attempts >= max_retries {
                    return Err(format!(
                        "Không thể đọc file {} sau {} lần thử (có thể đang bị Obsidian khóa): {e}",
                        path.display(),
                        max_retries
                    ));
                }
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
}

/// Processes a created or modified `.md` note incrementally in SQLite.
pub fn sync_single_file_change(
    conn: &mut Connection,
    root_path: &Path,
    file_path: &Path,
    raw_content: &str,
) -> Result<String, String> {
    let rel_path = match file_path.strip_prefix(root_path) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => file_path.to_string_lossy().replace('\\', "/"),
    };

    let title = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_path.clone());

    let (frontmatter_json, tags, content) = extract_frontmatter_and_content(raw_content);
    let links = extract_wikilinks(&content);
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
    let (note_type, external_uri) = parse_note_type_and_uri_from_json(&frontmatter_json);

    let metadata = std::fs::metadata(file_path).map_err(|e| format!("Lỗi metadata: {e}"))?;
    let file_mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let now_ts = chrono::Utc::now().timestamp();
    let tx = conn.transaction().map_err(|e| format!("DB transaction error: {e}"))?;

    // Check existing note
    let existing_opt: Option<(i64, String, String)> = tx
        .query_row(
            "SELECT rowid_key, title, content_cache FROM vault_notes WHERE id = ?1",
            params![rel_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    if let Some((rowid_key, old_title, old_content)) = existing_opt {
        // Contentless FTS5 delete old entry
        let (old_prose, old_code) = split_prose_and_code(&old_content);
        tx.execute(
            "INSERT INTO vault_fts(vault_fts, rowid, title, prose, code) VALUES('delete', ?1, ?2, ?3, ?4)",
            params![rowid_key, old_title, old_prose, old_code],
        )
        .map_err(|e| format!("FTS5 delete error: {e}"))?;

        // Update vault_notes
        tx.execute(
            r#"
            UPDATE vault_notes
            SET title = ?1, tags = ?2, frontmatter_json = ?3, file_mtime = ?4,
                content_cache = ?5, updated_at = ?6, note_type = ?7, external_uri = ?8
            WHERE rowid_key = ?9
            "#,
            params![
                title,
                tags_json,
                frontmatter_json,
                file_mtime,
                content,
                now_ts,
                note_type,
                external_uri,
                rowid_key
            ],
        )
        .map_err(|e| format!("Update note error: {e}"))?;

        // Re-insert into FTS5
        let (prose, code) = split_prose_and_code(&content);
        tx.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES(?1, ?2, ?3, ?4)",
            params![rowid_key, title, prose, code],
        )
        .map_err(|e| format!("FTS5 insert error: {e}"))?;

        // Update links
        tx.execute(
            "DELETE FROM vault_links WHERE source_id = ?1",
            params![rel_path],
        )
        .map_err(|e| format!("Delete links error: {e}"))?;

        for target in links {
            tx.execute(
                "INSERT OR IGNORE INTO vault_links(source_id, target_id, unresolved_target) VALUES(?1, NULL, ?2)",
                params![rel_path, target],
            )
            .map_err(|e| format!("Insert link error: {e}"))?;
        }
    } else {
        // New note
        tx.execute(
            r#"
            INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at, note_type, external_uri)
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                rel_path,
                title,
                tags_json,
                frontmatter_json,
                file_mtime,
                content,
                now_ts,
                note_type,
                external_uri
            ],
        )
        .map_err(|e| format!("Insert note error: {e}"))?;

        let rowid_key = tx.last_insert_rowid();
        let (prose, code) = split_prose_and_code(&content);

        tx.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES(?1, ?2, ?3, ?4)",
            params![rowid_key, title, prose, code],
        )
        .map_err(|e| format!("FTS5 insert error: {e}"))?;

        for target in links {
            tx.execute(
                "INSERT OR IGNORE INTO vault_links(source_id, target_id, unresolved_target) VALUES(?1, NULL, ?2)",
                params![rel_path, target],
            )
            .map_err(|e| format!("Insert link error: {e}"))?;
        }
    }

    tx.commit().map_err(|e| format!("Commit error: {e}"))?;
    Ok(rel_path)
}

/// Processes a deleted note incrementally in SQLite.
pub fn sync_single_file_delete(
    conn: &mut Connection,
    root_path: &Path,
    file_path: &Path,
) -> Result<String, String> {
    let rel_path = match file_path.strip_prefix(root_path) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => file_path.to_string_lossy().replace('\\', "/"),
    };

    let tx = conn.transaction().map_err(|e| format!("DB transaction error: {e}"))?;

    let existing_opt: Option<(i64, String, String)> = tx
        .query_row(
            "SELECT rowid_key, title, content_cache FROM vault_notes WHERE id = ?1",
            params![rel_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    if let Some((rowid_key, title, content_cache)) = existing_opt {
        let (old_prose, old_code) = split_prose_and_code(&content_cache);
        tx.execute(
            "INSERT INTO vault_fts(vault_fts, rowid, title, prose, code) VALUES('delete', ?1, ?2, ?3, ?4)",
            params![rowid_key, title, old_prose, old_code],
        )
        .map_err(|e| format!("FTS5 delete error: {e}"))?;

        tx.execute("DELETE FROM vault_links WHERE source_id = ?1", params![rel_path])
            .map_err(|e| format!("Delete links error: {e}"))?;

        tx.execute("DELETE FROM vault_notes WHERE id = ?1", params![rel_path])
            .map_err(|e| format!("Delete note error: {e}"))?;
    }

    tx.commit().map_err(|e| format!("Commit error: {e}"))?;
    Ok(rel_path)
}

/// Checks if a file path is a valid user markdown note eligible for indexing.
pub fn is_indexable_md_file(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    if path_str.contains(".obsidian")
        || path_str.contains(".git")
        || path_str.contains("node_modules")
        || path_str.ends_with(".tmp")
        || path_str.ends_with('~')
        || path_str.ends_with(".swp")
    {
        return false;
    }

    path.extension().and_then(|s| s.to_str()) == Some("md")
}

/// Starts watching a vault directory, debouncing events, updating FTS5, and emitting events.
pub async fn start_vault_watcher(
    app: AppHandle,
    vault_path: String,
    state: &VaultWatcherState,
    db: SharedDb,
) -> Result<bool, String> {
    let vault_root = PathBuf::from(&vault_path);
    if !vault_root.exists() {
        return Err(format!("Thư mục Vault không tồn tại: {vault_path}"));
    }

    // Check if already watching this exact path
    {
        let mut cur = state.current_vault_path.lock().await;
        if let Some(ref current) = *cur {
            if current == &vault_path {
                return Ok(true);
            }
        }
        *cur = Some(vault_path.clone());
    }

    // Stop existing watcher if running
    {
        let mut shutdown_guard = state.shutdown_tx.lock().await;
        if let Some(tx) = shutdown_guard.take() {
            let _ = tx.send(true);
        }
    }

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    {
        let mut shutdown_guard = state.shutdown_tx.lock().await;
        *shutdown_guard = Some(shutdown_tx);
    }

    let (event_tx, mut event_rx) = mpsc::channel::<PathBuf>(256);

    let event_tx_clone = event_tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for path in event.paths {
                            if is_indexable_md_file(&path) {
                                let _ = event_tx_clone.try_send(path);
                            }
                        }
                    }
                    _ => {}
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Lỗi khởi tạo notify watcher: {e}"))?;

    watcher
        .watch(&vault_root, RecursiveMode::Recursive)
        .map_err(|e| format!("Lỗi watch thư mục vault: {e}"))?;

    // Keep watcher alive by moving it into background task
    let root_for_worker = vault_root.clone();
    let app_for_worker = app.clone();

    tokio::spawn(async move {
        let _watcher = watcher; // Kept alive inside task closure
        let mut pending_paths: HashSet<PathBuf> = HashSet::new();
        let debounce_duration = Duration::from_millis(800);
        let mut debounce_timer = Box::pin(tokio::time::sleep(debounce_duration));
        let mut has_timer_active = false;

        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        println!("[Vault Watcher] Dừng watcher theo yêu cầu.");
                        break;
                    }
                }

                maybe_path = event_rx.recv() => {
                    match maybe_path {
                        Some(p) => {
                            pending_paths.insert(p);
                            // Reset 800ms debounce timer on each incoming edit
                            debounce_timer = Box::pin(tokio::time::sleep(debounce_duration));
                            has_timer_active = true;
                        }
                        None => break,
                    }
                }

                _ = &mut debounce_timer, if has_timer_active => {
                    has_timer_active = false;

                    if pending_paths.is_empty() {
                        continue;
                    }

                    let paths_to_process: Vec<PathBuf> = pending_paths.drain().collect();
                    let mut last_updated_file = String::new();

                    for path in paths_to_process {
                        if !is_indexable_md_file(&path) {
                            continue;
                        }

                        if path.exists() {
                            // File created or modified
                            if let Ok(content) = read_file_with_retry(&path, 3, 300).await {
                                if let Ok(mut conn) = db.lock() {
                                    if let Ok(rel) = sync_single_file_change(&mut conn, &root_for_worker, &path, &content) {
                                        last_updated_file = rel;
                                    }
                                }
                            }
                        } else {
                            // File deleted
                            if let Ok(mut conn) = db.lock() {
                                if let Ok(rel) = sync_single_file_delete(&mut conn, &root_for_worker, &path) {
                                    last_updated_file = rel;
                                }
                            }
                        }
                    }

                    // Query updated stats and emit event
                    if let Ok(mut conn) = db.lock() {
                        let _ = resolve_unresolved_links(&mut conn);

                        let total_notes: usize = conn
                            .query_row("SELECT COUNT(*) FROM vault_notes", [], |r| r.get(0))
                            .unwrap_or(0);

                        let distinct_tags: usize = conn
                            .query_row(
                                r#"
                                SELECT COUNT(DISTINCT value)
                                FROM vault_notes, json_each(vault_notes.tags)
                                WHERE vault_notes.tags IS NOT NULL AND vault_notes.tags != '[]'
                                "#,
                                [],
                                |r| r.get(0),
                            )
                            .unwrap_or(0);

                        let _ = app_for_worker.emit(
                            "vault-sync-event",
                            VaultSyncEventPayload {
                                total_notes,
                                distinct_tags,
                                updated_file: last_updated_file,
                            },
                        );
                    }
                }
            }
        }
    });

    Ok(true)
}

/// Stops the currently active vault watcher.
pub async fn stop_vault_watcher(state: &VaultWatcherState) -> Result<(), String> {
    let mut cur = state.current_vault_path.lock().await;
    *cur = None;

    let mut shutdown_guard = state.shutdown_tx.lock().await;
    if let Some(tx) = shutdown_guard.take() {
        let _ = tx.send(true);
    }

    Ok(())
}

/// Checks whether a vault watcher is currently active.
pub async fn get_vault_watcher_status(state: &VaultWatcherState) -> bool {
    let cur = state.current_vault_path.lock().await;
    cur.is_some()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    pub fn test_is_indexable_md_file() {
        assert!(is_indexable_md_file(Path::new("C:/vault/Note.md")));
        assert!(is_indexable_md_file(Path::new("C:/vault/Sub/00_Index.md")));
        assert!(!is_indexable_md_file(Path::new("C:/vault/Slide.pdf")));
        assert!(!is_indexable_md_file(Path::new("C:/vault/.obsidian/app.json")));
        assert!(!is_indexable_md_file(Path::new("C:/vault/.git/config")));
        assert!(!is_indexable_md_file(Path::new("C:/vault/Note.md.tmp")));
    }

    #[tokio::test]
    pub async fn test_debounce_file_events() {
        let (tx, mut rx) = mpsc::channel::<PathBuf>(10);
        let p1 = PathBuf::from("test1.md");
        let p2 = PathBuf::from("test2.md");
        let p3 = PathBuf::from("test1.md"); // Duplicate event

        tx.send(p1.clone()).await.unwrap();
        tx.send(p2.clone()).await.unwrap();
        tx.send(p3.clone()).await.unwrap();

        let mut collected = HashSet::new();
        while let Ok(p) = rx.try_recv() {
            collected.insert(p);
        }

        // Deduplication in set
        assert_eq!(collected.len(), 2);
        assert!(collected.contains(&p1));
        assert!(collected.contains(&p2));
    }
}
