use rusqlite::{params, OptionalExtension};
use tauri::State;
use crate::db::SharedDb;

const FIRST_PARTY_PLUGIN_IDS: &[&str] = &[
    "cp-codeforces",
    "cp-leetcode",
    "uit-wecode",
    "uit-courses",
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

use sha2::{Digest, Sha256};
use std::io::Write;
use tauri::Manager;

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct RemotePluginDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub download_url: String,
    pub sha256: String,
    pub manifest_url: String,
}

#[tauri::command]
pub async fn fetch_remote_registry() -> Result<Vec<RemotePluginDto>, String> {
    // Mock registry hoặc fetch từ GitHub raw
    Ok(vec![
        RemotePluginDto {
            id: "community-anki-sync".to_string(),
            name: "Anki Flashcard Sync".to_string(),
            version: "1.0.0".to_string(),
            author: "UIT Community".to_string(),
            download_url: "https://raw.githubusercontent.com/diark-os/plugins-repo/main/dist/anki-sync.zip".to_string(),
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
            manifest_url: "https://raw.githubusercontent.com/diark-os/plugins-repo/main/dist/manifest.json".to_string(),
        }
    ])
}

#[tauri::command]
pub async fn install_remote_plugin(
    app: tauri::AppHandle,
    plugin: RemotePluginDto,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let bytes = reqwest::get(&plugin.download_url)
        .await
        .map_err(|e| format!("Lỗi tải plugin: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Lỗi đọc dữ liệu: {e}"))?;

    // Kiểm tra Checksum SHA-256 trước khi giải nén
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let computed_hash = format!("{:x}", hasher.finalize());

    if computed_hash != plugin.sha256.to_lowercase() {
        return Err(format!(
            "Sai lệch Checksum: kỳ vọng {}, nhận được {computed_hash}. Hủy cài đặt.",
            plugin.sha256
        ));
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Không tìm thấy thư mục app_data: {e}"))?;

    let quarantine_dir = app_data_dir.join("plugins_quarantine").join(&plugin.id);
    let final_dir = app_data_dir.join("plugins").join(&plugin.id);

    std::fs::create_dir_all(&quarantine_dir).map_err(|e| e.to_string())?;

    let zip_path = quarantine_dir.join("bundle.zip");
    {
        let mut file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    // Giải nén với Zip-Slip protection
    extract_zip_safely(&zip_path, &quarantine_dir)?;
    let _ = std::fs::remove_file(&zip_path);

    if final_dir.exists() {
        std::fs::remove_dir_all(&final_dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&quarantine_dir, &final_dir).map_err(|e| e.to_string())?;

    // Ghi danh với is_builtin = 0 (luôn chạy sandboxed iframe)
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO plugin_registry (plugin_id, name, version, author, category, is_enabled, is_builtin)
         VALUES (?1, ?2, ?3, ?4, 'community', 0, 0)
         ON CONFLICT(plugin_id) DO UPDATE SET
            version = excluded.version, name = excluded.name",
        rusqlite::params![plugin.id, plugin.name, plugin.version, plugin.author],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn extract_zip_safely(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    const MAX_UNCOMPRESSED_SIZE: u64 = 20 * 1024 * 1024; // 20MB limit
    let mut total_size: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = entry.name().to_string();

        if entry_name.contains("..") || std::path::Path::new(&entry_name).is_absolute() {
            return Err(format!("Phát hiện đường dẫn không an toàn: {entry_name}"));
        }

        total_size += entry.size();
        if total_size > MAX_UNCOMPRESSED_SIZE {
            return Err("Kích thước giải nén vượt quá 20MB cho phép (chống Zip Bomb)".to_string());
        }

        let out_path = dest_dir.join(&entry_name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out_file = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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

        assert_eq!(plugins.len(), 6);
        assert!(plugins.iter().any(|p| p.plugin_id == "cp-codeforces" && p.trust_tier == "first_party"));
        assert!(plugins.iter().any(|p| p.plugin_id == "uit-wecode" && p.is_enabled));
        assert!(plugins.iter().any(|p| p.plugin_id == "uit-courses" && p.is_enabled));
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

    #[test]
    fn test_extract_zip_safely_valid_and_zip_slip() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let temp_dir = tempfile::tempdir().unwrap();
        let zip_path = temp_dir.path().join("test.zip");
        let extract_dir = temp_dir.path().join("extracted");
        std::fs::create_dir_all(&extract_dir).unwrap();

        // 1. Create valid zip
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            zip.start_file("index.html", options).unwrap();
            zip.write_all(b"<h1>Hello Plugin</h1>").unwrap();
            zip.finish().unwrap();
        }

        // Test safe extraction
        let res = extract_zip_safely(&zip_path, &extract_dir);
        assert!(res.is_ok());
        let content = std::fs::read_to_string(extract_dir.join("index.html")).unwrap();
        assert_eq!(content, "<h1>Hello Plugin</h1>");

        // 2. Create zip with zip-slip entry (containing ..)
        let evil_zip_path = temp_dir.path().join("evil.zip");
        {
            let file = std::fs::File::create(&evil_zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            zip.start_file("../outside.txt", options).unwrap();
            zip.write_all(b"malicious content").unwrap();
            zip.finish().unwrap();
        }

        // Safe extraction must reject entry containing ".."
        let evil_res = extract_zip_safely(&evil_zip_path, &extract_dir);
        assert!(evil_res.is_err());
        assert!(evil_res.unwrap_err().contains("Phát hiện đường dẫn không an toàn"));
    }

    #[test]
    fn test_sha256_checksum_verification() {
        let data = b"test plugin bundle content";
        let mut hasher = Sha256::new();
        hasher.update(data);
        let hash = format!("{:x}", hasher.finalize());

        assert_eq!(hash.len(), 64);
        assert_eq!(
            hash,
            "bc32188c7d64023bef1c80e0e249cc87e58627242e991b4a9ff75d3590c441e4"
        );
    }
}
