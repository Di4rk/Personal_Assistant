//! DRL Ingestion Engine — Sprint v0.3.1-DRL
//!
//! Bóc tách ra file riêng để giữ parser.rs làm pure generic parser,
//! còn module này là "pinned scraper" với DOM selector thật của Portal UIT.
//! Tách biệt hoàn toàn khỏi Tauri runtime: chỉ nhận `&mut Connection`, không
//! nhận AppHandle hay State — dễ test trong mọi môi trường.

use chrono::Utc;
use rusqlite::{params, Connection, Result as SqlResult};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

// ============================================================
//  DATA CONTRACTS
// ============================================================

/// Bản ghi ĐRL cho 1 học kỳ, trích từ bảng lịch sử Portal UIT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrlSemesterEntry {
    pub semester_id: String,
    pub academic_year: String,
    pub semester_term: i32,
    pub class_name: String,
    pub drl_score: i32,
    pub classification: String,
}

/// Kết quả parse toàn trang ĐRL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrlParseResult {
    pub cumulative_drl: Option<f64>,
    pub cumulative_classification: Option<String>,
    pub semesters: Vec<DrlSemesterEntry>,
}

/// Báo cáo sau khi persist thành công.
#[derive(Debug, Serialize)]
pub struct DrlIngestReport {
    pub updated_semesters: Vec<String>,
    pub cumulative_drl: Option<f64>,
    pub cumulative_classification: Option<String>,
}

// ============================================================
//  PURE PARSER — DOM Selectors khóa theo Portal UIT thực tế
// ============================================================

/// Parse fragment HTML của trang `portal.uit.edu.vn/sinh-vien/diem-ren-luyen`.
///
/// Selectors được khóa theo DOM thực tế của Portal UIT:
/// - Điểm TB toàn khóa: `div.rounded-xl p.text-4xl.font-bold`
/// - Xếp loại toàn khóa: `div.rounded-xl span.bg-primary`
/// - Bảng lịch sử: `table.w-full tbody tr`, mỗi row có cột học kỳ
///   chứa 2 thẻ `<p>` (term + academic year)
///
/// Hàm này là **pure function**: không có side effect, 100% testable.
pub fn parse_portal_drl(html: &str) -> Result<DrlParseResult, String> {
    let doc = Html::parse_fragment(html);

    // --- 1. Điểm TB và xếp loại toàn khóa ---
    let cumulative_score_sel =
        Selector::parse("div.rounded-xl p.text-4xl.font-bold")
            .map_err(|e| format!("Invalid cumulative score selector: {e:?}"))?;
    let cumulative_class_sel =
        Selector::parse("div.rounded-xl span.bg-primary")
            .map_err(|e| format!("Invalid cumulative class selector: {e:?}"))?;

    let cumulative_drl = doc
        .select(&cumulative_score_sel)
        .next()
        .and_then(|el| {
            el.text()
                .collect::<String>()
                .trim()
                .replace(',', ".")
                .parse::<f64>()
                .ok()
        });

    let cumulative_classification = doc
        .select(&cumulative_class_sel)
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
        .filter(|s| !s.is_empty());

    // --- 2. Bảng lịch sử học kỳ ---
    let row_sel = Selector::parse("table.w-full tbody tr")
        .map_err(|e| format!("Invalid row selector: {e:?}"))?;
    let cell_sel =
        Selector::parse("td").map_err(|e| format!("Invalid cell selector: {e:?}"))?;
    let p_sel = Selector::parse("p").map_err(|e| format!("Invalid p selector: {e:?}"))?;

    let mut semesters = Vec::new();

    for row in doc.select(&row_sel) {
        let cells: Vec<_> = row.select(&cell_sel).collect();

        // Portal UIT: STT | Học kỳ (2×p) | Lớp | Điểm | Xếp loại
        // Tối thiểu 5 cột; cột 0 là STT (số thứ tự), bỏ qua.
        if cells.len() < 5 {
            continue;
        }

        // Cột index 1: chứa 2 thẻ <p>
        //   p[0]: "Học kỳ 2"  → term = 2
        //   p[1]: "Năm học 2025-2026" → academic_year = "2025-2026"
        let p_texts: Vec<String> = cells[1]
            .select(&p_sel)
            .map(|p| p.text().collect::<String>().trim().to_string())
            .collect();

        if p_texts.len() < 2 {
            continue;
        }

        let term: i32 = if p_texts[0].contains("Học kỳ 1") {
            1
        } else if p_texts[0].contains("Học kỳ 2") {
            2
        } else if p_texts[0].contains("Học kỳ 3")
            || p_texts[0].to_lowercase().contains("hè")
        {
            3
        } else {
            continue; // nhãn không nhận dạng được → bỏ qua dòng này
        };

        // "Năm học 2025-2026" → "2025-2026" → year_clean = "2025_2026"
        let academic_year = p_texts[1]
            .replace("Năm học", "")
            .trim()
            .to_string();
        let semester_id = format!("{academic_year}.{term}");

        // Cột 2: Lớp chuyên ngành (e.g. "KHMT2025.1")
        let class_name = cells[2].text().collect::<String>().trim().to_string();

        // Cột 3: Điểm ĐRL (integer)
        let drl_score: i32 = match cells[3]
            .text()
            .collect::<String>()
            .trim()
            .parse::<i32>()
        {
            Ok(v) => v,
            Err(_) => continue, // dòng không có điểm số → bỏ qua
        };

        // Cột 4: Xếp loại học kỳ (e.g. "Xuất sắc")
        let classification = cells[4].text().collect::<String>().trim().to_string();

        semesters.push(DrlSemesterEntry {
            semester_id,
            academic_year,
            semester_term: term,
            class_name,
            drl_score,
            classification,
        });
    }

    Ok(DrlParseResult {
        cumulative_drl,
        cumulative_classification,
        semesters,
    })
}

// ============================================================
//  PERSISTENCE — 1 transaction nguyên tử
// ============================================================

/// Ghi kết quả parse ĐRL vào 2 bảng trong 1 SQLite transaction nguyên tử:
///
/// 1. `academic_program_summary` (sentinel row `id = 'MAIN'`): cDRL + xếp loại toàn khóa.
/// 2. `academic_macro_metrics` (per-semester): chỉ cập nhật cột `drl`, không động chạm GPA.
///
/// Chiến lược:
/// - `academic_program_summary`: UPSERT (INSERT ... ON CONFLICT) — tạo nếu chưa có.
/// - `academic_macro_metrics`: UPSERT với default 0/'' cho GPA nếu row chưa tồn tại.
///   Khi bảng điểm đã được sync trước, ON CONFLICT chỉ cập nhật `drl + updated_at`.
pub fn persist_portal_drl(
    conn: &mut Connection,
    parsed: &DrlParseResult,
) -> SqlResult<DrlIngestReport> {
    let tx = conn.transaction()?;
    let now = Utc::now().timestamp();
    let mut updated_semesters = Vec::new();

    // 1. Ghi tóm tắt toàn khóa vào academic_program_summary
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO academic_program_summary (
                id, cumulative_drl, drl_classification, updated_at
            ) VALUES ('MAIN', ?1, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET
                cumulative_drl       = excluded.cumulative_drl,
                drl_classification   = excluded.drl_classification,
                updated_at           = excluded.updated_at",
        )?;
        stmt.execute(params![
            parsed.cumulative_drl,
            parsed.cumulative_classification,
            now
        ])?;
    }

    // 2. Cập nhật ĐRL từng học kỳ trong academic_macro_metrics
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO academic_macro_metrics (
                semester_id, semester_label, year_name, term_gpa, cumulative_gpa, classification, rank_label,
                term_credits, cumulative_credits, drl, drl_score, updated_at
            ) VALUES (?1, ?2, ?3, 0.0, 0.0, ?4, ?4, 0, 0, ?5, ?5, ?6)
            ON CONFLICT(semester_id) DO UPDATE SET
                semester_label = CASE WHEN academic_macro_metrics.semester_label IS NULL OR academic_macro_metrics.semester_label = '' THEN excluded.semester_label ELSE academic_macro_metrics.semester_label END,
                year_name      = CASE WHEN academic_macro_metrics.year_name IS NULL OR academic_macro_metrics.year_name = '' THEN excluded.year_name ELSE academic_macro_metrics.year_name END,
                drl        = excluded.drl,
                drl_score  = excluded.drl_score,
                classification = CASE WHEN academic_macro_metrics.classification IS NULL OR academic_macro_metrics.classification = '' THEN excluded.classification ELSE academic_macro_metrics.classification END,
                rank_label     = CASE WHEN academic_macro_metrics.rank_label IS NULL OR academic_macro_metrics.rank_label = '' THEN excluded.rank_label ELSE academic_macro_metrics.rank_label END,
                updated_at = excluded.updated_at",
        )?;

        for sem in &parsed.semesters {
            let classif = if sem.classification.trim().is_empty() {
                "Giỏi"
            } else {
                sem.classification.as_str()
            };
            let sem_label = format!("Học kỳ {}/{}", sem.semester_term, sem.academic_year);
            stmt.execute(params![sem.semester_id, sem_label, sem.academic_year, classif, sem.drl_score, now])?;
            updated_semesters.push(sem.semester_id.clone());
        }
    }

    tx.commit()?;

    Ok(DrlIngestReport {
        updated_semesters,
        cumulative_drl: parsed.cumulative_drl,
        cumulative_classification: parsed.cumulative_classification.clone(),
    })
}

// ============================================================
//  UNIT TESTS
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory DB phải mở được");
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("bật FK phải thành công");
        // Schema tối thiểu cho test — mirrors ensure_academic_schema()
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS academic_program_summary (
                id TEXT PRIMARY KEY,
                cumulative_gpa REAL,
                cumulative_drl REAL,
                cumulative_credits INTEGER,
                total_degree_credits INTEGER DEFAULT 126,
                classification TEXT,
                drl_classification TEXT,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS academic_macro_metrics (
                semester_id        TEXT PRIMARY KEY,
                semester_label     TEXT NOT NULL DEFAULT '',
                year_name          TEXT NOT NULL DEFAULT '',
                term_gpa           REAL NOT NULL DEFAULT 0.0,
                cumulative_gpa     REAL NOT NULL DEFAULT 0.0,
                classification     TEXT NOT NULL DEFAULT 'Giỏi',
                rank_label         TEXT NOT NULL DEFAULT 'Giỏi',
                term_credits       INTEGER NOT NULL DEFAULT 0,
                cumulative_credits INTEGER NOT NULL DEFAULT 0,
                drl                INTEGER,
                drl_score          INTEGER NOT NULL DEFAULT 0,
                updated_at         INTEGER NOT NULL
            );
            "#,
        )
        .expect("schema test phải tạo được");
        conn
    }

    #[test]
    fn test_parse_real_portal_drl() {
        let html_data = r#"
        <div class="rounded-xl border border-primary/20 bg-primary/5">
            <p class="text-4xl font-bold text-emerald-700">97.5</p>
            <span class="bg-primary text-primary-foreground">Xuất sắc</span>
        </div>
        <table class="w-full">
            <tbody>
                <tr>
                    <td>1</td>
                    <td><p>Học kỳ 2</p><p>Năm học 2025-2026</p></td>
                    <td>KHMT2025.1</td>
                    <td>100</td>
                    <td>Xuất sắc</td>
                </tr>
                <tr>
                    <td>2</td>
                    <td><p>Học kỳ 1</p><p>Năm học 2025-2026</p></td>
                    <td>KHMT2025.1</td>
                    <td>95</td>
                    <td>Xuất sắc</td>
                </tr>
            </tbody>
        </table>
        "#;

        let result = parse_portal_drl(html_data).expect("Phải parse được HTML Portal thực tế");
        assert_eq!(result.cumulative_drl, Some(97.5));
        assert_eq!(
            result.cumulative_classification.as_deref(),
            Some("Xuất sắc")
        );
        assert_eq!(result.semesters.len(), 2);

        let hk2 = &result.semesters[0];
        assert_eq!(hk2.semester_id, "2025-2026.2");
        assert_eq!(hk2.academic_year, "2025-2026");
        assert_eq!(hk2.semester_term, 2);
        assert_eq!(hk2.class_name, "KHMT2025.1");
        assert_eq!(hk2.drl_score, 100);
        assert_eq!(hk2.classification, "Xuất sắc");

        let hk1 = &result.semesters[1];
        assert_eq!(hk1.semester_id, "2025-2026.1");
        assert_eq!(hk1.drl_score, 95);
    }

    #[test]
    fn test_parse_skips_rows_with_invalid_term() {
        let html = r#"
        <table class="w-full">
            <tbody>
                <tr>
                    <td>1</td>
                    <td><p>Học kỳ X</p><p>Năm học 2025-2026</p></td>
                    <td>KHMT2025.1</td>
                    <td>100</td>
                    <td>Xuất sắc</td>
                </tr>
                <tr>
                    <td>2</td>
                    <td><p>Học kỳ 2</p><p>Năm học 2025-2026</p></td>
                    <td>KHMT2025.1</td>
                    <td>95</td>
                    <td>Xuất sắc</td>
                </tr>
            </tbody>
        </table>
        "#;

        let result = parse_portal_drl(html).expect("parse phải thành công");
        // Dòng đầu có term không hợp lệ ("Học kỳ X") phải bị bỏ qua
        assert_eq!(result.semesters.len(), 1);
        assert_eq!(result.semesters[0].semester_id, "2025-2026.2");
    }

    #[test]
    fn test_parse_hk_he_maps_to_term_3() {
        let html = r#"
        <table class="w-full">
            <tbody>
                <tr>
                    <td>1</td>
                    <td><p>Học kỳ hè</p><p>Năm học 2024-2025</p></td>
                    <td>KHMT2024.1</td>
                    <td>88</td>
                    <td>Tốt</td>
                </tr>
            </tbody>
        </table>
        "#;
        let result = parse_portal_drl(html).expect("parse phải thành công");
        assert_eq!(result.semesters.len(), 1);
        assert_eq!(result.semesters[0].semester_id, "2024-2025.3");
        assert_eq!(result.semesters[0].semester_term, 3);
    }

    #[test]
    fn test_persist_creates_program_summary_and_updates_metrics() {
        let mut conn = setup_test_db();

        let parsed = DrlParseResult {
            cumulative_drl: Some(97.5),
            cumulative_classification: Some("Xuất sắc".to_string()),
            semesters: vec![DrlSemesterEntry {
                semester_id: "2025-2026.2".to_string(),
                academic_year: "2025-2026".to_string(),
                semester_term: 2,
                class_name: "KHMT2025.1".to_string(),
                drl_score: 100,
                classification: "Xuất sắc".to_string(),
            }],
        };

        let report = persist_portal_drl(&mut conn, &parsed).expect("persist phải thành công");

        assert_eq!(report.updated_semesters, vec!["2025-2026.2"]);
        assert_eq!(report.cumulative_drl, Some(97.5));

        // Kiểm tra academic_program_summary
        let (cdrl, drl_class): (Option<f64>, Option<String>) = conn
            .query_row(
                "SELECT cumulative_drl, drl_classification FROM academic_program_summary WHERE id = 'MAIN'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("MAIN row phải tồn tại");
        assert_eq!(cdrl, Some(97.5));
        assert_eq!(drl_class.as_deref(), Some("Xuất sắc"));

        // Kiểm tra academic_macro_metrics
        let drl: Option<i64> = conn
            .query_row(
                "SELECT drl FROM academic_macro_metrics WHERE semester_id = '2025-2026.2'",
                [],
                |r| r.get(0),
            )
            .expect("semester row phải tồn tại");
        assert_eq!(drl, Some(100));
    }

    #[test]
    fn test_persist_upsert_updates_existing_drl() {
        let mut conn = setup_test_db();
        let now = Utc::now().timestamp();

        // Tạo row macro_metrics sẵn (bảng điểm đã sync trước)
        conn.execute(
            "INSERT INTO academic_macro_metrics
             (semester_id, term_gpa, cumulative_gpa, classification, term_credits, cumulative_credits, drl, updated_at)
             VALUES ('2025-2026.2', 3.8, 3.9, 'Xuất sắc', 18, 36, NULL, ?1)",
            params![now],
        )
        .expect("insert row ban đầu phải thành công");

        let parsed = DrlParseResult {
            cumulative_drl: Some(95.0),
            cumulative_classification: Some("Xuất sắc".to_string()),
            semesters: vec![DrlSemesterEntry {
                semester_id: "2025-2026.2".to_string(),
                academic_year: "2025-2026".to_string(),
                semester_term: 2,
                class_name: "KHMT2025.1".to_string(),
                drl_score: 95,
                classification: "Xuất sắc".to_string(),
            }],
        };

        persist_portal_drl(&mut conn, &parsed).expect("persist phải thành công");

        // GPA phải KHÔNG bị thay đổi (ON CONFLICT chỉ update drl + updated_at)
        let (term_gpa, drl): (f64, Option<i64>) = conn
            .query_row(
                "SELECT term_gpa, drl FROM academic_macro_metrics WHERE semester_id = '2025-2026.2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("query phải thành công");
        assert!(
            (term_gpa - 3.8).abs() < 0.001,
            "GPA phải được giữ nguyên: got {term_gpa}"
        );
        assert_eq!(drl, Some(95), "DRL phải được cập nhật thành 95");
    }
}
