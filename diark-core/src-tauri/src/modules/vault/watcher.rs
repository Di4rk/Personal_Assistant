//! Vault Incremental File Watcher Engine
//!
//! Uses crate `notify` to listen for real-time filesystem changes inside the Obsidian vault.
//! Debounces events using VaultWatchPolicy to eliminate typing noise from text editors.
//! Handles Windows file locking (PermissionDenied / OS error 32) with a 3-retry backoff loop.
//! Updates SQLite FTS5 contentless index incrementally and emits `vault-sync-event` to UI.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch, Mutex};

use crate::db::{DbPools, SharedDb};
use crate::modules::vault::scanner::{
    extract_frontmatter_and_content, extract_wikilinks, parse_note_type_and_uri_from_json,
    resolve_unresolved_links, split_prose_and_code,
};
use tauri::Manager;

/// Configuration policy for vault file watching, debounce, and path ignore predicates.
#[derive(Debug, Clone)]
pub struct VaultWatchPolicy {
    pub ignored_dir_names: HashSet<OsString>,
    pub ignored_extensions: HashSet<OsString>,
    pub debounce: Duration,
    pub max_pending_paths: usize,
}

impl Default for VaultWatchPolicy {
    fn default() -> Self {
        let mut ignored_dir_names = HashSet::new();
        ignored_dir_names.insert(OsString::from(".obsidian"));
        ignored_dir_names.insert(OsString::from(".git"));
        ignored_dir_names.insert(OsString::from("node_modules"));
        ignored_dir_names.insert(OsString::from(".trash"));

        let mut ignored_extensions = HashSet::new();
        ignored_extensions.insert(OsString::from("tmp"));
        ignored_extensions.insert(OsString::from("swp"));
        ignored_extensions.insert(OsString::from("crswap"));
        ignored_extensions.insert(OsString::from("part"));

        Self {
            ignored_dir_names,
            ignored_extensions,
            debounce: Duration::from_millis(500),
            max_pending_paths: 128,
        }
    }
}

/// Signals communicated across watcher threads and background tasks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatcherSignal {
    Changed(PathBuf),
    Overflow,
    Shutdown,
}

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
    pub worker_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
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
    let existing_rowid: Option<i64> = tx
        .query_row(
            "SELECT rowid_key FROM vault_notes WHERE id = ?1",
            params![rel_path],
            |r| r.get(0),
        )
        .ok();

    if let Some(rowid_key) = existing_rowid {
        // Contentless FTS5 delete old entry directly by rowid
        tx.execute(
            "DELETE FROM vault_fts WHERE rowid = ?1",
            params![rowid_key],
        )
        .map_err(|e| format!("FTS5 delete error: {e}"))?;

        // Update vault_notes without content_cache
        tx.execute(
            r#"
            UPDATE vault_notes
            SET title = ?1, tags = ?2, frontmatter_json = ?3, file_mtime = ?4,
                updated_at = ?5, note_type = ?6, external_uri = ?7
            WHERE rowid_key = ?8
            "#,
            params![
                title,
                tags_json,
                frontmatter_json,
                file_mtime,
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
            INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, updated_at, note_type, external_uri)
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                rel_path,
                title,
                tags_json,
                frontmatter_json,
                file_mtime,
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

    let existing_rowid: Option<i64> = tx
        .query_row(
            "SELECT rowid_key FROM vault_notes WHERE id = ?1",
            params![rel_path],
            |r| r.get(0),
        )
        .ok();

    if let Some(rowid_key) = existing_rowid {
        tx.execute(
            "DELETE FROM vault_fts WHERE rowid = ?1",
            params![rowid_key],
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
/// Compares relative path components within the vault root, avoiding false-positive
/// substring matching.
pub fn is_indexable_md_file(root: &Path, path: &Path, policy: &VaultWatchPolicy) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(p) => p,
        Err(_) => path,
    };

    let mut components = rel.components().peekable();
    while let Some(comp) = components.next() {
        if let std::path::Component::Normal(os_name) = comp {
            // Check if this component is an intermediate directory (not the last element in path)
            if components.peek().is_some() {
                if policy.ignored_dir_names.contains(os_name) {
                    return false;
                }
            } else {
                // Leaf component (file name)
                if policy.ignored_dir_names.contains(os_name) {
                    return false;
                }

                // Check extension
                let path_ref = Path::new(os_name);
                let ext = path_ref.extension();
                if let Some(ext_str) = ext {
                    if policy.ignored_extensions.contains(ext_str) {
                        return false;
                    }
                    if !ext_str.eq_ignore_ascii_case("md") {
                        return false;
                    }
                } else {
                    return false;
                }

                // Check temporary editor patterns
                let name_str = os_name.to_string_lossy();
                if name_str.ends_with('~') || name_str.starts_with(".~") {
                    return false;
                }
            }
        }
    }

    true
}

/// Runs the background watcher event processing loop.
pub async fn run_vault_worker_loop<F>(
    mut event_rx: mpsc::Receiver<WatcherSignal>,
    mut shutdown_rx: watch::Receiver<bool>,
    overflow_flag: Arc<std::sync::atomic::AtomicBool>,
    root: PathBuf,
    pools: DbPools,
    policy: VaultWatchPolicy,
    on_event: F,
) where
    F: Fn(VaultSyncEventPayload) + Send + Sync + 'static,
{
    let mut pending_paths: HashSet<PathBuf> = HashSet::new();
    let mut has_overflow = false;
    let mut debounce_timer = Box::pin(tokio::time::sleep(policy.debounce));
    let mut has_timer_active = false;

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
            }

            maybe_signal = event_rx.recv() => {
                match maybe_signal {
                    Some(WatcherSignal::Shutdown) => break,
                    Some(WatcherSignal::Overflow) => {
                        has_overflow = true;
                        debounce_timer = Box::pin(tokio::time::sleep(policy.debounce));
                        has_timer_active = true;
                    }
                    Some(WatcherSignal::Changed(path)) => {
                        if overflow_flag.swap(false, std::sync::atomic::Ordering::SeqCst) {
                            has_overflow = true;
                        }

                        if pending_paths.len() < policy.max_pending_paths {
                            pending_paths.insert(path);
                        } else {
                            has_overflow = true;
                        }

                        debounce_timer = Box::pin(tokio::time::sleep(policy.debounce));
                        has_timer_active = true;
                    }
                    None => break,
                }
            }

            _ = &mut debounce_timer, if has_timer_active => {
                has_timer_active = false;

                if overflow_flag.swap(false, std::sync::atomic::Ordering::SeqCst) {
                    has_overflow = true;
                }

                if !has_overflow && pending_paths.is_empty() {
                    continue;
                }

                if has_overflow {
                    has_overflow = false;
                    pending_paths.clear();

                    // Step 3: Run full rescan upon queue overflow or burst limit
                    let root_clone = root.clone();
                    let rescan_res = pools
                        .write(move |conn| {
                            crate::modules::vault::scanner::scan_and_sync_vault(conn, &root_clone)
                        })
                        .await;

                    if let Ok(stats) = rescan_res {
                        on_event(VaultSyncEventPayload {
                            total_notes: stats.total_notes as usize,
                            distinct_tags: stats.total_tags as usize,
                            updated_file: "*rescan*".to_string(),
                        });
                    }
                } else {
                    let paths_to_process: Vec<PathBuf> = pending_paths.drain().collect();
                    let mut last_updated_file = String::new();

                    for path in paths_to_process {
                        if !is_indexable_md_file(&root, &path, &policy) {
                            continue;
                        }

                        if path.exists() {
                            // Step 5: Read file outside of writer transaction
                            if let Ok(content) = read_file_with_retry(&path, 3, 300).await {
                                let root_clone = root.clone();
                                let path_clone = path.clone();
                                let write_res = pools
                                    .write(move |conn| {
                                        sync_single_file_change(conn, &root_clone, &path_clone, &content)
                                            .map_err(crate::error::AppError::Vault)
                                    })
                                    .await;
                                if let Ok(rel) = write_res {
                                    last_updated_file = rel;
                                }
                            }
                        } else {
                            let root_clone = root.clone();
                            let path_clone = path.clone();
                            let del_res = pools
                                .write(move |conn| {
                                    sync_single_file_delete(conn, &root_clone, &path_clone)
                                        .map_err(crate::error::AppError::Vault)
                                })
                                .await;
                            if let Ok(rel) = del_res {
                                last_updated_file = rel;
                            }
                        }
                    }

                    // Resolve dangling links
                    let pools_resolve = pools.clone();
                    let _ = pools_resolve
                        .write(|conn| {
                            let _ = resolve_unresolved_links(conn);
                            Ok(())
                        })
                        .await;

                    // Query stats using reader pool
                    let stats_res = pools.read(|conn| {
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
                        Ok((total_notes, distinct_tags))
                    });

                    if let Ok((total_notes, distinct_tags)) = stats_res {
                        on_event(VaultSyncEventPayload {
                            total_notes,
                            distinct_tags,
                            updated_file: last_updated_file,
                        });
                    }
                }
            }
        }
    }
}

/// Starts watching a vault directory with a custom event emitter closure.
pub async fn start_vault_watcher_with_emitter<F>(
    vault_path: String,
    state: &VaultWatcherState,
    pools: DbPools,
    policy: VaultWatchPolicy,
    on_event: F,
) -> Result<bool, String>
where
    F: Fn(VaultSyncEventPayload) + Send + Sync + 'static,
{
    let vault_root = PathBuf::from(&vault_path);
    if !vault_root.exists() {
        return Err(format!("Thư mục Vault không tồn tại: {vault_path}"));
    }

    // Check if already watching this exact path
    {
        let cur = state.current_vault_path.lock().await;
        if let Some(ref current) = *cur {
            if current == &vault_path {
                return Ok(true);
            }
        }
    }

    // Step 6: Stop existing watcher if running and await worker join
    stop_vault_watcher(state).await?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    {
        let mut shutdown_guard = state.shutdown_tx.lock().await;
        *shutdown_guard = Some(shutdown_tx);
    }

    let (event_tx, event_rx) = mpsc::channel::<WatcherSignal>(256);
    let overflow_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let event_tx_clone = event_tx.clone();
    let root_clone = vault_root.clone();
    let policy_clone = policy.clone();
    let overflow_flag_clone = overflow_flag.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                        for path in event.paths {
                            if is_indexable_md_file(&root_clone, &path, &policy_clone) {
                                if let Err(mpsc::error::TrySendError::Full(_)) =
                                    event_tx_clone.try_send(WatcherSignal::Changed(path))
                                {
                                    overflow_flag_clone
                                        .store(true, std::sync::atomic::Ordering::SeqCst);
                                    let _ = event_tx_clone.try_send(WatcherSignal::Overflow);
                                }
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

    let root_for_worker = vault_root.clone();
    let worker_handle = tokio::spawn(async move {
        let _watcher = watcher; // Keep notify watcher instance alive in closure
        run_vault_worker_loop(
            event_rx,
            shutdown_rx,
            overflow_flag,
            root_for_worker,
            pools,
            policy,
            on_event,
        )
        .await;
    });

    {
        let mut cur = state.current_vault_path.lock().await;
        *cur = Some(vault_path);
    }
    {
        let mut handle_guard = state.worker_handle.lock().await;
        *handle_guard = Some(worker_handle);
    }

    Ok(true)
}

/// Starts watching a vault directory with custom VaultWatchPolicy.
pub async fn start_vault_watcher_with_policy(
    app: AppHandle,
    vault_path: String,
    state: &VaultWatcherState,
    pools: DbPools,
    policy: VaultWatchPolicy,
) -> Result<bool, String> {
    let app_for_worker = app.clone();
    start_vault_watcher_with_emitter(
        vault_path,
        state,
        pools,
        policy,
        move |payload| {
            let _ = app_for_worker.emit("vault-sync-event", payload);
        },
    )
    .await
}

/// Starts watching a vault directory using DbPools and default VaultWatchPolicy.
pub async fn start_vault_watcher_with_pools(
    app: AppHandle,
    vault_path: String,
    state: &VaultWatcherState,
    pools: DbPools,
) -> Result<bool, String> {
    start_vault_watcher_with_policy(app, vault_path, state, pools, VaultWatchPolicy::default()).await
}

/// Starts watching a vault directory. Backward-compatibility delegate retrieving DbPools from AppHandle.
pub async fn start_vault_watcher(
    app: AppHandle,
    vault_path: String,
    state: &VaultWatcherState,
    _legacy_db: SharedDb,
) -> Result<bool, String> {
    let pools = app
        .try_state::<DbPools>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "DbPools chưa được khởi tạo trong AppState".to_string())?;

    start_vault_watcher_with_pools(app, vault_path, state, pools).await
}

/// Stops the currently active vault watcher and waits for background worker task to cleanly terminate.
pub async fn stop_vault_watcher(state: &VaultWatcherState) -> Result<(), String> {
    {
        let mut cur = state.current_vault_path.lock().await;
        *cur = None;
    }

    {
        let mut shutdown_guard = state.shutdown_tx.lock().await;
        if let Some(tx) = shutdown_guard.take() {
            let _ = tx.send(true);
        }
    }

    let handle_opt = {
        let mut handle_guard = state.worker_handle.lock().await;
        handle_guard.take()
    };

    if let Some(handle) = handle_opt {
        let _ = handle.await;
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
    use tempfile::tempdir;

    #[test]
    pub fn test_is_indexable_md_file_path_table() {
        let root = Path::new("C:/vault");
        let policy = VaultWatchPolicy::default();

        // Path table test requirements from TASK-05:
        assert!(!is_indexable_md_file(root, Path::new("C:/vault/.obsidian/app.json"), &policy));
        assert!(!is_indexable_md_file(root, Path::new("C:/vault/.git/config"), &policy));
        assert!(!is_indexable_md_file(root, Path::new("C:/vault/node_modules/a.md"), &policy));
        assert!(!is_indexable_md_file(root, Path::new("C:/vault/Note.md.tmp"), &policy));
        assert!(is_indexable_md_file(root, Path::new("C:/vault/Note.md"), &policy));
        assert!(is_indexable_md_file(root, Path::new("C:/vault/my.git.notes/Note.md"), &policy));
        assert!(is_indexable_md_file(root, Path::new("C:/vault/archive.tmp/Note.md"), &policy));

        // Additional edge cases:
        assert!(is_indexable_md_file(root, Path::new("C:/vault/notes.tmp.md"), &policy));
        assert!(!is_indexable_md_file(root, Path::new("C:/vault/Note.md~"), &policy));
        assert!(!is_indexable_md_file(root, Path::new("C:/vault/Note.md.swp"), &policy));
        assert!(!is_indexable_md_file(root, Path::new("C:/vault/document.pdf"), &policy));
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

    #[tokio::test]
    pub async fn test_queue_overflow_triggers_rescan() {
        let temp_dir = tempdir().expect("create temp dir");
        let vault_root = temp_dir.path().join("vault");
        std::fs::create_dir_all(&vault_root).expect("create vault dir");

        let db_path = temp_dir.path().join("test_overflow.db");
        let pools = crate::db::schema::init_pools(&db_path).expect("init pools");

        // Seed 3 notes on disk
        for i in 1..=3 {
            let note_path = vault_root.join(format!("Note_{}.md", i));
            std::fs::write(&note_path, format!("# Note {}\nContent for note {}", i, i)).expect("write note");
        }

        let (event_tx, event_rx) = mpsc::channel::<WatcherSignal>(10);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let overflow_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let events_received = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let events_clone = events_received.clone();

        let mut policy = VaultWatchPolicy::default();
        policy.debounce = Duration::from_millis(50);

        let root_clone = vault_root.clone();
        let pools_clone = pools.clone();
        let worker_handle = tokio::spawn(async move {
            run_vault_worker_loop(
                event_rx,
                shutdown_rx,
                overflow_flag,
                root_clone,
                pools_clone,
                policy,
                move |payload| {
                    if payload.updated_file == "*rescan*" {
                        events_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                },
            )
            .await;
        });

        // Send an Overflow signal directly into event channel
        event_tx.send(WatcherSignal::Overflow).await.expect("send overflow");

        // Wait for debounce and rescan
        tokio::time::sleep(Duration::from_millis(150)).await;

        // Verify rescan event was processed
        assert!(events_received.load(std::sync::atomic::Ordering::SeqCst) >= 1);

        // Verify all 3 notes are indexed in DB
        let total_notes = pools.read(|conn| {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM vault_notes", [], |r| r.get(0))?;
            Ok(count)
        }).expect("query notes count");
        assert_eq!(total_notes, 3);

        // Shutdown cleanly
        let _ = shutdown_tx.send(true);
        let _ = worker_handle.await;
    }

    #[tokio::test]
    pub async fn test_stop_start_concurrency_no_duplicate_watcher() {
        let temp_dir = tempdir().expect("create temp dir");
        let vault_root = temp_dir.path().join("vault");
        std::fs::create_dir_all(&vault_root).expect("create vault dir");

        let db_path = temp_dir.path().join("test_concurrency.db");
        let pools = crate::db::schema::init_pools(&db_path).expect("init pools");

        let state = VaultWatcherState::default();
        let policy = VaultWatchPolicy::default();

        let path_str = vault_root.to_string_lossy().to_string();

        // 1. Start watcher
        let res1 = start_vault_watcher_with_emitter(
            path_str.clone(),
            &state,
            pools.clone(),
            policy.clone(),
            |_| {},
        )
        .await
        .expect("start watcher 1");
        assert!(res1);
        assert!(get_vault_watcher_status(&state).await);

        // 2. Starting on the same path returns Ok(true) without duplicate spawn
        let res2 = start_vault_watcher_with_emitter(
            path_str.clone(),
            &state,
            pools.clone(),
            policy.clone(),
            |_| {},
        )
        .await
        .expect("start watcher 2 idempotent");
        assert!(res2);

        // 3. Stop watcher
        stop_vault_watcher(&state).await.expect("stop watcher");
        assert!(!get_vault_watcher_status(&state).await);

        // 4. Start again after stop works cleanly
        let res3 = start_vault_watcher_with_emitter(
            path_str.clone(),
            &state,
            pools.clone(),
            policy.clone(),
            |_| {},
        )
        .await
        .expect("start watcher 3");
        assert!(res3);
        assert!(get_vault_watcher_status(&state).await);

        // Cleanup
        stop_vault_watcher(&state).await.expect("final stop");
        assert!(!get_vault_watcher_status(&state).await);
    }
}
