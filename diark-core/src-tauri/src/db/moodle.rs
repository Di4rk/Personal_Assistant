use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};

fn default_active_status() -> String {
    "active".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoodleCourseRecord {
    pub course_id: i64,
    pub course_code: String,
    pub fullname: String,
    pub term: String,
    pub instructor_name: String,
    pub instructor_mail: String,
    pub instructor_phone: String,
    pub course_url: String,
    #[serde(default = "default_active_status")]
    pub status: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoodleTaskRecord {
    pub task_id: i64,
    pub course_id: i64,
    pub title: String,
    pub task_type: String,
    pub due_date: i64,
    pub is_submitted: bool,
    pub submission_status: String,
    pub template_file_url: String,
    pub task_url: String,
    pub updated_at: i64,
    #[serde(default)]
    pub course_name: Option<String>,
    #[serde(default)]
    pub course_code: Option<String>,
}

fn default_download_status() -> String {
    "online_only".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoodleMaterialRecord {
    pub id: i64,
    pub course_id: i64,
    pub section_name: String,
    pub title: String,
    pub file_url: String,
    pub file_type: String,
    pub created_at: i64,
    #[serde(default)]
    pub local_file_path: String,
    #[serde(default = "default_download_status")]
    pub download_status: String, // 'online_only' | 'downloading' | 'synced' | 'failed'
    #[serde(default)]
    pub file_size_bytes: i64,
}

impl MoodleMaterialRecord {
    pub fn new_online(
        id: i64,
        course_id: i64,
        section_name: String,
        title: String,
        file_url: String,
        file_type: String,
        created_at: i64,
    ) -> Self {
        Self {
            id,
            course_id,
            section_name,
            title,
            file_url,
            file_type,
            created_at,
            local_file_path: String::new(),
            download_status: "online_only".to_string(),
            file_size_bytes: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MoodleSyncPayload {
    #[serde(default)]
    pub courses: Vec<MoodleCourseRecord>,
    #[serde(default)]
    pub tasks: Vec<MoodleTaskRecord>,
    #[serde(default)]
    pub materials: Vec<MoodleMaterialRecord>,
    #[serde(default)]
    pub is_final: Option<bool>,
    #[serde(default)]
    pub current_course: Option<String>,
    #[serde(default)]
    pub progress_current: Option<usize>,
    #[serde(default)]
    pub progress_total: Option<usize>,
    #[serde(default)]
    pub progress_pct: Option<f64>,
}

/// Atomic Transaction: commit toàn bộ payload Moodle (Courses, Tasks, Materials) vào SQLite.
pub fn commit_moodle_payload(
    conn: &mut Connection,
    payload: MoodleSyncPayload,
) -> Result<(usize, usize, usize), String> {
    crate::db::schema::ensure_moodle_schema(conn).map_err(|e| format!("Schema error: {e}"))?;
    crate::db::schema::ensure_sync_state_schema(conn).map_err(|e| format!("Sync schema error: {e}"))?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("Cannot begin transaction: {e}"))?;

    let now_ts = chrono::Utc::now().timestamp();

    // 1. Upsert moodle_courses
    let mut course_count = 0;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO moodle_courses (
                    course_id, course_code, fullname, term,
                    instructor_name, instructor_mail, instructor_phone,
                    course_url, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(course_id) DO UPDATE SET
                    course_code = excluded.course_code,
                    fullname = excluded.fullname,
                    term = CASE WHEN excluded.term != '' THEN excluded.term ELSE moodle_courses.term END,
                    instructor_name = CASE WHEN excluded.instructor_name != '' THEN excluded.instructor_name ELSE moodle_courses.instructor_name END,
                    instructor_mail = CASE WHEN excluded.instructor_mail != '' THEN excluded.instructor_mail ELSE moodle_courses.instructor_mail END,
                    instructor_phone = CASE WHEN excluded.instructor_phone != '' THEN excluded.instructor_phone ELSE moodle_courses.instructor_phone END,
                    course_url = excluded.course_url,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare insert course error: {e}"))?;

        for c in &payload.courses {
            let updated_at = if c.updated_at > 0 { c.updated_at } else { now_ts };
            stmt.execute(params![
                c.course_id,
                c.course_code,
                c.fullname,
                c.term,
                c.instructor_name,
                c.instructor_mail,
                c.instructor_phone,
                c.course_url,
                updated_at,
            ])
            .map_err(|e| format!("Execute insert course {} error: {e}", c.course_id))?;
            course_count += 1;
        }
    }

    // 2. Upsert moodle_tasks
    let mut task_count = 0;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO moodle_tasks (
                    task_id, course_id, title, task_type, due_date,
                    is_submitted, submission_status, template_file_url,
                    task_url, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(task_id) DO UPDATE SET
                    course_id = excluded.course_id,
                    title = excluded.title,
                    task_type = excluded.task_type,
                    due_date = excluded.due_date,
                    is_submitted = excluded.is_submitted,
                    submission_status = excluded.submission_status,
                    template_file_url = CASE WHEN excluded.template_file_url != '' THEN excluded.template_file_url ELSE moodle_tasks.template_file_url END,
                    task_url = excluded.task_url,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare insert task error: {e}"))?;

        for t in &payload.tasks {
            let updated_at = if t.updated_at > 0 { t.updated_at } else { now_ts };
            stmt.execute(params![
                t.task_id,
                t.course_id,
                t.title,
                t.task_type,
                t.due_date,
                if t.is_submitted { 1 } else { 0 },
                t.submission_status,
                t.template_file_url,
                t.task_url,
                updated_at,
            ])
            .map_err(|e| format!("Execute insert task {} error: {e}", t.task_id))?;
            task_count += 1;
        }
    }

    // 3. Upsert moodle_materials (xóa materials cũ của các course trong payload để tránh duplicates, bảo toàn file offline đã tải)
    let mut mat_count = 0;
    {
        let mut course_ids_touched = std::collections::HashSet::new();
        for m in &payload.materials {
            course_ids_touched.insert(m.course_id);
        }

        // Cache existing downloaded metadata: (course_id, file_url) -> (local_file_path, download_status, file_size_bytes)
        let mut existing_offline: std::collections::HashMap<(i64, String), (String, String, i64)> =
            std::collections::HashMap::new();
        for cid in &course_ids_touched {
            let mut sel = tx
                .prepare("SELECT file_url, local_file_path, download_status, file_size_bytes FROM moodle_materials WHERE course_id = ?1")
                .map_err(|e| format!("Prepare query offline materials: {e}"))?;
            let rows = sel
                .query_map(params![cid], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })
                .map_err(|e| format!("Query offline materials error: {e}"))?;
            for r in rows {
                if let Ok((url, path, status, size)) = r {
                    if !path.is_empty() || status == "synced" {
                        existing_offline.insert((*cid, url), (path, status, size));
                    }
                }
            }
        }

        let mut del_stmt = tx
            .prepare("DELETE FROM moodle_materials WHERE course_id = ?1")
            .map_err(|e| format!("Prepare del materials error: {e}"))?;

        for cid in &course_ids_touched {
            del_stmt
                .execute(params![cid])
                .map_err(|e| format!("Execute del materials for course {cid} error: {e}"))?;
        }

        let mut ins_stmt = tx
            .prepare(
                r#"
                INSERT INTO moodle_materials (
                    course_id, section_name, title, file_url, file_type, created_at,
                    local_file_path, download_status, file_size_bytes
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .map_err(|e| format!("Prepare insert material error: {e}"))?;

        for m in &payload.materials {
            let created_at = if m.created_at > 0 { m.created_at } else { now_ts };
            let (local_path, dl_status, file_size) = if let Some((p, s, sz)) =
                existing_offline.get(&(m.course_id, m.file_url.clone()))
            {
                (p.clone(), s.clone(), *sz)
            } else {
                (
                    m.local_file_path.clone(),
                    if m.download_status.is_empty() {
                        "online_only".to_string()
                    } else {
                        m.download_status.clone()
                    },
                    m.file_size_bytes,
                )
            };

            ins_stmt
                .execute(params![
                    m.course_id,
                    m.section_name,
                    m.title,
                    m.file_url,
                    m.file_type,
                    created_at,
                    local_path,
                    dl_status,
                    file_size,
                ])
                .map_err(|e| format!("Execute insert material error: {e}"))?;
            mat_count += 1;
        }
    }

    // 4. Update sync_state
    tx.execute(
        r#"
        INSERT INTO sync_state (service, last_synced_at)
        VALUES ('moodle', ?1)
        ON CONFLICT(service) DO UPDATE SET last_synced_at = excluded.last_synced_at
        "#,
        params![now_ts],
    )
    .map_err(|e| format!("Update sync_state error: {e}"))?;

    tx.commit().map_err(|e| format!("Transaction commit error: {e}"))?;

    Ok((course_count, task_count, mat_count))
}

pub fn get_all_moodle_courses(conn: &Connection) -> SqlResult<Vec<MoodleCourseRecord>> {
    crate::db::schema::ensure_moodle_schema(conn)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT course_id, course_code, fullname, term,
               instructor_name, instructor_mail, instructor_phone,
               course_url, COALESCE(status, 'active'), updated_at
        FROM moodle_courses
        ORDER BY course_code ASC
        "#,
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(MoodleCourseRecord {
            course_id: row.get(0)?,
            course_code: row.get(1)?,
            fullname: row.get(2)?,
            term: row.get(3)?,
            instructor_name: row.get(4)?,
            instructor_mail: row.get(5)?,
            instructor_phone: row.get(6)?,
            course_url: row.get(7)?,
            status: row.get(8)?,
            updated_at: row.get(9)?,
        })
    })?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r?);
    }
    Ok(list)
}

pub fn get_moodle_tasks(
    conn: &Connection,
    course_id: Option<i64>,
) -> SqlResult<Vec<MoodleTaskRecord>> {
    crate::db::schema::ensure_moodle_schema(conn)?;

    let query = match course_id {
        Some(_) => {
            r#"
            SELECT t.task_id, t.course_id, t.title, t.task_type, t.due_date,
                   t.is_submitted, t.submission_status, t.template_file_url,
                   t.task_url, t.updated_at, c.fullname, c.course_code
            FROM moodle_tasks t
            LEFT JOIN moodle_courses c ON c.course_id = t.course_id
            WHERE t.course_id = ?1
            ORDER BY t.due_date ASC
            "#
        }
        None => {
            r#"
            SELECT t.task_id, t.course_id, t.title, t.task_type, t.due_date,
                   t.is_submitted, t.submission_status, t.template_file_url,
                   t.task_url, t.updated_at, c.fullname, c.course_code
            FROM moodle_tasks t
            LEFT JOIN moodle_courses c ON c.course_id = t.course_id
            ORDER BY t.due_date ASC
            "#
        }
    };

    let mut stmt = conn.prepare(query)?;

    let mut rows = match course_id {
        Some(cid) => stmt.query(params![cid])?,
        None => stmt.query([])?,
    };

    let mut list = Vec::new();
    while let Some(row) = rows.next()? {
        let is_sub_int: i64 = row.get(5)?;
        list.push(MoodleTaskRecord {
            task_id: row.get(0)?,
            course_id: row.get(1)?,
            title: row.get(2)?,
            task_type: row.get(3)?,
            due_date: row.get(4)?,
            is_submitted: is_sub_int != 0,
            submission_status: row.get(6)?,
            template_file_url: row.get(7)?,
            task_url: row.get(8)?,
            updated_at: row.get(9)?,
            course_name: row.get(10)?,
            course_code: row.get(11)?,
        });
    }

    Ok(list)
}

pub fn get_moodle_materials(
    conn: &Connection,
    course_id: i64,
) -> SqlResult<Vec<MoodleMaterialRecord>> {
    crate::db::schema::ensure_moodle_schema(conn)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, course_id, section_name, title, file_url, file_type, created_at,
               local_file_path, download_status, file_size_bytes
        FROM moodle_materials
        WHERE course_id = ?1
        ORDER BY id ASC
        "#,
    )?;

    let rows = stmt.query_map(params![course_id], |row| {
        Ok(MoodleMaterialRecord {
            id: row.get(0)?,
            course_id: row.get(1)?,
            section_name: row.get(2)?,
            title: row.get(3)?,
            file_url: row.get(4)?,
            file_type: row.get(5)?,
            created_at: row.get(6)?,
            local_file_path: row.get(7)?,
            download_status: row.get(8)?,
            file_size_bytes: row.get(9)?,
        })
    })?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r?);
    }
    Ok(list)
}

pub fn get_material_by_id(
    conn: &Connection,
    material_id: i64,
) -> SqlResult<Option<MoodleMaterialRecord>> {
    crate::db::schema::ensure_moodle_schema(conn)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT id, course_id, section_name, title, file_url, file_type, created_at,
               local_file_path, download_status, file_size_bytes
        FROM moodle_materials
        WHERE id = ?1
        "#,
    )?;

    let mut rows = stmt.query_map(params![material_id], |row| {
        Ok(MoodleMaterialRecord {
            id: row.get(0)?,
            course_id: row.get(1)?,
            section_name: row.get(2)?,
            title: row.get(3)?,
            file_url: row.get(4)?,
            file_type: row.get(5)?,
            created_at: row.get(6)?,
            local_file_path: row.get(7)?,
            download_status: row.get(8)?,
            file_size_bytes: row.get(9)?,
        })
    })?;

    if let Some(r) = rows.next() {
        Ok(Some(r?))
    } else {
        Ok(None)
    }
}

pub fn update_material_download_status(
    conn: &Connection,
    material_id: i64,
    download_status: &str,
    local_file_path: &str,
    file_size_bytes: i64,
) -> SqlResult<()> {
    crate::db::schema::ensure_moodle_schema(conn)?;
    conn.execute(
        r#"
        UPDATE moodle_materials
        SET download_status = ?1, local_file_path = ?2, file_size_bytes = ?3
        WHERE id = ?4
        "#,
        params![download_status, local_file_path, file_size_bytes, material_id],
    )?;
    Ok(())
}

pub fn update_moodle_course_instructor(
    conn: &Connection,
    course_id: i64,
    instructor_name: &str,
    instructor_mail: &str,
    instructor_phone: &str,
) -> SqlResult<()> {
    let now_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    conn.execute(
        r#"
        UPDATE moodle_courses
        SET instructor_name = ?1,
            instructor_mail = ?2,
            instructor_phone = ?3,
            updated_at = ?4
        WHERE course_id = ?5
        "#,
        params![
            instructor_name,
            instructor_mail,
            instructor_phone,
            now_ts,
            course_id
        ],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::ensure_moodle_schema(&conn).unwrap();
        crate::db::schema::ensure_sync_state_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn test_commit_and_query_moodle_payload() {
        let mut conn = setup_test_db();

        let payload = MoodleSyncPayload {
            courses: vec![
                MoodleCourseRecord {
                    course_id: 1289,
                    course_code: "SS009.R12".to_string(),
                    fullname: "Chủ nghĩa xã hội khoa học - SS009.R12".to_string(),
                    term: "HK2 2025-2026".to_string(),
                    instructor_name: "ThS. Trịnh Bá Phương".to_string(),
                    instructor_mail: "phuongtbhcmue@gmail.com".to_string(),
                    instructor_phone: "0376 333 654".to_string(),
                    course_url: "https://courses.uit.edu.vn/course/view.php?id=1289".to_string(),
                    status: "active".to_string(),
                    updated_at: 1789663457,
                },
            ],
            tasks: vec![
                MoodleTaskRecord {
                    task_id: 11792,
                    course_id: 1289,
                    title: "ĐĂNG KÝ ĐỀ TÀI NHÓM".to_string(),
                    task_type: "assign".to_string(),
                    due_date: 1789750740,
                    is_submitted: false,
                    submission_status: "Chưa nộp".to_string(),
                    template_file_url: "https://courses.uit.edu.vn/mau.docx".to_string(),
                    task_url: "https://courses.uit.edu.vn/mod/assign/view.php?id=11792".to_string(),
                    updated_at: 1789663457,
                    course_name: None,
                    course_code: None,
                },
            ],
            materials: vec![
                MoodleMaterialRecord::new_online(
                    1,
                    1289,
                    "Tuần 2".to_string(),
                    "C1_Slide BG".to_string(),
                    "https://courses.uit.edu.vn/slide.pdf".to_string(),
                    "pdf".to_string(),
                    1789662966,
                ),
            ],
            ..Default::default()
        };

        let res = commit_moodle_payload(&mut conn, payload);
        assert!(res.is_ok(), "Commit moodle payload failed: {:?}", res);
        let (c, t, m) = res.unwrap();
        assert_eq!(c, 1);
        assert_eq!(t, 1);
        assert_eq!(m, 1);

        // Verify courses
        let courses = get_all_moodle_courses(&conn).unwrap();
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].course_code, "SS009.R12");
        assert_eq!(courses[0].instructor_name, "ThS. Trịnh Bá Phương");

        // Verify tasks with joined course name
        let tasks = get_moodle_tasks(&conn, None).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "ĐĂNG KÝ ĐỀ TÀI NHÓM");
        assert_eq!(tasks[0].course_code.as_deref(), Some("SS009.R12"));

        // Verify materials
        let materials = get_moodle_materials(&conn, 1289).unwrap();
        assert_eq!(materials.len(), 1);
        assert_eq!(materials[0].title, "C1_Slide BG");
        assert_eq!(materials[0].file_type, "pdf");

        // Verify sync_state
        let synced_at: i64 = conn
            .query_row(
                "SELECT last_synced_at FROM sync_state WHERE service = 'moodle'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(synced_at > 0);
    }

    #[test]
    fn test_manual_update_moodle_instructor_preserves_on_future_sync() {
        let mut conn = setup_test_db();

        // 1. Initial course with empty instructor
        let payload = MoodleSyncPayload {
            courses: vec![
                MoodleCourseRecord {
                    course_id: 1073,
                    course_code: "CS115.R11".to_string(),
                    fullname: "Toán cho khoa học máy tính".to_string(),
                    term: "HK2 2025-2026".to_string(),
                    instructor_name: "".to_string(),
                    instructor_mail: "".to_string(),
                    instructor_phone: "".to_string(),
                    course_url: "https://courses.uit.edu.vn/course/view.php?id=1073".to_string(),
                    status: "active".to_string(),
                    updated_at: 100,
                },
            ],
            tasks: vec![],
            materials: vec![],
            ..Default::default()
        };
        commit_moodle_payload(&mut conn, payload).unwrap();

        // 2. User manually customizes instructor info
        update_moodle_course_instructor(
            &conn,
            1073,
            "TS. Nguyễn Văn A",
            "anguyen@uit.edu.vn",
            "0909123456",
        )
        .unwrap();

        let updated = get_all_moodle_courses(&conn).unwrap();
        assert_eq!(updated[0].instructor_name, "TS. Nguyễn Văn A");
        assert_eq!(updated[0].instructor_mail, "anguyen@uit.edu.vn");
        assert_eq!(updated[0].instructor_phone, "0909123456");

        // 3. Subsequent Moodle sync where instructor info is still empty
        let sync_payload_2 = MoodleSyncPayload {
            courses: vec![
                MoodleCourseRecord {
                    course_id: 1073,
                    course_code: "CS115.R11".to_string(),
                    fullname: "Toán cho khoa học máy tính - Updated".to_string(),
                    term: "HK2 2025-2026".to_string(),
                    instructor_name: "".to_string(),
                    instructor_mail: "".to_string(),
                    instructor_phone: "".to_string(),
                    course_url: "https://courses.uit.edu.vn/course/view.php?id=1073".to_string(),
                    status: "active".to_string(),
                    updated_at: 200,
                },
            ],
            tasks: vec![],
            materials: vec![],
            ..Default::default()
        };
        commit_moodle_payload(&mut conn, sync_payload_2).unwrap();

        // 4. Verify user custom settings are preserved!
        let preserved = get_all_moodle_courses(&conn).unwrap();
        assert_eq!(preserved[0].fullname, "Toán cho khoa học máy tính - Updated");
        assert_eq!(preserved[0].instructor_name, "TS. Nguyễn Văn A");
        assert_eq!(preserved[0].instructor_mail, "anguyen@uit.edu.vn");
        assert_eq!(preserved[0].instructor_phone, "0909123456");
    }
}
