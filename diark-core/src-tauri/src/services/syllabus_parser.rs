use crate::services::curriculum_harvester::normalize_major_name;
use flate2::read::ZlibDecoder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParsedSyllabusWeights {
    pub qt: i32,
    pub th: i32,
    pub gk: i32,
    pub ck: i32,
}

static RE_PCT: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"(\d{1,3})\s*%").map_err(|e| format!("Invalid RE_PCT regex: {e}"))
});
static RE_SPLIT_DIGITS: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"(\d)\s+(\d)\s*%").map_err(|e| format!("Invalid RE_SPLIT_DIGITS regex: {e}"))
});
static RE_HEX: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"<([0-9a-fA-F]+)>").map_err(|e| format!("Invalid RE_HEX regex: {e}"))
});
static RE_BFCHAR: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"(?s)beginbfchar(.*?)endbfchar")
        .map_err(|e| format!("Invalid RE_BFCHAR regex: {e}"))
});
static RE_BFCHAR_PAIR: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>")
        .map_err(|e| format!("Invalid RE_BFCHAR_PAIR regex: {e}"))
});
static RE_BFRANGE: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"(?s)beginbfrange(.*?)endbfrange")
        .map_err(|e| format!("Invalid RE_BFRANGE regex: {e}"))
});
static RE_BFRANGE_TRIPLE: LazyLock<Result<Regex, String>> = LazyLock::new(|| {
    Regex::new(r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>")
        .map_err(|e| format!("Invalid RE_BFRANGE_TRIPLE regex: {e}"))
});

fn decode_utf16_hex(hex_str: &str) -> String {
    let padded = if hex_str.len() % 2 == 1 {
        format!("0{hex_str}")
    } else {
        hex_str.to_string()
    };
    let mut bytes = Vec::with_capacity(padded.len() / 2);
    for i in (0..padded.len()).step_by(2) {
        if let Ok(b) = u8::from_str_radix(&padded[i..i + 2], 16) {
            bytes.push(b);
        }
    }
    if bytes.len() >= 2 && bytes.len() % 2 == 0 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return char::decode_utf16(units)
            .filter_map(|r| r.ok())
            .collect();
    }
    bytes.into_iter().map(|b| b as char).collect()
}

fn parse_tounicode_cmap(data: &str, cmap: &mut HashMap<u16, String>) {
    if let Ok(re_bfchar) = RE_BFCHAR.as_ref() {
        if let Ok(re_pair) = RE_BFCHAR_PAIR.as_ref() {
            for block in re_bfchar.captures_iter(data) {
                if let Some(body) = block.get(1) {
                    for pair in re_pair.captures_iter(body.as_str()) {
                        let Some(src_hex) = pair.get(1).map(|m| m.as_str()) else {
                            continue;
                        };
                        let Some(dst_hex) = pair.get(2).map(|m| m.as_str()) else {
                            continue;
                        };
                        if let Ok(code) = u16::from_str_radix(src_hex, 16) {
                            let decoded = decode_utf16_hex(dst_hex);
                            if !decoded.is_empty() {
                                cmap.insert(code, decoded);
                            }
                        }
                    }
                }
            }
        }
    }

    if let Ok(re_bfrange) = RE_BFRANGE.as_ref() {
        if let Ok(re_triple) = RE_BFRANGE_TRIPLE.as_ref() {
            for block in re_bfrange.captures_iter(data) {
                if let Some(body) = block.get(1) {
                    for triple in re_triple.captures_iter(body.as_str()) {
                        let Some(s_hex) = triple.get(1).map(|m| m.as_str()) else {
                            continue;
                        };
                        let Some(e_hex) = triple.get(2).map(|m| m.as_str()) else {
                            continue;
                        };
                        let Some(d_hex) = triple.get(3).map(|m| m.as_str()) else {
                            continue;
                        };
                        if d_hex.len() > 8 {
                            continue;
                        }
                        let (Ok(start), Ok(end), Ok(dst_start)) = (
                            u16::from_str_radix(s_hex, 16),
                            u16::from_str_radix(e_hex, 16),
                            u32::from_str_radix(d_hex, 16),
                        ) else {
                            continue;
                        };
                        if end < start || (end - start) > 512 {
                            continue;
                        }
                        for offset in 0..=(end - start) {
                            let code = start + offset;
                            if let Some(ch) = char::from_u32(dst_start + u32::from(offset)) {
                                cmap.insert(code, ch.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if needle.is_empty() || start >= haystack.len() {
        return None;
    }
    haystack[start..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|idx| start + idx)
}

fn decode_pdf_hex_token(hex_str: &str, cmap: &HashMap<u16, String>, out: &mut String) {
    if cmap.is_empty() {
        out.push_str(&decode_utf16_hex(hex_str));
        return;
    }
    if hex_str.len() >= 4 {
        for i in (0..=hex_str.len() - 4).step_by(4) {
            if let Ok(code) = u16::from_str_radix(&hex_str[i..i + 4], 16) {
                if let Some(mapped) = cmap.get(&code) {
                    out.push_str(mapped);
                } else if (0x20..=0x7e).contains(&code) {
                    if let Some(ch) = char::from_u32(u32::from(code)) {
                        out.push(ch);
                    }
                }
            }
        }
    }
}

fn extract_text_from_content_stream(stream_text: &str, cmap: &HashMap<u16, String>) -> String {
    let mut out = String::new();
    let bytes = stream_text.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;

    while i < len {
        match bytes[i] {
            b'[' => {
                // Parse TJ array until matching ']'
                let start = i + 1;
                let mut j = start;
                let mut in_paren = false;
                let mut escaped = false;
                while j < len {
                    let b = bytes[j];
                    if in_paren {
                        if escaped {
                            escaped = false;
                        } else if b == b'\\' {
                            escaped = true;
                        } else if b == b')' {
                            in_paren = false;
                        }
                    } else if b == b'(' {
                        in_paren = true;
                    } else if b == b']' {
                        break;
                    }
                    j += 1;
                }
                let array_slice = &stream_text[start..j.min(len)];
                let after = stream_text[j.min(len)..].trim_start();
                if after.starts_with("]TJ") || after.starts_with("] TJ") || after.contains("TJ") {
                    if let Ok(re_hex) = RE_HEX.as_ref() {
                        for cap in re_hex.captures_iter(array_slice) {
                            if let Some(m) = cap.get(1) {
                                decode_pdf_hex_token(m.as_str(), cmap, &mut out);
                            }
                        }
                    }
                    // Also handle literal substrings inside TJ
                    let mut p = 0usize;
                    let ab = array_slice.as_bytes();
                    while p < ab.len() {
                        if ab[p] == b'(' {
                            p += 1;
                            let mut esc = false;
                            while p < ab.len() {
                                if esc {
                                    out.push(ab[p] as char);
                                    esc = false;
                                } else if ab[p] == b'\\' {
                                    esc = true;
                                } else if ab[p] == b')' {
                                    p += 1;
                                    break;
                                } else {
                                    out.push(ab[p] as char);
                                }
                                p += 1;
                            }
                        } else {
                            p += 1;
                        }
                    }
                }
                i = (j + 1).min(len);
            }
            b'<' if i + 1 < len && bytes[i + 1] != b'<' => {
                if let Some(close_rel) = bytes[i + 1..].iter().position(|&c| c == b'>') {
                    let hex_slice = &stream_text[i + 1..i + 1 + close_rel];
                    let after = &stream_text[i + 2 + close_rel..].trim_start();
                    if after.starts_with("Tj") {
                        decode_pdf_hex_token(hex_slice, cmap, &mut out);
                        out.push(' ');
                    }
                    i += 2 + close_rel;
                } else {
                    i += 1;
                }
            }
            b'(' => {
                let mut j = i + 1;
                let mut lit = String::new();
                let mut esc = false;
                while j < len {
                    let b = bytes[j];
                    if esc {
                        lit.push(b as char);
                        esc = false;
                    } else if b == b'\\' {
                        esc = true;
                    } else if b == b')' {
                        j += 1;
                        break;
                    } else {
                        lit.push(b as char);
                    }
                    j += 1;
                }
                let after = stream_text[j.min(len)..].trim_start();
                if after.starts_with("Tj") || after.starts_with('\'') || after.starts_with('"') {
                    out.push_str(&lit);
                    out.push(' ');
                }
                i = j.min(len);
            }
            b'T' if i + 1 < len && matches!(bytes[i + 1], b'D' | b'd' | b'*') => {
                out.push(' ');
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    out
}

/// Giải nén FlateDecode streams và CMap ToUnicode từ file PDF đề cương UIT sang Unicode text.
pub fn extract_pdf_text_for_syllabus(pdf_bytes: &[u8]) -> String {
    let mut cmap: HashMap<u16, String> = HashMap::new();
    let mut text_streams: Vec<String> = Vec::new();
    let mut cursor = 0usize;

    while let Some(stream_pos) = find_subslice(pdf_bytes, b"stream", cursor) {
        let mut data_start = stream_pos + b"stream".len();
        if pdf_bytes.get(data_start) == Some(&b'\r') {
            data_start += 1;
        }
        if pdf_bytes.get(data_start) == Some(&b'\n') {
            data_start += 1;
        } else {
            cursor = stream_pos + 6;
            continue;
        }

        let Some(end_pos) = find_subslice(pdf_bytes, b"endstream", data_start) else {
            break;
        };
        let mut raw_stream = &pdf_bytes[data_start..end_pos];
        while raw_stream.last() == Some(&b'\n') || raw_stream.last() == Some(&b'\r') {
            raw_stream = &raw_stream[..raw_stream.len() - 1];
        }

        let mut decompressed = Vec::new();
        let mut decoder = ZlibDecoder::new(raw_stream);
        let content_bytes = if decoder.read_to_end(&mut decompressed).is_ok() && !decompressed.is_empty()
        {
            &decompressed[..]
        } else {
            raw_stream
        };

        let latin1: String = content_bytes.iter().map(|&b| b as char).collect();
        if latin1.contains("beginbfchar") || latin1.contains("beginbfrange") {
            parse_tounicode_cmap(&latin1, &mut cmap);
        } else if latin1.contains("Tj") || latin1.contains("TJ") {
            text_streams.push(latin1);
        }

        cursor = end_pos + b"endstream".len();
    }

    let mut combined = String::new();
    for ts in text_streams {
        let chunk = extract_text_from_content_stream(&ts, &cmap);
        if !chunk.trim().is_empty() {
            combined.push_str(&chunk);
            combined.push('\n');
        }
    }
    combined
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComponentKind {
    Qt,
    Th,
    Gk,
    Ck,
}

fn find_component_mentions(segment: &str) -> Vec<(usize, ComponentKind)> {
    let patterns: &[(&str, ComponentKind)] = &[
        ("qua trinh", ComponentKind::Qt),
        ("qu trinh", ComponentKind::Qt),
        ("chuyen can", ComponentKind::Qt),
        ("thuc hanh", ComponentKind::Th),
        ("thuc hnh", ComponentKind::Th),
        ("giua ky", ComponentKind::Gk),
        ("giua ki", ComponentKind::Gk),
        ("cuoi ky", ComponentKind::Ck),
        ("cuoi ki", ComponentKind::Ck),
    ];

    let mut hits: Vec<(usize, ComponentKind)> = Vec::new();
    for (pat, kind) in patterns {
        let mut from = 0usize;
        while let Some(rel) = segment[from..].find(pat) {
            let abs = from + rel;
            // Bỏ qua "thực hành cuối kỳ" trong phần chia nhỏ cuối kỳ (như CS115 A4 = 30% + 30%)
            let trailing = &segment[abs..];
            let is_th_cuoi_ky = *kind == ComponentKind::Th && trailing.starts_with("thuc hanh cuoi k");
            if !is_th_cuoi_ky {
                hits.push((abs, *kind));
            }
            from = abs + pat.len();
        }
    }
    hits.sort_by_key(|h| h.0);
    hits
}

/// Phân giải trọng số QT / TH / GK / CK (tổng = 100%) từ nội dung text của đề cương UIT.
pub fn parse_weights_from_syllabus_text(raw_text: &str) -> Option<ParsedSyllabusWeights> {
    let Ok(re_split) = RE_SPLIT_DIGITS.as_ref() else {
        return None;
    };
    let Ok(re_pct) = RE_PCT.as_ref() else {
        return None;
    };

    // Gộp các chữ số bị tách do kerning PDF ("4 0%" -> "40%")
    let joined_digits = re_split.replace_all(raw_text, "${1}${2}%");
    let joined_digits = re_split.replace_all(&joined_digits, "${1}${2}%");
    let norm = normalize_major_name(&joined_digits);

    let section_start = [
        "khung thong tin ve kiem tra danh gia",
        "danh gia mon hoc",
        "dnh gi mon hoc",
        "course assessment",
        "thanh phan danh gia",
        "thanh phan dnh gi",
    ]
    .iter()
    .filter_map(|marker| norm.find(marker))
    .min()
    .unwrap_or(0);

    let after_start = &norm[section_start..];
    let section_end = [
        "ghi chu",
        "tai lieu hoc tap",
        "tai lieu tham khao",
        "rubric",
        "quy dinh cua mon hoc",
        "phan mem hay cong cu",
        "8. ",
        "7. danh gia mon hoc chi tiet",
    ]
    .iter()
    .filter_map(|marker| after_start.find(marker))
    .min()
    .unwrap_or(after_start.len());

    let slice = &after_start[..section_end];

    let mut qt = 0i32;
    let mut th = 0i32;
    let mut gk = 0i32;
    let mut ck = 0i32;
    let mut prev_end = 0usize;

    for cap in re_pct.captures_iter(slice) {
        let Some(full_match) = cap.get(0) else {
            continue;
        };
        let Some(num_match) = cap.get(1) else {
            continue;
        };
        let Ok(pct) = num_match.as_str().parse::<i32>() else {
            continue;
        };
        let seg = &slice[prev_end..full_match.start()];
        prev_end = full_match.end();

        if pct <= 0 || pct >= 100 {
            continue;
        }

        let hits = find_component_mentions(seg);
        if hits.is_empty() {
            continue;
        }

        // Nếu mở đầu bằng Thực hành + gộp A1 Quá trình trong cùng 1 ô (như IT004), ưu tiên TH;
        // ngược lại lấy nhãn gần dấu % nhất (như CS115 sau "A2 Giữa kỳ 0 A3 Thực hành 0 A4 Cuối kỳ").
        let selected_kind = if hits.len() >= 2
            && hits[0].1 == ComponentKind::Th
            && hits[1].1 == ComponentKind::Qt
            && !seg.contains(" 0 ")
            && seg.contains("a1")
        {
            ComponentKind::Th
        } else if let Some(last) = hits.last() {
            last.1
        } else {
            continue;
        };

        match selected_kind {
            ComponentKind::Qt if qt == 0 => qt = pct,
            ComponentKind::Th if th == 0 => th = pct,
            ComponentKind::Gk if gk == 0 => gk = pct,
            ComponentKind::Ck if ck == 0 => ck = pct,
            _ => {}
        }

        if qt + th + gk + ck == 100 {
            return Some(ParsedSyllabusWeights { qt, th, gk, ck });
        }
    }

    if qt + th + gk + ck == 100 {
        Some(ParsedSyllabusWeights { qt, th, gk, ck })
    } else {
        None
    }
}

pub fn parse_weights_from_syllabus_pdf(pdf_bytes: &[u8]) -> Option<ParsedSyllabusWeights> {
    let text = extract_pdf_text_for_syllabus(pdf_bytes);
    parse_weights_from_syllabus_text(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    #[test]
    fn test_parse_cs115_style_weights_with_subcomponents() {
        let text = r#"
            7.1 Khung thông tin về kiểm tra đánh giá kết quả học tập
            A1 Quá trình Tham dự lớp và kết quả làm bài tập của sinh viên 4 0% 10
            A2 Giữa kỳ 0
            A3 Thực hành 0
            A4 Cuối kỳ 60% 10
            Bài thi viết 30% 10
            Thực hành cuối kỳ Báo cáo đồ án môn học 30% 10
            8. TÀI LIỆU HỌC TẬP, THAM KHẢO
        "#;
        let parsed = parse_weights_from_syllabus_text(text).expect("CS115 should parse");
        assert_eq!(
            parsed,
            ParsedSyllabusWeights {
                qt: 40,
                th: 0,
                gk: 0,
                ck: 60,
            }
        );
    }

    #[test]
    fn test_parse_it004_style_weights_and_ignore_ghi_chu() {
        let text = r#"
            6. ĐÁNH GIÁ MÔN HỌC (Course assessment)
            Thành phần đánh giá Nội dung CĐRMH Tỷ lệ (%)
            Thực hnh A1. Qu trình: Kiểm tra trên lớp, bài tập G1, G2, G3 30%
            A2. Thi thực hnh G2
            Lý thuyết giữa kỳ Thi lý thuyết giữa kỳ G1,G2 20%
            Lý thuyết cuối kỳ Thi lý thuyết cuối kỳ G1, G2, G3 50%
            Ghi chú: nộp bài trễ 1 ngày trừ 20%, trễ hơn 1 ngày xem như không nộp bài tập
            7. ĐÁNH GIÁ MÔN HỌC CHI TIẾT
        "#;
        let parsed = parse_weights_from_syllabus_text(text).expect("IT004 should parse");
        assert_eq!(
            parsed,
            ParsedSyllabusWeights {
                qt: 0,
                th: 30,
                gk: 20,
                ck: 50,
            }
        );
    }

    #[test]
    fn test_parse_standard_4_component_weights() {
        let text = r#"
            Thành phần đánh giá:
            - Quá trình: 20%
            - Thực hành: 20%
            - Giữa kỳ: 20%
            - Cuối kỳ: 40%
        "#;
        let parsed = parse_weights_from_syllabus_text(text).expect("Standard 4-component should parse");
        assert_eq!(
            parsed,
            ParsedSyllabusWeights {
                qt: 20,
                th: 20,
                gk: 20,
                ck: 40,
            }
        );
    }

    #[test]
    fn test_extract_and_parse_flate_pdf_with_tounicode_cmap() {
        let cmap_body = b"beginbfchar\n<0001> <0051>\n<0002> <0054>\n<0003> <0047>\n<0004> <004B>\n<0005> <0043>\nendbfchar";
        let content_body = b"BT (<0001>) Tj (Qua trinh 20% Thuc hanh 20% Giua ky 20% Cuoi ky 40%) Tj ET";

        let compress = |raw: &[u8]| -> Vec<u8> {
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
            enc.write_all(raw).unwrap();
            enc.finish().unwrap()
        };

        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.4\n1 0 obj\n<< /Length 10 >>\nstream\n");
        pdf.extend_from_slice(&compress(cmap_body));
        pdf.extend_from_slice(b"\nendstream\nendobj\n2 0 obj\n<< /Length 10 >>\nstream\n");
        pdf.extend_from_slice(&compress(content_body));
        pdf.extend_from_slice(b"\nendstream\nendobj\n");

        let parsed = parse_weights_from_syllabus_pdf(&pdf).expect("PDF bytes should parse");
        assert_eq!(
            parsed,
            ParsedSyllabusWeights {
                qt: 20,
                th: 20,
                gk: 20,
                ck: 40,
            }
        );
        assert_eq!(parse_weights_from_syllabus_text("Không có bảng trọng số nào"), None);
    }
}
