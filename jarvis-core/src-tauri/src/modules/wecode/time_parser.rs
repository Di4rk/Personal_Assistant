use chrono::{FixedOffset, NaiveDateTime, TimeZone};

const ICT_OFFSET_SECONDS: i32 = 7 * 3600;
const PRIMARY_FORMAT: &str = "%a, %d %b %Y %H:%M:%S";

pub fn parse_wecode_timestamp(raw: &str) -> Result<i64, String> {
    let ict_offset = FixedOffset::east_opt(ICT_OFFSET_SECONDS)
        .ok_or_else(|| "Invalid ICT offset constant".to_string())?;

    let naive = NaiveDateTime::parse_from_str(raw.trim(), PRIMARY_FORMAT)
        .map_err(|e| format!("Failed to parse Wecode timestamp '{raw}': {e}"))?;

    match ict_offset.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Ok(dt.timestamp()),
        chrono::LocalResult::None => {
            Err(format!("Timestamp '{raw}' does not exist in ICT offset"))
        }
        chrono::LocalResult::Ambiguous(dt, _) => Ok(dt.timestamp()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_standard_wecode_format() {
        let ts = parse_wecode_timestamp("Fri, 17 Jul 2026 01:50:46").unwrap();
        assert!(ts > 0);
    }

    #[test]
    fn test_parse_rejects_malformed_input_without_panic() {
        let result = parse_wecode_timestamp("invalid timestamp format");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_boundary_date() {
        let ts = parse_wecode_timestamp("Wed, 31 Dec 2025 23:59:59").unwrap();
        assert!(ts > 0);
    }
}
