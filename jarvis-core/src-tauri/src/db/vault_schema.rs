use rusqlite::{Connection, OptionalExtension, Result as SqlResult};

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

/// Checks whether vault_fts needs to be rebuilt (e.g. from legacy 2-column to 3-column prose/code).
pub fn vault_fts_needs_rebuild(conn: &Connection) -> Result<bool, String> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='vault_fts'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to check vault_fts schema: {e}"))?;

    match sql {
        None => Ok(false), // Bảng chưa tồn tại, init_vault_tables sẽ tạo mới
        Some(ddl) => Ok(!ddl.contains("prose") || !ddl.contains("code")),
    }
}

/// Re-indexes all existing notes from vault_notes into the newly recreated vault_fts.
pub fn reindex_all_notes_to_fts(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT rowid_key, title, content_cache FROM vault_notes")
        .map_err(|e| format!("Failed to prepare notes for reindexing: {e}"))?;

    let notes = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("Failed to query notes for reindexing: {e}"))?;

    let mut insert_stmt = conn
        .prepare("INSERT INTO vault_fts(rowid, title, prose, code) VALUES (?1, ?2, ?3, ?4)")
        .map_err(|e| format!("Failed to prepare FTS5 insert statement: {e}"))?;

    for note in notes {
        let (rowid, title, content_cache) =
            note.map_err(|e| format!("Failed to read note row: {e}"))?;
        let (prose, code) = crate::modules::vault::scanner::split_prose_and_code(&content_cache);
        insert_stmt
            .execute(rusqlite::params![rowid, title, prose, code])
            .map_err(|e| format!("Failed to reindex note {rowid} into FTS5: {e}"))?;
    }

    Ok(())
}

/// Migrates vault_fts if it exists with legacy schema (missing prose or code columns).
pub fn migrate_vault_fts_if_needed(conn: &Connection) -> Result<(), String> {
    if !vault_fts_needs_rebuild(conn)? {
        return Ok(());
    }

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
    )
    .map_err(|e| format!("Failed to recreate 3-column vault_fts: {e}"))?;

    // Tự động re-index toàn bộ notes đang có trong DB vào FTS5 mới
    reindex_all_notes_to_fts(conn)?;
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
    migrate_vault_fts_if_needed(conn).map_err(|e| {
        rusqlite::Error::UserFunctionError(e.into())
    })?;

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

    #[test]
    fn test_fts5_legacy_migration() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        // Initialize base vault tables first so vault_notes exists
        init_vault_tables(&conn).expect("base init");

        // Manually simulate legacy 2-column vault_fts (v0.5)
        conn.execute_batch(
            r#"
            DROP TABLE IF EXISTS vault_fts;
            CREATE VIRTUAL TABLE vault_fts USING fts5(
                title,
                content,
                content='',
                tokenize='unicode61 remove_diacritics 2'
            );
            "#,
        )
        .expect("create legacy table");

        // Insert a note into vault_notes to verify reindexing
        conn.execute(
            r#"
            INSERT INTO vault_notes (id, title, tags, file_mtime, content_cache, updated_at, note_type, external_uri)
            VALUES ('algo/dp.md', 'DP Intro', '["dp"]', 100, 'Hello world\n```cpp\nint x = 0;\n```', 100, 'ALGO_TRICK', '')
            "#,
            [],
        )
        .expect("insert note");

        // Check that it needs rebuild
        assert!(vault_fts_needs_rebuild(&conn).expect("check rebuild"));

        // Run migration
        migrate_vault_fts_if_needed(&conn).expect("migration must succeed");

        // Verify it no longer needs rebuild
        assert!(!vault_fts_needs_rebuild(&conn).expect("check rebuild"));

        // Verify schema is 3 columns (title, prose, code)
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='vault_fts'",
                [],
                |r| r.get(0),
            )
            .expect("query ddl");
        assert!(sql.contains("prose") && sql.contains("code"));

        // Verify the existing note was reindexed into 3 columns
        let fts_count: i64 = conn
            .query_row("SELECT count(*) FROM vault_fts", [], |r| r.get(0))
            .expect("query fts count");
        assert_eq!(fts_count, 1);

        // Verify inserting 4 parameters (rowid, title, prose, code) succeeds
        conn.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES (999, 'Test Title', 'Test Prose', 'Test Code')",
            [],
        )
        .expect("insert into migrated vault_fts");
    }
}
