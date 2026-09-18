use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ============================================================
//  DTOs & Structures
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GeminiConfigDto {
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeminiStreamChunk {
    pub session_id: String,
    pub chunk: String,
    pub is_done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocraticDebugRequestDto {
    pub session_id: String,
    pub problem_name: String,
    pub problem_id: Option<i64>,
    pub verdict: String,
    pub score: i64,
    pub execution_time: f64,
    pub memory_kib: i64,
    pub language: String,
    #[serde(default)]
    pub code_snippet: Option<String>,
    #[serde(default)]
    pub user_query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExtractionRequestDto {
    pub prose_text: String,
    #[serde(default)]
    pub course_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtractedTaskDto {
    pub title: String,
    #[serde(default)]
    pub course_code: String,
    #[serde(default)]
    pub course_name: String,
    pub due_date_str: String,
    pub due_timestamp: i64,
    pub priority: String, // 'urgent' | 'high' | 'normal'
    pub description: String,
    pub task_type: String, // 'assignment' | 'quiz' | 'lab' | 'report' | 'exam' | 'general'
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedTaskListDto {
    pub tasks: Vec<ExtractedTaskDto>,
}

// Internal Gemini API Wire Formats
#[derive(Serialize)]
struct GeminiPartWire {
    text: String,
}

#[derive(Serialize)]
struct GeminiContentWire {
    role: String,
    parts: Vec<GeminiPartWire>,
}

#[derive(Serialize)]
struct GeminiGenerationConfigWire {
    temperature: f32,
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none", rename = "responseMimeType")]
    response_mime_type: Option<String>,
}

#[derive(Serialize)]
struct GeminiRequestWire {
    contents: Vec<GeminiContentWire>,
    #[serde(rename = "generationConfig")]
    generation_config: GeminiGenerationConfigWire,
}

#[derive(Deserialize)]
struct GeminiResponsePart {
    text: Option<String>,
}

#[derive(Deserialize)]
struct GeminiResponseContent {
    parts: Option<Vec<GeminiResponsePart>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiResponseContent>,
}

#[derive(Deserialize)]
struct GeminiApiErrorDetail {
    message: String,
}

#[derive(Deserialize)]
struct GeminiApiResponseWire {
    candidates: Option<Vec<GeminiCandidate>>,
    error: Option<GeminiApiErrorDetail>,
}

// ============================================================
//  Gemini Configuration Store (SQLite settings table)
// ============================================================

pub fn query_gemini_config(conn: &Connection) -> Result<GeminiConfigDto, rusqlite::Error> {
    let get_setting = |key: &str| -> Result<Option<String>, rusqlite::Error> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
    };

    let api_key = get_setting("gemini_api_key")?.unwrap_or_default();
    let model = get_setting("gemini_model")?.unwrap_or_else(|| "gemini-1.5-flash".to_string());

    Ok(GeminiConfigDto { api_key, model })
}

pub fn update_gemini_config(
    conn: &mut Connection,
    api_key: &str,
    model: &str,
) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT INTO settings (key, value) VALUES ('gemini_api_key', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![api_key.trim()],
    )?;

    tx.execute(
        "INSERT INTO settings (key, value) VALUES ('gemini_model', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![model.trim()],
    )?;

    tx.commit()?;
    Ok(())
}

// ============================================================
//  Gemini SSE Stream Parser
// ============================================================

pub fn parse_gemini_sse_line(line: &str) -> Result<Option<String>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.starts_with("data:") {
        return Ok(None);
    }

    let json_str = trimmed.trim_start_matches("data:").trim();
    if json_str == "[DONE]" {
        return Ok(None);
    }

    let payload: GeminiApiResponseWire = serde_json::from_str(json_str)
        .map_err(|e| format!("Lỗi phân tích JSON stream Gemini: {e} | Raw: {json_str}"))?;

    if let Some(err) = payload.error {
        return Err(format!("Gemini API Error: {}", err.message));
    }

    if let Some(candidates) = payload.candidates {
        for candidate in candidates {
            if let Some(content) = candidate.content {
                if let Some(parts) = content.parts {
                    let mut text_acc = String::new();
                    for part in parts {
                        if let Some(t) = part.text {
                            text_acc.push_str(&t);
                        }
                    }
                    if !text_acc.is_empty() {
                        return Ok(Some(text_acc));
                    }
                }
            }
        }
    }

    Ok(None)
}

pub fn clean_json_markdown_block(raw: &str) -> &str {
    let trimmed = raw.trim();
    if trimmed.starts_with("```json") {
        let after_prefix = &trimmed[7..];
        if let Some(end_idx) = after_prefix.rfind("```") {
            return after_prefix[..end_idx].trim();
        }
    } else if trimmed.starts_with("```") {
        let after_prefix = &trimmed[3..];
        if let Some(end_idx) = after_prefix.rfind("```") {
            return after_prefix[..end_idx].trim();
        }
    }
    trimmed
}

// ============================================================
//  Prompt Builders
// ============================================================

pub fn build_socratic_prompt(req: &SocraticDebugRequestDto) -> String {
    let user_code = req
        .code_snippet
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("// (Chưa có mã nguồn bài nộp, phân tích dựa trên metrics & verdict)");

    let user_extra = req
        .user_query
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|q| format!("\n\nCÂU HỎI THẮC MẮC CỦA SINH VIÊN:\n\"{q}\""))
        .unwrap_or_default();

    format!(
r#"Bạn là Huấn luyện viên Thuật toán Socratic (Socratic Competitive Programming Coach) tại Trường Đại học Công nghệ Thông tin (UIT - ĐHQG-HCM).
Nhiệm vụ của bạn là hỗ trợ sinh viên UIT phân tích nguyên nhân thất bại và gợi ý hướng đi cho bài nộp trên hệ thống Wecode mà TUYỆT ĐỐI KHÔNG LÀM HỘ.

THÔNG TIN BÀI NỘP WECODE:
- Tên bài tập: {problem}
- Kết quả chấm (Verdict): {verdict}
- Điểm số: {score} / 100
- Thời gian thực thi: {time:.2}s | Bộ nhớ: {mem} KiB
- Ngôn ngữ lập trình: {lang}

MÃ NGUỒN CỦA BÀI NỘP:
```{lang}
{code}
```{user_extra}

KỶ LUẬT SƯ PHẠM TỐI THƯỢNG (TUYỆT ĐỐI TUÂN THỦ):
1. KHÔNG BAO GIỜ viết code giải hoàn chỉnh hoặc spoil toàn bộ thuật toán.
2. KHÔNG BAO GIỜ chỉ đích danh "hãy sửa dòng A thành B".
3. Hãy áp dụng phương pháp Socratic và cấu trúc câu trả lời thành 4 phần rõ ràng:
   - 🔍 **Chẩn đoán sơ bộ**: Nhận xét ngắn gọn về bản chất lỗi (Nếu WA: lỗi tư duy thuật toán, thiếu nhánh logic; Nếu TLE: độ phức tạp thời gian O(N^2) vượt quá ngưỡng thời gian ~1s với N=10^5; Nếu MLE/RTE: tràn bộ nhớ, đệ quy vô hạn hoặc truy cập mảng ngoài biên).
   - ⚡ **Test case biên nghi vấn (Edge Cases)**: Liệt kê 2 - 3 kịch bản kiểm thử biên đặc biệt mà mã nguồn trên rất dễ bỏ sót (ví dụ: N=0, N=1, chuỗi rỗng, tràn số 32-bit int sang âm cần dùng long long, số âm, đồ thị không liên thông, mảng có các phần tử trùng lặp...).
   - ❓ **Câu hỏi gợi mở**: 2 câu hỏi phản biện sắc sảo kích thích sinh viên tự tìm ra lỗ hổng trong code.
   - 🧪 **Thử nghiệm đề xuất**: Cung cấp 1 bộ input kiểm thử nhỏ để sinh viên chạy thử bằng tay và tự nghiệm ra kết quả sai.

Ngôn ngữ: Tiếng Việt, súc tích, chuyên nghiệp, phong cách kỹ sư thuật toán sắc bén."#,
        problem = req.problem_name,
        verdict = req.verdict,
        score = req.score,
        time = req.execution_time,
        mem = req.memory_kib,
        lang = req.language,
        code = user_code,
        user_extra = user_extra,
    )
}

pub fn build_task_extraction_prompt(prose_text: &str, course_hint: Option<&str>) -> String {
    let hint_str = course_hint.unwrap_or("Không xác định (hãy đoán dựa trên nội dung bài viết)");
    let now_iso = Utc::now().to_rfc3339();

    format!(
r#"Nhiệm vụ: Bạn là chuyên gia trích xuất nhiệm vụ học thuật UIT thông minh.
Hãy đọc kỹ đoạn văn xuôi thông báo sau đây của giảng viên (trên diễn đàn Moodle, thông báo môn học, Zalo hoặc Email):

"""
{prose}
"""

THÔNG TIN BỔ TRỢ:
- Gợi ý môn học: {hint}
- Thời điểm hiện tại: {now_iso} (Múi giờ UTC+7 Hồ Chí Minh, Việt Nam).

YÊU CẦU BÓC TÁCH:
1. Trích xuất tất cả các deadline, bài tập, kiểm tra, nộp đồ án, báo cáo tiến độ hoặc việc cần làm được đề cập.
2. Xử lý chính xác các mốc thời gian tương đối của tiếng Việt (ví dụ: "thứ tư tuần sau", "25/10", "chủ nhật này lúc 23h59", "tiết 3-4 sáng mai"). Nếu giảng viên không ghi rõ giờ nộp cụ thể, hãy mặc định là 23:59:00 của ngày đó.
3. Tính toán `due_timestamp` chính xác ra Unix epoch seconds.
4. Xác định mức độ khẩn cấp (priority: "urgent" nếu còn dưới 3 ngày, "high" nếu dưới 7 ngày, "normal" nếu trên 7 ngày).
5. Trả về DUY NHẤT một chuỗi JSON chuẩn theo cấu trúc sau, không kèm bất kỳ giải thích hay markdown phụ:
{{
  "tasks": [
    {{
      "title": "Tên nhiệm vụ ngắn gọn rõ nghĩa (VD: Nộp Báo Cáo Đồ Án Giữa Kỳ)",
      "course_code": "Mã môn (VD: IT004, IT007...) hoặc để trống",
      "course_name": "Tên môn học tương ứng",
      "due_date_str": "YYYY-MM-DD HH:MM:SS",
      "due_timestamp": 1792947540,
      "priority": "urgent" | "high" | "normal",
      "description": "Tóm tắt yêu cầu chính, deliverables, hình thức nộp",
      "task_type": "assignment" | "quiz" | "lab" | "report" | "exam" | "general"
    }}
  ]
}}
"#,
        prose = prose_text,
        hint = hint_str,
        now_iso = now_iso,
    )
}

// ============================================================
//  API Client Operations (Streaming & Non-Streaming)
// ============================================================

pub async fn test_gemini_api_key(api_key: &str, model: &str) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("API Key không được để trống".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Không thể khởi tạo HTTP Client: {e}"))?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model.trim(),
        api_key.trim()
    );

    let body = GeminiRequestWire {
        contents: vec![GeminiContentWire {
            role: "user".to_string(),
            parts: vec![GeminiPartWire {
                text: "Ping test. Please reply with 'OK'.".to_string(),
            }],
        }],
        generation_config: GeminiGenerationConfigWire {
            temperature: 0.1,
            max_output_tokens: 16,
            response_mime_type: None,
        },
    };

    let start = std::time::Instant::now();
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Lỗi kết nối tới Gemini API: {e}"))?;

    let duration_ms = start.elapsed().as_millis();

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Gemini API từ chối ({status}): {err_text}"));
    }

    Ok(format!("Kết nối thành công tới {model} ({duration_ms}ms)!"))
}

pub async fn stream_gemini_request(
    app: AppHandle,
    api_key: String,
    model: String,
    session_id: String,
    prompt: String,
) -> Result<(), String> {
    if api_key.trim().is_empty() {
        let err_msg = "Chưa cấu hình Gemini API Key. Vui lòng nhập API Key trong Cài đặt hoặc giao diện.".to_string();
        let _ = app.emit(
            &format!("gemini-stream-{}", session_id),
            GeminiStreamChunk {
                session_id: session_id.clone(),
                chunk: String::new(),
                is_done: true,
                error: Some(err_msg.clone()),
            },
        );
        return Err(err_msg);
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Lỗi khởi tạo HTTP client: {e}"))?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
        model.trim(),
        api_key.trim()
    );

    let body = GeminiRequestWire {
        contents: vec![GeminiContentWire {
            role: "user".to_string(),
            parts: vec![GeminiPartWire { text: prompt }],
        }],
        generation_config: GeminiGenerationConfigWire {
            temperature: 0.3,
            max_output_tokens: 3072,
            response_mime_type: None,
        },
    };

    let event_name = format!("gemini-stream-{}", session_id);

    tokio::spawn(async move {
        let response_res = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;

        let mut response = match response_res {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let status = resp.status();
                    let err_body = resp.text().await.unwrap_or_default();
                    let _ = app.emit(
                        &event_name,
                        GeminiStreamChunk {
                            session_id: session_id.clone(),
                            chunk: String::new(),
                            is_done: true,
                            error: Some(format!("Gemini API Error ({status}): {err_body}")),
                        },
                    );
                    return;
                }
                resp
            }
            Err(e) => {
                let _ = app.emit(
                    &event_name,
                    GeminiStreamChunk {
                        session_id: session_id.clone(),
                        chunk: String::new(),
                        is_done: true,
                        error: Some(format!("Lỗi kết nối mạng: {e}")),
                    },
                );
                return;
            }
        };

        let mut buffer = String::new();

        while let Ok(Some(chunk_bytes)) = response.chunk().await {
            let chunk_str = String::from_utf8_lossy(&chunk_bytes);
            buffer.push_str(&chunk_str);

            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].to_string();
                buffer = buffer[pos + 1..].to_string();

                match parse_gemini_sse_line(&line) {
                    Ok(Some(text)) => {
                        let _ = app.emit(
                            &event_name,
                            GeminiStreamChunk {
                                session_id: session_id.clone(),
                                chunk: text,
                                is_done: false,
                                error: None,
                            },
                        );
                    }
                    Ok(None) => {}
                    Err(err) => {
                        let _ = app.emit(
                            &event_name,
                            GeminiStreamChunk {
                                session_id: session_id.clone(),
                                chunk: String::new(),
                                is_done: true,
                                error: Some(err),
                            },
                        );
                        return;
                    }
                }
            }
        }

        // Emit final done chunk
        let _ = app.emit(
            &event_name,
            GeminiStreamChunk {
                session_id,
                chunk: String::new(),
                is_done: true,
                error: None,
            },
        );
    });

    Ok(())
}

pub async fn extract_tasks_with_gemini(
    api_key: &str,
    model: &str,
    prose_text: &str,
    course_hint: Option<&str>,
) -> Result<Vec<ExtractedTaskDto>, String> {
    if api_key.trim().is_empty() {
        return Err("Chưa cấu hình Gemini API Key. Vui lòng nhập API Key để bóc tách bài viết.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP Client Error: {e}"))?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model.trim(),
        api_key.trim()
    );

    let prompt = build_task_extraction_prompt(prose_text, course_hint);

    let body = GeminiRequestWire {
        contents: vec![GeminiContentWire {
            role: "user".to_string(),
            parts: vec![GeminiPartWire { text: prompt }],
        }],
        generation_config: GeminiGenerationConfigWire {
            temperature: 0.1,
            max_output_tokens: 4096,
            response_mime_type: Some("application/json".to_string()),
        },
    };

    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Lỗi kết nối Gemini API: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Gemini API từ chối ({status}): {err_text}"));
    }

    let api_resp: GeminiApiResponseWire = res
        .json()
        .await
        .map_err(|e| format!("Lỗi parse response từ Gemini: {e}"))?;

    if let Some(err) = api_resp.error {
        return Err(format!("Gemini Error: {}", err.message));
    }

    let candidate_text = api_resp
        .candidates
        .and_then(|mut c| c.pop())
        .and_then(|c| c.content)
        .and_then(|c| c.parts)
        .and_then(|mut p| p.pop())
        .and_then(|p| p.text)
        .ok_or_else(|| "Gemini không trả về nội dung text nào".to_string())?;

    let cleaned_json = clean_json_markdown_block(&candidate_text);

    let list_res: Result<ExtractedTaskListDto, _> = serde_json::from_str(cleaned_json);
    match list_res {
        Ok(list) => Ok(list.tasks),
        Err(e) => {
            // Thử parse mảng trực tiếp [ ... ]
            let vec_res: Result<Vec<ExtractedTaskDto>, _> = serde_json::from_str(cleaned_json);
            match vec_res {
                Ok(tasks) => Ok(tasks),
                Err(_) => Err(format!(
                    "Không thể phân tích cấu trúc task JSON: {e} | Raw JSON: {cleaned_json}"
                )),
            }
        }
    }
}

// ============================================================
//  Insert Extracted Task Into SQLite moodle_tasks
// ============================================================

pub fn insert_extracted_moodle_task(
    conn: &mut Connection,
    task: &ExtractedTaskDto,
) -> Result<i64, String> {
    crate::db::schema::ensure_moodle_schema(conn).map_err(|e| format!("Schema error: {e}"))?;

    let now_ts = Utc::now().timestamp();
    // Sinh task_id âm để đảm bảo không bao giờ trùng với task_id dương do Moodle sinh ra
    let generated_task_id = -(Utc::now().timestamp_millis());

    // Tìm course_id tương ứng với course_code nếu có; nếu chưa có thì tạo placeholder course
    let course_id = if !task.course_code.trim().is_empty() {
        let code_pattern = format!("%{}%", task.course_code.trim());
        let found: Option<i64> = conn
            .query_row(
                "SELECT course_id FROM moodle_courses WHERE course_code LIKE ?1 LIMIT 1",
                params![code_pattern],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Query course_id error: {e}"))?;

        if let Some(cid) = found {
            cid
        } else {
            let new_cid = -(now_ts % 1_000_000);
            let cname = if task.course_name.trim().is_empty() {
                task.course_code.trim()
            } else {
                task.course_name.trim()
            };
            conn.execute(
                "INSERT INTO moodle_courses (course_id, course_code, fullname, course_url, updated_at)
                 VALUES (?1, ?2, ?3, '', ?4)",
                params![new_cid, task.course_code.trim(), cname, now_ts],
            ).map_err(|e| format!("Insert placeholder course error: {e}"))?;
            new_cid
        }
    } else {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM moodle_courses WHERE course_id = -1)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !exists {
            conn.execute(
                "INSERT INTO moodle_courses (course_id, course_code, fullname, course_url, updated_at)
                 VALUES (-1, 'GENERAL', 'Nhiệm vụ chung', '', ?1)",
                params![now_ts],
            ).map_err(|e| format!("Insert general course error: {e}"))?;
        }
        -1
    };

    let task_type_formatted = format!("ai_{}", task.task_type.trim());

    conn.execute(
        r#"
        INSERT INTO moodle_tasks (
            task_id, course_id, title, task_type, due_date,
            is_submitted, submission_status, template_file_url,
            task_url, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(task_id) DO UPDATE SET
            title = excluded.title,
            due_date = excluded.due_date,
            updated_at = excluded.updated_at
        "#,
        params![
            generated_task_id,
            course_id,
            task.title.trim(),
            task_type_formatted,
            task.due_timestamp,
            0, // is_submitted = false
            "Chưa nộp",
            "",
            "",
            now_ts
        ],
    )
    .map_err(|e| format!("Không thể lưu task vào SQLite: {e}"))?;

    Ok(generated_task_id)
}

// ============================================================
//  Unit Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_gemini_sse_line_valid_chunk() {
        let line = r#"data: {"candidates":[{"content":{"parts":[{"text":"Chào bạn! Dưới đây là phân tích:"}]}}]}"#;
        let res = parse_gemini_sse_line(line).unwrap();
        assert_eq!(res, Some("Chào bạn! Dưới đây là phân tích:".to_string()));
    }

    #[test]
    fn test_parse_gemini_sse_line_empty_or_done() {
        assert_eq!(parse_gemini_sse_line("").unwrap(), None);
        assert_eq!(parse_gemini_sse_line("data: [DONE]").unwrap(), None);
        assert_eq!(parse_gemini_sse_line(": keep-alive ping").unwrap(), None);
    }

    #[test]
    fn test_parse_gemini_sse_line_api_error() {
        let err_line = r#"data: {"error":{"message":"API_KEY_INVALID"}}"#;
        let res = parse_gemini_sse_line(err_line);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("API_KEY_INVALID"));
    }

    #[test]
    fn test_clean_json_markdown_block() {
        let raw1 = "```json\n{\"tasks\": []}\n```";
        assert_eq!(clean_json_markdown_block(raw1), "{\"tasks\": []}");

        let raw2 = "{\"tasks\": []}";
        assert_eq!(clean_json_markdown_block(raw2), "{\"tasks\": []}");
    }

    #[test]
    fn test_build_socratic_prompt_has_pedagogical_rules() {
        let req = SocraticDebugRequestDto {
            session_id: "test-sess".to_string(),
            problem_name: "Tìm đường đi ngắn nhất".to_string(),
            problem_id: Some(101),
            verdict: "WRONG ANSWER".to_string(),
            score: 40,
            execution_time: 0.05,
            memory_kib: 1024,
            language: "C++".to_string(),
            code_snippet: Some("int main() { return 0; }".to_string()),
            user_query: Some("Tại sao em bị sai test cuối?".to_string()),
        };

        let prompt = build_socratic_prompt(&req);
        assert!(prompt.contains("Huấn luyện viên Thuật toán Socratic"));
        assert!(prompt.contains("KHÔNG BAO GIỜ viết code giải hoàn chỉnh"));
        assert!(prompt.contains("Test case biên nghi vấn"));
        assert!(prompt.contains("Tìm đường đi ngắn nhất"));
        assert!(prompt.contains("Tại sao em bị sai test cuối?"));
    }

    #[test]
    fn test_insert_extracted_moodle_task_persistence() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::schema::create_tables(&conn).unwrap();

        let task = ExtractedTaskDto {
            title: "Nộp bài tập lớn CSDL".to_string(),
            course_code: "IT004".to_string(),
            course_name: "Cơ sở dữ liệu".to_string(),
            due_date_str: "2026-10-25 23:59:00".to_string(),
            due_timestamp: 1792947540,
            priority: "urgent".to_string(),
            description: "Nộp file PDF báo cáo qua link drive".to_string(),
            task_type: "report".to_string(),
        };

        let task_id = insert_extracted_moodle_task(&mut conn, &task).unwrap();
        assert!(task_id < 0);

        let row_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM moodle_tasks WHERE task_id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(row_count, 1);
    }
}
