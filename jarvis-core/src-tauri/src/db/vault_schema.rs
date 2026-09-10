//! SQLite Schema and FTS5 Virtual Table setup for Native Vault Core.

use rusqlite::{Connection, Result as SqlResult};

/// Verifies that SQLite was compiled with FTS5 support.
pub fn check_fts5_support(conn: &Connection) -> SqlResult<()> {
    let fts5_enabled: i64 = conn.query_row(
        "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
        [],
        |r| r.get(0),
    )?;

    if fts5_enabled == 0 {
        return Err(rusqlite::Error::UserFunctionError(
            "SQLite was compiled without FTS5 support! Check Cargo features.".into(),
        ));
    }
    Ok(())
}

/// Initializes vault tables for notes metadata, wikilinks graph, and FTS5 full-text indexing.
pub fn init_vault_tables(conn: &Connection) -> SqlResult<()> {
    check_fts5_support(conn)?;
    // 1. Metadata table with surrogate integer key for FTS5 rowid mapping
    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS vault_notes (
            rowid_key INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL,                  -- Relative path (e.g. 'cs/dp.md')
            title TEXT NOT NULL,
            tags TEXT,                                 -- JSON string array: '["icpc"]'
            frontmatter_json TEXT,                     -- Raw metadata JSON
            file_mtime INTEGER NOT NULL,              -- Unix timestamp for incremental sync
            content_cache TEXT NOT NULL DEFAULT '',    -- Needed for FTS5 contentless 'delete'
            updated_at INTEGER NOT NULL
        )
        "#,
        [],
    )?;

    // 2. Outlinks / Backlinks table
    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS vault_links (
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            PRIMARY KEY (source_id, target_id),
            FOREIGN KEY(source_id) REFERENCES vault_notes(id) ON DELETE CASCADE
        )
        "#,
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_vault_links_target ON vault_links(target_id)",
        [],
    )?;

    // 3. FTS5 Virtual Table (Contentless)
    conn.execute(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
            title,
            content,
            content='',
            tokenize='unicode61 remove_diacritics 2'
        )
        "#,
        [],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_vault_tables_succeeds() {
        let conn = Connection::open_in_memory().expect("in-memory db should open");
        init_vault_tables(&conn).expect("vault tables must initialize successfully");

        // Verify vault_notes, vault_links, and vault_fts exist
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('vault_notes', 'vault_links', 'vault_fts')",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 3);
    }
}
