//! Academic Radar — Database layer.
//!
//! Design principle: bảng `academic_semesters` KHÔNG lưu `actual_gpa` hay
//! `actual_drl`. Mọi chỉ số động đều được tính LIVE qua SQL aggregates trên
//! `academic_courses` và `academic_drl_events`. Điều này tránh denormalization
//! drift khi user sửa điểm môn học nhưng quên cập nhật aggregate.

use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ============================================================
//  SECTION 1: Grading Engine (ĐHQG-HCM Credit System)
// ============================================================

/// Thang điểm chữ theo quy chế ĐHQG-HCM.
/// Sử dụng strongly-typed enum thay vì string để:
/// 1. Trình biên dịch bắt được mọi case thiếu qua exhaustive match.
/// 2. `to_scale_4()` không bao giờ trả sai giá trị vì không có parse string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GradeScale {
    APlus,
    A,
    BPlus,
    B,
    CPlus,
    C,
    DPlus,
    D,
    F,
}

impl GradeScale {
    /// Chuyển điểm hệ 10 sang thang điểm chữ theo quy chế ĐHQG-HCM.
    ///
    /// Boundary rules (QUAN TRỌNG):
    /// - Dùng `>=` trên ngưỡng ĐỦ để số như 8.50 rơi vào A, không phải B+.
    /// - Thứ tự kiểm tra TỪ CAO XUỐNG THẤP: nếu đảo thứ tự sẽ luôn match nhánh đầu.
    pub fn from_score_10(score: f64) -> Self {
        if score >= 9.0 {
            GradeScale::APlus
        } else if score >= 8.5 {
            GradeScale::A
        } else if score >= 8.0 {
            GradeScale::BPlus
        } else if score >= 7.0 {
            GradeScale::B
        } else if score >= 6.5 {
            GradeScale::CPlus
        } else if score >= 5.5 {
            GradeScale::C
        } else if score >= 5.0 {
            GradeScale::DPlus
        } else if score >= 4.0 {
            GradeScale::D
        } else {
            GradeScale::F
        }
    }

    /// Quy đổi sang hệ 4 theo bảng tra cứu cố định của ĐHQG-HCM.
    pub fn to_scale_4(&self) -> f64 {
        match self {
            GradeScale::APlus => 4.0,
            GradeScale::A => 3.7,
            GradeScale::BPlus => 3.5,
            GradeScale::B => 3.0,
            GradeScale::CPlus => 2.5,
            GradeScale::C => 2.0,
            GradeScale::DPlus => 1.5,
            GradeScale::D => 1.0,
            GradeScale::F => 0.0,
        }
    }

    /// Chuỗi ký tự hiển thị cho grade (A+, B+, v.v.)
    pub fn as_char(&self) -> &'static str {
        match self {
            GradeScale::APlus => "A+",
            GradeScale::A => "A",
            GradeScale::BPlus => "B+",
            GradeScale::B => "B",
            GradeScale::CPlus => "C+",
            GradeScale::C => "C",
            GradeScale::DPlus => "D+",
            GradeScale::D => "D",
            GradeScale::F => "F",
        }
    }

    /// Môn học có được tính vào GPA không (môn D trở lên mới được tính GPA
    /// trong quy chế credit — tuy nhiên, `is_passed` là cờ riêng ở course level).
    /// Grade F không phải môn đạt, nhưng vẫn được TÍNH vào GPA (kéo điểm xuống).
    pub fn is_passed(&self) -> bool {
        !matches!(self, GradeScale::F)
    }
}

// ============================================================
//  SECTION 2: Data Transfer Objects
// ============================================================

/// Bản ghi đầy đủ của 1 học kỳ, trả về từ IPC `get_academic_overview`.
/// `actual_gpa_*` và `actual_drl` là COMPUTED FIELDS (tính live từ SQL aggregate),
/// không được lưu trong DB.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemesterOverview {
    pub id: String,
    pub academic_year: String,
    pub semester_term: i64,
    pub target_gpa: Option<f64>,
    pub target_drl: Option<i64>,
    pub is_completed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    // --- Computed live from aggregate queries ---
    pub actual_gpa_10: Option<f64>,
    pub actual_gpa_4: Option<f64>,
    pub actual_drl: i64,
    pub passed_credits: i64,
    pub total_credits: i64,
}

/// Bản ghi 1 môn học, trả về từ IPC `get_semester_courses`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcademicCourseRecord {
    pub id: String,
    pub semester_id: String,
    pub course_code: String,
    pub course_name: String,
    pub credits: i64,
    pub midterm_score: Option<f64>,
    pub final_score: Option<f64>,
    pub other_scores: Option<String>, // JSON string
    pub summary_score_10: Option<f64>,
    pub summary_score_4: Option<f64>,
    pub grade_char: Option<String>,
    pub is_passed: bool,
    pub is_gpa_calculated: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub process_point: Option<f64>,
    #[serde(default)]
    pub practice_point: Option<f64>,
    #[serde(default)]
    pub final_point: Option<f64>,
    #[serde(default)]
    pub course_point: Option<f64>,
    #[serde(default)]
    pub grade_4: Option<f64>,
    #[serde(default)]
    pub result_status: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// DTO để upsert 1 môn học từ frontend. `id` là optional:
/// - None → sinh UUID v4 mới (INSERT)
/// - Some → dùng id đã có (UPDATE, nhưng vẫn UPSERT qua ON CONFLICT)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCourseDto {
    pub id: Option<String>,
    pub semester_id: String,
    pub course_code: String,
    pub course_name: String,
    pub credits: i64,
    pub midterm_score: Option<f64>,
    pub final_score: Option<f64>,
    pub other_scores: Option<String>,
    /// Nếu None, backend tự tính từ midterm/final theo quy chế ĐHQG-HCM.
    pub summary_score_10: Option<f64>,
    pub is_gpa_calculated: Option<bool>, // default true
}

/// DTO để upsert học kỳ.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSemesterDto {
    pub id: String,
    pub academic_year: String,
    pub semester_term: i64,
    pub target_gpa: Option<f64>,
    pub target_drl: Option<i64>,
    pub is_completed: Option<bool>,
}

// ============================================================
//  SECTION 3: Schema Migration
// ============================================================

/// Tạo 3 bảng Academic Radar nếu chưa có (idempotent).
///
/// Quyết định kiến trúc LOCKED:
/// - `academic_semesters` CHỈ lưu metadata + chỉ tiêu (`target_gpa`, `target_drl`).
/// - `actual_gpa_*`, `actual_drl`, `total_credits` KHÔNG được lưu — tính động.
/// - `academic_courses.id` dùng TEXT UUID v4 (bắt buộc theo spec).
/// - ON DELETE CASCADE: xoá học kỳ → xoá toàn bộ môn và DRL events của học kỳ đó.
pub fn ensure_academic_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS academic_semesters (
            id             TEXT PRIMARY KEY,
            academic_year  TEXT NOT NULL,
            semester_term  INTEGER NOT NULL,
            target_gpa     REAL,
            target_drl     INTEGER,
            is_completed   INTEGER NOT NULL DEFAULT 0,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS academic_courses (
            id                 TEXT PRIMARY KEY,
            semester_id        TEXT NOT NULL,
            course_code        TEXT NOT NULL,
            course_name        TEXT NOT NULL,
            credits            INTEGER NOT NULL,
            process_point      REAL,
            midterm_score      REAL,
            practice_point     REAL,
            final_point        REAL,
            course_point       REAL NOT NULL DEFAULT 0.0,
            status             TEXT NOT NULL DEFAULT 'normal',
            note               TEXT,
            final_score        REAL,
            other_scores       TEXT,
            summary_score_10   REAL,
            summary_score_4    REAL,
            grade_char         TEXT,
            is_passed          INTEGER NOT NULL DEFAULT 0,
            is_gpa_calculated  INTEGER NOT NULL DEFAULT 1,
            created_at         INTEGER NOT NULL DEFAULT 0,
            updated_at         INTEGER NOT NULL,
            FOREIGN KEY(semester_id) REFERENCES academic_semesters(id) ON DELETE CASCADE,
            UNIQUE(semester_id, course_code)
        );

        CREATE TABLE IF NOT EXISTS academic_drl_events (
            id           TEXT PRIMARY KEY,
            semester_id  TEXT NOT NULL,
            event_name   TEXT NOT NULL,
            category     TEXT NOT NULL
                CHECK (category IN ('DAO_DUC','HOC_TAP','THE_CHAT','TINH_NGUYEN','HOI_NHAP')),
            points       INTEGER NOT NULL,
            proof_url    TEXT,
            status       TEXT NOT NULL DEFAULT 'PLANNED'
                CHECK (status IN ('PLANNED','CONFIRMED','REJECTED')),
            created_at   INTEGER NOT NULL,
            FOREIGN KEY(semester_id) REFERENCES academic_semesters(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS academic_drl (
            semester   TEXT PRIMARY KEY,
            score      INTEGER NOT NULL,
            grade_text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_courses_semester ON academic_courses(semester_id);
        CREATE INDEX IF NOT EXISTS idx_drl_semester    ON academic_drl_events(semester_id);

        -- Lưu trữ danh mục môn học theo khung CTĐT (Tab 3)
        CREATE TABLE IF NOT EXISTS academic_curriculum (
            course_code TEXT PRIMARY KEY,
            course_name TEXT NOT NULL,
            credits INTEGER NOT NULL,
            course_type TEXT NOT NULL, -- 'Bắt buộc' | 'Tự chọn'
            ideal_term INTEGER NOT NULL, -- 1, 2, 3, 4, 5, 6, 7, 20
            status TEXT NOT NULL, -- 'Đã qua' | 'Đang học' | 'Chưa học'
            final_score REAL,
            updated_at INTEGER NOT NULL
        );

        -- Macro snapshot theo từng học kỳ (Single Source of Truth cho Cards và DRL)
        CREATE TABLE IF NOT EXISTS academic_macro_metrics (
            semester_id TEXT PRIMARY KEY,        -- "2025-2026.1", "2025-2026.2"
            semester_label TEXT NOT NULL DEFAULT '', -- "Học kỳ 1/2025-2026", "Học kỳ 2/2025-2026"
            year_name TEXT NOT NULL DEFAULT '',      -- "2025-2026"
            term_gpa REAL NOT NULL DEFAULT 0.0,
            cumulative_gpa REAL NOT NULL DEFAULT 0.0,
            term_credits INTEGER NOT NULL DEFAULT 0,
            cumulative_credits INTEGER NOT NULL DEFAULT 0,
            drl_score INTEGER NOT NULL DEFAULT 0,    -- 95, 100
            rank_label TEXT NOT NULL DEFAULT 'Chưa xếp loại',     -- "Giỏi", "Xuất sắc"
            classification TEXT NOT NULL DEFAULT 'Chưa xếp loại',
            drl INTEGER,
            updated_at INTEGER NOT NULL
        );

        -- Bảng tóm tắt toàn khóa: sentinel row id='MAIN' lưu cDRL, cGPA, tổng TC.
        -- Tách riêng để tránh sentinel row nằm lẫn trong bảng học kỳ gây drift.
        CREATE TABLE IF NOT EXISTS academic_program_summary (
            id                  TEXT PRIMARY KEY,  -- luôn là 'MAIN'
            cumulative_gpa      REAL,
            cumulative_drl      REAL,
            cumulative_credits  INTEGER,
            total_degree_credits INTEGER DEFAULT 126,
            classification      TEXT,
            drl_classification  TEXT,
            updated_at          INTEGER NOT NULL
        );
        "#,
    )?;

    // Migration helper: bảo đảm các cột cần thiết nếu bảng đã tồn tại từ trước
    let ensure_column = |table: &str, column: &str, col_def: &str| -> SqlResult<()> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let exists = names.filter_map(Result::ok).any(|n| n == column);
        if !exists {
            let _ = conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {col_def};"));
        }
        Ok(())
    };

    ensure_column("academic_macro_metrics", "semester_label", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column("academic_macro_metrics", "year_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column("academic_macro_metrics", "drl_score", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column("academic_macro_metrics", "rank_label", "TEXT NOT NULL DEFAULT 'Chưa xếp loại'")?;
    ensure_column("academic_macro_metrics", "classification", "TEXT NOT NULL DEFAULT 'Chưa xếp loại'")?;
    ensure_column("academic_macro_metrics", "drl", "INTEGER")?;
    ensure_column("academic_drl", "grade_text", "TEXT NOT NULL DEFAULT ''")?;

    ensure_column("academic_courses", "process_point", "REAL")?;
    ensure_column("academic_courses", "practice_point", "REAL")?;
    ensure_column("academic_courses", "final_point", "REAL")?;
    ensure_column("academic_courses", "course_point", "REAL NOT NULL DEFAULT 0.0")?;
    ensure_column("academic_courses", "grade_4", "REAL")?;
    ensure_column("academic_courses", "result_status", "TEXT NOT NULL DEFAULT 'Đạt'")?;
    ensure_column("academic_courses", "category", "TEXT NOT NULL DEFAULT 'dai_cuong'")?;
    ensure_column("academic_courses", "status", "TEXT NOT NULL DEFAULT 'normal'")?;
    ensure_column("academic_courses", "note", "TEXT")?;

    self_heal_academic_data(conn)?;

    Ok(())
}

/// Tự phục hồi dữ liệu học vụ: chuẩn hóa semester_id lệch, dọn dẹp row 'LATEST', đồng bộ program summary
pub fn self_heal_academic_data(conn: &Connection) -> SqlResult<()> {
    // 1. Xóa bỏ sentinel LATEST và legacy prefixes khỏi macro metrics
    let _ = conn.execute("DELETE FROM academic_macro_metrics WHERE semester_id = 'LATEST' OR semester_id LIKE 'Học_kỳ_%';", []);

    // 2. Chuẩn hóa semester_id trong academic_courses
    let _ = conn.execute("UPDATE OR IGNORE academic_courses SET semester_id = '2025-2026.1' WHERE semester_id IN ('2025_2026_HK1', 'Học_kỳ_1.2025-2026');", []);
    let _ = conn.execute("UPDATE OR IGNORE academic_courses SET semester_id = '2025-2026.2' WHERE semester_id IN ('2025_2026_HK2', 'Học_kỳ_2.2025-2026');", []);
    let _ = conn.execute("DELETE FROM academic_courses WHERE semester_id IN ('2025_2026_HK1', 'Học_kỳ_1.2025-2026', '2025_2026_HK2', 'Học_kỳ_2.2025-2026');", []);

    // 3. Chuẩn hóa ID trong academic_semesters
    let _ = conn.execute("UPDATE OR IGNORE academic_semesters SET id = '2025-2026.1', academic_year = '2025-2026', semester_term = 1 WHERE id IN ('2025_2026_HK1', 'Học_kỳ_1.2025-2026');", []);
    let _ = conn.execute("UPDATE OR IGNORE academic_semesters SET id = '2025-2026.2', academic_year = '2025-2026', semester_term = 2 WHERE id IN ('2025_2026_HK2', 'Học_kỳ_2.2025-2026');", []);
    let _ = conn.execute("DELETE FROM academic_semesters WHERE id IN ('2025_2026_HK1', 'Học_kỳ_1.2025-2026', '2025_2026_HK2', 'Học_kỳ_2.2025-2026');", []);

    // 4. Chuẩn hóa semester_id và label trong academic_macro_metrics
    let _ = conn.execute("UPDATE OR IGNORE academic_macro_metrics SET semester_id = '2025-2026.1', semester_label = 'Học kỳ 1/2025-2026', year_name = '2025-2026' WHERE semester_id = '2025_2026_HK1';", []);
    let _ = conn.execute("UPDATE OR IGNORE academic_macro_metrics SET semester_id = '2025-2026.2', semester_label = 'Học kỳ 2/2025-2026', year_name = '2025-2026' WHERE semester_id = '2025_2026_HK2';", []);
    let _ = conn.execute("DELETE FROM academic_macro_metrics WHERE semester_id IN ('2025_2026_HK1', '2025_2026_HK2');", []);

    // 5. Cập nhật label sạch sẽ nếu nhãn còn chứa ký tự gạch dưới hoặc thiếu
    let _ = conn.execute(
        "UPDATE academic_macro_metrics 
         SET semester_label = 'Học kỳ 1/2025-2026', year_name = '2025-2026'
         WHERE semester_id = '2025-2026.1' AND (semester_label = '' OR semester_label LIKE '%Học_kỳ%');",
        [],
    );
    let _ = conn.execute(
        "UPDATE academic_macro_metrics 
         SET semester_label = 'Học kỳ 2/2025-2026', year_name = '2025-2026'
         WHERE semester_id = '2025-2026.2' AND (semester_label = '' OR semester_label LIKE '%Học_kỳ%');",
        [],
    );

    // 6. Tự động giải quyết số tín chỉ CTĐT: Ưu tiên số tín chỉ chính thức từ portal nếu đã có
    let existing_portal_credits: Option<i64> = conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'total_degree_credits' AND CAST(value AS INTEGER) > 0",
        [],
        |r| r.get(0),
    ).ok();

    if let Some(portal_credits) = existing_portal_credits {
        let _ = conn.execute(
            "UPDATE academic_program_summary 
             SET total_degree_credits = ?1 
             WHERE id = 'MAIN';",
            rusqlite::params![portal_credits],
        );
    } else {
        let (curriculum_code, major_code, student_class) = {
            let get_val = |k: &str| -> String {
                conn.query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    [k],
                    |r| r.get(0),
                ).unwrap_or_default()
            };
            (get_val("curriculum_code"), get_val("major_code"), get_val("student_class"))
        };
        let combined_hint = format!("{major_code} {student_class}");
        if let Ok(res) = crate::modules::academic::curriculum_resolver::resolve_curriculum(
            conn,
            &curriculum_code,
            if combined_hint.trim().is_empty() { None } else { Some(&combined_hint) },
        ) {
            let _ = conn.execute(
                "UPDATE academic_program_summary 
                 SET total_degree_credits = ?1 
                 WHERE id = 'MAIN' AND (total_degree_credits IS NULL OR total_degree_credits = 0);",
                rusqlite::params![res.total_credits],
            );
        }
    }

    Ok(())
}

/// Khởi tạo module học vụ: chỉ đảm bảo schema bảng tồn tại, ZERO-STATE không tự ý seed dữ liệu.
pub fn init_academic_module(conn: &Connection) -> SqlResult<()> {
    ensure_academic_schema(conn)
}

// ============================================================
//  SECTION 4: Repository Functions
// ============================================================

/// Tính GPA hệ 10, GPA hệ 4, số tín chỉ đạt và tổng tín chỉ của 1 học kỳ
/// ĐỘNG qua SQL aggregate. Không bao giờ đọc từ cột lưu sẵn vì không có cột đó.
///
/// NULLIF(..., 0) đảm bảo không chia cho 0 khi chưa có môn nào có điểm.
/// Trả về (gpa_10, gpa_4, passed_credits, total_credits).
fn query_semester_stats(
    conn: &Connection,
    semester_id: &str,
) -> SqlResult<(Option<f64>, Option<f64>, i64, i64)> {
    conn.query_row(
        r#"
        SELECT
            SUM(CASE WHEN is_gpa_calculated = 1 THEN summary_score_10 * credits ELSE 0 END) /
                NULLIF(SUM(CASE WHEN is_gpa_calculated = 1 AND summary_score_10 IS NOT NULL
                                THEN credits ELSE 0 END), 0)  AS gpa_10,
            SUM(CASE WHEN is_gpa_calculated = 1 THEN summary_score_4 * credits ELSE 0 END) /
                NULLIF(SUM(CASE WHEN is_gpa_calculated = 1 AND summary_score_4 IS NOT NULL
                                THEN credits ELSE 0 END), 0)  AS gpa_4,
            COALESCE(SUM(CASE WHEN is_passed = 1 THEN credits ELSE 0 END), 0) AS passed_credits,
            COALESCE(SUM(credits), 0)                                         AS total_credits
        FROM academic_courses
        WHERE semester_id = ?1
        "#,
        params![semester_id],
        |row| {
            Ok((
                row.get::<_, Option<f64>>(0)?,
                row.get::<_, Option<f64>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    )
}

/// Tính tổng DRL đã CONFIRMED của học kỳ.
fn query_drl_sum(conn: &Connection, semester_id: &str) -> SqlResult<i64> {
    conn.query_row(
        "SELECT COALESCE(SUM(points), 0) FROM academic_drl_events
         WHERE semester_id = ?1 AND status = 'CONFIRMED'",
        params![semester_id],
        |row| row.get(0),
    )
}

/// Lấy tất cả học kỳ kèm chỉ số tính động, sắp xếp theo năm học và học kỳ.
pub fn get_all_semesters_with_stats(conn: &Connection) -> SqlResult<Vec<SemesterOverview>> {
    let mut stmt = conn.prepare(
        "SELECT id, academic_year, semester_term, target_gpa, target_drl,
                is_completed, created_at, updated_at
         FROM academic_semesters
         ORDER BY academic_year DESC, semester_term ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<f64>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
        ))
    })?;

    let mut result = Vec::new();
    for row in rows {
        let (id, academic_year, semester_term, target_gpa, target_drl, is_completed_raw, created_at, updated_at) =
            row?;

        let (actual_gpa_10, actual_gpa_4, passed_credits, total_credits) =
            query_semester_stats(conn, &id)?;
        let actual_drl = query_drl_sum(conn, &id)?;

        result.push(SemesterOverview {
            id,
            academic_year,
            semester_term,
            target_gpa,
            target_drl,
            is_completed: is_completed_raw != 0,
            created_at,
            updated_at,
            actual_gpa_10,
            actual_gpa_4,
            actual_drl,
            passed_credits,
            total_credits,
        });
    }

    Ok(result)
}

/// Lấy danh sách môn học của 1 học kỳ.
pub fn get_courses_by_semester(
    conn: &Connection,
    semester_id: &str,
) -> SqlResult<Vec<AcademicCourseRecord>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, semester_id, course_code, course_name, credits,
               midterm_score, final_score, other_scores,
               summary_score_10, summary_score_4, grade_char,
               is_passed, is_gpa_calculated, created_at, updated_at,
               process_point, practice_point, final_point, course_point,
               grade_4, result_status, category, status, note
        FROM academic_courses
        WHERE semester_id = ?1
        ORDER BY course_code ASC
        "#,
    )?;

    let rows = stmt.query_map(params![semester_id], |row| {
        Ok(AcademicCourseRecord {
            id: row.get(0)?,
            semester_id: row.get(1)?,
            course_code: row.get(2)?,
            course_name: row.get(3)?,
            credits: row.get(4)?,
            midterm_score: row.get(5)?,
            final_score: row.get(6)?,
            other_scores: row.get(7)?,
            summary_score_10: row.get(8)?,
            summary_score_4: row.get(9)?,
            grade_char: row.get(10)?,
            is_passed: row.get::<_, i64>(11)? != 0,
            is_gpa_calculated: row.get::<_, i64>(12)? != 0,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
            process_point: row.get(15)?,
            practice_point: row.get(16)?,
            final_point: row.get(17)?,
            course_point: row.get(18)?,
            grade_4: row.get(19)?,
            result_status: row.get(20)?,
            category: row.get(21)?,
            status: row.get(22)?,
            note: row.get(23)?,
        })
    })?;

    rows.collect::<SqlResult<Vec<_>>>()
}

/// Upsert 1 môn học. Nếu `dto.id` là None, sinh UUID v4 mới.
/// Tính tự động `summary_score_10`, `summary_score_4`, `grade_char`, `is_passed`
/// theo quy chế ĐHQG-HCM nếu điểm tổng kết chưa có.
///
/// Công thức tính điểm tổng kết (nếu chưa có `summary_score_10`):
///   - 30% midterm + 70% final (quy chế phổ biến nhất ĐHQG-HCM).
///   - Chỉ tính nếu CẢ HAI điểm đều không null.
fn compute_summary(dto: &UpsertCourseDto) -> (Option<f64>, Option<f64>, Option<String>, bool) {
    // Ưu tiên summary_score_10 đã được truyền thẳng từ frontend
    // (VD: user nhập từ bảng điểm portal, đã biết điểm tổng kết chính xác).
    let score_10 = dto.summary_score_10.or_else(|| {
        match (dto.midterm_score, dto.final_score) {
            (Some(mid), Some(fin)) => Some((mid * 0.3 + fin * 0.7).min(10.0)),
            _ => None,
        }
    });

    match score_10 {
        Some(s10) => {
            let grade = GradeScale::from_score_10(s10);
            let s4 = grade.to_scale_4();
            let is_gpa_calc = dto.is_gpa_calculated.unwrap_or(true);
            let passed = if is_gpa_calc { grade.is_passed() } else { s10 >= 4.0 };
            (Some(s10), Some(s4), Some(grade.as_char().to_string()), passed)
        }
        None => (None, None, None, false),
    }
}

/// Batch upsert nhiều môn học trong 1 transaction.
///
/// Dùng `ON CONFLICT(semester_id, course_code) DO UPDATE SET ...` để:
/// 1. Insert môn mới mà không có lỗi duplicate.
/// 2. Update môn đã tồn tại (user nhập lại sau khi có điểm cuối kỳ).
///
/// `id` TEXT PRIMARY KEY: nếu frontend gửi id khác với id cũ nhưng cùng
/// `(semester_id, course_code)`, ON CONFLICT sẽ giữ id cũ (vì SET không đổi id).
pub fn upsert_courses(conn: &mut Connection, courses: &[UpsertCourseDto]) -> SqlResult<()> {
    let now = chrono::Utc::now().timestamp();
    let tx = conn.transaction()?;

    for dto in courses {
        let id = dto
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let is_gpa_calculated: i64 = if dto.is_gpa_calculated.unwrap_or(true) {
            1
        } else {
            0
        };

        let (summary_10, summary_4, grade_char, is_passed) = compute_summary(dto);
        let is_passed_int: i64 = if is_passed { 1 } else { 0 };

        tx.execute(
            r#"
            INSERT INTO academic_courses
                (id, semester_id, course_code, course_name, credits,
                 midterm_score, final_score, other_scores,
                 summary_score_10, summary_score_4, grade_char,
                 is_passed, is_gpa_calculated, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
            ON CONFLICT(semester_id, course_code) DO UPDATE SET
                course_name       = excluded.course_name,
                credits           = excluded.credits,
                midterm_score     = excluded.midterm_score,
                final_score       = excluded.final_score,
                other_scores      = excluded.other_scores,
                summary_score_10  = excluded.summary_score_10,
                summary_score_4   = excluded.summary_score_4,
                grade_char        = excluded.grade_char,
                is_passed         = excluded.is_passed,
                is_gpa_calculated = excluded.is_gpa_calculated,
                updated_at        = excluded.updated_at
            "#,
            params![
                id,
                dto.semester_id,
                dto.course_code,
                dto.course_name,
                dto.credits,
                dto.midterm_score,
                dto.final_score,
                dto.other_scores,
                summary_10,
                summary_4,
                grade_char,
                is_passed_int,
                is_gpa_calculated,
                now,
            ],
        )?;
    }

    tx.commit()?;
    Ok(())
}

/// Upsert 1 học kỳ. Dùng để frontend tạo/sửa học kỳ và cập nhật chỉ tiêu.
pub fn upsert_semester(conn: &Connection, dto: &UpsertSemesterDto) -> SqlResult<()> {
    let now = chrono::Utc::now().timestamp();
    let is_completed: i64 = if dto.is_completed.unwrap_or(false) { 1 } else { 0 };

    conn.execute(
        r#"
        INSERT INTO academic_semesters
            (id, academic_year, semester_term, target_gpa, target_drl, is_completed, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
        ON CONFLICT(id) DO UPDATE SET
            academic_year = excluded.academic_year,
            semester_term = excluded.semester_term,
            target_gpa    = excluded.target_gpa,
            target_drl    = excluded.target_drl,
            is_completed  = excluded.is_completed,
            updated_at    = excluded.updated_at
        "#,
        params![
            dto.id,
            dto.academic_year,
            dto.semester_term,
            dto.target_gpa,
            dto.target_drl,
            is_completed,
            now,
        ],
    )?;

    Ok(())
}

/// Persist toàn bộ 3 tập dữ liệu học vụ UIT (Macro metrics, Historical courses, Curriculum roadmap)
/// nguyên tử trong 1 SQLite transaction duy nhất.
pub fn persist_unified_academic_sync(
    conn: &mut Connection,
    data: &crate::modules::academic::parser::UnifiedAcademicData,
) -> SqlResult<()> {
    let tx = conn.transaction()?;
    let now = chrono::Utc::now().timestamp();

    // 1. Batch upsert Macro Metrics
    if !data.macro_metrics.is_empty() {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO academic_macro_metrics (
                semester_id, term_gpa, cumulative_gpa, classification, rank_label, term_credits, cumulative_credits, drl, drl_score, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(semester_id) DO UPDATE SET
                term_gpa = excluded.term_gpa,
                cumulative_gpa = excluded.cumulative_gpa,
                classification = excluded.classification,
                rank_label = excluded.rank_label,
                term_credits = excluded.term_credits,
                cumulative_credits = excluded.cumulative_credits,
                drl = COALESCE(excluded.drl, academic_macro_metrics.drl),
                drl_score = COALESCE(excluded.drl_score, academic_macro_metrics.drl_score),
                updated_at = excluded.updated_at",
        )?;
        for m in &data.macro_metrics {
            let classif = if m.classification.trim().is_empty() {
                "Giỏi"
            } else {
                m.classification.as_str()
            };
            let drl_val = m.drl.unwrap_or(0);
            stmt.execute(params![
                m.semester_id,
                m.term_gpa,
                m.cumulative_gpa,
                classif,
                m.term_credits,
                m.cumulative_credits,
                m.drl,
                drl_val,
                now,
            ])?;
        }
    }

    // 2. Batch upsert Historical Courses
    if !data.historical_semesters.is_empty() {
        let mut upsert_sem_stmt = tx.prepare_cached(
            "INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET
                academic_year = excluded.academic_year,
                semester_term = excluded.semester_term,
                updated_at    = excluded.updated_at",
        )?;

        let mut upsert_course_stmt = tx.prepare_cached(
            "INSERT INTO academic_courses (
                id, semester_id, course_code, course_name, credits,
                midterm_score, final_score, summary_score_10, summary_score_4,
                grade_char, is_passed, is_gpa_calculated, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
            )
            ON CONFLICT(semester_id, course_code) DO UPDATE SET
                course_name       = excluded.course_name,
                credits           = excluded.credits,
                midterm_score     = excluded.midterm_score,
                final_score       = excluded.final_score,
                summary_score_10  = excluded.summary_score_10,
                summary_score_4   = excluded.summary_score_4,
                grade_char        = excluded.grade_char,
                is_passed         = excluded.is_passed,
                is_gpa_calculated = excluded.is_gpa_calculated,
                updated_at        = excluded.updated_at",
        )?;

        for sem in &data.historical_semesters {
            upsert_sem_stmt.execute(params![
                sem.semester.id,
                sem.semester.academic_year,
                sem.semester.semester_term as i64,
                now,
            ])?;

            for c in &sem.courses {
                let record_id = uuid::Uuid::new_v4().to_string();
                upsert_course_stmt.execute(params![
                    record_id,
                    sem.semester.id,
                    c.course_code,
                    c.course_name,
                    c.credits,
                    c.midterm_score,
                    c.final_score,
                    c.summary_score_10,
                    c.summary_score_4,
                    c.grade_char,
                    c.is_passed as i32,
                    c.is_gpa_calculated as i32,
                    now,
                ])?;
            }
        }
    }

    // 3. Batch upsert Curriculum Roadmap
    if !data.curriculum_courses.is_empty() {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO academic_curriculum (
                course_code, course_name, credits, course_type, ideal_term, status, final_score, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(course_code) DO UPDATE SET
                course_name = excluded.course_name,
                credits = excluded.credits,
                course_type = excluded.course_type,
                ideal_term = excluded.ideal_term,
                status = excluded.status,
                final_score = excluded.final_score,
                updated_at = excluded.updated_at",
        )?;

        for c in &data.curriculum_courses {
            stmt.execute(params![
                c.course_code,
                c.course_name,
                c.credits,
                c.course_type,
                c.ideal_term,
                c.status,
                c.final_score,
                now,
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

/// Nhận `Vec<ParsedSemester>` đã validate từ pure parser,
/// ghi nguyên tử vào database SQLite trong 1 transaction duy nhất.
pub fn persist_portal_sync(
    conn: &mut Connection,
    semesters: &[crate::modules::academic::parser::ParsedSemester],
) -> SqlResult<()> {
    let data = crate::modules::academic::parser::UnifiedAcademicData {
        macro_metrics: Vec::new(),
        historical_semesters: semesters.to_vec(),
        curriculum_courses: Vec::new(),
    };
    persist_unified_academic_sync(conn, &data)
}

/// Lấy toàn bộ macro metrics chính thức từ `academic_macro_metrics`.
pub fn get_all_macro_metrics(
    conn: &Connection,
) -> SqlResult<Vec<crate::modules::academic::parser::MacroMetricRecord>> {
    let mut stmt = conn.prepare(
        "SELECT semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl
         FROM academic_macro_metrics
         ORDER BY semester_id ASC",
    )?;

    let records = stmt
        .query_map([], |row| {
            Ok(crate::modules::academic::parser::MacroMetricRecord {
                semester_id: row.get(0)?,
                term_gpa: row.get(1)?,
                cumulative_gpa: row.get(2)?,
                classification: row.get(3)?,
                term_credits: row.get(4)?,
                cumulative_credits: row.get(5)?,
                drl: row.get(6)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    Ok(records)
}

/// Lấy danh mục chương trình đào tạo từ `academic_curriculum`.
pub fn get_all_curriculum_courses(
    conn: &Connection,
) -> SqlResult<Vec<crate::modules::academic::parser::CurriculumCourseRecord>> {
    let mut stmt = conn.prepare(
        "SELECT course_code, course_name, credits, course_type, ideal_term, status, final_score
         FROM academic_curriculum
         ORDER BY ideal_term ASC, course_code ASC",
    )?;

    let records = stmt
        .query_map([], |row| {
            Ok(crate::modules::academic::parser::CurriculumCourseRecord {
                course_code: row.get(0)?,
                course_name: row.get(1)?,
                credits: row.get(2)?,
                course_type: row.get(3)?,
                ideal_term: row.get(4)?,
                status: row.get(5)?,
                final_score: row.get(6)?,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    Ok(records)
}

/// Cập nhật cột `drl` trong `academic_macro_metrics` từ kết quả parse trang ĐRL portal.
///
/// Chiến lược: UPDATE thuần, không INSERT — rows được tạo bởi `persist_unified_academic_sync`
/// khi sync bảng điểm. Nếu chưa có row (bảng điểm chưa sync), DRL bị bỏ qua an toàn.
/// Trả về số rows thực sự được cập nhật.
pub fn update_drl_from_portal(
    conn: &mut Connection,
    drl_data: &crate::modules::academic::parser::PortalDrlOverview,
) -> SqlResult<usize> {
    let tx = conn.transaction()?;
    let now = chrono::Utc::now().timestamp();
    let mut updated_count = 0usize;

    for sem in &drl_data.semesters {
        let rows = tx.execute(
            "UPDATE academic_macro_metrics
             SET drl = ?1, updated_at = ?2
             WHERE semester_id = ?3",
            params![sem.drl_score, now, sem.semester_id],
        )?;
        updated_count += rows;
    }

    tx.commit()?;
    Ok(updated_count)
}

/// Xóa sổ toàn bộ mock courses cũ trong SQLite và nạp bộ dữ liệu chuẩn xác 100%
/// theo đặc tả của UIT (HK1: 6 môn - 18 TC, HK2: 7 môn - 24 TC).
pub fn purge_and_seed_canonical_data(conn: &mut Connection) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;
    let now = chrono::Utc::now().timestamp();

    // 0. Đảm bảo academic_semesters tồn tại để thỏa mãn foreign key
    tx.execute(
        "INSERT INTO academic_semesters (id, academic_year, semester_term, is_completed, created_at, updated_at)
         VALUES 
            ('2025-2026.1', '2025-2026', 1, 1, ?1, ?1),
            ('2025-2026.2', '2025-2026', 2, 1, ?1, ?1)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at;",
        params![now],
    )?;

    // 1. Dọn dẹp dữ liệu mock
    tx.execute("DELETE FROM academic_courses;", [])?;
    tx.execute("DELETE FROM academic_macro_metrics;", [])?;

    // 2. Nạp dữ liệu Macro Học Kỳ (SSOT)
    tx.execute(
        "INSERT INTO academic_macro_metrics 
            (semester_id, semester_label, year_name, term_gpa, cumulative_gpa, term_credits, cumulative_credits, drl_score, rank_label, classification, drl, updated_at)
         VALUES 
            ('2025-2026.1', 'Học kỳ 1/2025-2026', '2025-2026', 8.20, 8.20, 18, 18, 95, 'Giỏi', 'Giỏi', 95, ?1),
            ('2025-2026.2', 'Học kỳ 2/2025-2026', '2025-2026', 8.55, 8.40, 24, 42, 100, 'Xuất sắc', 'Xuất sắc', 100, ?1)
         ON CONFLICT(semester_id) DO UPDATE SET
            semester_label = excluded.semester_label,
            year_name = excluded.year_name,
            term_gpa = excluded.term_gpa,
            cumulative_gpa = excluded.cumulative_gpa,
            term_credits = excluded.term_credits,
            cumulative_credits = excluded.cumulative_credits,
            drl_score = excluded.drl_score,
            rank_label = excluded.rank_label,
            classification = excluded.classification,
            drl = excluded.drl,
            updated_at = excluded.updated_at;",
        params![now],
    )?;

    // 3. Nạp danh sách môn học HK1 (18 TC)
    let hk1_courses = [
        ("CS005-1", "2025-2026.1", "CS005", "Giới thiệu ngành Khoa học Máy tính", 1, Some(10.0), None, None, Some(9.5), 9.7, 4.0, "A+", "Đạt", "co_so_nganh"),
        ("ENG01-2", "2025-2026.1", "ENG01", "Anh văn 1", 4, Some(8.0), None, None, Some(7.5), 7.7, 3.0, "B", "Đạt", "dai_cuong"),
        ("IT001-3", "2025-2026.1", "IT001", "Nhập môn lập trình", 4, Some(10.0), Some(9.5), None, Some(8.5), 9.1, 4.0, "A+", "Đạt", "co_so_nganh"),
        ("MA003-4", "2025-2026.1", "MA003", "Đại số tuyến tính", 3, Some(10.0), None, Some(9.5), Some(10.0), 9.9, 4.0, "A+", "Đạt", "dai_cuong"),
        ("MA006-5", "2025-2026.1", "MA006", "Giải tích", 4, Some(10.0), None, Some(6.5), Some(7.0), 7.5, 3.0, "B", "Đạt", "dai_cuong"),
        ("SS006-6", "2025-2026.1", "SS006", "Pháp luật đại cương", 2, None, None, Some(5.5), Some(5.5), 5.5, 2.0, "C", "Đạt", "dai_cuong"),
    ];

    // 4. Nạp danh sách môn học HK2 (24 TC)
    let hk2_courses = [
        ("IT002-1", "2025-2026.2", "IT002", "Lập trình hướng đối tượng", 4, Some(10.0), Some(9.0), None, Some(6.5), 8.0, 3.5, "B+", "Đạt", "co_so_nganh"),
        ("IT003-2", "2025-2026.2", "IT003", "Cấu trúc dữ liệu và giải thuật", 4, Some(10.0), Some(9.0), None, Some(7.5), 8.5, 3.7, "A", "Đạt", "co_so_nganh"),
        ("IT012-3", "2025-2026.2", "IT012", "Tổ chức và cấu trúc máy tính 2", 4, Some(10.0), Some(9.5), Some(8.5), Some(8.5), 8.9, 3.7, "A", "Đạt", "co_so_nganh"),
        ("MA004-4", "2025-2026.2", "MA004", "Cấu trúc rời rạc", 4, Some(10.0), None, Some(8.5), Some(10.0), 9.7, 4.0, "A+", "Đạt", "co_so_nganh"),
        ("MA005-5", "2025-2026.2", "MA005", "Xác suất thống kê", 3, Some(10.0), None, Some(8.0), Some(9.5), 9.3, 4.0, "A+", "Đạt", "co_so_nganh"),
        ("SS004-6", "2025-2026.2", "SS004", "Kỹ năng nghề nghiệp", 2, Some(10.0), None, None, Some(9.5), 9.7, 4.0, "A+", "Đạt", "dai_cuong"),
        ("SS007-7", "2025-2026.2", "SS007", "Triết học Mác – Lênin", 3, Some(7.5), None, None, Some(4.0), 5.8, 2.0, "C", "Đạt", "dai_cuong"),
    ];

    let mut stmt = tx.prepare(
        "INSERT INTO academic_courses 
            (id, semester_id, course_code, course_name, credits, process_point, practice_point, midterm_score, final_point, course_point, grade_4, grade_char, result_status, category, summary_score_10, summary_score_4, final_score, is_passed, is_gpa_calculated, status, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?10, ?11, ?9, 1, 1, ?13, ?15);"
    )?;

    for c in hk1_courses.iter().chain(hk2_courses.iter()) {
        stmt.execute(params![
            c.0, c.1, c.2, c.3, c.4, c.5, c.6, c.7, c.8, c.9, c.10, c.11, c.12, c.13, now
        ])?;
    }

    drop(stmt);
    tx.commit()?;
    Ok(())
}

// ============================================================
//  SECTION 5: Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------
    // 5a. GradeScale boundary tests (bắt buộc theo spec)
    // -------------------------------------------------------

    #[test]
    fn grade_8_49_is_bplus_3_5() {
        let grade = GradeScale::from_score_10(8.49);
        assert_eq!(grade, GradeScale::BPlus, "8.49 phải là B+ (dưới ngưỡng 8.5 của A)");
        assert_eq!(grade.to_scale_4(), 3.5);
        assert_eq!(grade.as_char(), "B+");
    }

    #[test]
    fn grade_8_50_is_a_3_7() {
        let grade = GradeScale::from_score_10(8.50);
        assert_eq!(grade, GradeScale::A, "8.50 phải là A (chính xác ngưỡng >= 8.5)");
        assert_eq!(grade.to_scale_4(), 3.7);
    }

    #[test]
    fn grade_8_99_is_a_3_7() {
        let grade = GradeScale::from_score_10(8.99);
        assert_eq!(grade, GradeScale::A, "8.99 phải là A (dưới ngưỡng 9.0 của A+)");
        assert_eq!(grade.to_scale_4(), 3.7);
    }

    #[test]
    fn grade_9_00_is_aplus_4_0() {
        let grade = GradeScale::from_score_10(9.00);
        assert_eq!(grade, GradeScale::APlus, "9.00 phải là A+ (chính xác ngưỡng >= 9.0)");
        assert_eq!(grade.to_scale_4(), 4.0);
    }

    #[test]
    fn grade_f_is_not_passed() {
        assert!(!GradeScale::F.is_passed());
    }

    #[test]
    fn grade_d_is_passed() {
        assert!(GradeScale::D.is_passed());
    }

    #[test]
    fn all_boundaries_spot_check() {
        // Kiểm tra toàn bộ ranh giới để tránh off-by-one
        let cases: &[(f64, GradeScale, f64)] = &[
            (10.0, GradeScale::APlus, 4.0),
            (9.0, GradeScale::APlus, 4.0),
            (8.99, GradeScale::A, 3.7),
            (8.5, GradeScale::A, 3.7),
            (8.49, GradeScale::BPlus, 3.5),
            (8.0, GradeScale::BPlus, 3.5),
            (7.99, GradeScale::B, 3.0),
            (7.0, GradeScale::B, 3.0),
            (6.99, GradeScale::CPlus, 2.5),
            (6.5, GradeScale::CPlus, 2.5),
            (6.49, GradeScale::C, 2.0),
            (5.5, GradeScale::C, 2.0),
            (5.49, GradeScale::DPlus, 1.5),
            (5.0, GradeScale::DPlus, 1.5),
            (4.99, GradeScale::D, 1.0),
            (4.0, GradeScale::D, 1.0),
            (3.99, GradeScale::F, 0.0),
            (0.0, GradeScale::F, 0.0),
        ];
        for (score, expected_grade, expected_scale4) in cases {
            let grade = GradeScale::from_score_10(*score);
            assert_eq!(
                grade, *expected_grade,
                "score {score}: expected {expected_grade:?}, got {grade:?}"
            );
            assert_eq!(
                grade.to_scale_4(),
                *expected_scale4,
                "score {score}: scale4 mismatch"
            );
        }
    }

    // -------------------------------------------------------
    // 5b. Repository / aggregation integration tests
    // -------------------------------------------------------

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory()
            .expect("in-memory DB phải luôn mở được");
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("bật FK phải thành công");
        ensure_academic_schema(&conn).expect("schema phải tạo được");
        conn
    }

    fn insert_test_semester(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO academic_semesters (id, academic_year, semester_term, created_at, updated_at)
             VALUES (?1, '2024-2025', 1, 0, 0)",
            params![id],
        )
        .expect("insert test semester phải thành công");
    }

    #[test]
    fn gpa_aggregation_returns_null_when_no_courses() {
        let conn = setup_test_db();
        insert_test_semester(&conn, "SEM_A");

        let (gpa10, gpa4, passed, total) = query_semester_stats(&conn, "SEM_A")
            .expect("query phải chạy được");
        assert!(gpa10.is_none(), "GPA 10 phải None khi chưa có môn");
        assert!(gpa4.is_none(), "GPA 4 phải None khi chưa có môn");
        assert_eq!(passed, 0);
        assert_eq!(total, 0);
    }

    #[test]
    fn gpa_aggregation_correct_with_courses() {
        let mut conn = setup_test_db();
        insert_test_semester(&conn, "SEM_B");

        // IT001: 4 tín chỉ, điểm 9.0 → A+ (4.0)
        // MA003: 3 tín chỉ, điểm 7.5 → B  (3.0)
        // GPA_10 = (9.0*4 + 7.5*3) / (4+3) = (36 + 22.5) / 7 = 58.5/7 ≈ 8.357
        // GPA_4  = (4.0*4 + 3.0*3) / (4+3) = (16 + 9) / 7 = 25/7 ≈ 3.571
        let courses = vec![
            UpsertCourseDto {
                id: None,
                semester_id: "SEM_B".to_string(),
                course_code: "IT001".to_string(),
                course_name: "Lập trình căn bản".to_string(),
                credits: 4,
                midterm_score: None,
                final_score: None,
                other_scores: None,
                summary_score_10: Some(9.0),
                is_gpa_calculated: Some(true),
            },
            UpsertCourseDto {
                id: None,
                semester_id: "SEM_B".to_string(),
                course_code: "MA003".to_string(),
                course_name: "Giải tích".to_string(),
                credits: 3,
                midterm_score: None,
                final_score: None,
                other_scores: None,
                summary_score_10: Some(7.5),
                is_gpa_calculated: Some(true),
            },
        ];
        upsert_courses(&mut conn, &courses).expect("upsert phải thành công");

        let (gpa10, gpa4, passed, total) = query_semester_stats(&conn, "SEM_B")
            .expect("aggregate phải chạy được");

        let expected_gpa10 = 58.5 / 7.0;
        let expected_gpa4 = 25.0 / 7.0;

        assert!(
            (gpa10.unwrap() - expected_gpa10).abs() < 0.001,
            "GPA 10 sai: got {:.4}, expected {:.4}",
            gpa10.unwrap(),
            expected_gpa10
        );
        assert!(
            (gpa4.unwrap() - expected_gpa4).abs() < 0.001,
            "GPA 4 sai: got {:.4}, expected {:.4}",
            gpa4.unwrap(),
            expected_gpa4
        );
        assert_eq!(passed, 7, "Cả 2 môn đều đạt → 7 tín chỉ đã qua");
        assert_eq!(total, 7);
    }

    #[test]
    fn gdtc_excluded_from_gpa_calculation() {
        let mut conn = setup_test_db();
        insert_test_semester(&conn, "SEM_C");

        // GDTC: is_gpa_calculated = false → không tính vào GPA
        let courses = vec![
            UpsertCourseDto {
                id: None,
                semester_id: "SEM_C".to_string(),
                course_code: "GDTC1".to_string(),
                course_name: "Giáo dục thể chất".to_string(),
                credits: 1,
                midterm_score: None,
                final_score: None,
                other_scores: None,
                summary_score_10: Some(8.0),
                is_gpa_calculated: Some(false), // GDTC không tính GPA
            },
            UpsertCourseDto {
                id: None,
                semester_id: "SEM_C".to_string(),
                course_code: "IT002".to_string(),
                course_name: "Cấu trúc dữ liệu".to_string(),
                credits: 3,
                midterm_score: None,
                final_score: None,
                other_scores: None,
                summary_score_10: Some(9.0),
                is_gpa_calculated: Some(true),
            },
        ];
        upsert_courses(&mut conn, &courses).expect("upsert phải thành công");

        let (gpa10, _, _, _) = query_semester_stats(&conn, "SEM_C").expect("aggregate phải chạy");
        // GPA chỉ tính IT002: 9.0 * 3 / 3 = 9.0 (GDTC bị loại)
        assert!(
            (gpa10.unwrap() - 9.0).abs() < 0.001,
            "GDTC phải bị loại khỏi GPA calculation, got {:.4}",
            gpa10.unwrap()
        );
    }

    #[test]
    fn drl_sum_only_counts_confirmed() {
        let conn = setup_test_db();
        insert_test_semester(&conn, "SEM_D");
        let now = chrono::Utc::now().timestamp();

        conn.execute_batch(&format!(
            r#"
            INSERT INTO academic_drl_events (id, semester_id, event_name, category, points, status, created_at)
            VALUES
                ('d1','SEM_D','Tình nguyện hè','TINH_NGUYEN',10,'CONFIRMED',{now}),
                ('d2','SEM_D','Nghiên cứu KH','HOC_TAP',20,'PLANNED',{now}),
                ('d3','SEM_D','Thể thao','THE_CHAT',5,'REJECTED',{now}),
                ('d4','SEM_D','Lớp trưởng','DAO_DUC',15,'CONFIRMED',{now});
            "#
        ))
        .expect("insert DRL events phải thành công");

        let drl = query_drl_sum(&conn, "SEM_D").expect("DRL sum phải chạy được");
        assert_eq!(drl, 25, "Chỉ CONFIRMED mới tính: 10+15 = 25 (PLANNED và REJECTED bị loại)");
    }

    #[test]
    fn upsert_deduplicates_same_course_code() {
        let mut conn = setup_test_db();
        insert_test_semester(&conn, "SEM_E");

        let first = vec![UpsertCourseDto {
            id: None,
            semester_id: "SEM_E".to_string(),
            course_code: "IT001".to_string(),
            course_name: "Old Name".to_string(),
            credits: 3,
            midterm_score: Some(6.0),
            final_score: None,
            other_scores: None,
            summary_score_10: None,
            is_gpa_calculated: Some(true),
        }];
        upsert_courses(&mut conn, &first).expect("insert lần 1 phải thành công");

        let second = vec![UpsertCourseDto {
            id: None,
            semester_id: "SEM_E".to_string(),
            course_code: "IT001".to_string(),
            course_name: "New Name".to_string(),
            credits: 3,
            midterm_score: Some(6.0),
            final_score: Some(8.0),
            other_scores: None,
            summary_score_10: None,
            is_gpa_calculated: Some(true),
        }];
        upsert_courses(&mut conn, &second).expect("upsert lần 2 phải thành công");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM academic_courses WHERE semester_id = 'SEM_E'",
                [],
                |r| r.get(0),
            )
            .expect("count phải chạy được");
        assert_eq!(count, 1, "ON CONFLICT phải dedup, không tạo 2 row");

        let name: String = conn
            .query_row(
                "SELECT course_name FROM academic_courses WHERE semester_id = 'SEM_E'",
                [],
                |r| r.get(0),
            )
            .expect("query name phải chạy được");
        assert_eq!(name, "New Name", "Tên phải được cập nhật từ lần upsert thứ 2");
    }

    #[test]
    fn compute_summary_from_midterm_and_final() {
        // 30% mid + 70% final = 0.3*6 + 0.7*8 = 1.8 + 5.6 = 7.4 → B (3.0)
        let dto = UpsertCourseDto {
            id: None,
            semester_id: "X".to_string(),
            course_code: "X".to_string(),
            course_name: "X".to_string(),
            credits: 3,
            midterm_score: Some(6.0),
            final_score: Some(8.0),
            other_scores: None,
            summary_score_10: None,
            is_gpa_calculated: Some(true),
        };
        let (s10, s4, grade, passed) = compute_summary(&dto);
        assert!((s10.unwrap() - 7.4).abs() < 0.001);
        assert_eq!(s4.unwrap(), 3.0); // B
        assert_eq!(grade.unwrap(), "B");
        assert!(passed);
    }

    #[test]
    fn update_drl_from_portal_updates_existing_row() {
        use crate::modules::academic::parser::{PortalDrlOverview, SemesterDrlRecord};

        let mut conn = setup_test_db();
        let now = chrono::Utc::now().timestamp();

        // Tạo row macro_metrics (thường được tạo bởi persist_unified_academic_sync)
        conn.execute(
            "INSERT INTO academic_macro_metrics
             (semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl, updated_at)
             VALUES ('2025_2026_HK2', 3.8, 3.9, 'Xuất sắc', 18, 36, NULL, ?1)",
            params![now],
        ).expect("insert macro metric phải thành công");

        let drl_data = PortalDrlOverview {
            cumulative_drl: 97.5,
            cumulative_classification: "Xuất sắc".to_string(),
            semesters: vec![SemesterDrlRecord {
                semester_id: "2025_2026_HK2".to_string(),
                class_name: "KHMT2025.1".to_string(),
                drl_score: 100,
                classification: "Xuất sắc".to_string(),
            }],
        };

        let count = update_drl_from_portal(&mut conn, &drl_data)
            .expect("update DRL phải thành công");
        assert_eq!(count, 1, "Phải update đúng 1 row");

        let drl: Option<i64> = conn
            .query_row(
                "SELECT drl FROM academic_macro_metrics WHERE semester_id = '2025_2026_HK2'",
                [],
                |r| r.get(0),
            )
            .expect("query phải chạy được");
        assert_eq!(drl, Some(100), "Cột drl phải được cập nhật thành 100");
    }

    #[test]
    fn update_drl_from_portal_noop_when_no_matching_row() {
        use crate::modules::academic::parser::{PortalDrlOverview, SemesterDrlRecord};

        let mut conn = setup_test_db();

        // Không có row nào trong academic_macro_metrics
        let drl_data = PortalDrlOverview {
            cumulative_drl: 95.0,
            cumulative_classification: "Xuất sắc".to_string(),
            semesters: vec![SemesterDrlRecord {
                semester_id: "9999_9999_HK9".to_string(),
                class_name: "TEST".to_string(),
                drl_score: 99,
                classification: "Xuất sắc".to_string(),
            }],
        };

        let count = update_drl_from_portal(&mut conn, &drl_data)
            .expect("update DRL phải thành công dù không có row nào khớp");
        assert_eq!(count, 0, "Không có row nào khớp → count phải là 0");
    }

    #[test]
    fn test_purge_and_seed_canonical_data() {
        let mut conn = setup_test_db();

        // Chạy purge và nạp dữ liệu chuẩn UIT
        purge_and_seed_canonical_data(&mut conn).expect("purge_and_seed phải thành công");

        // 1. Kiểm tra không có bất kỳ môn rác PE nào
        let pe_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM academic_courses WHERE course_code LIKE 'PE00%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pe_count, 0, "Không được tồn tại môn PE nào");

        // 2. Kiểm tra HK1 có đúng 6 môn và 18 tín chỉ
        let hk1_courses: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM academic_courses WHERE semester_id = '2025-2026.1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hk1_courses, 6, "HK1 phải có đúng 6 môn học");

        let hk1_credits: i64 = conn
            .query_row(
                "SELECT SUM(credits) FROM academic_courses WHERE semester_id = '2025-2026.1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hk1_credits, 18, "HK1 phải có đúng 18 tín chỉ");

        // 3. Kiểm tra HK2 có đúng 7 môn và 24 tín chỉ
        let hk2_courses: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM academic_courses WHERE semester_id = '2025-2026.2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hk2_courses, 7, "HK2 phải có đúng 7 môn học");

        let hk2_credits: i64 = conn
            .query_row(
                "SELECT SUM(credits) FROM academic_courses WHERE semester_id = '2025-2026.2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hk2_credits, 24, "HK2 phải có đúng 24 tín chỉ");

        // 4. Kiểm tra macro metrics của cả 2 kỳ
        let macro_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM academic_macro_metrics", [], |r| r.get(0))
            .unwrap();
        assert_eq!(macro_count, 2);

        // 5. Kiểm tra các trường điểm (QT, TH, GK, CK) được lưu chính xác
        let it001 = get_courses_by_semester(&conn, "2025-2026.1")
            .unwrap()
            .into_iter()
            .find(|c| c.course_code == "IT001")
            .expect("Phải tìm thấy IT001 trong HK1");
        assert_eq!(it001.process_point, Some(10.0));
        assert_eq!(it001.practice_point, Some(9.5));
        assert_eq!(it001.final_point, Some(8.5));
        assert_eq!(it001.course_point, Some(9.1));
        assert_eq!(it001.grade_4, Some(4.0));
        assert_eq!(it001.grade_char.as_deref(), Some("A+"));
    }

    #[test]
    fn test_seed_academic_macro_metrics_not_null() {
        let mut conn = Connection::open_in_memory().unwrap();
        // Giả lập schema cũ hoặc strict DB với `classification TEXT NOT NULL` không có DEFAULT
        conn.execute_batch(
            r#"
            CREATE TABLE academic_semesters (
                id TEXT PRIMARY KEY,
                academic_year TEXT NOT NULL,
                semester_term INTEGER NOT NULL,
                is_completed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE academic_macro_metrics (
                semester_id TEXT PRIMARY KEY,
                semester_label TEXT NOT NULL,
                year_name TEXT NOT NULL,
                term_gpa REAL NOT NULL,
                cumulative_gpa REAL NOT NULL,
                term_credits INTEGER NOT NULL,
                cumulative_credits INTEGER NOT NULL,
                drl_score INTEGER NOT NULL DEFAULT 0,
                rank_label TEXT NOT NULL,
                classification TEXT NOT NULL,
                drl INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE academic_courses (
                id TEXT PRIMARY KEY,
                semester_id TEXT NOT NULL,
                course_code TEXT NOT NULL,
                course_name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                process_point REAL,
                practice_point REAL,
                midterm_score REAL,
                final_point REAL,
                course_point REAL NOT NULL DEFAULT 0.0,
                grade_4 REAL,
                grade_char TEXT,
                result_status TEXT NOT NULL DEFAULT 'Đạt',
                category TEXT NOT NULL DEFAULT 'dai_cuong',
                summary_score_10 REAL,
                summary_score_4 REAL,
                final_score REAL,
                is_passed INTEGER NOT NULL DEFAULT 1,
                is_gpa_calculated INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();

        // Chạy purge và seed canonical data
        let seed_res = purge_and_seed_canonical_data(&mut conn);
        assert!(
            seed_res.is_ok(),
            "Seeding không được văng lỗi NOT NULL constraint: {:?}",
            seed_res.err()
        );

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM academic_macro_metrics", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "Phải nạp thành công 2 học kỳ");

        let c1: String = conn
            .query_row(
                "SELECT classification FROM academic_macro_metrics WHERE semester_id = '2025-2026.1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(c1, "Giỏi");

        let c2: String = conn
            .query_row(
                "SELECT classification FROM academic_macro_metrics WHERE semester_id = '2025-2026.2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(c2, "Xuất sắc");
    }
}
