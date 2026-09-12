use tauri::State;
use crate::db::SharedDb;

#[tauri::command]
pub fn seed_mock_academic_data(db: State<SharedDb>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('mock_seeded', 'true')",
        [],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_cf_cache(db: State<SharedDb>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM submissions", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}
