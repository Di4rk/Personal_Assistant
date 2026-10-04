use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};

/// In-memory representation of existing note metadata in SQLite without full content body.
#[derive(Debug, Clone)]
pub struct VaultNoteIndexRow {
    pub rowid_key: i64,
    pub id: String,
    pub title: String,
    pub tags: Option<String>,
    pub file_mtime: i64,
    pub note_type: Option<String>,
    pub external_uri: Option<String>,
}

/// Transactional payload for updating FTS5 entries in memory during an active write transaction.
#[derive(Debug, Clone)]
pub struct VaultIndexUpdate {
    pub rowid_key: i64,
    pub title: String,
    pub prose: String,
    pub code: String,
}

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

/// Checks whether vault_fts needs to be rebuilt (e.g. missing prose/code or missing contentless_delete=1).
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
        Some(ddl) => Ok(
            !ddl.contains("prose")
                || !ddl.contains("code")
                || !ddl.contains("contentless_delete=1"),
        ),
    }
}

/// Re-indexes all existing notes from vault_notes into the newly recreated vault_fts if content_cache is available.
pub fn reindex_all_notes_to_fts(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "vault_notes", "content_cache")? {
        return Ok(());
    }

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

/// Migrates vault_notes by dropping content_cache and rebuilding vault_fts with contentless_delete=1.
/// Runs inside an atomic transaction. If migration fails at any step, the transaction rolls back.
pub fn migrate_vault_cache_to_contentless_delete(conn: &mut Connection) -> Result<(), AppError> {
    let table_exists: bool = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='vault_notes'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !table_exists {
        return Ok(());
    }

    let has_content_cache = column_exists(conn, "vault_notes", "content_cache")
        .map_err(AppError::Vault)?;
    let fts_needs_rebuild = vault_fts_needs_rebuild(conn)
        .map_err(AppError::Vault)?;

    if !has_content_cache && !fts_needs_rebuild {
        return Ok(());
    }

    let tx = conn.transaction()?;

    let mut existing_notes = Vec::new();
    if has_content_cache {
        let mut stmt = tx.prepare("SELECT rowid_key, title, content_cache FROM vault_notes")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for r in rows {
            existing_notes.push(r?);
        }
    }

    tx.execute_batch(
        r#"
        DROP TABLE IF EXISTS vault_fts;
        CREATE VIRTUAL TABLE vault_fts USING fts5(
            title,
            prose,
            code,
            content='',
            contentless_delete=1,
            tokenize='unicode61 remove_diacritics 2'
        );
        "#,
    )?;

    if !existing_notes.is_empty() {
        let mut insert_stmt = tx.prepare(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (rowid, title, content_cache) in &existing_notes {
            let (prose, code) = crate::modules::vault::scanner::split_prose_and_code(content_cache);
            insert_stmt.execute(params![rowid, title, prose, code])?;
        }

        let fts_count: i64 = tx.query_row("SELECT count(*) FROM vault_fts", [], |r| r.get(0))?;
        if fts_count != existing_notes.len() as i64 {
            return Err(AppError::Vault(format!(
                "FTS verification failed: expected {} entries, got {}",
                existing_notes.len(),
                fts_count
            )));
        }
    }

    if has_content_cache {
        tx.execute_batch("ALTER TABLE vault_notes DROP COLUMN content_cache;")?;
    }

    tx.commit()?;
    Ok(())
}

/// Migrates vault_fts if it exists with legacy schema (missing prose/code or contentless_delete=1).
pub fn migrate_vault_fts_if_needed(conn: &mut Connection) -> Result<(), String> {
    migrate_vault_cache_to_contentless_delete(conn).map_err(|e| e.to_string())
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
    // 1. Metadata table with surrogate integer key for FTS5 rowid mapping (no content_cache)
    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS vault_notes (
            rowid_key INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL,                  -- Relative path (e.g. 'cs/dp.md')
            title TEXT NOT NULL,
            tags TEXT,                                 -- JSON string array: '["icpc"]'
            frontmatter_json TEXT,                     -- Raw metadata JSON
            file_mtime INTEGER NOT NULL,              -- Unix timestamp for incremental sync
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

    // 3. Ensure FTS5 Virtual Table exists (Contentless, Multi-column: title, prose, code, contentless_delete=1)
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
            title,
            prose,
            code,
            content='',
            contentless_delete=1,
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
        let mut conn = Connection::open_in_memory().expect("in-memory db should open");
        init_vault_tables(&mut conn).expect("vault tables must initialize successfully");

        // Verify vault_notes, vault_links, and vault_fts exist
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('vault_notes', 'vault_links', 'vault_fts')",
                [],
                |r| r.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(count, 3);
        assert!(!column_exists(&conn, "vault_notes", "content_cache").unwrap());
    }

    #[test]
    fn test_init_vault_tables_migration_idempotency() {
        let mut conn = Connection::open_in_memory().expect("in-memory db should open");
        // First run
        init_vault_tables(&mut conn).expect("first init must succeed");
        // Second run (idempotency check)
        init_vault_tables(&mut conn).expect("second init must succeed without duplicate column error");

        // Verify columns exist
        assert!(column_exists(&conn, "vault_notes", "note_type").unwrap());
        assert!(column_exists(&conn, "vault_notes", "external_uri").unwrap());
        assert!(!column_exists(&conn, "vault_notes", "content_cache").unwrap());
    }

    #[test]
    fn test_fts5_legacy_migration() {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        // Initialize base vault tables first so vault_notes exists
        init_vault_tables(&mut conn).expect("base init");

        // Manually add content_cache to simulate legacy table
        ensure_column(&conn, "vault_notes", "content_cache", "content_cache TEXT NOT NULL DEFAULT ''").expect("add content_cache");

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
        migrate_vault_fts_if_needed(&mut conn).expect("migration must succeed");

        // Verify it no longer needs rebuild
        assert!(!vault_fts_needs_rebuild(&conn).expect("check rebuild"));

        // Verify schema is 3 columns (title, prose, code) with contentless_delete=1
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='vault_fts'",
                [],
                |r| r.get(0),
            )
            .expect("query ddl");
        assert!(sql.contains("prose") && sql.contains("code") && sql.contains("contentless_delete=1"));

        // Verify content_cache is dropped
        assert!(!column_exists(&conn, "vault_notes", "content_cache").unwrap());

        // Verify the existing note was reindexed into 3 columns
        let fts_count: i64 = conn
            .query_row("SELECT count(*) FROM vault_fts", [], |r| r.get(0))
            .expect("query fts count");
        assert_eq!(fts_count, 1);

        // Verify searching for prose works
        let match_count: i64 = conn
            .query_row("SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'Hello'", [], |r| r.get(0))
            .expect("match query");
        assert_eq!(match_count, 1);

        // Verify deleting by rowid succeeds directly on contentless table!
        conn.execute("DELETE FROM vault_fts WHERE rowid = 1", []).expect("delete by rowid");
        let count_after: i64 = conn
            .query_row("SELECT count(*) FROM vault_fts", [], |r| r.get(0))
            .expect("count after delete");
        assert_eq!(count_after, 0);
    }

    #[test]
    fn test_sqlite_version_and_contentless_delete_support() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .expect("query sqlite version");
        println!("\n>>> Bundled SQLite Version: {} <<<\n", version);

        let res = conn.execute_batch(
            r#"
            CREATE VIRTUAL TABLE test_contentless_fts USING fts5(
                title,
                prose,
                code,
                content='',
                contentless_delete=1,
                tokenize='unicode61 remove_diacritics 2'
            );
            INSERT INTO test_contentless_fts(rowid, title, prose, code) VALUES(1, 'Title 1', 'Prose 1', 'Code 1');
            INSERT INTO test_contentless_fts(rowid, title, prose, code) VALUES(2, 'Title 2', 'Prose 2', 'Code 2');
            "#,
        );
        assert!(res.is_ok(), "Creating contentless_delete=1 table must succeed: {:?}", res);

        // Verify query matches
        let count: i64 = conn
            .query_row("SELECT count(*) FROM test_contentless_fts WHERE test_contentless_fts MATCH 'Prose'", [], |r| r.get(0))
            .expect("query match");
        assert_eq!(count, 2);

        // Verify DELETE by rowid without old text works!
        let del_res = conn.execute("DELETE FROM test_contentless_fts WHERE rowid = 1", []);
        assert!(del_res.is_ok(), "Deleting from contentless table with contentless_delete=1 must succeed: {:?}", del_res);

        // Verify match count decreased to 1
        let count_after: i64 = conn
            .query_row("SELECT count(*) FROM test_contentless_fts WHERE test_contentless_fts MATCH 'Prose'", [], |r| r.get(0))
            .expect("query match after delete");
        assert_eq!(count_after, 1);
    }
}
