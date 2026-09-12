//! Academic validation utilities for UIT

/// Validate Vietnamese UIT Student ID (MSSV)
/// Rule: exactly 8 numeric digits (e.g., 21520000, 22521234).
pub fn is_valid_student_id(id: &str) -> bool {
    let trimmed = id.trim();
    trimmed.len() == 8 && trimmed.chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_student_id_8_digits() {
        assert!(is_valid_student_id("21520000"));
        assert!(is_valid_student_id("22521234"));
        assert!(is_valid_student_id("  23529999  "));
    }

    #[test]
    fn test_invalid_student_id() {
        assert!(!is_valid_student_id("2152000")); // 7 digits
        assert!(!is_valid_student_id("215200000")); // 9 digits
        assert!(!is_valid_student_id("2152ABCD")); // letters
        assert!(!is_valid_student_id("")); // empty
        assert!(!is_valid_student_id("2152-000")); // special char
    }
}
