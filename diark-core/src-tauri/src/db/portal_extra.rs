use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Deserializer, Serialize};

/// Deserialize số nguyên từ cả JSON number lẫn string (VD: `"20900000"` hoặc `20900000`).
fn de_flexible_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let val = serde_json::Value::deserialize(deserializer)?;
    Ok(match val {
        serde_json::Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f.round() as i64))
            .unwrap_or(0),
        serde_json::Value::String(s) => s
            .trim()
            .replace(',', "")
            .parse::<f64>()
            .map(|f| f.round() as i64)
            .unwrap_or(0),
        _ => 0,
    })
}

fn de_flexible_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let val = serde_json::Value::deserialize(deserializer)?;
    Ok(match val {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
        serde_json::Value::String(s) => s.trim().replace(',', ".").parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    })
}

fn de_flexible_bool_int<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let val = serde_json::Value::deserialize(deserializer)?;
    Ok(match val {
        serde_json::Value::Bool(b) => b,
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        serde_json::Value::String(s) => {
            let trimmed = s.trim().to_ascii_lowercase();
            trimmed == "true" || trimmed == "1"
        }
        _ => false,
    })
}

fn de_flexible_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let val = serde_json::Value::deserialize(deserializer)?;
    Ok(match val {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => {
            if b {
                "true".to_string()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimetableSlotDto {
    #[serde(default)]
    pub thu: i64,
    #[serde(default, alias = "tietBatDau", alias = "tiet_bat_dau")]
    pub tiet_bat_dau: i64,
    #[serde(default, alias = "tietKetThuc", alias = "tiet_ket_thuc")]
    pub tiet_ket_thuc: i64,
    #[serde(default)]
    pub room: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortalRegisteredClassRecord {
    pub id: i64,
    pub code: String,
    pub subject_code: String,
    pub subject_name: String,
    pub subject_id: i64,
    pub has_syllabus: bool,
    pub credit: i64,
    pub lecturer: String,
    pub method_code: String,
    pub start_date: String,
    pub end_date: String,
    pub slots_json: String,
    pub hoc_ky: i64,
    pub year_id: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalRegisteredClassInput {
    pub id: i64,
    #[serde(default)]
    pub code: String,
    #[serde(default, alias = "subjectCode")]
    pub subject_code: String,
    #[serde(default, alias = "subjectName")]
    pub subject_name: String,
    #[serde(default, alias = "subjectId")]
    pub subject_id: i64,
    #[serde(default, alias = "hasSyllabus")]
    pub has_syllabus: bool,
    #[serde(default)]
    pub credit: i64,
    #[serde(default)]
    pub lecturer: String,
    #[serde(default, alias = "methodCode")]
    pub method_code: String,
    #[serde(default, alias = "startDate")]
    pub start_date: String,
    #[serde(default, alias = "endDate")]
    pub end_date: String,
    #[serde(default)]
    pub slots: Vec<TimetableSlotDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalTkbDangKyInput {
    #[serde(default, alias = "hocKy")]
    pub hoc_ky: i64,
    #[serde(default, alias = "yearId")]
    pub year_id: i64,
    #[serde(default)]
    pub rows: Vec<PortalRegisteredClassInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortalTimetableRecord {
    pub id: String,
    pub ma_lop: String,
    pub ten_mon_hoc: String,
    pub ngay: String,
    pub thu: i64,
    pub tiet_bat_dau: i64,
    pub tiet_ket_thuc: i64,
    pub phong: String,
    pub hinh_thuc: String,
    pub ten_giang_vien: String,
    pub lecturer_title: String,
    pub subject_id: i64,
    pub trang_thai: String,
    pub hoc_ky: i64,
    pub nam_hoc: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalTietInput {
    pub id: String,
    #[serde(default, alias = "maLop")]
    pub ma_lop: String,
    #[serde(default, alias = "tenMonHoc")]
    pub ten_mon_hoc: String,
    #[serde(default)]
    pub ngay: String,
    #[serde(default)]
    pub thu: i64,
    #[serde(default, alias = "tietBatDau")]
    pub tiet_bat_dau: i64,
    #[serde(default, alias = "tietKetThuc")]
    pub tiet_ket_thuc: i64,
    #[serde(default)]
    pub phong: String,
    #[serde(default, alias = "hinhThuc")]
    pub hinh_thuc: String,
    #[serde(default, alias = "tenGiangVien")]
    pub ten_giang_vien: String,
    #[serde(default, alias = "lecturerTitle")]
    pub lecturer_title: String,
    #[serde(default, alias = "subjectId")]
    pub subject_id: i64,
    #[serde(default, alias = "trangThai")]
    pub trang_thai: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalTkbInput {
    #[serde(default, alias = "hocKy")]
    pub hoc_ky: i64,
    #[serde(default, alias = "namHoc")]
    pub nam_hoc: i64,
    #[serde(default)]
    pub tiets: Vec<PortalTietInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortalTuitionRecord {
    pub id: i64,
    pub period: String,
    pub semester: String,
    pub year_id_name: String,
    pub subject_codes: String,
    pub tuition_amount: i64,
    pub must_be_paid: i64,
    pub paid: i64,
    pub remaining: i64,
    pub payment_status: String,
    pub payment_status_label: String,
    pub tuition_status: String,
    pub tuition_status_label: String,
    pub period_1_due_date: String,
    pub period_2_due_date: String,
    pub paid_time_formatted: String,
    pub details_json: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalTuitionInput {
    pub id: i64,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub period: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub semester: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub year_id_name: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub subject_codes: String,
    #[serde(default, deserialize_with = "de_flexible_i64")]
    pub tuition_amount: i64,
    #[serde(default, deserialize_with = "de_flexible_i64")]
    pub must_be_paid: i64,
    #[serde(default, deserialize_with = "de_flexible_i64")]
    pub paid: i64,
    #[serde(default, deserialize_with = "de_flexible_i64")]
    pub remaining: i64,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub payment_status: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub payment_status_label: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub tuition_status: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub tuition_status_label: String,
    #[serde(
        default,
        alias = "period_1_due_date_formatted",
        deserialize_with = "de_flexible_string"
    )]
    pub period_1_due_date: String,
    #[serde(
        default,
        alias = "period_2_due_date_formatted",
        deserialize_with = "de_flexible_string"
    )]
    pub period_2_due_date: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub paid_time_formatted: String,
    #[serde(default)]
    pub detail_ids: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PortalCertificateRecord {
    pub id: String,
    pub cert_type: String,
    pub tongdiem: f64,
    pub capdo: String,
    pub ngaythi: String,
    pub status: String,
    pub output_standard: bool,
    pub create_date: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalCertificateInput {
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub id: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub cert_type: String,
    #[serde(default, deserialize_with = "de_flexible_f64")]
    pub tongdiem: f64,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub capdo: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub ngaythi: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub status: String,
    #[serde(default, deserialize_with = "de_flexible_bool_int")]
    pub output_standard: bool,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub create_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortalClassActivityRecord {
    pub id: String,
    pub ngay: String,
    pub tiet_bat_dau: i64,
    pub tiet_ket_thuc: i64,
    pub noi_dung: String,
    pub dia_diem: String,
    pub gv_chu_tri: String,
    pub status: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalClassActivityInput {
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub id: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub ngay: String,
    #[serde(default, alias = "tietBatDau")]
    pub tiet_bat_dau: i64,
    #[serde(default, alias = "tietKetThuc")]
    pub tiet_ket_thuc: i64,
    #[serde(default, alias = "noiDung", deserialize_with = "de_flexible_string")]
    pub noi_dung: String,
    #[serde(default, alias = "diaDiem", deserialize_with = "de_flexible_string")]
    pub dia_diem: String,
    #[serde(default, alias = "gvChuTri", deserialize_with = "de_flexible_string")]
    pub gv_chu_tri: String,
    #[serde(default, deserialize_with = "de_flexible_string")]
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalExtraSyncPayload {
    #[serde(default)]
    pub tkb_dang_ky: Option<PortalTkbDangKyInput>,
    #[serde(default)]
    pub tkb: Option<PortalTkbInput>,
    #[serde(default)]
    pub tuition_records: Vec<PortalTuitionInput>,
    #[serde(default)]
    pub certificates: Vec<PortalCertificateInput>,
    #[serde(default)]
    pub class_activities: Vec<PortalClassActivityInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortalExtraSyncStats {
    pub classes_count: usize,
    pub timetable_count: usize,
    pub tuition_count: usize,
    pub certificates_count: usize,
    pub activities_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoogleCalendarConfig {
    pub id: String,
    pub name: String,
    pub ics_url: String,
    pub color: String,
    pub is_enabled: bool,
    pub last_synced_at: i64,
    pub created_at: i64,
    pub source: String,
    pub google_calendar_id: String,
    pub can_write: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CalendarEventRecord {
    pub uid: String,
    pub calendar_id: String,
    pub summary: String,
    pub description: String,
    pub location: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub all_day: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MoodleGradeRecord {
    pub course_id: i64,
    pub course_name: String,
    #[serde(default)]
    pub grade_text: String,
    #[serde(default)]
    pub grade_numeric: Option<f64>,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CourseSyllabusWeightDto {
    pub subject_code: String,
    pub subject_id: i64,
    pub qt_weight: i32,
    pub th_weight: i32,
    pub gk_weight: i32,
    pub ck_weight: i32,
    pub source: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MoodleNotificationRecord {
    pub id: i64,
    pub subject: String,
    #[serde(default, alias = "shortenedsubject")]
    pub shortened_subject: String,
    #[serde(default, alias = "fullmessage")]
    pub full_message: String,
    #[serde(default)]
    pub is_read: bool,
    #[serde(default, alias = "timecreated")]
    pub created_at: i64,
}

pub fn ensure_portal_extra_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS portal_registered_classes (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL,
            subject_code TEXT NOT NULL,
            subject_name TEXT NOT NULL,
            subject_id INTEGER NOT NULL DEFAULT 0,
            has_syllabus INTEGER NOT NULL DEFAULT 0,
            credit INTEGER NOT NULL DEFAULT 0,
            lecturer TEXT NOT NULL DEFAULT '',
            method_code TEXT NOT NULL DEFAULT '',
            start_date TEXT NOT NULL DEFAULT '',
            end_date TEXT NOT NULL DEFAULT '',
            slots_json TEXT NOT NULL DEFAULT '[]',
            hoc_ky INTEGER NOT NULL DEFAULT 1,
            year_id INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS portal_timetable (
            id TEXT PRIMARY KEY,
            ma_lop TEXT NOT NULL,
            ten_mon_hoc TEXT NOT NULL,
            ngay TEXT NOT NULL,
            thu INTEGER NOT NULL,
            tiet_bat_dau INTEGER NOT NULL,
            tiet_ket_thuc INTEGER NOT NULL,
            phong TEXT NOT NULL DEFAULT '',
            hinh_thuc TEXT NOT NULL DEFAULT '',
            ten_giang_vien TEXT NOT NULL DEFAULT '',
            lecturer_title TEXT NOT NULL DEFAULT '',
            subject_id INTEGER NOT NULL DEFAULT 0,
            trang_thai TEXT NOT NULL DEFAULT 'normal',
            hoc_ky INTEGER NOT NULL DEFAULT 1,
            nam_hoc INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_portal_timetable_ngay ON portal_timetable(ngay);

        CREATE TABLE IF NOT EXISTS portal_tuition (
            id INTEGER PRIMARY KEY,
            period TEXT NOT NULL,
            semester TEXT NOT NULL DEFAULT '',
            year_id_name TEXT NOT NULL DEFAULT '',
            subject_codes TEXT NOT NULL DEFAULT '',
            tuition_amount INTEGER NOT NULL DEFAULT 0,
            must_be_paid INTEGER NOT NULL DEFAULT 0,
            paid INTEGER NOT NULL DEFAULT 0,
            remaining INTEGER NOT NULL DEFAULT 0,
            payment_status TEXT NOT NULL DEFAULT '',
            payment_status_label TEXT NOT NULL DEFAULT '',
            tuition_status TEXT NOT NULL DEFAULT '',
            tuition_status_label TEXT NOT NULL DEFAULT '',
            period_1_due_date TEXT NOT NULL DEFAULT '',
            period_2_due_date TEXT NOT NULL DEFAULT '',
            paid_time_formatted TEXT NOT NULL DEFAULT '',
            details_json TEXT NOT NULL DEFAULT '[]',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS portal_certificates (
            id TEXT PRIMARY KEY,
            cert_type TEXT NOT NULL,
            tongdiem REAL NOT NULL DEFAULT 0,
            capdo TEXT NOT NULL DEFAULT '',
            ngaythi TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            output_standard INTEGER NOT NULL DEFAULT 0,
            create_date TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS course_syllabus_weights (
            subject_code TEXT PRIMARY KEY,
            subject_id INTEGER NOT NULL DEFAULT 0,
            qt_weight INTEGER NOT NULL DEFAULT 0,
            th_weight INTEGER NOT NULL DEFAULT 0,
            gk_weight INTEGER NOT NULL DEFAULT 0,
            ck_weight INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'syllabus_pdf',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS portal_class_activities (
            id TEXT PRIMARY KEY,
            ngay TEXT NOT NULL,
            tiet_bat_dau INTEGER NOT NULL DEFAULT 0,
            tiet_ket_thuc INTEGER NOT NULL DEFAULT 0,
            noi_dung TEXT NOT NULL,
            dia_diem TEXT NOT NULL DEFAULT '',
            gv_chu_tri TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS google_calendars (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ics_url TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#10b981',
            is_enabled INTEGER NOT NULL DEFAULT 1,
            last_synced_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS calendar_events (
            uid TEXT NOT NULL,
            calendar_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            start_ts INTEGER NOT NULL,
            end_ts INTEGER NOT NULL,
            all_day INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (calendar_id, uid),
            FOREIGN KEY (calendar_id) REFERENCES google_calendars(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_ts);

        CREATE TABLE IF NOT EXISTS moodle_grades (
            course_id INTEGER PRIMARY KEY,
            course_name TEXT NOT NULL,
            grade_text TEXT NOT NULL DEFAULT '',
            grade_numeric REAL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS moodle_notifications (
            id INTEGER PRIMARY KEY,
            subject TEXT NOT NULL,
            shortened_subject TEXT NOT NULL DEFAULT '',
            full_message TEXT NOT NULL DEFAULT '',
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        "#,
    )?;

    // Idempotent migrations cho đồng bộ Google Calendar OAuth 2 chiều
    for alter_sql in [
        "ALTER TABLE google_calendars ADD COLUMN source TEXT NOT NULL DEFAULT 'ics'",
        "ALTER TABLE google_calendars ADD COLUMN google_calendar_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE google_calendars ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0",
    ] {
        let _ = conn.execute(alter_sql, []);
    }

    Ok(())
}

pub fn commit_portal_extra_payload(
    conn: &mut Connection,
    payload: &PortalExtraSyncPayload,
) -> Result<PortalExtraSyncStats, String> {
    ensure_portal_extra_schema(conn).map_err(|e| format!("Schema error: {e}"))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Cannot start tx: {e}"))?;
    let now_ts = chrono::Utc::now().timestamp();
    let mut stats = PortalExtraSyncStats::default();

    if let Some(ref dang_ky) = payload.tkb_dang_ky {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO portal_registered_classes (
                    id, code, subject_code, subject_name, subject_id,
                    has_syllabus, credit, lecturer, method_code,
                    start_date, end_date, slots_json, hoc_ky, year_id, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                ON CONFLICT(id) DO UPDATE SET
                    code = excluded.code,
                    subject_code = excluded.subject_code,
                    subject_name = excluded.subject_name,
                    subject_id = excluded.subject_id,
                    has_syllabus = excluded.has_syllabus,
                    credit = excluded.credit,
                    lecturer = excluded.lecturer,
                    method_code = excluded.method_code,
                    start_date = excluded.start_date,
                    end_date = excluded.end_date,
                    slots_json = excluded.slots_json,
                    hoc_ky = excluded.hoc_ky,
                    year_id = excluded.year_id,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare registered classes error: {e}"))?;

        for row in &dang_ky.rows {
            let slots_json =
                serde_json::to_string(&row.slots).unwrap_or_else(|_| "[]".to_string());
            stmt.execute(params![
                row.id,
                row.code.trim(),
                row.subject_code.trim(),
                row.subject_name.trim(),
                row.subject_id,
                if row.has_syllabus { 1 } else { 0 },
                row.credit,
                row.lecturer.trim(),
                row.method_code.trim(),
                row.start_date.trim(),
                row.end_date.trim(),
                slots_json,
                dang_ky.hoc_ky,
                dang_ky.year_id,
                now_ts,
            ])
            .map_err(|e| format!("Insert registered class {} error: {e}", row.id))?;
            stats.classes_count += 1;
        }
    }

    if let Some(ref tkb) = payload.tkb {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO portal_timetable (
                    id, ma_lop, ten_mon_hoc, ngay, thu, tiet_bat_dau, tiet_ket_thuc,
                    phong, hinh_thuc, ten_giang_vien, lecturer_title,
                    subject_id, trang_thai, hoc_ky, nam_hoc, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(id) DO UPDATE SET
                    ma_lop = excluded.ma_lop,
                    ten_mon_hoc = excluded.ten_mon_hoc,
                    ngay = excluded.ngay,
                    thu = excluded.thu,
                    tiet_bat_dau = excluded.tiet_bat_dau,
                    tiet_ket_thuc = excluded.tiet_ket_thuc,
                    phong = excluded.phong,
                    hinh_thuc = excluded.hinh_thuc,
                    ten_giang_vien = excluded.ten_giang_vien,
                    lecturer_title = excluded.lecturer_title,
                    subject_id = excluded.subject_id,
                    trang_thai = excluded.trang_thai,
                    hoc_ky = excluded.hoc_ky,
                    nam_hoc = excluded.nam_hoc,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare timetable error: {e}"))?;

        for t in &tkb.tiets {
            if t.id.trim().is_empty() {
                continue;
            }
            stmt.execute(params![
                t.id.trim(),
                t.ma_lop.trim(),
                t.ten_mon_hoc.trim(),
                t.ngay.trim(),
                t.thu,
                t.tiet_bat_dau,
                t.tiet_ket_thuc,
                t.phong.trim(),
                t.hinh_thuc.trim(),
                t.ten_giang_vien.trim(),
                t.lecturer_title.trim(),
                t.subject_id,
                if t.trang_thai.trim().is_empty() {
                    "normal"
                } else {
                    t.trang_thai.trim()
                },
                tkb.hoc_ky,
                tkb.nam_hoc,
                now_ts,
            ])
            .map_err(|e| format!("Insert timetable {} error: {e}", t.id))?;
            stats.timetable_count += 1;
        }
    }

    if !payload.tuition_records.is_empty() {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO portal_tuition (
                    id, period, semester, year_id_name, subject_codes,
                    tuition_amount, must_be_paid, paid, remaining,
                    payment_status, payment_status_label,
                    tuition_status, tuition_status_label,
                    period_1_due_date, period_2_due_date, paid_time_formatted,
                    details_json, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
                ON CONFLICT(id) DO UPDATE SET
                    period = excluded.period,
                    semester = excluded.semester,
                    year_id_name = excluded.year_id_name,
                    subject_codes = excluded.subject_codes,
                    tuition_amount = excluded.tuition_amount,
                    must_be_paid = excluded.must_be_paid,
                    paid = excluded.paid,
                    remaining = excluded.remaining,
                    payment_status = excluded.payment_status,
                    payment_status_label = excluded.payment_status_label,
                    tuition_status = excluded.tuition_status,
                    tuition_status_label = excluded.tuition_status_label,
                    period_1_due_date = excluded.period_1_due_date,
                    period_2_due_date = excluded.period_2_due_date,
                    paid_time_formatted = excluded.paid_time_formatted,
                    details_json = excluded.details_json,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare tuition error: {e}"))?;

        for rec in &payload.tuition_records {
            let details_json =
                serde_json::to_string(&rec.detail_ids).unwrap_or_else(|_| "[]".to_string());
            stmt.execute(params![
                rec.id,
                rec.period.trim(),
                rec.semester.trim(),
                rec.year_id_name.trim(),
                rec.subject_codes.trim(),
                rec.tuition_amount,
                rec.must_be_paid,
                rec.paid,
                rec.remaining,
                rec.payment_status.trim(),
                rec.payment_status_label.trim(),
                rec.tuition_status.trim(),
                rec.tuition_status_label.trim(),
                rec.period_1_due_date.trim(),
                rec.period_2_due_date.trim(),
                rec.paid_time_formatted.trim(),
                details_json,
                now_ts,
            ])
            .map_err(|e| format!("Insert tuition {} error: {e}", rec.id))?;
            stats.tuition_count += 1;
        }
    }

    if !payload.certificates.is_empty() {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO portal_certificates (
                    id, cert_type, tongdiem, capdo, ngaythi, status,
                    output_standard, create_date, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET
                    cert_type = excluded.cert_type,
                    tongdiem = excluded.tongdiem,
                    capdo = excluded.capdo,
                    ngaythi = excluded.ngaythi,
                    status = excluded.status,
                    output_standard = excluded.output_standard,
                    create_date = excluded.create_date,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare certificate error: {e}"))?;

        for cert in &payload.certificates {
            if cert.id.trim().is_empty() {
                continue;
            }
            stmt.execute(params![
                cert.id.trim(),
                cert.cert_type.trim(),
                cert.tongdiem,
                cert.capdo.trim(),
                cert.ngaythi.trim(),
                cert.status.trim(),
                if cert.output_standard { 1 } else { 0 },
                cert.create_date.trim(),
                now_ts,
            ])
            .map_err(|e| format!("Insert cert {} error: {e}", cert.id))?;
            stats.certificates_count += 1;
        }
    }

    if !payload.class_activities.is_empty() {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO portal_class_activities (
                    id, ngay, tiet_bat_dau, tiet_ket_thuc, noi_dung,
                    dia_diem, gv_chu_tri, status, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(id) DO UPDATE SET
                    ngay = excluded.ngay,
                    tiet_bat_dau = excluded.tiet_bat_dau,
                    tiet_ket_thuc = excluded.tiet_ket_thuc,
                    noi_dung = excluded.noi_dung,
                    dia_diem = excluded.dia_diem,
                    gv_chu_tri = excluded.gv_chu_tri,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare class activity error: {e}"))?;

        for act in &payload.class_activities {
            if act.id.trim().is_empty() {
                continue;
            }
            stmt.execute(params![
                act.id.trim(),
                act.ngay.trim(),
                act.tiet_bat_dau,
                act.tiet_ket_thuc,
                act.noi_dung.trim(),
                act.dia_diem.trim(),
                act.gv_chu_tri.trim(),
                act.status.trim(),
                now_ts,
            ])
            .map_err(|e| format!("Insert class activity {} error: {e}", act.id))?;
            stats.activities_count += 1;
        }
    }

    tx.commit().map_err(|e| format!("Commit tx error: {e}"))?;
    Ok(stats)
}

pub fn upsert_course_syllabus_weight(
    conn: &Connection,
    subject_code: &str,
    subject_id: i64,
    weights: &crate::services::syllabus_parser::ParsedSyllabusWeights,
) -> SqlResult<()> {
    ensure_portal_extra_schema(conn)?;
    let now_ts = chrono::Utc::now().timestamp();
    let clean_code = subject_code.trim().to_uppercase();
    conn.execute(
        r#"
        INSERT INTO course_syllabus_weights (
            subject_code, subject_id, qt_weight, th_weight, gk_weight, ck_weight, source, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'syllabus_pdf', ?7)
        ON CONFLICT(subject_code) DO UPDATE SET
            subject_id = excluded.subject_id,
            qt_weight = excluded.qt_weight,
            th_weight = excluded.th_weight,
            gk_weight = excluded.gk_weight,
            ck_weight = excluded.ck_weight,
            source = excluded.source,
            updated_at = excluded.updated_at
        "#,
        params![
            clean_code,
            subject_id,
            weights.qt,
            weights.th,
            weights.gk,
            weights.ck,
            now_ts
        ],
    )?;
    Ok(())
}

pub fn get_all_course_syllabus_weights(conn: &Connection) -> SqlResult<Vec<CourseSyllabusWeightDto>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT subject_code, subject_id, qt_weight, th_weight, gk_weight, ck_weight, source, updated_at
         FROM course_syllabus_weights
         ORDER BY subject_code ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(CourseSyllabusWeightDto {
            subject_code: r.get(0)?,
            subject_id: r.get(1)?,
            qt_weight: r.get(2)?,
            th_weight: r.get(3)?,
            gk_weight: r.get(4)?,
            ck_weight: r.get(5)?,
            source: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_known_syllabus_subject_codes(conn: &Connection) -> SqlResult<Vec<String>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt =
        conn.prepare("SELECT subject_code FROM course_syllabus_weights ORDER BY subject_code ASC")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_registered_classes(conn: &Connection) -> SqlResult<Vec<PortalRegisteredClassRecord>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, code, subject_code, subject_name, subject_id, has_syllabus,
                credit, lecturer, method_code, start_date, end_date, slots_json,
                hoc_ky, year_id, updated_at
         FROM portal_registered_classes
         ORDER BY subject_code ASC, code ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PortalRegisteredClassRecord {
            id: r.get(0)?,
            code: r.get(1)?,
            subject_code: r.get(2)?,
            subject_name: r.get(3)?,
            subject_id: r.get(4)?,
            has_syllabus: r.get::<_, i64>(5)? != 0,
            credit: r.get(6)?,
            lecturer: r.get(7)?,
            method_code: r.get(8)?,
            start_date: r.get(9)?,
            end_date: r.get(10)?,
            slots_json: r.get(11)?,
            hoc_ky: r.get(12)?,
            year_id: r.get(13)?,
            updated_at: r.get(14)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_timetable_range(
    conn: &Connection,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> SqlResult<Vec<PortalTimetableRecord>> {
    ensure_portal_extra_schema(conn)?;
    let sql = match (start_date, end_date) {
        (Some(_), Some(_)) => {
            "SELECT id, ma_lop, ten_mon_hoc, ngay, thu, tiet_bat_dau, tiet_ket_thuc,
                    phong, hinh_thuc, ten_giang_vien, lecturer_title, subject_id,
                    trang_thai, hoc_ky, nam_hoc, updated_at
             FROM portal_timetable
             WHERE ngay >= ?1 AND ngay <= ?2
             ORDER BY ngay ASC, tiet_bat_dau ASC"
        }
        _ => {
            "SELECT id, ma_lop, ten_mon_hoc, ngay, thu, tiet_bat_dau, tiet_ket_thuc,
                    phong, hinh_thuc, ten_giang_vien, lecturer_title, subject_id,
                    trang_thai, hoc_ky, nam_hoc, updated_at
             FROM portal_timetable
             ORDER BY ngay ASC, tiet_bat_dau ASC"
        }
    };

    let mut stmt = conn.prepare(sql)?;
    let mapper = |r: &rusqlite::Row<'_>| -> SqlResult<PortalTimetableRecord> {
        Ok(PortalTimetableRecord {
            id: r.get(0)?,
            ma_lop: r.get(1)?,
            ten_mon_hoc: r.get(2)?,
            ngay: r.get(3)?,
            thu: r.get(4)?,
            tiet_bat_dau: r.get(5)?,
            tiet_ket_thuc: r.get(6)?,
            phong: r.get(7)?,
            hinh_thuc: r.get(8)?,
            ten_giang_vien: r.get(9)?,
            lecturer_title: r.get(10)?,
            subject_id: r.get(11)?,
            trang_thai: r.get(12)?,
            hoc_ky: r.get(13)?,
            nam_hoc: r.get(14)?,
            updated_at: r.get(15)?,
        })
    };

    let mut out = Vec::new();
    match (start_date, end_date) {
        (Some(s), Some(e)) => {
            let rows = stmt.query_map(params![s, e], mapper)?;
            for row in rows {
                out.push(row?);
            }
        }
        _ => {
            let rows = stmt.query_map([], mapper)?;
            for row in rows {
                out.push(row?);
            }
        }
    }
    Ok(out)
}

pub fn get_tuition_records(conn: &Connection) -> SqlResult<Vec<PortalTuitionRecord>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, period, semester, year_id_name, subject_codes,
                tuition_amount, must_be_paid, paid, remaining,
                payment_status, payment_status_label,
                tuition_status, tuition_status_label,
                period_1_due_date, period_2_due_date, paid_time_formatted,
                details_json, updated_at
         FROM portal_tuition
         ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PortalTuitionRecord {
            id: r.get(0)?,
            period: r.get(1)?,
            semester: r.get(2)?,
            year_id_name: r.get(3)?,
            subject_codes: r.get(4)?,
            tuition_amount: r.get(5)?,
            must_be_paid: r.get(6)?,
            paid: r.get(7)?,
            remaining: r.get(8)?,
            payment_status: r.get(9)?,
            payment_status_label: r.get(10)?,
            tuition_status: r.get(11)?,
            tuition_status_label: r.get(12)?,
            period_1_due_date: r.get(13)?,
            period_2_due_date: r.get(14)?,
            paid_time_formatted: r.get(15)?,
            details_json: r.get(16)?,
            updated_at: r.get(17)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_certificates(conn: &Connection) -> SqlResult<Vec<PortalCertificateRecord>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, cert_type, tongdiem, capdo, ngaythi, status, output_standard, create_date, updated_at
         FROM portal_certificates
         ORDER BY create_date DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PortalCertificateRecord {
            id: r.get(0)?,
            cert_type: r.get(1)?,
            tongdiem: r.get(2)?,
            capdo: r.get(3)?,
            ngaythi: r.get(4)?,
            status: r.get(5)?,
            output_standard: r.get::<_, i64>(6)? != 0,
            create_date: r.get(7)?,
            updated_at: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_class_activities(conn: &Connection) -> SqlResult<Vec<PortalClassActivityRecord>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, ngay, tiet_bat_dau, tiet_ket_thuc, noi_dung, dia_diem, gv_chu_tri, status, updated_at
         FROM portal_class_activities
         ORDER BY ngay DESC, tiet_bat_dau ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PortalClassActivityRecord {
            id: r.get(0)?,
            ngay: r.get(1)?,
            tiet_bat_dau: r.get(2)?,
            tiet_ket_thuc: r.get(3)?,
            noi_dung: r.get(4)?,
            dia_diem: r.get(5)?,
            gv_chu_tri: r.get(6)?,
            status: r.get(7)?,
            updated_at: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_google_calendars(conn: &Connection) -> SqlResult<Vec<GoogleCalendarConfig>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, ics_url, color, is_enabled, last_synced_at, created_at,
                source, google_calendar_id, can_write
         FROM google_calendars
         ORDER BY CASE WHEN source = 'oauth' THEN 0 ELSE 1 END, created_at ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        let raw_url: String = r.get(2)?;
        let ics_url = crate::db::secret_store::decrypt_secret(&raw_url).unwrap_or(raw_url);
        Ok(GoogleCalendarConfig {
            id: r.get(0)?,
            name: r.get(1)?,
            ics_url,
            color: r.get(3)?,
            is_enabled: r.get::<_, i64>(4)? != 0,
            last_synced_at: r.get(5)?,
            created_at: r.get(6)?,
            source: r.get(7)?,
            google_calendar_id: r.get(8)?,
            can_write: r.get::<_, i64>(9)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_google_calendar_by_id(
    conn: &Connection,
    id: &str,
) -> SqlResult<Option<GoogleCalendarConfig>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, name, ics_url, color, is_enabled, last_synced_at, created_at,
                source, google_calendar_id, can_write
         FROM google_calendars WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(r) = rows.next()? {
        let raw_url: String = r.get(2)?;
        let ics_url = crate::db::secret_store::decrypt_secret(&raw_url).unwrap_or(raw_url);
        return Ok(Some(GoogleCalendarConfig {
            id: r.get(0)?,
            name: r.get(1)?,
            ics_url,
            color: r.get(3)?,
            is_enabled: r.get::<_, i64>(4)? != 0,
            last_synced_at: r.get(5)?,
            created_at: r.get(6)?,
            source: r.get(7)?,
            google_calendar_id: r.get(8)?,
            can_write: r.get::<_, i64>(9)? != 0,
        }));
    }
    Ok(None)
}

pub fn upsert_google_calendar(
    conn: &Connection,
    id: &str,
    name: &str,
    ics_url: &str,
    color: &str,
) -> SqlResult<GoogleCalendarConfig> {
    ensure_portal_extra_schema(conn)?;
    let now_ts = chrono::Utc::now().timestamp();
    let encrypted_url = crate::db::secret_store::encrypt_secret(ics_url).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            e,
        )))
    })?;
    conn.execute(
        r#"
        INSERT INTO google_calendars (
            id, name, ics_url, color, is_enabled, last_synced_at, created_at,
            source, google_calendar_id, can_write
        )
        VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, 'ics', '', 0)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            ics_url = excluded.ics_url,
            color = excluded.color
        "#,
        params![id, name, encrypted_url, color, now_ts],
    )?;

    conn.query_row(
        "SELECT id, name, ics_url, color, is_enabled, last_synced_at, created_at,
                source, google_calendar_id, can_write
         FROM google_calendars WHERE id = ?1",
        params![id],
        |r| {
            let raw_url: String = r.get(2)?;
            let plain_url = crate::db::secret_store::decrypt_secret(&raw_url).unwrap_or(raw_url);
            Ok(GoogleCalendarConfig {
                id: r.get(0)?,
                name: r.get(1)?,
                ics_url: plain_url,
                color: r.get(3)?,
                is_enabled: r.get::<_, i64>(4)? != 0,
                last_synced_at: r.get(5)?,
                created_at: r.get(6)?,
                source: r.get(7)?,
                google_calendar_id: r.get(8)?,
                can_write: r.get::<_, i64>(9)? != 0,
            })
        },
    )
}

pub fn upsert_oauth_google_calendar(
    conn: &Connection,
    google_calendar_id: &str,
    name: &str,
    color: &str,
    can_write: bool,
) -> SqlResult<GoogleCalendarConfig> {
    ensure_portal_extra_schema(conn)?;
    let now_ts = chrono::Utc::now().timestamp();
    let local_id = format!("oauth:{google_calendar_id}");
    conn.execute(
        r#"
        INSERT INTO google_calendars (
            id, name, ics_url, color, is_enabled, last_synced_at, created_at,
            source, google_calendar_id, can_write
        )
        VALUES (?1, ?2, '', ?3, 1, 0, ?4, 'oauth', ?5, ?6)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            color = excluded.color,
            source = 'oauth',
            google_calendar_id = excluded.google_calendar_id,
            can_write = excluded.can_write
        "#,
        params![
            local_id,
            name,
            color,
            now_ts,
            google_calendar_id,
            if can_write { 1 } else { 0 }
        ],
    )?;

    conn.query_row(
        "SELECT id, name, ics_url, color, is_enabled, last_synced_at, created_at,
                source, google_calendar_id, can_write
         FROM google_calendars WHERE id = ?1",
        params![local_id],
        |r| {
            Ok(GoogleCalendarConfig {
                id: r.get(0)?,
                name: r.get(1)?,
                ics_url: r.get(2)?,
                color: r.get(3)?,
                is_enabled: r.get::<_, i64>(4)? != 0,
                last_synced_at: r.get(5)?,
                created_at: r.get(6)?,
                source: r.get(7)?,
                google_calendar_id: r.get(8)?,
                can_write: r.get::<_, i64>(9)? != 0,
            })
        },
    )
}

pub fn delete_oauth_calendars(conn: &Connection) -> SqlResult<()> {
    ensure_portal_extra_schema(conn)?;
    conn.execute(
        "DELETE FROM calendar_events WHERE calendar_id IN (SELECT id FROM google_calendars WHERE source = 'oauth')",
        [],
    )?;
    conn.execute("DELETE FROM google_calendars WHERE source = 'oauth'", [])?;
    Ok(())
}

pub fn upsert_single_calendar_event(conn: &Connection, ev: &CalendarEventRecord) -> SqlResult<()> {
    ensure_portal_extra_schema(conn)?;
    let now_ts = chrono::Utc::now().timestamp();
    conn.execute(
        r#"
        INSERT INTO calendar_events (
            uid, calendar_id, summary, description, location,
            start_ts, end_ts, all_day, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(calendar_id, uid) DO UPDATE SET
            summary = excluded.summary,
            description = excluded.description,
            location = excluded.location,
            start_ts = excluded.start_ts,
            end_ts = excluded.end_ts,
            all_day = excluded.all_day,
            updated_at = excluded.updated_at
        "#,
        params![
            ev.uid,
            ev.calendar_id,
            ev.summary,
            ev.description,
            ev.location,
            ev.start_ts,
            ev.end_ts,
            if ev.all_day { 1 } else { 0 },
            now_ts,
        ],
    )?;
    Ok(())
}

pub fn delete_single_calendar_event(
    conn: &Connection,
    calendar_id: &str,
    uid: &str,
) -> SqlResult<()> {
    ensure_portal_extra_schema(conn)?;
    conn.execute(
        "DELETE FROM calendar_events WHERE calendar_id = ?1 AND uid = ?2",
        params![calendar_id, uid],
    )?;
    Ok(())
}

pub fn delete_google_calendar(conn: &Connection, id: &str) -> SqlResult<()> {
    ensure_portal_extra_schema(conn)?;
    conn.execute("DELETE FROM calendar_events WHERE calendar_id = ?1", params![id])?;
    conn.execute("DELETE FROM google_calendars WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_google_calendar_enabled(
    conn: &Connection,
    id: &str,
    is_enabled: bool,
) -> SqlResult<()> {
    ensure_portal_extra_schema(conn)?;
    conn.execute(
        "UPDATE google_calendars SET is_enabled = ?2 WHERE id = ?1",
        params![id, if is_enabled { 1 } else { 0 }],
    )?;
    Ok(())
}

pub fn replace_calendar_events(
    conn: &mut Connection,
    calendar_id: &str,
    events: &[CalendarEventRecord],
) -> Result<usize, String> {
    ensure_portal_extra_schema(conn).map_err(|e| format!("Schema error: {e}"))?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Cannot start tx: {e}"))?;
    let now_ts = chrono::Utc::now().timestamp();

    tx.execute(
        "DELETE FROM calendar_events WHERE calendar_id = ?1",
        params![calendar_id],
    )
    .map_err(|e| format!("Delete old events error: {e}"))?;

    let mut inserted = 0;
    {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO calendar_events (
                    uid, calendar_id, summary, description, location,
                    start_ts, end_ts, all_day, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(calendar_id, uid) DO UPDATE SET
                    summary = excluded.summary,
                    description = excluded.description,
                    location = excluded.location,
                    start_ts = excluded.start_ts,
                    end_ts = excluded.end_ts,
                    all_day = excluded.all_day,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare calendar event error: {e}"))?;

        for ev in events {
            stmt.execute(params![
                ev.uid,
                calendar_id,
                ev.summary,
                ev.description,
                ev.location,
                ev.start_ts,
                ev.end_ts,
                if ev.all_day { 1 } else { 0 },
                now_ts,
            ])
            .map_err(|e| format!("Insert calendar event {} error: {e}", ev.uid))?;
            inserted += 1;
        }
    }

    tx.execute(
        "UPDATE google_calendars SET last_synced_at = ?2 WHERE id = ?1",
        params![calendar_id, now_ts],
    )
    .map_err(|e| format!("Update last_synced_at error: {e}"))?;

    tx.commit().map_err(|e| format!("Commit tx error: {e}"))?;
    Ok(inserted)
}

pub fn get_calendar_events_range(
    conn: &Connection,
    start_ts: i64,
    end_ts: i64,
) -> SqlResult<Vec<CalendarEventRecord>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        r#"
        SELECT e.uid, e.calendar_id, e.summary, e.description, e.location,
               e.start_ts, e.end_ts, e.all_day, e.updated_at
        FROM calendar_events e
        INNER JOIN google_calendars c ON c.id = e.calendar_id
        WHERE c.is_enabled = 1
          AND (e.end_ts > ?1 OR (e.end_ts = e.start_ts AND e.start_ts >= ?1))
          AND e.start_ts <= ?2
        ORDER BY e.start_ts ASC
        "#,
    )?;
    let rows = stmt.query_map(params![start_ts, end_ts], |r| {
        Ok(CalendarEventRecord {
            uid: r.get(0)?,
            calendar_id: r.get(1)?,
            summary: r.get(2)?,
            description: r.get(3)?,
            location: r.get(4)?,
            start_ts: r.get(5)?,
            end_ts: r.get(6)?,
            all_day: r.get::<_, i64>(7)? != 0,
            updated_at: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn upsert_moodle_grades_and_notifications(
    tx: &rusqlite::Transaction<'_>,
    grades: &[MoodleGradeRecord],
    notifications: &[MoodleNotificationRecord],
    now_ts: i64,
) -> Result<(), String> {
    if !grades.is_empty() {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO moodle_grades (course_id, course_name, grade_text, grade_numeric, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(course_id) DO UPDATE SET
                    course_name = excluded.course_name,
                    grade_text = excluded.grade_text,
                    grade_numeric = excluded.grade_numeric,
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| format!("Prepare moodle grade error: {e}"))?;

        for g in grades {
            let updated_at = if g.updated_at > 0 { g.updated_at } else { now_ts };
            stmt.execute(params![
                g.course_id,
                g.course_name.trim(),
                g.grade_text.trim(),
                g.grade_numeric,
                updated_at,
            ])
            .map_err(|e| format!("Insert moodle grade {} error: {e}", g.course_id))?;
        }
    }

    if !notifications.is_empty() {
        let mut stmt = tx
            .prepare(
                r#"
                INSERT INTO moodle_notifications (id, subject, shortened_subject, full_message, is_read, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(id) DO UPDATE SET
                    subject = excluded.subject,
                    shortened_subject = excluded.shortened_subject,
                    full_message = excluded.full_message,
                    is_read = excluded.is_read
                "#,
            )
            .map_err(|e| format!("Prepare moodle notification error: {e}"))?;

        for n in notifications {
            let created_at = if n.created_at > 0 { n.created_at } else { now_ts };
            stmt.execute(params![
                n.id,
                n.subject.trim(),
                n.shortened_subject.trim(),
                n.full_message.trim(),
                if n.is_read { 1 } else { 0 },
                created_at,
            ])
            .map_err(|e| format!("Insert moodle notification {} error: {e}", n.id))?;
        }
    }

    Ok(())
}

pub fn get_moodle_grades(conn: &Connection) -> SqlResult<Vec<MoodleGradeRecord>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT course_id, course_name, grade_text, grade_numeric, updated_at
         FROM moodle_grades
         ORDER BY course_name ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MoodleGradeRecord {
            course_id: r.get(0)?,
            course_name: r.get(1)?,
            grade_text: r.get(2)?,
            grade_numeric: r.get(3)?,
            updated_at: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn get_moodle_notifications(conn: &Connection) -> SqlResult<Vec<MoodleNotificationRecord>> {
    ensure_portal_extra_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, subject, shortened_subject, full_message, is_read, created_at
         FROM moodle_notifications
         ORDER BY created_at DESC
         LIMIT 50",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MoodleNotificationRecord {
            id: r.get(0)?,
            subject: r.get(1)?,
            shortened_subject: r.get(2)?,
            full_message: r.get(3)?,
            is_read: r.get::<_, i64>(4)? != 0,
            created_at: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commit_portal_extra_and_tuition_string_parsing() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_portal_extra_schema(&conn).unwrap();

        let raw_json = serde_json::json!({
            "tkb_dang_ky": {
                "hocKy": 1,
                "yearId": 47,
                "rows": [
                    {
                        "id": 110075,
                        "code": "CS115.R11",
                        "subjectCode": "CS115",
                        "subjectName": "Toán cho khoa học máy tính",
                        "subjectId": 13284,
                        "hasSyllabus": true,
                        "credit": 4,
                        "lecturer": "TS Dương Việt Hằng",
                        "methodCode": "LT",
                        "startDate": "2026-09-07",
                        "endDate": "2026-12-26",
                        "slots": [{"thu": 2, "tietBatDau": 1, "tietKetThuc": 4, "room": "C314"}]
                    }
                ]
            },
            "tkb": {
                "hocKy": 1,
                "namHoc": 2026,
                "tiets": [
                    {
                        "id": "tkb-0-SS009.R12-2026-11-16",
                        "maLop": "SS009.R12",
                        "tenMonHoc": "Chủ nghĩa xã hội khoa học",
                        "ngay": "2026-11-16",
                        "thu": 2,
                        "tietBatDau": 9,
                        "tietKetThuc": 10,
                        "phong": "B1.14",
                        "hinhThuc": "LT",
                        "tenGiangVien": "Trịnh Bá Phương",
                        "lecturerTitle": "ThS",
                        "subjectId": 13552,
                        "trangThai": "normal"
                    }
                ]
            },
            "tuition_records": [
                {
                    "id": 601171,
                    "period": "Học kỳ 1/2026-2027",
                    "semester": "1",
                    "year_id_name": "2026-2027",
                    "subject_codes": "CS115, IT004",
                    "tuition_amount": "20900000",
                    "must_be_paid": "20900000",
                    "paid": "20900000",
                    "remaining": "0",
                    "payment_status": "fully_paid",
                    "payment_status_label": "Đã đóng đủ",
                    "tuition_status": "extended",
                    "tuition_status_label": "Gia hạn",
                    "period_1_due_date_formatted": "01/10/2026",
                    "period_2_due_date_formatted": "",
                    "paid_time_formatted": "26/10/2026 10:22:07",
                    "detail_ids": []
                }
            ],
            "certificates": [
                {
                    "id": "490173",
                    "cert_type": "IELTS",
                    "tongdiem": "7.5",
                    "capdo": "B2",
                    "ngaythi": "2026-05-11",
                    "status": "approved",
                    "output_standard": true,
                    "create_date": "2026-05-11"
                }
            ],
            "class_activities": []
        });

        let payload: PortalExtraSyncPayload = serde_json::from_value(raw_json).unwrap();
        let stats = commit_portal_extra_payload(&mut conn, &payload).unwrap();
        assert_eq!(stats.classes_count, 1);
        assert_eq!(stats.timetable_count, 1);
        assert_eq!(stats.tuition_count, 1);
        assert_eq!(stats.certificates_count, 1);

        let tuition = get_tuition_records(&conn).unwrap();
        assert_eq!(tuition[0].tuition_amount, 20_900_000);
        assert_eq!(tuition[0].remaining, 0);

        let slots = get_timetable_range(&conn, Some("2026-11-16"), Some("2026-11-16")).unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].phong, "B1.14");

        let certs = get_certificates(&conn).unwrap();
        assert_eq!(certs[0].tongdiem, 7.5);
        assert!(certs[0].output_standard);
    }

    #[test]
    fn test_google_calendar_events_range_and_toggle() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_portal_extra_schema(&conn).unwrap();

        upsert_google_calendar(&conn, "cal-1", "Personal", "https://calendar.google.com/calendar/ical/test.ics", "#10b981").unwrap();
        let evs = vec![CalendarEventRecord {
            uid: "u1".to_string(),
            calendar_id: "cal-1".to_string(),
            summary: "Meeting".to_string(),
            description: String::new(),
            location: "Room A".to_string(),
            start_ts: 1_700_000_000,
            end_ts: 1_700_003_600,
            all_day: false,
            updated_at: 0,
        }];
        replace_calendar_events(&mut conn, "cal-1", &evs).unwrap();

        let fetched = get_calendar_events_range(&conn, 1_699_999_000, 1_700_010_000).unwrap();
        assert_eq!(fetched.len(), 1);

        set_google_calendar_enabled(&conn, "cal-1", false).unwrap();
        let hidden = get_calendar_events_range(&conn, 1_699_999_000, 1_700_010_000).unwrap();
        assert!(hidden.is_empty());

        let stored_url: String = conn
            .query_row(
                "SELECT ics_url FROM google_calendars WHERE id = 'cal-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        #[cfg(windows)]
        assert!(stored_url.starts_with("dpapi:v1:"));
        let listed = list_google_calendars(&conn).unwrap();
        assert_eq!(
            listed[0].ics_url,
            "https://calendar.google.com/calendar/ical/test.ics"
        );
    }

    #[test]
    fn test_all_day_exclusive_dtend_does_not_bleed_into_next_day() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_portal_extra_schema(&conn).unwrap();

        upsert_google_calendar(
            &conn,
            "cal-ad",
            "Personal",
            "https://calendar.google.com/calendar/ical/test.ics",
            "#10b981",
        )
        .unwrap();
        let day1_start = 1_700_000_000i64;
        let day2_start = day1_start + 86400;
        let day2_end = day2_start + 86399;
        replace_calendar_events(
            &mut conn,
            "cal-ad",
            &[CalendarEventRecord {
                uid: "all-day-1".to_string(),
                calendar_id: "cal-ad".to_string(),
                summary: "Day 1 Only".to_string(),
                description: String::new(),
                location: String::new(),
                start_ts: day1_start,
                end_ts: day2_start,
                all_day: true,
                updated_at: 0,
            }],
        )
        .unwrap();

        let on_day1 = get_calendar_events_range(&conn, day1_start, day2_start - 1).unwrap();
        assert_eq!(on_day1.len(), 1);
        let on_day2 = get_calendar_events_range(&conn, day2_start, day2_end).unwrap();
        assert!(on_day2.is_empty());
    }

    #[test]
    fn test_oauth_calendars_isolation_and_single_event_crud() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_portal_extra_schema(&conn).unwrap();

        upsert_google_calendar(
            &conn,
            "ics-1",
            "ICS Feed",
            "https://calendar.google.com/calendar/ical/test.ics",
            "#10b981",
        )
        .unwrap();
        let oauth_cal = upsert_oauth_google_calendar(
            &conn,
            "primary@gmail.com",
            "Lịch chính",
            "#38bdf8",
            true,
        )
        .unwrap();
        assert_eq!(oauth_cal.source, "oauth");
        assert!(oauth_cal.can_write);

        upsert_single_calendar_event(
            &conn,
            &CalendarEventRecord {
                uid: "g-evt-1".to_string(),
                calendar_id: oauth_cal.id.clone(),
                summary: "Làm bài tập".to_string(),
                description: String::new(),
                location: "Thư viện".to_string(),
                start_ts: 1_700_000_000,
                end_ts: 1_700_003_600,
                all_day: false,
                updated_at: 0,
            },
        )
        .unwrap();
        assert_eq!(
            get_calendar_events_range(&conn, 1_699_999_000, 1_700_010_000)
                .unwrap()
                .len(),
            1
        );

        delete_single_calendar_event(&conn, &oauth_cal.id, "g-evt-1").unwrap();
        assert!(
            get_calendar_events_range(&conn, 1_699_999_000, 1_700_010_000)
                .unwrap()
                .is_empty()
        );

        delete_oauth_calendars(&conn).unwrap();
        let remaining = list_google_calendars(&conn).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "ics-1");
    }
}
