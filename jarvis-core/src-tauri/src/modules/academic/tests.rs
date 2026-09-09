#[cfg(test)]
mod tests {
    use crate::modules::academic::parser::{
        parse_portal_transcript, parse_semester_label, score_to_scale_4, GpaPolicy,
    };

    #[test]
    fn test_float_and_policy_pe_me_and_eng() {
        // 1. PE001 (2 TC, 8.0) -> is_passed = true, is_gpa_calculated = false, summary_score_4 = None
        let html_pe = r#"
            <table>
              <tbody>
                <tr>
                  <td>PE001</td><td>Bóng bàn 1</td><td>2</td><td>–</td><td>–</td><td>–</td><td>–</td><td>8.0</td>
                </tr>
              </tbody>
            </table>
        "#;
        let parsed_pe = parse_portal_transcript(html_pe).expect("parse PE should succeed");
        assert_eq!(parsed_pe.len(), 1);
        let course_pe = &parsed_pe[0].courses[0];
        assert_eq!(course_pe.course_code, "PE001");
        assert!(course_pe.is_passed);
        assert!(!course_pe.is_gpa_calculated);
        assert_eq!(course_pe.summary_score_4, None);

        // 2. ME001 (3 TC, 7.5) -> is_passed = true, is_gpa_calculated = false, summary_score_4 = None
        let html_me = r#"
            <table>
              <tbody>
                <tr>
                  <td>ME001</td><td>Giáo dục quốc phòng 1</td><td>3</td><td>–</td><td>–</td><td>–</td><td>–</td><td>7.5</td>
                </tr>
              </tbody>
            </table>
        "#;
        let parsed_me = parse_portal_transcript(html_me).expect("parse ME should succeed");
        let course_me = &parsed_me[0].courses[0];
        assert_eq!(course_me.course_code, "ME001");
        assert!(course_me.is_passed);
        assert!(!course_me.is_gpa_calculated);
        assert_eq!(course_me.summary_score_4, None);

        // 3. ENG01 (4 TC, 7.7) -> is_passed = true, is_gpa_calculated = true, summary_score_4 = 3.0
        let html_eng = r#"
            <table>
              <tbody>
                <tr>
                  <td>ENG01</td><td>Tiếng Anh 1</td><td>4</td><td>–</td><td>–</td><td>8.0</td><td>7.5</td><td>7.7</td>
                </tr>
              </tbody>
            </table>
        "#;
        let parsed_eng = parse_portal_transcript(html_eng).expect("parse ENG should succeed");
        let course_eng = &parsed_eng[0].courses[0];
        assert_eq!(course_eng.course_code, "ENG01");
        assert!(course_eng.is_passed);
        assert!(course_eng.is_gpa_calculated);
        assert_eq!(course_eng.summary_score_4, Some(3.0));
        assert_eq!(course_eng.grade_char, Some("B".to_string()));
    }

    #[test]
    fn test_floating_boundary_scale_4() {
        // Boundary 8.49999 -> B+ (3.5)
        let (s4_low, char_low) = score_to_scale_4(8.49999);
        assert_eq!(s4_low, 3.5);
        assert_eq!(char_low, "B+");

        // Boundary 8.50000 -> A (3.7)
        let (s4_high, char_high) = score_to_scale_4(8.50000);
        assert_eq!(s4_high, 3.7);
        assert_eq!(char_high, "A");
    }

    #[test]
    fn test_special_symbol_m_and_dash_handling() {
        // Môn có điểm M (Điểm miễn): summary_score_10 = None, grade_char = Some("M"), is_passed = true, is_gpa_calculated = false
        let html_m = r#"
            <table>
              <tbody>
                <tr>
                  <td>IT002</td><td>OOP</td><td>4</td><td>–</td><td>–</td><td>–</td><td>–</td><td>M</td>
                </tr>
              </tbody>
            </table>
        "#;
        let parsed_m = parse_portal_transcript(html_m).expect("parse M score should succeed");
        let course_m = &parsed_m[0].courses[0];
        assert_eq!(course_m.summary_score_10, None);
        assert_eq!(course_m.grade_char, Some("M".to_string()));
        assert!(course_m.is_passed);
        assert!(!course_m.is_gpa_calculated);

        // Cột TH, GK, CK chứa '–' hoặc '-': Parse thành None an toàn, không panic
        assert_eq!(course_m.midterm_score, None);
        assert_eq!(course_m.final_score, None);
    }

    #[test]
    fn test_semester_id_generation() {
        // "Học kỳ 1/2025-2026" -> 2025_2026_HK1
        let s1 = parse_semester_label("Học kỳ 1/2025-2026").expect("HK1 valid");
        assert_eq!(s1.id, "2025_2026_HK1");
        assert_eq!(s1.academic_year, "2025-2026");
        assert_eq!(s1.semester_term, 1);

        // "Học kỳ 2/2025-2026" -> 2025_2026_HK2
        let s2 = parse_semester_label("Học kỳ 2/2025-2026").expect("HK2 valid");
        assert_eq!(s2.id, "2025_2026_HK2");
        assert_eq!(s2.academic_year, "2025-2026");
        assert_eq!(s2.semester_term, 2);

        // "Học kỳ 4/2025-2026" -> Err (Term out of bounds)
        let s4 = parse_semester_label("Học kỳ 4/2025-2026");
        assert!(s4.is_err(), "Term 4 must be rejected");
    }
}
