//! OneNote URI Security Validator & Link Bridge
//!
//! Enforces strict URI boundaries to prevent command line argument injection
//! or unauthorized scheme invocation.

/// Validates that a string is a safe, conformant OneNote URI.
pub fn validate_onenote_uri(uri: &str) -> Result<(), String> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    if trimmed.len() > 1024 {
        return Err("OneNote URI vượt quá độ dài cho phép (tối đa 1024 ký tự)".into());
    }

    // Bắt buộc bắt đầu bằng onenote: (case-insensitive)
    if !trimmed.to_lowercase().starts_with("onenote:") {
        return Err("URI scheme không hợp lệ: phải bắt đầu bằng 'onenote:'".into());
    }

    // Chặn tuyệt đối raw double quote để triệt tiêu command line argument injection
    if trimmed.contains('"') {
        return Err("Ký tự không hợp lệ trong URI: phát hiện dấu ngoặc kép '\"'".into());
    }

    // Whitelist bộ ký tự an toàn
    let is_valid_char = |c: char| {
        c.is_alphanumeric()
            || matches!(
                c,
                '/' | '.' | '-' | '_' | ':' | '%' | '?' | '#' | '&' | '=' | '@' | '+' | '~'
            )
    };

    if !trimmed.chars().all(is_valid_char) {
        return Err("OneNote URI chứa ký tự đặc biệt không được phép".into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reject_double_quotes() {
        let res = validate_onenote_uri("onenote:test\" -arg");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("dấu ngoặc kép"));
    }

    #[test]
    fn test_reject_invalid_scheme() {
        let res = validate_onenote_uri("https://onenote.com/notebook");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("URI scheme không hợp lệ"));
    }

    #[test]
    fn test_reject_overlong_uri() {
        let mut long_uri = String::from("onenote:");
        long_uri.push_str(&"a".repeat(1025));
        let res = validate_onenote_uri(&long_uri);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("tối đa 1024 ký tự"));
    }

    #[test]
    fn test_accept_valid_onenote_uri() {
        let valid_uri = "onenote:https://d.docs.live.net/123/Notebook/Page.one#section-id";
        assert!(validate_onenote_uri(valid_uri).is_ok());
    }

    #[test]
    fn test_accept_empty_uri() {
        assert!(validate_onenote_uri("").is_ok());
        assert!(validate_onenote_uri("   ").is_ok());
    }
}
