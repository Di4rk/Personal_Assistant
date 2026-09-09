#[cfg(test)]
mod tests {
    use crate::modules::academic::parser::{
        parse_portal_transcript, parse_semester_label, score_to_scale_4,
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

    #[test]
    fn test_parse_summary_tab_with_comma_and_dot() {
        let html_summary = r#"
            <table>
              <thead>
                <tr>
                  <th>Học kỳ</th><th>Điểm TB HK</th><th>Điểm TB tích lũy</th><th>Xếp loại</th><th>TC HK</th><th>TC tích lũy</th><th>ĐRL</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>HK1 · 2025</td>
                  <td>8,45</td>
                  <td>8,20</td>
                  <td>Giỏi</td>
                  <td>21</td>
                  <td>65</td>
                  <td>85</td>
                </tr>
                <tr>
                  <td>HK2 · 2024</td>
                  <td>7.90</td>
                  <td>8.10</td>
                  <td>Khá</td>
                  <td>19</td>
                  <td>44</td>
                  <td>90</td>
                </tr>
              </tbody>
            </table>
        "#;

        let records = crate::modules::academic::parser::parse_summary_tab(html_summary)
            .expect("parse summary tab should succeed");

        assert_eq!(records.len(), 2);
        let r0 = &records[0];
        assert_eq!(r0.semester_id, "2025_2026_HK1");
        assert_eq!(r0.term_gpa, 8.45);
        assert_eq!(r0.cumulative_gpa, 8.20);
        assert_eq!(r0.classification, "Giỏi");
        assert_eq!(r0.term_credits, 21);
        assert_eq!(r0.cumulative_credits, 65);
        assert_eq!(r0.drl, Some(85));

        let r1 = &records[1];
        assert_eq!(r1.semester_id, "2024_2025_HK2");
        assert_eq!(r1.term_gpa, 7.90);
        assert_eq!(r1.cumulative_gpa, 8.10);
        assert_eq!(r1.classification, "Khá");
        assert_eq!(r1.term_credits, 19);
        assert_eq!(r1.cumulative_credits, 44);
        assert_eq!(r1.drl, Some(90));
    }

    #[test]
    fn test_parse_by_ctdt_tab_terms_and_courses() {
        let html_ctdt = r#"
            <div class="space-y-4">
              <div class="rounded-lg border">
                <h3>Học kỳ 1 (CTĐT)</h3>
                <table>
                  <tbody>
                    <tr>
                      <td>IT001</td><td>Nhập môn lập trình</td><td>4</td><td>Bắt buộc</td><td>8,5</td><td>Đã qua</td>
                    </tr>
                    <tr>
                      <td>MA003</td><td>Đại số tuyến tính</td><td>3</td><td>Bắt buộc</td><td>–</td><td>Đang học</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="rounded-lg border">
                <h3>Học kỳ 20 (CTĐT)</h3>
                <table>
                  <tbody>
                    <tr>
                      <td>SE334</td><td>Kiến trúc phần mềm nâng cao</td><td>3</td><td>Tự chọn</td><td>–</td><td>Chưa học</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
        "#;

        let curriculum = crate::modules::academic::parser::parse_by_ctdt_tab(html_ctdt)
            .expect("parse ctdt should succeed");

        assert_eq!(curriculum.len(), 3);

        let c0 = &curriculum[0];
        assert_eq!(c0.course_code, "IT001");
        assert_eq!(c0.course_name, "Nhập môn lập trình");
        assert_eq!(c0.credits, 4);
        assert_eq!(c0.course_type, "Bắt buộc");
        assert_eq!(c0.ideal_term, 1);
        assert_eq!(c0.status, "Đã qua");
        assert_eq!(c0.final_score, Some(8.5));

        let c1 = &curriculum[1];
        assert_eq!(c1.course_code, "MA003");
        assert_eq!(c1.ideal_term, 1);
        assert_eq!(c1.status, "Đang học");
        assert_eq!(c1.final_score, None);

        let c2 = &curriculum[2];
        assert_eq!(c2.course_code, "SE334");
        assert_eq!(c2.ideal_term, 20);
        assert_eq!(c2.course_type, "Tự chọn");
        assert_eq!(c2.status, "Chưa học");
        assert_eq!(c2.final_score, None);
    }

    #[test]
    fn test_unified_3in1_pipeline_persistence() {
        let raw_summary = r#"
            <table>
              <tbody>
                <tr>
                  <td>HK1 · 2025</td><td>8.50</td><td>8.50</td><td>Giỏi</td><td>20</td><td>20</td><td>90</td>
                </tr>
              </tbody>
            </table>
        "#;

        let raw_semester = r#"
            <div class="rounded-lg border">
              <h3>Học kỳ 1/2025-2026</h3>
              <table>
                <tbody>
                  <tr>
                    <td>IT001</td><td>Nhập môn lập trình</td><td>4</td><td>9.0</td><td>8.0</td><td>8.5</td><td>8.5</td><td>8.5</td>
                  </tr>
                </tbody>
              </table>
            </div>
        "#;

        let raw_ctdt = r#"
            <div class="rounded-lg border">
              <h3>Học kỳ 1 (CTĐT)</h3>
              <table>
                <tbody>
                  <tr>
                    <td>IT001</td><td>Nhập môn lập trình</td><td>4</td><td>Bắt buộc</td><td>8.5</td><td>Đã qua</td>
                  </tr>
                </tbody>
              </table>
            </div>
        "#;

        let payload_raw = serde_json::json!({
            "summary": raw_summary,
            "by_semester": raw_semester,
            "by_ctdt": raw_ctdt,
        }).to_string();

        let unified = crate::modules::academic::parser::parse_unified_portal_payload(&payload_raw)
            .expect("unified payload parse should succeed");

        assert_eq!(unified.macro_metrics.len(), 1);
        assert_eq!(unified.historical_semesters.len(), 1);
        assert_eq!(unified.curriculum_courses.len(), 1);

        // Test persistence into SQLite
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::academic::ensure_academic_schema(&conn).unwrap();

        crate::db::academic::persist_unified_academic_sync(&mut conn, &unified)
            .expect("persist unified sync should succeed");

        let macros = crate::db::academic::get_all_macro_metrics(&conn).unwrap();
        assert_eq!(macros.len(), 1);
        assert_eq!(macros[0].semester_id, "2025_2026_HK1");
        assert_eq!(macros[0].term_gpa, 8.5);

        let curriculum = crate::db::academic::get_all_curriculum_courses(&conn).unwrap();
        assert_eq!(curriculum.len(), 1);
        assert_eq!(curriculum[0].course_code, "IT001");
        assert_eq!(curriculum[0].status, "Đã qua");

        let semesters = crate::db::academic::get_all_semesters_with_stats(&conn).unwrap();
        assert_eq!(semesters.len(), 1);
        assert_eq!(semesters[0].id, "2025_2026_HK1");
        assert_eq!(semesters[0].actual_gpa_10, Some(8.5));
    }
}
