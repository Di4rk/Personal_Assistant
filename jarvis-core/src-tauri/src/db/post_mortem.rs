use rusqlite::{params, types::Type, Connection, OptionalExtension, Result, Row};
use serde::{Deserialize, Serialize};

/// Danh sách root_cause hợp lệ - PHẢI khớp CHÍNH XÁC với CHECK constraint
/// trong schema.rs. Validate ở Rust trước khi chạm DB để trả lỗi dễ hiểu,
/// không để CHECK constraint của SQLite là tuyến phòng thủ duy nhất (thông
/// báo lỗi CHECK constraint raw rất khó hiểu với người dùng cuối).
const VALID_ROOT_CAUSES: [&str; 5] = [
    "LOGIC_BUG",
    "CORNER_CASE",
    "TIME_COMPLEXITY",
    "IMPLEMENTATION",
    "MISREAD",
];

const RECORD_SELECT_COLUMNS: &str =
    "id, problem_id, problem_name, platform, root_cause, key_insight, tags, created_at, updated_at";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMortemRecord {
    pub id: i64,
    pub problem_id: String,
    pub problem_name: String,
    pub platform: String,
    pub root_cause: String,
    pub key_insight: String,
    /// Comma-separated, đã normalize (VD: "dp,tree,bitmask") - không phải JSON array.
    pub tags: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMortemInput {
    pub problem_id: String,
    pub problem_name: String,
    pub platform: Option<String>,
    pub root_cause: String,
    pub key_insight: String,
    pub tags: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultItem {
    pub record: PostMortemRecord,
    /// BM25 score THÔ từ SQLite - CÀNG ÂM càng khớp (quy ước gốc của SQLite,
    /// KHÔNG đảo dấu ở đây). Caller tự quyết định cách hiển thị/sort tiếp.
    pub rank: f64,
}

/// Lỗi validate cục bộ (không phụ thuộc crate::error::AppError) - module này
/// tự chứa toàn bộ, chỉ dùng rusqlite::Result theo đúng contract được giao,
/// implement std::error::Error để box được vào rusqlite::Error::ToSqlConversionFailure.
#[derive(Debug)]
struct ValidationError(String);

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ValidationError {}

fn validation_error(msg: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(ValidationError(msg.into())))
}

fn validate_root_cause(raw: &str) -> Result<()> {
    if VALID_ROOT_CAUSES.contains(&raw) {
        Ok(())
    } else {
        Err(validation_error(format!(
            "root_cause '{raw}' không hợp lệ - phải là 1 trong: {}",
            VALID_ROOT_CAUSES.join(", ")
        )))
    }
}

/// Chuẩn hoá tags: trim từng tag, lowercase, bỏ tag rỗng, loại trùng (giữ thứ
/// tự xuất hiện đầu tiên), rồi nối lại bằng dấu phẩy KHÔNG có khoảng trắng -
/// đảm bảo cùng 1 tag luôn được lưu 1 dạng duy nhất dù user gõ "DP, Tree" hay
/// "dp,tree" hay "dp , tree ,dp" (có tag trùng lặp).
fn normalize_tags(raw: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();

    for tag in raw.split(',') {
        let cleaned = tag.trim().to_lowercase();
        if cleaned.is_empty() {
            continue;
        }
        if seen.insert(cleaned.clone()) {
            normalized.push(cleaned);
        }
    }

    normalized.join(",")
}

fn json_conversion_error(col_idx: usize, err: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(col_idx, Type::Text, Box::new(err))
}

/// Map 1 row từ bảng post_mortems thành PostMortemRecord. Thứ tự cột PHẢI khớp
/// chính xác với RECORD_SELECT_COLUMNS (id, problem_id, problem_name, platform,
/// root_cause, key_insight, tags, created_at, updated_at).
fn map_row_to_record(row: &Row) -> rusqlite::Result<PostMortemRecord> {
    let root_cause: String = row.get(4)?;

    // Re-validate root_cause đọc TỪ DB (không chỉ tin CHECK constraint mù
    // quáng) - phòng trường hợp DB bị chỉnh sửa thủ công từ bên ngoài app.
    if !VALID_ROOT_CAUSES.contains(&root_cause.as_str()) {
        return Err(json_conversion_error(
            4,
            ValidationError(format!(
                "root_cause '{root_cause}' trong DB không khớp danh sách hợp lệ - dữ liệu có thể bị ghi sai từ bên ngoài"
            )),
        ));
    }

    Ok(PostMortemRecord {
        id: row.get(0)?,
        problem_id: row.get(1)?,
        problem_name: row.get(2)?,
        platform: row.get(3)?,
        root_cause,
        key_insight: row.get(5)?,
        tags: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// Tạo mới hoặc cập nhật post-mortem cho 1 problem_id (UNIQUE constraint đảm
/// bảo mỗi problem chỉ có đúng 1 bản ghi - làm lại bài thì ghi đè bản cũ,
/// không tích luỹ nhiều bản ghi rác cho cùng 1 problem).
///
/// Bọc trong 1 transaction tường minh: dù INSERT...ON CONFLICT vốn đã atomic
/// ở mức 1 statement, việc SELECT lại record ngay sau đó để trả về CẦN nằm
/// cùng transaction để đảm bảo đọc được đúng state vừa ghi, không bị race
/// bởi 1 write khác chen giữa 2 bước (dù xác suất thấp với app single-user
/// local, vẫn là thói quen đúng khi có &mut Connection trong tay).
///
/// `created_at` CHỦ ĐỘNG không nằm trong SET của ON CONFLICT - giữ nguyên giá
/// trị gốc lần đầu tạo, chỉ `updated_at` mới đổi theo mỗi lần sửa.
pub fn upsert_post_mortem(conn: &mut Connection, input: &PostMortemInput) -> Result<PostMortemRecord> {
    validate_root_cause(&input.root_cause)?;

    let platform = input.platform.clone().unwrap_or_else(|| "codeforces".to_string());
    let normalized_tags = normalize_tags(&input.tags);
    let now = chrono::Utc::now().timestamp();

    let tx = conn.transaction()?;

    tx.execute(
        r#"
        INSERT INTO post_mortems
            (problem_id, problem_name, platform, root_cause, key_insight, tags, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
        ON CONFLICT(problem_id) DO UPDATE SET
            problem_name = excluded.problem_name,
            platform     = excluded.platform,
            root_cause   = excluded.root_cause,
            key_insight  = excluded.key_insight,
            tags         = excluded.tags,
            updated_at   = excluded.updated_at
        "#,
        params![
            input.problem_id,
            input.problem_name,
            platform,
            input.root_cause,
            input.key_insight,
            normalized_tags,
            now,
        ],
    )?;

    let sql = format!("SELECT {RECORD_SELECT_COLUMNS} FROM post_mortems WHERE problem_id = ?1");
    let record = tx.query_row(&sql, params![input.problem_id], map_row_to_record)?;

    tx.commit()?;

    Ok(record)
}

pub fn get_post_mortem_by_problem(conn: &Connection, problem_id: &str) -> Result<Option<PostMortemRecord>> {
    let sql = format!("SELECT {RECORD_SELECT_COLUMNS} FROM post_mortems WHERE problem_id = ?1");

    conn.query_row(&sql, params![problem_id], map_row_to_record).optional()
}

/// Xoá post-mortem theo problem_id. Trả về `true` nếu có bản ghi bị xoá,
/// `false` nếu problem_id đó chưa từng có post-mortem (không phải lỗi).
///
/// KHÔNG có trong danh sách hàm gốc của spec IPC layer trước đó, nhưng bắt
/// buộc phải thêm để chứng minh trigger `post_mortems_ad` hoạt động đúng
/// (xem unit test `delete_purges_fts_index` bên dưới) - không có hàm delete
/// thì không cách nào test được trigger DELETE.
pub fn delete_post_mortem(conn: &Connection, problem_id: &str) -> Result<bool> {
    let affected = conn.execute("DELETE FROM post_mortems WHERE problem_id = ?1", params![problem_id])?;
    Ok(affected > 0)
}

/// Chuyển query thô của user thành cú pháp MATCH an toàn cho FTS5:
/// - Escape dấu ngoặc kép (tránh phá cú pháp MATCH).
/// - Bọc từng từ trong ngoặc kép + hậu tố `*` để search theo kiểu "prefix
///   match" (gõ "over" vẫn ra kết quả chứa "overflow") - trải nghiệm search
///   tức thời cần prefix match, exact match sẽ cảm giác "đơ".
/// - Nhiều từ nối bằng khoảng trắng = AND ngầm định của FTS5.
fn build_fts_match_query(raw: &str) -> String {
    raw.split_whitespace()
        .map(|term| {
            let escaped = term.replace('"', "\"\"");
            format!("\"{escaped}\"*")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Full-text search qua FTS5, xếp hạng bằng BM25. Với external-content table
/// + index gọn (problem_id UNINDEXED, dữ liệu text ngắn của 1 user cá nhân),
/// truy vấn này thường chạy dưới 5ms trên vài nghìn bản ghi - đủ nhanh để gọi
/// trực tiếp mỗi lần gõ phím (debounce ở frontend, không cần cache thêm).
pub fn search_post_mortems(conn: &Connection, raw_query: &str, limit: usize) -> Result<Vec<SearchResultItem>> {
    let trimmed = raw_query.trim();
    if trimmed.is_empty() {
        // Query rỗng: không phải lỗi, chỉ đơn giản chưa có gì để tìm - trả
        // mảng rỗng thay vì để FTS5 MATCH ném lỗi syntax với input rỗng.
        return Ok(Vec::new());
    }

    let match_query = build_fts_match_query(trimmed);
    let limit = limit.clamp(1, 100) as i64;

    let sql = r#"
        SELECT
            p.id, p.problem_id, p.problem_name, p.platform, p.root_cause,
            p.key_insight, p.tags, p.created_at, p.updated_at,
            bm25(post_mortems_fts) AS rank
        FROM post_mortems_fts
        JOIN post_mortems p ON p.id = post_mortems_fts.rowid
        WHERE post_mortems_fts MATCH ?1
        ORDER BY rank
        LIMIT ?2
    "#;

    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![match_query, limit], |row| {
        let record = map_row_to_record(row)?;
        let rank: f64 = row.get(9)?;
        Ok(SearchResultItem { record, rank })
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `.expect()` trong test setup là idiomatic Rust và KHÔNG vi phạm ràng
    /// buộc "zero unwrap/expect" - ràng buộc đó chỉ áp dụng cho production
    /// database path (upsert/get/search/delete ở trên), không áp dụng cho
    /// test code, nơi panic sớm khi setup lỗi là hành vi ĐÚNG mong muốn.
    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("mở in-memory DB cho test phải luôn thành công");
        crate::db::schema::ensure_post_mortem_schema(&conn)
            .expect("migration schema post-mortem cho test phải luôn thành công");
        conn
    }

    fn sample_input(problem_id: &str, key_insight: &str) -> PostMortemInput {
        PostMortemInput {
            problem_id: problem_id.to_string(),
            problem_name: format!("Problem {problem_id}"),
            platform: None,
            root_cause: "LOGIC_BUG".to_string(),
            key_insight: key_insight.to_string(),
            tags: "test,fts".to_string(),
        }
    }

    #[test]
    fn insert_syncs_to_fts_index() {
        let mut conn = setup_test_db();
        let input = sample_input("1900A", "forgot to handle integer overflow in multiplication");

        upsert_post_mortem(&mut conn, &input).expect("upsert phải thành công với input hợp lệ");

        let results = search_post_mortems(&conn, "overflow", 10).expect("search phải chạy được");
        assert_eq!(results.len(), 1, "trigger post_mortems_ai không đồng bộ FTS index sau INSERT");
        assert_eq!(results[0].record.problem_id, "1900A");
    }

    #[test]
    fn update_purges_old_terms_and_indexes_new_ones() {
        let mut conn = setup_test_db();
        let mut input = sample_input("1900B", "missed empty array edge case entirely");

        upsert_post_mortem(&mut conn, &input).expect("upsert lần 1 phải thành công");

        // Từ khoá cũ phải tìm ra được TRƯỚC khi update.
        let before = search_post_mortems(&conn, "empty", 10).expect("search phải chạy được");
        assert_eq!(before.len(), 1);

        input.key_insight = "off by one error in the nested loop boundary".to_string();
        upsert_post_mortem(&mut conn, &input).expect("upsert lần 2 (update) phải thành công");

        // Từ khoá CŨ không còn tìm ra được nữa - chứng minh trigger post_mortems_au
        // đã xoá đúng bản ghi CŨ khỏi FTS index (không chỉ thêm bản ghi mới đè lên).
        let after_old_term = search_post_mortems(&conn, "empty", 10).expect("search phải chạy được");
        assert!(
            after_old_term.is_empty(),
            "trigger post_mortems_au không xoá từ khoá cũ khỏi FTS index - index bị lệch"
        );

        // Từ khoá MỚI phải tìm ra được - chứng minh vế insert lại của trigger hoạt động.
        let after_new_term = search_post_mortems(&conn, "boundary", 10).expect("search phải chạy được");
        assert_eq!(after_new_term.len(), 1);
        assert_eq!(after_new_term[0].record.key_insight, input.key_insight);
    }

    #[test]
    fn delete_purges_fts_index() {
        let mut conn = setup_test_db();
        let input = sample_input("1900C", "misread the constraint about negative numbers");

        upsert_post_mortem(&mut conn, &input).expect("upsert phải thành công");

        let before = search_post_mortems(&conn, "negative", 10).expect("search phải chạy được");
        assert_eq!(before.len(), 1);

        let deleted = delete_post_mortem(&conn, "1900C").expect("delete phải chạy được");
        assert!(deleted, "delete_post_mortem phải trả true khi record tồn tại");

        let after = search_post_mortems(&conn, "negative", 10).expect("search phải chạy được");
        assert!(
            after.is_empty(),
            "trigger post_mortems_ad không xoá record khỏi FTS index sau DELETE"
        );
    }

    #[test]
    fn invalid_root_cause_is_rejected_before_hitting_db() {
        let mut conn = setup_test_db();
        let mut input = sample_input("1900D", "some insight");
        input.root_cause = "NOT_A_REAL_CAUSE".to_string();

        let result = upsert_post_mortem(&mut conn, &input);
        assert!(result.is_err(), "root_cause không hợp lệ phải bị từ chối ngay ở Rust, không đợi CHECK constraint");
    }

    #[test]
    fn tags_are_normalized_on_write() {
        let mut conn = setup_test_db();
        let mut input = sample_input("1900E", "duplicate tags test");
        input.tags = " DP , Tree ,dp,  ".to_string();

        let record = upsert_post_mortem(&mut conn, &input).expect("upsert phải thành công");
        assert_eq!(record.tags, "dp,tree", "normalize_tags phải lowercase, trim, và loại trùng");
    }
}
