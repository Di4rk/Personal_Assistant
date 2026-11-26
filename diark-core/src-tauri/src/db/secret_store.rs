//! Bảo vệ dữ liệu nhạy cảm lưu tại chỗ (mật khẩu SSO, Private Google Calendar ICS URL)
//! bằng Windows DPAPI (`CryptProtectData` / `CryptUnprotectData`), kèm tiền tố `"dpapi:v1:"`.
//! Giữ tương thích ngược nếu đọc dữ liệu cũ chưa được mã hóa.

const DPAPI_PREFIX: &str = "dpapi:v1:";

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("Chuỗi hex không hợp lệ (độ dài lẻ)".to_string());
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let hi = (chunk[0] as char)
            .to_digit(16)
            .ok_or_else(|| "Ký tự hex không hợp lệ".to_string())?;
        let lo = (chunk[1] as char)
            .to_digit(16)
            .ok_or_else(|| "Ký tự hex không hợp lệ".to_string())?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

#[cfg(windows)]
pub fn encrypt_secret(plaintext: &str) -> Result<String, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if plaintext.is_empty() {
        return Ok(String::new());
    }
    if plaintext.starts_with(DPAPI_PREFIX) {
        return Ok(plaintext.to_string());
    }

    let raw = plaintext.as_bytes();
    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(raw.len()).map_err(|_| "Dữ liệu quá lớn để mã hóa".to_string())?,
        pbData: raw.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };

    // SAFETY: `in_blob` trỏ tới slice hợp lệ suốt lời gọi; `out_blob` được Win32 cấp phát qua LocalAlloc và giải phóng bằng LocalFree ngay bên dưới.
    let ok = unsafe {
        CryptProtectData(
            &mut in_blob,
            std::ptr::null(),
            std::ptr::null(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err("CryptProtectData thất bại".to_string());
    }

    let encrypted = unsafe {
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let vec = slice.to_vec();
        LocalFree(out_blob.pbData as *mut std::ffi::c_void);
        vec
    };

    Ok(format!("{DPAPI_PREFIX}{}", encode_hex(&encrypted)))
}

#[cfg(windows)]
pub fn decrypt_secret(stored: &str) -> Result<String, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if stored.is_empty() {
        return Ok(String::new());
    }
    let Some(hex_part) = stored.strip_prefix(DPAPI_PREFIX) else {
        // Tương thích ngược với dữ liệu văn bản thuần từ phiên bản trước
        return Ok(stored.to_string());
    };

    let mut cipher = decode_hex(hex_part)?;
    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(cipher.len()).map_err(|_| "Dữ liệu mã hóa quá lớn".to_string())?,
        pbData: cipher.as_mut_ptr(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };

    // SAFETY: `in_blob` trỏ tới `cipher` còn sống suốt lời gọi; `out_blob` được giải phóng bằng `LocalFree` ngay sau khi copy.
    let ok = unsafe {
        CryptUnprotectData(
            &mut in_blob,
            null_mut(),
            std::ptr::null(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err("CryptUnprotectData thất bại".to_string());
    }

    let decrypted = unsafe {
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let vec = slice.to_vec();
        LocalFree(out_blob.pbData as *mut std::ffi::c_void);
        vec
    };

    String::from_utf8(decrypted).map_err(|e| format!("Secret không phải UTF-8 hợp lệ: {e}"))
}

#[cfg(not(windows))]
pub fn encrypt_secret(plaintext: &str) -> Result<String, String> {
    Ok(plaintext.to_string())
}

#[cfg(not(windows))]
pub fn decrypt_secret(stored: &str) -> Result<String, String> {
    Ok(stored.strip_prefix(DPAPI_PREFIX).unwrap_or(stored).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_secret_protection() {
        let secret = "s3cr3t-uit-password-!@#";
        let encrypted = encrypt_secret(secret).expect("encrypt should succeed");
        #[cfg(windows)]
        {
            assert_ne!(encrypted, secret);
            assert!(encrypted.starts_with(DPAPI_PREFIX));
        }
        let decrypted = decrypt_secret(&encrypted).expect("decrypt should succeed");
        assert_eq!(decrypted, secret);
    }

    #[test]
    fn plaintext_fallback_for_legacy_rows() {
        let legacy = "https://calendar.google.com/calendar/ical/example/basic.ics";
        let decrypted = decrypt_secret(legacy).expect("legacy fallback should work");
        assert_eq!(decrypted, legacy);
    }

    #[test]
    fn empty_secret_is_noop() {
        assert_eq!(encrypt_secret("").unwrap(), "");
        assert_eq!(decrypt_secret("").unwrap(), "");
    }
}
