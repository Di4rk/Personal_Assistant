//! SQLite Schema and FTS5 Virtual Table setup for Native Vault Core.

use rusqlite::{Connection, Result as SqlResult};

/// Helper to safely check if a column exists in a given table.
pub fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| format!("Failed to prepare table_info for {}: {}", table, e))?;

    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to query table_info for {}: {}", table, e))?;

    for name in names {
        let name = name.map_err(|e| format!("Failed to read column name: {}", e))?;
        if name.eq_ignore_ascii_case(column) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Helper to safely add a column to a table if it does not already exist.
pub fn ensure_column(conn: &Connection, table: &str, column_name: &str, column_def: &str) -> Result<(), String> {
    if !column_exists(conn, table, column_name)? {
        conn.execute(&format!("ALTER TABLE {} ADD COLUMN {}", table, column_def), [])
            .map_err(|e| format!("Failed to add column {} to {}: {}", column_name, table, e))?;
    }
    Ok(())
}

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
            updated_at INTEGER NOT NULL,
            -- Giá trị mặc định 'GENERAL' phải khớp với enum NoteType bên TypeScript types.ts
            note_type TEXT DEFAULT 'GENERAL',
            external_uri TEXT DEFAULT ''
        )
        "#,
        [],
    )?;

    // Migration guard: ensure columns exist for existing tables
    ensure_column(conn, "vault_notes", "note_type", "note_type TEXT DEFAULT 'GENERAL'").map_err(|e| {
        rusqlite::Error::UserFunctionError(e.into())
    })?;
    ensure_column(conn, "vault_notes", "external_uri", "external_uri TEXT DEFAULT ''").map_err(|e| {
        rusqlite::Error::UserFunctionError(e.into())
    })?;

    // 2. Outlinks / Backlinks table
    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS vault_links (
            source_id TEXT NOT NULL,
            target_id TEXT,                          -- NULL nếu chưa resolve được đường dẫn
            unresolved_target TEXT NOT NULL DEFAULT '', -- Tên gốc được viết trong wikilink [[...]]
            PRIMARY KEY (source_id, unresolved_target),
            FOREIGN KEY(source_id) REFERENCES vault_notes(id) ON DELETE CASCADE
        )
        "#,
        [],
    )?;

    // Migration guard: check if vault_links table exists with unresolved_target column
    let needs_migration: bool = {
        let table_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='vault_links'",
                [],
                |r| r.get(0),
            )
            .ok();

        match table_sql {
            Some(sql) => !sql.contains("unresolved_target"),
            None => false,
        }
    };

    if needs_migration {
        // Table existed with old schema (source_id, target_id); migrate it
        conn.execute_batch(
            r#"
            DROP TABLE IF EXISTS vault_links;
            CREATE TABLE vault_links (
                source_id TEXT NOT NULL,
                target_id TEXT,
                unresolved_target TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (source_id, unresolved_target),
                FOREIGN KEY(source_id) REFERENCES vault_notes(id) ON DELETE CASCADE
            );
            "#,
        )?;
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_vault_links_target ON vault_links(target_id)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_vault_links_unresolved ON vault_links(unresolved_target) WHERE target_id IS NULL",
        [],
    )?;

    // 3. FTS5 Virtual Table (Contentless, Multi-column: title, prose, code)
    let fts_needs_migration: bool = {
        let table_sql: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='vault_fts'",
                [],
                |r| r.get(0),
            )
            .ok();

        match table_sql {
            Some(sql) => !sql.contains("prose") || !sql.contains("code"),
            None => false,
        }
    };

    if fts_needs_migration {
        conn.execute_batch(
            r#"
            DROP TABLE IF EXISTS vault_fts;
            CREATE VIRTUAL TABLE vault_fts USING fts5(
                title,
                prose,
                code,
                content='',
                tokenize='unicode61 remove_diacritics 2'
            );
            "#,
        )?;
    } else {
        conn.execute_batch(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
                title,
                prose,
                code,
                content='',
                tokenize='unicode61 remove_diacritics 2'
            );
            "#,
        )?;
    }

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

    #[test]
    fn test_init_vault_tables_migration_idempotency() {
        let conn = Connection::open_in_memory().expect("in-memory db should open");
        // First run
        init_vault_tables(&conn).expect("first init must succeed");
        // Second run (idempotency check)
        init_vault_tables(&conn).expect("second init must succeed without duplicate column error");

        // Verify columns exist
        assert!(column_exists(&conn, "vault_notes", "note_type").unwrap());
        assert!(column_exists(&conn, "vault_notes", "external_uri").unwrap());
    }
}
