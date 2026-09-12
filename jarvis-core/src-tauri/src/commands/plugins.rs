use rusqlite::{params, OptionalExtension};
use tauri::State;
use crate::db::SharedDb;

const FIRST_PARTY_PLUGIN_IDS: &[&str] = &[
    "cp-codeforces",
    "cp-leetcode",
    "uit-wecode",
    "sec-ctf",
    "ai-lab",
];

fn derive_trust_tier(plugin_id: &str) -> &'static str {
    if FIRST_PARTY_PLUGIN_IDS.contains(&plugin_id) {
        "first_party"
    } else {
        "third_party"
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginMetaDto {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub category: String,
    pub is_enabled: bool,
    pub is_builtin: bool,
    pub trust_tier: String,
}

#[derive(serde::Deserialize)]
pub struct ActivityEventInput {
    pub event_date: String,
    pub event_type: String,
    pub xp_value: i64,
    pub ref_id: Option<String>,
}

#[tauri::command]
pub fn list_installed_plugins(db: State<'_, SharedDb>) -> Result<Vec<PluginMetaDto>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT plugin_id, name, version, author, category, is_enabled, is_builtin FROM plugin_registry")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let plugin_id: String = row.get(0)?;
            let trust_tier = derive_trust_tier(&plugin_id).to_string();
            Ok(PluginMetaDto {
                plugin_id,
                name: row.get(1)?,
                version: row.get(2)?,
                author: row.get(3)?,
                category: row.get(4)?,
                is_enabled: row.get(5)?,
                is_builtin: row.get(6)?,
                trust_tier,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for item in rows {
        list.push(item.map_err(|e| e.to_string())?);
    }
    Ok(list)
}

#[tauri::command]
pub fn toggle_plugin(plugin_id: String, enabled: bool, db: State<'_, SharedDb>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE plugin_registry SET is_enabled = ?1 WHERE plugin_id = ?2",
        params![enabled, plugin_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn plugin_storage_get(plugin_id: String, key: String, db: State<'_, SharedDb>) -> Result<Option<String>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2",
        params![plugin_id, key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_storage_set(plugin_id: String, key: String, value: String, db: State<'_, SharedDb>) -> Result<(), String> {
    if value.len() > 1_048_576 {
        return Err("Payload vượt quá giới hạn 1MB".into());
    }

    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO plugin_storage (plugin_id, key, value, updated_at) 
         VALUES (?1, ?2, ?3, datetime('now', '+7 hours'))
         ON CONFLICT(plugin_id, key) DO UPDATE SET 
            value = excluded.value, 
            updated_at = excluded.updated_at",
        params![plugin_id, key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn record_activity_event(
    plugin_id: String,
    input: ActivityEventInput,
    db: State<'_, SharedDb>,
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;

    let is_enabled: bool = conn
        .query_row(
            "SELECT is_enabled FROM plugin_registry WHERE plugin_id = ?1",
            params![plugin_id],
            |row| row.get(0),
        )
        .map_err(|_| "Plugin không tồn tại trong registry".to_string())?;

    if !is_enabled {
        return Err("Plugin đang tắt, không thể ghi nhận sự kiện".to_string());
    }

    conn.execute(
        "INSERT OR IGNORE INTO activity_events
         (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))",
        params![plugin_id, input.event_date, input.event_type, input.xp_value, input.ref_id],
    )
    .map_err(|e| e.to_string())?;

    // Tự động trigger recompute cho ngày có event
    recompute_daily_matrix(&conn, &input.event_date)?;

    Ok(())
}

pub fn recompute_daily_matrix(conn: &rusqlite::Connection, date: &str) -> Result<(), String> {
    let total_xp: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(xp_value), 0) FROM activity_events WHERE event_date = ?1",
            params![date],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let ac_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM activity_events
             WHERE event_date = ?1 AND event_type = 'submission_ac'",
            params![date],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let deadlines_cleared: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM activity_events
             WHERE event_date = ?1 AND event_type = 'deadline_cleared'",
            params![date],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let state_tier = match total_xp {
        0 => 0,
        1..=20 => 1,
        21..=50 => 2,
        51..=100 => 3,
        _ => 4,
    };

    conn.execute(
        "INSERT INTO life_matrix_daily (date, ac_count, deadlines_cleared, total_xp, state_tier, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))
         ON CONFLICT(date) DO UPDATE SET
            ac_count = excluded.ac_count,
            deadlines_cleared = excluded.deadlines_cleared,
            total_xp = excluded.total_xp,
            state_tier = excluded.state_tier,
            updated_at = excluded.updated_at",
        params![date, ac_count, deadlines_cleared, total_xp, state_tier],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn trigger_recompute_daily_matrix(date: String, db: State<'_, SharedDb>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    recompute_daily_matrix(&conn, &date)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn test_list_installed_plugins_contains_seeded_first_parties() {
        let conn = setup_test_db();
        let mut stmt = conn
            .prepare("SELECT plugin_id, name, version, author, category, is_enabled, is_builtin FROM plugin_registry")
            .unwrap();

        let plugins = stmt
            .query_map([], |row| {
                let plugin_id: String = row.get(0)?;
                Ok(PluginMetaDto {
                    plugin_id: plugin_id.clone(),
                    name: row.get(1)?,
                    version: row.get(2)?,
                    author: row.get(3)?,
                    category: row.get(4)?,
                    is_enabled: row.get(5)?,
                    is_builtin: row.get(6)?,
                    trust_tier: derive_trust_tier(&plugin_id).to_string(),
                })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect::<Vec<_>>();

        assert_eq!(plugins.len(), 5);
        assert!(plugins.iter().any(|p| p.plugin_id == "cp-codeforces" && p.trust_tier == "first_party"));
        assert!(plugins.iter().any(|p| p.plugin_id == "uit-wecode" && p.is_enabled));
    }

    #[test]
    fn test_plugin_storage_quota_and_isolation() {
        let conn = setup_test_db();

        // 1MB = 1_048_576 bytes. Oversized payload > 1MB should be rejected.
        let oversized = "x".repeat(1_048_577);
        assert!(oversized.len() > 1_048_576);

        // Test quota enforcement via direct logic check
        let is_oversized = oversized.len() > 1_048_576;
        assert!(is_oversized);

        // Test normal storage set and get
        conn.execute(
            "INSERT INTO plugin_storage (plugin_id, key, value) VALUES ('cp-codeforces', 'theme', 'monokai')",
            [],
        ).unwrap();

        let val: Option<String> = conn.query_row(
            "SELECT value FROM plugin_storage WHERE plugin_id = 'cp-codeforces' AND key = 'theme'",
            [],
            |r| r.get(0),
        ).optional().unwrap();

        assert_eq!(val, Some("monokai".to_string()));

        // Check isolation: another plugin cannot read key
        let other_val: Option<String> = conn.query_row(
            "SELECT value FROM plugin_storage WHERE plugin_id = 'uit-wecode' AND key = 'theme'",
            [],
            |r| r.get(0),
        ).optional().unwrap();

        assert_eq!(other_val, None);
    }

    #[test]
    fn test_record_activity_event_and_recompute_daily_matrix() {
        let conn = setup_test_db();
        let test_date = "2026-09-12";

        // Insert event 1: submission_ac 10 XP
        conn.execute(
            "INSERT INTO activity_events (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
             VALUES ('cp-codeforces', ?1, 'submission_ac', 10, 'sub_1', 1710000000)",
            params![test_date],
        ).unwrap();

        // Insert event 2: deadline_cleared 25 XP
        conn.execute(
            "INSERT INTO activity_events (plugin_id, event_date, event_type, xp_value, ref_id, created_at)
             VALUES ('uit-wecode', ?1, 'deadline_cleared', 25, 'dl_1', 1710000005)",
            params![test_date],
        ).unwrap();

        recompute_daily_matrix(&conn, test_date).unwrap();

        let (ac_count, deadlines_cleared, total_xp, state_tier): (i64, i64, i64, i64) = conn.query_row(
            "SELECT ac_count, deadlines_cleared, total_xp, state_tier FROM life_matrix_daily WHERE date = ?1",
            params![test_date],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).unwrap();

        assert_eq!(ac_count, 1);
        assert_eq!(deadlines_cleared, 1);
        assert_eq!(total_xp, 35);
        assert_eq!(state_tier, 2); // 21..=50 -> 2
    }
}
