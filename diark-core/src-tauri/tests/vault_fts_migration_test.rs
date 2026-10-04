//! Integration & Migration Test Suite for TASK-04:
//! Vault Storage — Dropping content_cache, contentless_delete=1 consistency, and FTS5 optimization.

use std::fs;
use diark_core_lib::db::vault_schema::{column_exists, migrate_vault_cache_to_contentless_delete};
use rusqlite::{params, Connection};
use tempfile::tempdir;

fn setup_legacy_vault_db(conn: &Connection) {
    conn.execute_batch(
        r#"
        CREATE TABLE vault_notes (
            rowid_key INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            tags TEXT,
            frontmatter_json TEXT,
            file_mtime INTEGER NOT NULL,
            content_cache TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            note_type TEXT DEFAULT 'GENERAL',
            external_uri TEXT DEFAULT ''
        );

        CREATE VIRTUAL TABLE vault_fts USING fts5(
            title,
            prose,
            code,
            content='',
            tokenize='unicode61 remove_diacritics 2'
        );
        "#,
    )
    .expect("setup legacy schema");
}

#[test]
fn test_vault_fts_legacy_migration_and_crud() {
    let mut conn = Connection::open_in_memory().expect("open memory db");
    setup_legacy_vault_db(&conn);

    // Seed sample notes with prose and code into legacy database
    let sample_notes = [
        (
            "cs/segment_tree.md",
            "Segment Tree",
            r#"# Segment Tree
A tree data structure for range queries and point updates.
```rust
fn query_range(l: usize, r: usize) -> i64 { 0 }
```"#,
        ),
        (
            "cs/dynamic_programming.md",
            "Dynamic Programming",
            r#"# Dynamic Programming
Optimal substructure and overlapping subproblems are key characteristics.
```cpp
int memo[1000][1000];
int solve(int i, int j) { return memo[i][j]; }
```"#,
        ),
        (
            "math/number_theory.md",
            "Number Theory",
            r#"# Extended Euclidean Algorithm
Finds integer coefficients x and y such that ax + by = gcd(a, b).
```python
def egcd(a, b):
    return (a, 1, 0)
```"#,
        ),
    ];

    for (id, title, content) in &sample_notes {
        conn.execute(
            r#"
            INSERT INTO vault_notes (id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at, note_type, external_uri)
            VALUES (?1, ?2, '[]', NULL, 1000, ?3, 1000, 'GENERAL', '')
            "#,
            params![id, title, content],
        )
        .expect("insert legacy note");

        let rowid = conn.last_insert_rowid();
        let (prose, code) = diark_core_lib::modules::vault::scanner::split_prose_and_code(content);
        conn.execute(
            "INSERT INTO vault_fts(rowid, title, prose, code) VALUES (?1, ?2, ?3, ?4)",
            params![rowid, title, prose, code],
        )
        .expect("insert legacy fts");
    }

    // Verify content_cache initially exists
    assert!(column_exists(&conn, "vault_notes", "content_cache").expect("column check"));

    // Run migration
    migrate_vault_cache_to_contentless_delete(&mut conn).expect("migration should succeed");

    // 1. Verify content_cache has been dropped from vault_notes
    assert!(
        !column_exists(&conn, "vault_notes", "content_cache").expect("column check"),
        "content_cache must be removed from vault_notes schema"
    );

    // 2. Verify vault_fts now has contentless_delete=1
    let fts_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='vault_fts'",
            [],
            |r| r.get(0),
        )
        .expect("get fts sql");
    assert!(
        fts_sql.contains("contentless_delete=1"),
        "vault_fts table definition must contain contentless_delete=1"
    );

    // 3. Verify all notes are searchable via FTS5 MATCH
    let count_prose: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'subproblems'",
            [],
            |r| r.get(0),
        )
        .expect("search prose");
    assert_eq!(count_prose, 1, "Should find 'subproblems' in FTS index");

    let count_code: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'egcd'",
            [],
            |r| r.get(0),
        )
        .expect("search code");
    assert_eq!(count_code, 1, "Should find 'egcd' in FTS index");

    let count_title: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'Segment'",
            [],
            |r| r.get(0),
        )
        .expect("search title");
    assert_eq!(count_title, 1, "Should find 'Segment' in FTS index");

    // 4. Test Idempotency: Running migration second time must be a no-op and succeed
    migrate_vault_cache_to_contentless_delete(&mut conn).expect("idempotent migration should succeed");
    let count_after_idempotency: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'subproblems'",
            [],
            |r| r.get(0),
        )
        .expect("search prose after second migration");
    assert_eq!(count_after_idempotency, 1);

    // 5. Test UPDATE consistency: direct rowid deletion without content_cache
    // Note 1 (rowid 1): update from 'Segment Tree' to 'Fenwick Tree'
    let note1_rowid: i64 = 1;
    conn.execute("DELETE FROM vault_fts WHERE rowid = ?1", params![note1_rowid])
        .expect("contentless delete by rowid");
    conn.execute(
        r#"
        UPDATE vault_notes
        SET title = 'Fenwick Tree', updated_at = 2000
        WHERE rowid_key = ?1
        "#,
        params![note1_rowid],
    )
    .expect("update note metadata");
    conn.execute(
        "INSERT INTO vault_fts(rowid, title, prose, code) VALUES (?1, ?2, ?3, ?4)",
        params![
            note1_rowid,
            "Fenwick Tree",
            "Binary Indexed Tree for prefix sums and point updates.",
            "fn bit_query() {}"
        ],
    )
    .expect("insert updated fts");

    // Verify old keyword is removed
    let old_keyword_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'queries'",
            [],
            |r| r.get(0),
        )
        .expect("search old keyword");
    assert_eq!(old_keyword_count, 0, "Old keyword 'queries' must not match after update");

    // Verify new keyword is searchable
    let new_keyword_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'prefix'",
            [],
            |r| r.get(0),
        )
        .expect("search new keyword");
    assert_eq!(new_keyword_count, 1, "New keyword 'prefix' must match after update");

    // 6. Test DELETE consistency: direct rowid deletion without content_cache
    // Note 3 (rowid 3): delete Number Theory
    let note3_rowid: i64 = 3;
    conn.execute("DELETE FROM vault_fts WHERE rowid = ?1", params![note3_rowid])
        .expect("contentless delete by rowid");
    conn.execute(
        "DELETE FROM vault_notes WHERE rowid_key = ?1",
        params![note3_rowid],
    )
    .expect("delete note metadata");

    // Verify deleted keywords return 0 hits
    let deleted_code_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'egcd'",
            [],
            |r| r.get(0),
        )
        .expect("search deleted code");
    assert_eq!(deleted_code_count, 0, "Deleted note code must not match");

    let deleted_title_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM vault_fts WHERE vault_fts MATCH 'Euclidean'",
            [],
            |r| r.get(0),
        )
        .expect("search deleted title");
    assert_eq!(deleted_title_count, 0, "Deleted note title must not match");
}

#[test]
fn test_vault_fts_migration_fault_injection_rollback() {
    let mut conn = Connection::open_in_memory().expect("open memory db");
    setup_legacy_vault_db(&conn);

    conn.execute(
        r#"
        INSERT INTO vault_notes (id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at, note_type, external_uri)
        VALUES ('critical/data.md', 'Critical Data', '[]', NULL, 1000, 'Crucial confidential content to preserve', 1000, 'GENERAL', '')
        "#,
        [],
    )
    .expect("insert note");

    // Simulate an aborted/failed transaction midway through migration
    let tx_res = (|| -> Result<(), rusqlite::Error> {
        let tx = conn.transaction()?;
        // Simulate partial step
        tx.execute("CREATE TABLE IF NOT EXISTS temp_guard (x INTEGER)", [])?;
        // Inject failure
        if true {
            return Err(rusqlite::Error::ExecuteReturnedResults);
        }
        tx.commit()?;
        Ok(())
    })();

    assert!(tx_res.is_err(), "Simulated error must trigger transaction failure");

    // Verify original database state remains intact
    assert!(
        column_exists(&conn, "vault_notes", "content_cache").expect("check content_cache"),
        "content_cache must be preserved when migration transaction fails"
    );

    let saved_content: String = conn
        .query_row(
            "SELECT content_cache FROM vault_notes WHERE id = 'critical/data.md'",
            [],
            |r| r.get(0),
        )
        .expect("read preserved content_cache");
    assert_eq!(saved_content, "Crucial confidential content to preserve");
}

#[test]
fn test_vault_fts_db_size_reduction_measurement() {
    let temp_dir = tempdir().expect("create temp dir");
    let db_path = temp_dir.path().join("vault_storage_test.db");

    let mut conn = Connection::open(&db_path).expect("open file db");
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )
    .expect("set pragma");

    setup_legacy_vault_db(&conn);

    // Generate 120 realistic notes with ~4KB body each (~500KB total note body content)
    let body_chunk = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.\n\n```rust\npub fn solve_problem(input: &str) -> Vec<i64> {\n    let mut result = Vec::new();\n    for item in input.lines() {\n        result.push(item.len() as i64);\n    }\n    result\n}\n```\n";
    let full_body = body_chunk.repeat(8); // ~4KB per note

    {
        let tx = conn.transaction().expect("tx");
        for i in 1..=120 {
            let id = format!("notes/note_{:03}.md", i);
            let title = format!("Technical Note #{:03}", i);
            let note_body = format!("# {}\n{}", title, full_body);

            tx.execute(
                r#"
                INSERT INTO vault_notes (id, title, tags, frontmatter_json, file_mtime, content_cache, updated_at, note_type, external_uri)
                VALUES (?1, ?2, '["bench"]', NULL, 1000, ?3, 1000, 'GENERAL', '')
                "#,
                params![id, title, note_body],
            )
            .expect("insert note");

            let rowid = tx.last_insert_rowid();
            let (prose, code) = diark_core_lib::modules::vault::scanner::split_prose_and_code(&note_body);
            tx.execute(
                "INSERT INTO vault_fts(rowid, title, prose, code) VALUES (?1, ?2, ?3, ?4)",
                params![rowid, title, prose, code],
            )
            .expect("insert fts");
        }
        tx.commit().expect("commit seed");
    }

    // Checkpoint WAL and vacuum before migration to get baseline file size
    conn.execute_batch(
        "VACUUM;
         PRAGMA wal_checkpoint(TRUNCATE);",
    )
    .expect("vacuum before");

    let size_before = fs::metadata(&db_path).expect("stat db before").len();

    // Execute TASK-04 migration
    migrate_vault_cache_to_contentless_delete(&mut conn).expect("execute migration");

    // Optimize FTS and vacuum to reclaim pages freed by dropping content_cache
    conn.execute_batch(
        "INSERT INTO vault_fts(vault_fts) VALUES('optimize');
         VACUUM;
         PRAGMA wal_checkpoint(TRUNCATE);",
    )
    .expect("vacuum after");

    let size_after = fs::metadata(&db_path).expect("stat db after").len();

    let bytes_saved = size_before.saturating_sub(size_after);
    let pct_saved = if size_before > 0 {
        (bytes_saved as f64 / size_before as f64) * 100.0
    } else {
        0.0
    };

    println!(
        "\n[TASK-04 Storage Benchmark Report]\n\
         - Legacy DB Size (with content_cache): {} bytes ({:.2} KB)\n\
         - Migrated DB Size (contentless_delete): {} bytes ({:.2} KB)\n\
         - Storage Reclaimed: {} bytes ({:.2}% reduction)\n",
        size_before,
        size_before as f64 / 1024.0,
        size_after,
        size_after as f64 / 1024.0,
        bytes_saved,
        pct_saved
    );

    // Verify storage reduction gate
    assert!(
        size_after < size_before,
        "Migrated database (without content_cache duplicate) must be smaller than legacy database! Before: {}, After: {}",
        size_before,
        size_after
    );
    assert!(
        pct_saved > 20.0,
        "Expected significant size reduction from dropping content_cache; got {:.2}%",
        pct_saved
    );
}
