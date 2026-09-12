use regex::Regex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurriculumResolution {
    pub major_code: String,
    pub total_credits: i64,
    pub matched_via: String,
}

static D_CODE_RE: OnceLock<Regex> = OnceLock::new();

fn d_code_pattern() -> &'static Regex {
    D_CODE_RE.get_or_init(|| {
        match Regex::new(r"D\d{6}") {
            Ok(re) => re,
            Err(_) => match Regex::new(r"$^") {
                Ok(fallback) => fallback,
                Err(_) => loop {},
            },
        }
    })
}

/// Phân tách chuỗi thô thành danh sách các token chuẩn hóa (viết hoa, bỏ ký tự ngăn cách)
pub fn tokenize(raw: &str) -> Vec<String> {
    raw.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_uppercase())
        .collect()
}

/// Phân giải chương trình đào tạo theo 4 tầng thứ bậc nghiêm ngặt:
/// Tầng 1: D-Code trực tiếp (VD: D480101) -> matched_via: "d_code_direct"
/// Tầng 2: Composite Alias Track-Specific (VD: KHMT-CLC) -> matched_via: "alias_track_specific"
/// Tầng 3: Acronym trần (VD: KHMT) -> matched_via: "alias_acronym_fallback"
/// Tầng 4: Fallback cứng về UNKNOWN với 130 TC -> matched_via: "hard_fallback"
pub fn resolve_curriculum(
    conn: &Connection,
    curriculum_code: &str,
    major_code_hint: Option<&str>,
) -> Result<CurriculumResolution, String> {
    // -------------------------------------------------------------
    // TẦNG 1: Match D-Code trực tiếp (D\d{6})
    // -------------------------------------------------------------
    let re = d_code_pattern();
    let d_code_match = re
        .find(curriculum_code)
        .map(|m| m.as_str().to_string())
        .or_else(|| {
            major_code_hint.and_then(|hint| re.find(hint).map(|m| m.as_str().to_string()))
        });

    if let Some(d_code) = d_code_match {
        let query_res = conn.query_row(
            "SELECT total_credits FROM academic_curriculums WHERE major_code = ?1",
            [&d_code],
            |row| row.get::<_, i64>(0),
        );

        if let Ok(total_credits) = query_res {
            return Ok(CurriculumResolution {
                major_code: d_code,
                total_credits,
                matched_via: "d_code_direct".to_string(),
            });
        }
    }

    // -------------------------------------------------------------
    // Chuẩn bị tokens cho Tầng 2 và Tầng 3
    // -------------------------------------------------------------
    let mut tokens = tokenize(curriculum_code);
    if let Some(hint) = major_code_hint {
        tokens.extend(tokenize(hint));
    }

    // -------------------------------------------------------------
    // TẦNG 2: Match Composite Alias (ACRONYM-TRACK, có dấu '-')
    // -------------------------------------------------------------
    let mut stmt_composite = conn
        .prepare(
            "SELECT ca.alias_token, ca.major_code, ca.credit_override, ac.total_credits
             FROM curriculum_aliases ca
             JOIN academic_curriculums ac ON ca.major_code = ac.major_code
             WHERE ca.alias_token LIKE '%-%'
             ORDER BY LENGTH(ca.alias_token) DESC",
        )
        .map_err(|e| format!("Lỗi prepare composite aliases: {e}"))?;

    let composite_rows = stmt_composite
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("Lỗi query composite aliases: {e}"))?;

    for row_res in composite_rows {
        let (alias_token, major_code, credit_override, default_credits) =
            row_res.map_err(|e| e.to_string())?;

        let alias_parts: Vec<&str> = alias_token.split('-').collect();
        // Kiểm tra xem mọi phần của composite alias có xuất hiện trong tokens không
        let matches = !alias_parts.is_empty()
            && alias_parts.iter().all(|part| tokens.iter().any(|t| t == part));

        if matches {
            let total_credits = credit_override.unwrap_or(default_credits);
            return Ok(CurriculumResolution {
                major_code,
                total_credits,
                matched_via: "alias_track_specific".to_string(),
            });
        }
    }

    // -------------------------------------------------------------
    // TẦNG 3: Match Acronym trần (không có dấu '-')
    // -------------------------------------------------------------
    let mut stmt_acronym = conn
        .prepare(
            "SELECT ca.alias_token, ca.major_code, ca.credit_override, ac.total_credits
             FROM curriculum_aliases ca
             JOIN academic_curriculums ac ON ca.major_code = ac.major_code
             WHERE ca.alias_token NOT LIKE '%-%'
             ORDER BY LENGTH(ca.alias_token) DESC",
        )
        .map_err(|e| format!("Lỗi prepare acronym aliases: {e}"))?;

    let acronym_rows = stmt_acronym
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("Lỗi query acronym aliases: {e}"))?;

    for row_res in acronym_rows {
        let (alias_token, major_code, credit_override, default_credits) =
            row_res.map_err(|e| e.to_string())?;

        if tokens.iter().any(|t| t == &alias_token) {
            let total_credits = credit_override.unwrap_or(default_credits);
            return Ok(CurriculumResolution {
                major_code,
                total_credits,
                matched_via: "alias_acronym_fallback".to_string(),
            });
        }
    }

    // -------------------------------------------------------------
    // TẦNG 4: Hard Fallback về UNKNOWN với 130 TC
    // -------------------------------------------------------------
    Ok(CurriculumResolution {
        major_code: "UNKNOWN".to_string(),
        total_credits: 130,
        matched_via: "hard_fallback".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_mock_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::schema::ensure_curriculum_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn test_tier1_d_code_direct() {
        let conn = setup_mock_db();
        let res = resolve_curriculum(&conn, "KHMT-CQUI-D480101 K20", None).unwrap();
        assert_eq!(res.major_code, "D480101");
        assert_eq!(res.total_credits, 126);
        assert_eq!(res.matched_via, "d_code_direct");
    }

    #[test]
    fn test_tier2_alias_track_specific() {
        let conn = setup_mock_db();
        let res = resolve_curriculum(&conn, "KHMT CLC 2025", None).unwrap();
        assert_eq!(res.major_code, "D480101");
        assert_eq!(res.total_credits, 130);
        assert_eq!(res.matched_via, "alias_track_specific");
    }

    #[test]
    fn test_tier3_alias_acronym_fallback() {
        let conn = setup_mock_db();
        let res = resolve_curriculum(&conn, "CNCL-KTPM-2025", None).unwrap();
        assert_eq!(res.major_code, "D480103");
        assert_eq!(res.total_credits, 130);
        assert_eq!(res.matched_via, "alias_acronym_fallback");
    }

    #[test]
    fn test_tier4_hard_fallback() {
        let conn = setup_mock_db();
        let res = resolve_curriculum(&conn, "UNKNOWN-UNMATCHABLE-STRING", None).unwrap();
        assert_eq!(res.major_code, "UNKNOWN");
        assert_eq!(res.total_credits, 130);
        assert_eq!(res.matched_via, "hard_fallback");
    }

    #[test]
    fn test_tokenize_clean_behavior() {
        let tokens = tokenize("KHMT-CQUI-D480101 K20_test.xyz/123");
        assert_eq!(
            tokens,
            vec!["KHMT", "CQUI", "D480101", "K20", "TEST", "XYZ", "123"]
        );
    }
}
