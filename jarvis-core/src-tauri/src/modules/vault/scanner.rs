//! Native Vault Scanner Engine & Incremental FTS5 Synchronization.
//!
//! Follows Karpathy simplicity principles:
//! - Direct file walking with walkdir, skipping `.git`, `.obsidian`, `node_modules`.
//! - Read-before-write FTS5 lifecycle for contentless virtual table:
//!   Delete existing rowid from FTS5 using old title & content_cache, then update table & reinsert FTS5.
//! - Extracts YAML frontmatter and [[wikilinks]].

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultNoteParsed {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub frontmatter_json: Option<String>,
    pub file_mtime: i64,
    pub content: String,
    pub links: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecentNoteDto {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatsDto {
    pub total_notes: i64,
    pub total_links: i64,
    pub total_tags: i64,
    pub recent_notes: Vec<RecentNoteDto>,
}

/// Parses YAML frontmatter (between leading `---` markers) and returns:
/// (Option<serde_json::Value frontmatter>, parsed_tags, content_body)
pub fn extract_frontmatter_and_content(raw_text: &str) -> (Option<String>, Vec<String>, String) {
    let trimmed = raw_text.trim_start();
    if !trimmed.starts_with("---") {
        return (None, Vec::new(), raw_text.to_string());
    }

    // Must find the closing --- after the opening ---
    // Look at rest of string after the first 3 characters
    let rest = &trimmed[3..];
    if let Some(end_idx) = rest.find("\n---") {
        let yaml_str = &rest[..end_idx];
        let content_start = end_idx + 4; // skip \n---
        let content_after = if content_start < rest.len() {
            rest[content_start..].trim_start_matches(|c| c == '\r' || c == '\n')
        } else {
            ""
        };

        if let Ok(yaml_val) = serde_yaml::from_str::<serde_yaml::Value>(yaml_str) {
            let mut tags: Vec<String> = Vec::new();

            // Check if tags field exists in YAML mapping
            if let Some(mapping) = yaml_val.as_mapping() {
                let tags_key = serde_yaml::Value::String("tags".to_string());
                let tag_key = serde_yaml::Value::String("tag".to_string());

                let target = mapping.get(&tags_key).or_else(|| mapping.get(&tag_key));
                if let Some(tag_node) = target {
                    match tag_node {
                        serde_yaml::Value::Sequence(seq) => {
                            for item in seq {
                                if let Some(s) = item.as_str() {
                                    tags.push(s.trim().to_string());
                                }
                            }
                        }
                        serde_yaml::Value::String(s) => {
                            for part in s.split(|c: char| c == ',' || c == ' ') {
                                let t = part.trim();
                                if !t.is_empty() {
                                    tags.push(t.to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }

            let frontmatter_json = serde_json::to_string(&yaml_val).ok();
            return (frontmatter_json, tags, content_after.to_string());
        }
    }

    (None, Vec::new(), raw_text.to_string())
}

/// Extracts wikilinks `[[target|alias]]` or `[[target]]` from text.
/// Returns a list of target note identifiers.
pub fn extract_wikilinks(content: &str) -> Vec<String> {
    // Regex matches [[target]] or [[target|alias]]
    let re = Regex::new(r"\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]");
    let mut targets = Vec::new();
    let mut seen = HashSet::new();

    if let Ok(re) = re {
        for cap in re.captures_iter(content) {
            if let Some(target) = cap.get(1) {
                let clean_target = target.as_str().trim();
                if !clean_target.is_empty() && seen.insert(clean_target.to_string()) {
                    targets.push(clean_target.to_string());
                }
            }
        }
    }

    targets
}

/// Scans a directory of Markdown files and incrementally syncs them with `vault_notes`,
/// `vault_links`, and the contentless `vault_fts` full-text index.
pub fn scan_and_sync_vault(conn: &mut Connection, root_path: &Path) -> AppResult<VaultStatsDto> {
    if !root_path.exists() {
        return Err(AppError::Vault(format!(
            "Đường dẫn vault không tồn tại: {}",
            root_path.display()
        )));
    }

    // 1. Fetch existing notes metadata from DB: id -> (rowid_key, file_mtime, title, content_cache)
    let mut existing_notes: HashMap<String, (i64, i64, String, String)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, rowid_key, file_mtime, title, content_cache FROM vault_notes",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;

        for r in rows {
            let (id, rowid_key, file_mtime, title, content_cache) = r?;
            existing_notes.insert(id, (rowid_key, file_mtime, title, content_cache));
        }
    }

    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut to_insert: Vec<VaultNoteParsed> = Vec::new();
    let mut to_update: Vec<(i64, String, String, VaultNoteParsed)> = Vec::new(); // (rowid_key, old_title, old_content, new_parsed)

    let root_canonical = root_path.canonicalize().map_err(AppError::from)?;

    // 2. Walk directory
    for entry in walkdir::WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let file_name = e.file_name().to_string_lossy();
            // Skip hidden or system directories
            !(file_name.starts_with('.')
                || file_name == "node_modules"
                || file_name == ".git"
                || file_name == ".obsidian")
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }

        // Relative path as unique ID (normalize path separators to '/')
        let rel_path = match path.strip_prefix(root_path) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => match path.canonicalize() {
                Ok(c) => match c.strip_prefix(&root_canonical) {
                    Ok(p) => p.to_string_lossy().replace('\\', "/"),
                    Err(_) => path.to_string_lossy().replace('\\', "/"),
                },
                Err(_) => path.to_string_lossy().replace('\\', "/"),
            },
        };

        seen_ids.insert(rel_path.clone());

        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let current_mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Check if note exists in DB
        if let Some(&(rowid_key, db_mtime, ref old_title, ref old_content)) =
            existing_notes.get(&rel_path)
        {
            if db_mtime >= current_mtime {
                // Unmodified, skip
                continue;
            }

            // Modified, needs update
            let raw_text = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => continue,
            };

            let (frontmatter_json, tags, content) = extract_frontmatter_and_content(&raw_text);
            let links = extract_wikilinks(&content);
            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.clone());

            to_update.push((
                rowid_key,
                old_title.clone(),
                old_content.clone(),
                VaultNoteParsed {
                    id: rel_path,
                    title,
                    tags,
                    frontmatter_json,
                    file_mtime: current_mtime,
                    content,
                    links,
                },
            ));
        } else {
            // New note, needs insert
            let raw_text = match fs::read_to_string(path) {
                Ok(t) => t,
                Err(_) => continue,
            };

            let (frontmatter_json, tags, content) = extract_frontmatter_and_content(&raw_text);
            let links = extract_wikilinks(&content);
            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.clone());

            to_insert.push(VaultNoteParsed {
                id: rel_path,
                title,
                tags,
                frontmatter_json,
                file_mtime: current_mtime,
                content,
                links,
            });
        }
    }

    // 3. Find deleted notes (exist in DB but not in seen_ids)
    let to_delete: Vec<(String, i64, String, String)> = existing_notes
        .into_iter()
        .filter(|(id, _)| !seen_ids.contains(id))
        .map(|(id, (rowid, _, title, content))| (id, rowid, title, content))
        .collect();

    // 4. Execute transactional updates
    let now_ts = chrono::Utc::now().timestamp();
    let tx = conn.transaction()?;

    // Process deletions
    for (id, rowid_key, title, content_cache) in to_delete {
        // Contentless FTS5 delete: must pass old title and content
        tx.execute(
            "INSERT INTO vault_fts(vault_fts, rowid, title, content) VALUES('delete', ?1, ?2, ?3)",
            params![rowid_key, title, content_cache],
        )?;

        tx.execute(
            "DELETE FROM vault_links WHERE source_id = ?1",
            params![id],
        )?;

        tx.execute(
            "DELETE FROM vault_notes WHERE id = ?1",
            params![id],
        )?;
    }

    // Process updates
    for (rowid_key, old_title, old_content, parsed) in to_update {
        // Delete old entry in FTS5
        tx.execute(
            "INSERT INTO vault_fts(vault_fts, rowid, title, content) VALUES('delete', ?1, ?2, ?3)",
            params![rowid_key, old_title, old_content],
        )?;

        let tags_json = serde_json::to_string(&parsed.tags).unwrap_or_else(|_| "[]".to_string());

        // Update vault_notes
        tx.execute(
            r#"
            UPDATE vault_notes
            SET title = ?1, tags = ?2, frontmatter_json = ?3, file_mtime = ?4,
                content_cache = ?5, updated_at = ?6
            WHERE rowid_key = ?7
            "#,
            params![
                parsed.title,
                tags_json,
                parsed.frontmatter_json,
                parsed.file_mtime,
                parsed.content,
                now_ts,
                rowid_key
            ],
        )?;

        // Re-insert into FTS5
        tx.execute(
            "INSERT INTO vault_fts(rowid, title, content) VALUES(?1, ?2, ?3)",
            params![rowid_key, parsed.title, parsed.content],
        )?;

        // Update links
        tx.execute(
            "DELETE FROM vault_links WHERE source_id = ?1",
            params![parsed.id],
        )?;
        for target in parsed.links {
            tx.execute(
                "INSERT OR IGNORE INTO vault_links(source_id, target_id) VALUES(?1, ?2)",
                params![parsed.id, target],
            )?;
        }
    }

    // Process inserts
    for parsed in to_insert {
        let tags_json = serde_json::to_string(&parsed.tags).unwrap_or_else(|_| "[]".to_string());

        tx.execute(
            r#"
            INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at)
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                parsed.id,
                parsed.title,
                tags_json,
                parsed.frontmatter_json,
                parsed.file_mtime,
                parsed.content,
                now_ts
            ],
        )?;

        let rowid_key = tx.last_insert_rowid();

        tx.execute(
            "INSERT INTO vault_fts(rowid, title, content) VALUES(?1, ?2, ?3)",
            params![rowid_key, parsed.title, parsed.content],
        )?;

        for target in parsed.links {
            tx.execute(
                "INSERT OR IGNORE INTO vault_links(source_id, target_id) VALUES(?1, ?2)",
                params![parsed.id, target],
            )?;
        }
    }

    tx.commit()?;

    // 5. Query and return VaultStatsDto
    query_vault_stats(conn)
}

/// Retrieves aggregated metrics for the Native Vault dashboard.
pub fn query_vault_stats(conn: &Connection) -> AppResult<VaultStatsDto> {
    let total_notes: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_notes",
        [],
        |r| r.get(0),
    )?;

    let total_links: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_links",
        [],
        |r| r.get(0),
    )?;

    // Total distinct tags extracted from notes
    let total_tags: i64 = {
        let mut stmt = conn.prepare("SELECT tags FROM vault_notes WHERE tags IS NOT NULL")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut all_tags = HashSet::new();
        for r in rows {
            if let Ok(json_str) = r {
                if let Ok(tags) = serde_json::from_str::<Vec<String>>(&json_str) {
                    for tag in tags {
                        all_tags.insert(tag);
                    }
                }
            }
        }
        all_tags.len() as i64
    };

    let mut recent_notes = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, title, updated_at FROM vault_notes ORDER BY updated_at DESC, rowid_key DESC LIMIT 10",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RecentNoteDto {
                id: r.get(0)?,
                title: r.get(1)?,
                updated_at: r.get(2)?,
            })
        })?;

        for r in rows {
            recent_notes.push(r?);
        }
    }

    Ok(VaultStatsDto {
        total_notes,
        total_links,
        total_tags,
        recent_notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::vault_schema::init_vault_tables;
    use std::fs::File;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_extract_frontmatter_and_content() {
        let raw = r#"---
title: Dynamic Programming
tags: [icpc, algorithms, dp]
status: active
---
# Dynamic Programming Intro
Some content here."#;

        let (frontmatter, tags, content) = extract_frontmatter_and_content(raw);
        assert!(frontmatter.is_some());
        assert_eq!(tags, vec!["icpc", "algorithms", "dp"]);
        assert!(content.contains("# Dynamic Programming Intro"));
    }

    #[test]
    fn test_extract_wikilinks() {
        let content = "Check out [[algorithms/graphs|Graph Theory]] and also [[dp]] and [[algorithms/graphs]].";
        let links = extract_wikilinks(content);
        assert_eq!(links.len(), 2);
        assert!(links.contains(&"algorithms/graphs".to_string()));
        assert!(links.contains(&"dp".to_string()));
    }

    #[test]
    fn test_incremental_sync_and_fts5_search() {
        let dir = tempdir().expect("tempdir");
        let vault_path = dir.path();

        // Create initial note
        let note1_path = vault_path.join("note1.md");
        let mut file1 = File::create(&note1_path).expect("create note1");
        write!(
            file1,
            "---\ntags: [icpc]\n---\n# Knapsack Problem\nWe use memoization for knapsack. See [[note2]]."
        )
        .expect("write note1");

        let mut conn = Connection::open_in_memory().expect("in-memory db");
        init_vault_tables(&conn).expect("init tables");

        // 1. Initial Scan
        let stats = scan_and_sync_vault(&mut conn, vault_path).expect("first sync");
        assert_eq!(stats.total_notes, 1);
        assert_eq!(stats.total_links, 1);
        assert_eq!(stats.total_tags, 1);

        // Verify FTS5 Search for "knapsack"
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'knapsack'",
                [],
                |r| r.get(0),
            )
            .expect("search fts5");
        assert_eq!(count, 1);

        // 2. Incremental Sync without changes -> unchanged
        let stats2 = scan_and_sync_vault(&mut conn, vault_path).expect("second sync");
        assert_eq!(stats2.total_notes, 1);

        // 3. Update note1 with different text and timestamp
        // Set timestamp slightly in the future to ensure mtime increases
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let mut file1 = File::create(&note1_path).expect("overwrite note1");
        write!(
            file1,
            "---\ntags: [icpc, graph]\n---\n# Dijkstra Algorithm\nShortest path using priority queue."
        )
        .expect("overwrite note1 content");

        let stats3 = scan_and_sync_vault(&mut conn, vault_path).expect("third sync");
        assert_eq!(stats3.total_notes, 1);
        assert_eq!(stats3.total_tags, 2);

        // FTS5 should no longer match "knapsack" but should match "Dijkstra"
        let knapsack_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'knapsack'",
                [],
                |r| r.get(0),
            )
            .expect("search knapsack");
        assert_eq!(knapsack_count, 0);

        let dijkstra_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'Dijkstra'",
                [],
                |r| r.get(0),
            )
            .expect("search dijkstra");
        assert_eq!(dijkstra_count, 1);

        // 4. Delete file -> should be purged from DB and FTS5
        fs::remove_file(&note1_path).expect("delete note1");
        let stats4 = scan_and_sync_vault(&mut conn, vault_path).expect("fourth sync");
        assert_eq!(stats4.total_notes, 0);
        assert_eq!(stats4.total_links, 0);

        let final_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'Dijkstra'",
                [],
                |r| r.get(0),
            )
            .expect("search after delete");
        assert_eq!(final_count, 0);
    }
}
