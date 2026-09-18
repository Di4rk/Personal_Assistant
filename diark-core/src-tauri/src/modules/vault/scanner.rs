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
    pub note_type: String,
    pub external_uri: String,
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

/// Separates markdown body into prose and code snippets.
/// Code fence blocks (```...```) are collected into code, the rest into prose.
pub fn split_prose_and_code(body: &str) -> (String, String) {
    let mut prose_lines = Vec::new();
    let mut code_lines = Vec::new();
    let mut in_code_block = false;

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }

        if in_code_block {
            code_lines.push(line);
        } else {
            prose_lines.push(line);
        }
    }

    (prose_lines.join("\n"), code_lines.join("\n"))
}

/// Parses note_type and external_uri from the serialized frontmatter JSON if available.
pub fn parse_note_type_and_uri_from_json(json_opt: &Option<String>) -> (String, String) {
    if let Some(json_str) = json_opt {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
            let note_type = val
                .get("note_type")
                .or_else(|| val.get("noteType"))
                .or_else(|| val.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("GENERAL")
                .to_string();
            let external_uri = val
                .get("external_uri")
                .or_else(|| val.get("externalUri"))
                .or_else(|| val.get("uri"))
                .or_else(|| val.get("onenote_uri"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            return (note_type, external_uri);
        }
    }
    ("GENERAL".to_string(), "".to_string())
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

/// Builds a safe FTS5 query string from user input to prevent syntax errors on raw operators.
///
/// Safety guarantees:
/// - Strips any `*` the user typed inside a token (prevents `foo*"*` syntax errors).
/// - Escapes inner `"` as `""` (FTS5 double-quote escaping).
/// - Discards tokens that are empty after cleaning (e.g. a lone `*` or `***`).
/// - Wraps each surviving token in double quotes.
/// - Joins tokens with ` AND `.
/// - Appends `*` **outside** the closing quote of the last token for live prefix search.
pub fn build_safe_fts5_query(user_input: &str) -> Option<String> {
    let tokens: Vec<String> = user_input
        .split_whitespace()
        .filter_map(|t| {
            // Strip user-supplied wildcards first, then escape inner quotes
            let cleaned = t.replace('*', "").replace('"', "\"\"");
            if cleaned.trim().is_empty() {
                None
            } else {
                Some(format!("\"{}\"", cleaned))
            }
        })
        .collect();

    if tokens.is_empty() {
        return None;
    }

    let mut query = String::new();
    let total = tokens.len();

    for (idx, token) in tokens.iter().enumerate() {
        if idx > 0 {
            query.push_str(" AND ");
        }
        query.push_str(token);
        // Wildcard appended outside the closing quote of the last token for live-search prefix
        if idx == total - 1 {
            query.push('*');
        }
    }

    Some(query)
}

/// Resolves dangling links (where target_id IS NULL) against existing vault notes.
/// Only queries rows with target_id IS NULL; avoids re-scanning files from disk.
/// If exactly 1 note matches unresolved_target (by id, title, or relative path with/without .md),
/// updates target_id. If ambiguous (>1 match), leaves target_id as NULL.
pub fn resolve_unresolved_links(conn: &mut Connection) -> AppResult<usize> {
    // 1. Query distinct unresolved targets
    let mut dangling_targets: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT unresolved_target FROM vault_links WHERE target_id IS NULL AND unresolved_target != ''",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            dangling_targets.push(r?);
        }
    }

    if dangling_targets.is_empty() {
        return Ok(0);
    }

    // 2. Query all notes id & title to build lookup indices
    // note_id (e.g. 'cs/dp.md'), note_title (e.g. 'dp')
    let mut id_set: HashSet<String> = HashSet::new();
    let mut title_to_ids: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, title FROM vault_notes")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for r in rows {
            let (id, title) = r?;
            id_set.insert(id.clone());
            title_to_ids.entry(title.to_lowercase()).or_default().push(id.clone());
        }
    }

    let mut resolved_count = 0;
    let tx = conn.transaction()?;

    for target in dangling_targets {
        let clean_target = target.trim();
        let target_lower = clean_target.to_lowercase();
        let with_md = if target_lower.ends_with(".md") {
            target_lower.clone()
        } else {
            format!("{}.md", target_lower)
        };

        // Attempt match:
        // Case A: exact match against note id (or note id with .md)
        let mut matching_ids: Vec<String> = Vec::new();

        for id in &id_set {
            let id_lower = id.to_lowercase();
            if id_lower == target_lower || id_lower == with_md {
                matching_ids.push(id.clone());
            }
        }

        // Case B: If not matched by ID, try matching note title (basename)
        if matching_ids.is_empty() {
            let stripped_title = if target_lower.ends_with(".md") {
                &target_lower[..target_lower.len() - 3]
            } else {
                &target_lower
            };

            if let Some(ids) = title_to_ids.get(stripped_title) {
                matching_ids = ids.clone();
            }
        }

        // Exact 1 match -> resolve link!
        // If > 1 match, ambiguity guard keeps target_id as NULL
        if matching_ids.len() == 1 {
            let resolved_id = &matching_ids[0];
            let rows_affected = tx.execute(
                "UPDATE vault_links SET target_id = ?1 WHERE unresolved_target = ?2 AND target_id IS NULL",
                params![resolved_id, target],
            )?;
            resolved_count += rows_affected;
        }
    }

    tx.commit()?;
    Ok(resolved_count)
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
        // Contentless FTS5 delete: must pass old title, prose, and code
        let (old_prose, old_code) = split_prose_and_code(&content_cache);
        tx.execute(
            "INSERT INTO vault_fts(vault_fts, rowid, title, prose, code) VALUES('delete', ?1, ?2, ?3, ?4)",
            params![rowid_key, title, old_prose, old_code],
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
        let (old_prose, old_code) = split_prose_and_code(&old_content);
        tx.execute(
            "INSERT INTO vault_fts(vault_fts, rowid, title, prose, code) VALUES('delete', ?1, ?2, ?3, ?4)",
            params![rowid_key, old_title, old_prose, old_code],
        )?;

        let tags_json = serde_json::to_string(&parsed.tags).unwrap_or_else(|_| "[]".to_string());
        let (note_type, external_uri) = parse_note_type_and_uri_from_json(&parsed.frontmatter_json);

        // Update vault_notes
        tx.execute(
            r#"
            UPDATE vault_notes
            SET title = ?1, tags = ?2, frontmatter_json = ?3, file_mtime = ?4,
                content_cache = ?5, updated_at = ?6, note_type = ?7, external_uri = ?8
            WHERE rowid_key = ?9
            "#,
            params![
                parsed.title,
                tags_json,
                parsed.frontmatter_json,
                parsed.file_mtime,
                parsed.content,
                now_ts,
                note_type,
                external_uri,
                rowid_key
            ],
        )?;

        // Re-insert into FTS5
        let (prose, code) = split_prose_and_code(&parsed.content);
        tx.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES(?1, ?2, ?3, ?4)",
            params![rowid_key, parsed.title, prose, code],
        )?;

        // Update links
        tx.execute(
            "DELETE FROM vault_links WHERE source_id = ?1",
            params![parsed.id],
        )?;
        for target in parsed.links {
            tx.execute(
                "INSERT OR IGNORE INTO vault_links(source_id, target_id, unresolved_target) VALUES(?1, NULL, ?2)",
                params![parsed.id, target],
            )?;
        }
    }

    // Process inserts
    for parsed in to_insert {
        let tags_json = serde_json::to_string(&parsed.tags).unwrap_or_else(|_| "[]".to_string());
        let (note_type, external_uri) = parse_note_type_and_uri_from_json(&parsed.frontmatter_json);

        tx.execute(
            r#"
            INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at, note_type, external_uri)
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                parsed.id,
                parsed.title,
                tags_json,
                parsed.frontmatter_json,
                parsed.file_mtime,
                parsed.content,
                now_ts,
                note_type,
                external_uri
            ],
        )?;

        let rowid_key = tx.last_insert_rowid();
        let (prose, code) = split_prose_and_code(&parsed.content);

        tx.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES(?1, ?2, ?3, ?4)",
            params![rowid_key, parsed.title, prose, code],
        )?;

        for target in parsed.links {
            tx.execute(
                "INSERT OR IGNORE INTO vault_links(source_id, target_id, unresolved_target) VALUES(?1, NULL, ?2)",
                params![parsed.id, target],
            )?;
        }
    }

    tx.commit()?;

    // 5. Re-resolve dangling links across the vault
    let _ = resolve_unresolved_links(conn)?;

    // 6. Query and return VaultStatsDto
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
            "SELECT id, title, updated_at, COALESCE(note_type, 'GENERAL'), COALESCE(external_uri, '') 
             FROM vault_notes ORDER BY updated_at DESC, rowid_key DESC LIMIT 10",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RecentNoteDto {
                id: r.get(0)?,
                title: r.get(1)?,
                updated_at: r.get(2)?,
                note_type: r.get(3)?,
                external_uri: r.get(4)?,
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

    #[test]
    fn test_fts5_syntax_safety() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        init_vault_tables(&conn).expect("init tables");

        // Insert a dummy note into vault_notes and vault_fts to query against
        conn.execute(
            r#"
            INSERT INTO vault_notes(id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at)
            VALUES('test.md', 'Test', '[]', NULL, 100, 'segment tree algorithm details', 100)
            "#,
            [],
        )
        .expect("insert dummy note");
        conn.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES(1, 'Test', 'segment tree algorithm details', '')",
            [],
        )
        .expect("insert dummy fts");

        // Malicious or broken user input with operators and unclosed quotes
        let malicious_input = "segment tree ( AND NOT ";
        let safe_query = build_safe_fts5_query(malicious_input);
        assert!(safe_query.is_some());
        let query_str = safe_query.expect("safe query exists");

        // Assert query format matches directive
        assert_eq!(
            query_str,
            "\"segment\" AND \"tree\" AND \"(\" AND \"AND\" AND \"NOT\"*"
        );

        // Execute against SQLite Rusqlite FTS5 without error
        let mut stmt = conn
            .prepare("SELECT rowid FROM vault_fts WHERE vault_fts MATCH ?1")
            .expect("prepare fts query");
        let result = stmt.query_map(params![query_str], |r| r.get::<_, i64>(0));
        assert!(result.is_ok(), "Safe FTS5 query must not fail");
    }

    #[test]
    fn test_fts5_wildcard_in_token_is_stripped() {
        // Input: "foo*" -> stripped to "foo" -> safe query: "\"foo\"*"
        let result = build_safe_fts5_query("foo*");
        assert_eq!(result, Some("\"foo\"*".to_string()));

        // Input: "foo*" must NOT produce "foo*"* (double wildcard)
        let q = result.unwrap();
        assert!(!q.contains("*\""), "wildcard must be outside closing quote");
    }

    #[test]
    fn test_fts5_pure_wildcard_returns_none() {
        // A lone '*' cleans to empty string -> None
        assert_eq!(build_safe_fts5_query("*"), None);
        // Multiple wildcards also clean to empty
        assert_eq!(build_safe_fts5_query("***"), None);
        // Mixed whitespace and wildcards
        assert_eq!(build_safe_fts5_query("  *  ***  "), None);
    }

    #[test]
    fn test_duplicate_wikilink_in_same_note_no_unique_constraint_error() {
        let dir = tempdir().expect("tempdir");
        let vault_path = dir.path();

        // A note that references [[NonExistent]] twice
        let note_path = vault_path.join("duplicate_links.md");
        let mut file = File::create(&note_path).expect("create note");
        write!(
            file,
            "# Duplicate Link Note\nSee [[NonExistent]] and again [[NonExistent]]."
        )
        .expect("write note");

        let mut conn = Connection::open_in_memory().expect("in-memory db");
        init_vault_tables(&conn).expect("init tables");

        // Must not panic or return error due to UNIQUE constraint
        let stats = scan_and_sync_vault(&mut conn, vault_path)
            .expect("scan with duplicate wikilinks must not fail");
        assert_eq!(stats.total_notes, 1);

        // INSERT OR IGNORE: exactly 1 row for the (source_id, unresolved_target) pair
        let link_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vault_links WHERE source_id = 'duplicate_links.md' AND unresolved_target = 'NonExistent'",
                [],
                |r| r.get(0),
            )
            .expect("query vault_links");
        assert_eq!(link_count, 1, "duplicate wikilinks must produce exactly 1 row");
    }

    #[test]
    fn test_dangling_link_resolution() {
        let dir = tempdir().expect("tempdir");
        let vault_path = dir.path();

        // 1. Create A.md referencing [[B]]
        let note_a_path = vault_path.join("A.md");
        let mut file_a = File::create(&note_a_path).expect("create A.md");
        write!(file_a, "# Note A\nLinks to [[B]].").expect("write A.md");

        let mut conn = Connection::open_in_memory().expect("in-memory db");
        init_vault_tables(&conn).expect("init tables");

        // Scan initial state: B does not exist yet
        let stats = scan_and_sync_vault(&mut conn, vault_path).expect("scan with dangling link");
        assert_eq!(stats.total_notes, 1);
        assert_eq!(stats.total_links, 1);

        // Assert target_id of the link is NULL, unresolved_target is 'B'
        let (target_id, unresolved_target): (Option<String>, String) = conn
            .query_row(
                "SELECT target_id, unresolved_target FROM vault_links WHERE source_id = 'A.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("query vault_links");
        assert_eq!(target_id, None);
        assert_eq!(unresolved_target, "B");

        // 2. Create B.md (without modifying A.md)
        let note_b_path = vault_path.join("B.md");
        let mut file_b = File::create(&note_b_path).expect("create B.md");
        write!(file_b, "# Note B\nThis is target note B.").expect("write B.md");

        // Re-scan: A.md mtime is unchanged, but B.md is new and link re-resolution runs
        let stats2 = scan_and_sync_vault(&mut conn, vault_path).expect("rescan after B created");
        assert_eq!(stats2.total_notes, 2);
        assert_eq!(stats2.total_links, 1);

        // Assert target_id has been automatically updated to 'B.md'
        let (resolved_target_id, unresolved_target_after): (Option<String>, String) = conn
            .query_row(
                "SELECT target_id, unresolved_target FROM vault_links WHERE source_id = 'A.md'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("query vault_links after resolution");
        assert_eq!(resolved_target_id, Some("B.md".to_string()));
        assert_eq!(unresolved_target_after, "B");
    }

    #[test]
    fn test_fts5_frontmatter_not_indexed() {
        let dir = tempdir().expect("temp dir");
        let vault_path = dir.path();
        let note_path = vault_path.join("fib.md");

        let mut file = File::create(&note_path).expect("create fib note");
        write!(
            file,
            "---\ntitle: \"Fibonacci Note\"\nnote_type: \"ALGO_TRICK\"\ntags: [dynamic_programming, math]\nexternal_uri: \"onenote:https://example.com\"\n---\n# Insight\nFibonacci sequence computation via matrix exponentiation."
        )
        .expect("write fib note");

        let mut conn = Connection::open_in_memory().expect("in-memory db");
        init_vault_tables(&conn).expect("init tables");

        scan_and_sync_vault(&mut conn, vault_path).expect("sync vault");

        // Frontmatter fields should NOT be indexed in FTS5
        let note_type_match: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'note_type'",
                [],
                |r| r.get(0),
            )
            .expect("query note_type");
        assert_eq!(note_type_match, 0, "YAML frontmatter field 'note_type' must not be in FTS5");

        let tags_field_match: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'tags'",
                [],
                |r| r.get(0),
            )
            .expect("query tags keyword");
        assert_eq!(tags_field_match, 0, "YAML frontmatter field 'tags:' must not be in FTS5");

        // Actual content in body SHOULD match
        let fib_match: i64 = conn
            .query_row(
                "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'exponentiation'",
                [],
                |r| r.get(0),
            )
            .expect("query body content");
        assert_eq!(fib_match, 1, "Body content should be indexed in FTS5");
    }
}
