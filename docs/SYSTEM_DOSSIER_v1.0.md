# DIARK // OS — MASTER ARCHITECTURAL DOSSIER (v1.1.0 CANONICAL BASELINE)

## 1. TỔNG QUAN HỆ THỐNG & NHÂN THỨC NGƯỜI DÙNG (PERSONA & HARDWARE)
- **Chủ sở hữu hệ thống:** Sinh viên CS/IT năm 2 (UIT - ĐHQG-HCM), định hướng Competitive Programming (ICPC), Nghiên cứu AI và An toàn thông tin; Visual Designer thương hiệu Diark.
- **Triết lý Vận hành:** Zero-Cloud, Pure Local Identity, Zero-Effort Automation, Zero Tampermonkey Dependency, Socratic Pedagogy.
- **Ngân sách Phần cứng (Acer Nitro 5 Tiger / Windows 11 Target):**
  - **Idle RAM:** < 100MB RAM (chuẩn release bundle tối ưu).
  - **Active Peak RAM:** < 500MB (khi mở Webview In-App SSO đồng bộ hoặc nạp FTS5 scan).
  - **CPU Usage:** 0.0% khi ở trạng thái nghỉ; các bộ đếm thời gian (Exam Countdown, Watchdog, Daily Briefing Scheduler) tự động rơi vào chu kỳ sleep/yield, triệt tiêu background polling vô ích.

---

## 2. TECH STACK & INVARIANTS KỸ THUẬT

### A. Core Stack
- **Native Host:** Tauri v2 (Rust 2021 edition, Tokio async runtime).
- **Database Layer:** SQLite 3 qua `rusqlite` (bundled Windows, custom functions, FTS5 full-text search), cấu hình chuẩn:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  ```
- **Database Connection Pooling:** Tuần tự hóa truy cập qua `Arc<Mutex<Connection>>` (SharedDb) tránh database locks giữa background workers và IPC handlers. Định kỳ 15 phút thực thi `PRAGMA wal_checkpoint(PASSIVE)` nhằm dọn dẹp dung lượng file `-wal`.
- **Local AI & Text Embeddings:** FastEmbed v4 (Pure Rust ONNX Engine cục bộ) & Google Gemini REST API qua SSE Streaming với giao thức BYOK (Bring Your Own Key).
- **Frontend Layer:** React 19 (`^19.1.0`), Vite 7 (`^7.0.4`), TypeScript (`~5.8.3`), Tailwind CSS v4 (`^4.3.3`), Zustand Stores (`^5.0.15`), Lucide Icons (`^1.32.0`), Visx Charts (`^4.0.0`).
- **Timezone Invariant:** Toàn bộ timestamp được chuẩn hóa về Unix Epoch UTC+7 (`Asia/Ho_Chi_Minh`).

### B. Security & Safety Invariants (P0 Rules)
1. **P0 Invariant — Zero IPC on Remote Webviews:** Mọi Webview bên ngoài (`uit-sso-login`, `wecode-sso-login`, `moodle-sso-login`, `moodle-silent-sync`) là Remote Origin không đáng tin cậy, **TUYỆT ĐỐI KHÔNG** được cấp bất kỳ Tauri IPC capability nào (`invoke`, `listen`, `emit`).
2. **P0 Invariant — Zero Cookie Exfiltration:** Hệ thống không bóc tách hay lưu trữ cookie thô (`MoodleSession`, `laravel_session`, `ums_session`). Webview tự mang phiên same-origin; dữ liệu được gửi về qua Navigation Scheme Interception:
   ```
   diark-sso://callback#target=<service>&data=<url_encoded_json>
   diark-sso://failed#reason=<error_code>
   ```
3. **P0 Invariant — Zero Code Panic:** Tuyệt đối 0 `unwrap()` hay `expect()` trên production paths của Rust; sử dụng `Result<T, AppError>` / `rusqlite::Result` và toán tử `?`. Ở Frontend, 0 `any` trong toàn bộ TypeScript codebase.
4. **P0 Invariant — Presentation-Only Privacy Masking:** Demo Mode chỉ che mờ lúc render giao diện (`Compute-on-Render`), tuyệt đối không ghi đè dữ liệu che mờ ngược vào SQLite.
5. **P0 Invariant — Socratic Pedagogy (Zero Spoiler):** Trợ lý AI Gemini hoạt động dưới nguyên tắc Socratic: Không giải bài hộ, không viết sẵn full source code hoàn chỉnh; chỉ phân tích phản xạ tư duy, gợi mở câu hỏi định hướng và cung cấp biên dữ liệu (Boundary/Corner Test Cases).
6. **P0 Invariant — Idempotent Scaffolding & Vault Non-Clobbering:** Khi sinh thư mục và ghi chú học tập (`scaffold_semester_vault`), hệ thống kiểm tra file tồn tại; tuyệt đối KHÔNG BAO GIỜ ghi đè các ghi chú người dùng đã chỉnh sửa.
7. **P0 Invariant — System Tray & Silent Execution:** Cửa sổ chính không tắt hoàn toàn khi bấm nút X (`CloseRequested` bị chặn bằng `api.prevent_close()`), mà ẩn vào khay hệ thống (System Tray). Phím tắt toàn cục `Alt+K` mở/đóng HUD tức thì từ bất kỳ đâu trên hệ điều hành.

---

## 3. DATABASE SCHEMA TOPOLOGY (SQLITE WAL)

```sql
-- Cấu hình hệ thống & Key-Value Store (BYOK API Key, Nickname, Settings)
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- ============================================================================
-- 1. ACADEMIC & CURRICULUM SUBSYSTEM
-- ============================================================================

-- Chương trình đào tạo & Chuẩn tín chỉ tốt nghiệp theo 15 ngành UIT
CREATE TABLE IF NOT EXISTS academic_curriculums (
    major_code      TEXT PRIMARY KEY,
    major_name      TEXT NOT NULL,
    faculty         TEXT NOT NULL,
    total_credits   INTEGER NOT NULL,
    standard_years  REAL NOT NULL DEFAULT 4.0
);

-- Bảng ánh xạ bí danh phân hệ đào tạo (CQUI / CLC / CTTT)
CREATE TABLE IF NOT EXISTS curriculum_aliases (
    alias_token     TEXT PRIMARY KEY,
    major_code      TEXT NOT NULL,
    credit_override INTEGER,
    FOREIGN KEY (major_code) REFERENCES academic_curriculums(major_code)
);

-- Chỉ mục CTĐT theo chuyên ngành & phân hệ
CREATE TABLE IF NOT EXISTS curriculum_index (
    slug            TEXT PRIMARY KEY,
    major_code      TEXT NOT NULL,
    specialization  TEXT NOT NULL,
    program_type    TEXT NOT NULL,
    total_credits   INTEGER NOT NULL,
    FOREIGN KEY (major_code) REFERENCES academic_curriculums(major_code)
);

-- Quy tắc kiểm định tốt nghiệp theo từng khối kiến thức
CREATE TABLE IF NOT EXISTS curriculum_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    curriculum_slug TEXT NOT NULL,
    rule_type       TEXT NOT NULL,   -- 'compulsory', 'elective', 'general', 'internship', 'thesis'
    required_credits INTEGER NOT NULL,
    FOREIGN KEY (curriculum_slug) REFERENCES curriculum_index(slug)
);

-- Danh mục học phần mẫu trong khung chương trình
CREATE TABLE IF NOT EXISTS curriculum_courses (
    curriculum_slug TEXT NOT NULL,
    course_code     TEXT NOT NULL,
    course_name     TEXT NOT NULL,
    credits         INTEGER NOT NULL,
    semester_order  INTEGER NOT NULL DEFAULT 1,
    course_type     TEXT NOT NULL DEFAULT 'Bắt buộc',
    knowledge_block TEXT NOT NULL DEFAULT 'co_so_nganh',
    PRIMARY KEY (curriculum_slug, course_code)
);

-- Hồ sơ sinh viên trích xuất từ Portal SSO (Next.js RSC Flight Stream & Metadata)
CREATE TABLE IF NOT EXISTS student_profile (
    student_id      TEXT PRIMARY KEY,
    full_name       TEXT NOT NULL,
    faculty         TEXT NOT NULL,
    major_code      TEXT NOT NULL,
    specialization  TEXT,
    student_class   TEXT NOT NULL,
    curriculum_code TEXT,
    cohort          TEXT,
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Lịch sử học kỳ chính thức
CREATE TABLE IF NOT EXISTS academic_semesters (
    semester        TEXT PRIMARY KEY,
    term_gpa_10     REAL NOT NULL DEFAULT 0.0,
    term_gpa_4      REAL NOT NULL DEFAULT 0.0,
    term_credits    INTEGER NOT NULL DEFAULT 0,
    cumulative_gpa_10 REAL NOT NULL DEFAULT 0.0,
    cumulative_gpa_4  REAL NOT NULL DEFAULT 0.0,
    cumulative_credits INTEGER NOT NULL DEFAULT 0,
    academic_status TEXT NOT NULL DEFAULT 'Bình thường',
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Môn học tích lũy theo từng học kỳ thực tế (bySemester)
CREATE TABLE IF NOT EXISTS academic_courses (
    course_code      TEXT NOT NULL,
    semester         TEXT NOT NULL,
    course_name      TEXT NOT NULL,
    credits          INTEGER NOT NULL,
    knowledge_block  TEXT NOT NULL DEFAULT 'co_so_nganh',
    score_10         REAL,
    score_4          REAL,
    score_char       TEXT,
    is_passed        BOOLEAN NOT NULL DEFAULT 1,
    grade_4          REAL,
    grade_char       TEXT,
    category         TEXT NOT NULL DEFAULT 'co_so_nganh',
    summary_score_4  REAL,
    is_retaken       BOOLEAN NOT NULL DEFAULT 0,
    replaced_by      TEXT,
    status           TEXT NOT NULL DEFAULT 'Hoàn thành',
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (course_code, semester)
);

-- Khung chương trình đào tạo chính thức (bóc tách từ Portal byCtdt.program_scores)
CREATE TABLE IF NOT EXISTS academic_curriculum (
    course_code      TEXT NOT NULL,
    semester         INTEGER NOT NULL,
    course_name      TEXT NOT NULL,
    credits          INTEGER NOT NULL DEFAULT 0,
    course_type      TEXT NOT NULL DEFAULT 'Bắt buộc',
    status           TEXT NOT NULL DEFAULT 'Chưa học',
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (course_code, semester)
);

-- Tổng kết chỉ tiêu chương trình đào tạo & SSOT tín chỉ tốt nghiệp
CREATE TABLE IF NOT EXISTS academic_program_summary (
    id                   TEXT PRIMARY KEY, -- 'MAIN'
    total_degree_credits INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Chỉ số Macro học tập (cGPA, tín chỉ đã tích lũy, tổng tín chỉ)
CREATE TABLE IF NOT EXISTS academic_macro_metrics (
    id                   TEXT PRIMARY KEY, -- 'CURRENT'
    cgpa_10              REAL NOT NULL DEFAULT 0.0,
    cgpa_4               REAL NOT NULL DEFAULT 0.0,
    accumulated_credits  INTEGER NOT NULL DEFAULT 0,
    total_degree_credits INTEGER NOT NULL DEFAULT 126,
    drl_latest           INTEGER NOT NULL DEFAULT 0,
    updated_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Điểm rèn luyện theo học kỳ (bóc tách từ /api/sinh-vien/diem-ren-luyen)
CREATE TABLE IF NOT EXISTS academic_drl (
    semester    TEXT PRIMARY KEY,
    score       INTEGER NOT NULL,
    grade_text  TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Lịch thi học kỳ & Checklist phòng thi (Exam Radar)
CREATE TABLE IF NOT EXISTS academic_exams (
    id                  INTEGER PRIMARY KEY,
    subject_code        TEXT NOT NULL,
    subject_name        TEXT NOT NULL,
    section_class_id    TEXT NOT NULL DEFAULT '',
    section_class_code  TEXT NOT NULL DEFAULT '',
    format              TEXT NOT NULL DEFAULT '',
    examination         TEXT NOT NULL DEFAULT '',
    shift               TEXT NOT NULL DEFAULT '',
    start_time          TEXT NOT NULL DEFAULT '',
    end_time            TEXT NOT NULL DEFAULT '',
    weekday             TEXT NOT NULL DEFAULT '',
    date_str            TEXT NOT NULL,
    exam_timestamp      INTEGER NOT NULL,
    room                TEXT NOT NULL DEFAULT '',
    seat_number         TEXT NOT NULL DEFAULT '',
    absent              TEXT NOT NULL DEFAULT '',
    note                TEXT NOT NULL DEFAULT '',
    checklist_items     TEXT NOT NULL DEFAULT '[]', -- JSON Checklist
    updated_at          INTEGER NOT NULL
);

-- ============================================================================
-- 2. MOODLE & COURSES ENGINE
-- ============================================================================

CREATE TABLE IF NOT EXISTS moodle_courses (
    course_id         INTEGER PRIMARY KEY,
    course_code       TEXT NOT NULL,
    fullname          TEXT NOT NULL,
    term              TEXT NOT NULL,
    instructor_name   TEXT NOT NULL DEFAULT '',
    instructor_mail   TEXT NOT NULL DEFAULT '',
    instructor_phone  TEXT NOT NULL DEFAULT '',
    course_url        TEXT NOT NULL,
    updated_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS moodle_tasks (
    task_id           INTEGER PRIMARY KEY,
    course_id         INTEGER NOT NULL,
    title             TEXT NOT NULL,
    task_type         TEXT NOT NULL,
    due_date          INTEGER NOT NULL,
    is_submitted      BOOLEAN NOT NULL DEFAULT 0,
    submission_status TEXT NOT NULL DEFAULT 'Chưa nộp',
    template_file_url TEXT NOT NULL DEFAULT '',
    task_url          TEXT NOT NULL,
    updated_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (course_id) REFERENCES moodle_courses(course_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS moodle_materials (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id         INTEGER NOT NULL,
    section_name      TEXT NOT NULL,
    title             TEXT NOT NULL,
    file_url          TEXT NOT NULL,
    file_type         TEXT NOT NULL,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (course_id) REFERENCES moodle_courses(course_id) ON DELETE CASCADE
);

-- ============================================================================
-- 3. COMPETITIVE PROGRAMMING (CODEFORCES & WECODE)
-- ============================================================================

-- Lịch sử nộp bài Codeforces
CREATE TABLE IF NOT EXISTS cf_submissions (
    id                  INTEGER PRIMARY KEY,
    contest_id          INTEGER NOT NULL,
    creation_time_sec   INTEGER NOT NULL,
    relative_time_sec   INTEGER NOT NULL DEFAULT 0,
    problem_index       TEXT NOT NULL,
    problem_name        TEXT NOT NULL,
    problem_tags        TEXT NOT NULL DEFAULT '[]',
    programming_language TEXT NOT NULL,
    verdict             TEXT,
    passed_test_count   INTEGER NOT NULL DEFAULT 0,
    time_consumed_millis INTEGER NOT NULL DEFAULT 0,
    memory_consumed_bytes INTEGER NOT NULL DEFAULT 0,
    is_ac               INTEGER NOT NULL DEFAULT 0
);

-- Đợt bài tập Wecode UIT
CREATE TABLE IF NOT EXISTS wecode_assignments (
    id              INTEGER PRIMARY KEY,
    class_name      TEXT NOT NULL,
    title           TEXT NOT NULL,
    author          TEXT,
    total_problems  INTEGER NOT NULL DEFAULT 0,
    total_submits   INTEGER NOT NULL DEFAULT 0,
    status_text     TEXT,
    start_time      TEXT,
    finish_time     TEXT,
    is_finished     BOOLEAN NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Danh mục bài tập cụ thể thuộc Wecode
CREATE TABLE IF NOT EXISTS wecode_problems (
    problem_id      INTEGER NOT NULL,
    assignment_id   INTEGER NOT NULL,
    problem_name    TEXT NOT NULL,
    max_score       INTEGER NOT NULL DEFAULT 100,
    status          TEXT NOT NULL DEFAULT 'UNSOLVED',
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (assignment_id, problem_id),
    FOREIGN KEY (assignment_id) REFERENCES wecode_assignments(id) ON DELETE CASCADE
);

-- Lịch sử nộp bài Wecode UIT
CREATE TABLE IF NOT EXISTS wecode_submissions (
    submission_id   INTEGER PRIMARY KEY,
    assignment_id   INTEGER NOT NULL,
    problem_id      INTEGER NOT NULL,
    problem_name    TEXT NOT NULL,
    submit_time     INTEGER NOT NULL,
    verdict         TEXT NOT NULL,
    score           INTEGER NOT NULL DEFAULT 0,
    execution_time  REAL NOT NULL DEFAULT 0.0,
    memory_kib      INTEGER NOT NULL DEFAULT 0,
    language        TEXT NOT NULL DEFAULT 'C++',
    is_final        BOOLEAN NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (assignment_id) REFERENCES wecode_assignments(id) ON DELETE CASCADE
);

-- Nhật ký Post-Mortem cho thuật toán & kỳ thi ICPC
CREATE TABLE IF NOT EXISTS post_mortems (
    submission_id   INTEGER PRIMARY KEY,
    problem_id      TEXT NOT NULL,
    notes           TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',
    time_complexity TEXT,
    space_complexity TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- ============================================================================
-- 4. LIFE MATRIX & GAMIFICATION ENGINE
-- ============================================================================

-- Event Sourcing Ledger (First-AC & XP Engine)
CREATE TABLE IF NOT EXISTS activity_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id   TEXT NOT NULL,
    event_date  TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    xp_value    INTEGER NOT NULL,
    ref_id      TEXT,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(plugin_id, event_type, ref_id)
);

-- Ma trận năng suất hàng ngày (Aggregated 364-day Heatmap)
CREATE TABLE IF NOT EXISTS daily_life_matrix (
    date            TEXT PRIMARY KEY,
    total_xp        INTEGER NOT NULL DEFAULT 0,
    intensity_level INTEGER NOT NULL DEFAULT 0,
    breakdown_json  TEXT NOT NULL DEFAULT '{}',
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Plugin Registry (First-party Builtin & Community Mods)
CREATE TABLE IF NOT EXISTS plugin_registry (
    plugin_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    version     TEXT NOT NULL,
    author      TEXT NOT NULL,
    category    TEXT NOT NULL,
    is_enabled  BOOLEAN NOT NULL DEFAULT 0,
    is_builtin  BOOLEAN NOT NULL DEFAULT 0,
    installed_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Khung lưu trữ Key-Value cách ly cho từng Plugin
CREATE TABLE IF NOT EXISTS plugin_storage (
    plugin_id   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (plugin_id, key)
);

-- ============================================================================
-- 5. NATIVE VAULT & FULL-TEXT SEARCH (FTS5)
-- ============================================================================

CREATE TABLE IF NOT EXISTS vault_notes (
    rowid_key         INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT UNIQUE NOT NULL,       -- Ví dụ: '2025-2026_HK2/CS115_.../00_CS115_Index.md'
    title             TEXT NOT NULL,
    tags              TEXT,                       -- JSON string array: '["course", "uit"]'
    frontmatter_json  TEXT,                       -- Raw metadata JSON
    file_mtime        INTEGER NOT NULL,           -- Unix timestamp cho incremental sync
    content_cache     TEXT NOT NULL DEFAULT '',   -- Bộ đệm nội dung phục vụ FTS5 delete
    updated_at        INTEGER NOT NULL,
    note_type         TEXT DEFAULT 'GENERAL',     -- 'ALGO_TRICK', 'ACADEMIC_SUMMARY', 'TEACHING_SHEET', 'ONENOTE_LINK', 'GENERAL'
    external_uri      TEXT DEFAULT ''
);

-- Wikilinks Graph giữa các notes
CREATE TABLE IF NOT EXISTS vault_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    source_note_id    TEXT NOT NULL,
    target_note_id    TEXT NOT NULL,
    link_text         TEXT,
    FOREIGN KEY (source_note_id) REFERENCES vault_notes(id) ON DELETE CASCADE
);

-- Tra cứu toàn văn tốc độ cao (BM25 Tokenizer)
CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
    title,
    prose,
    code,
    content='',
    tokenize='porter unicode61'
);

-- Cấu hình liên kết IDE / VSCode Workspace & Deadlines đồng bộ
CREATE TABLE IF NOT EXISTS course_workspace_config (
    course_id   INTEGER PRIMARY KEY,
    folder_path TEXT NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS course_deadlines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id   INTEGER NOT NULL,
    title       TEXT NOT NULL,
    due_date    INTEGER NOT NULL,
    is_done     BOOLEAN NOT NULL DEFAULT 0,
    source      TEXT NOT NULL DEFAULT 'moodle',
    FOREIGN KEY (course_id) REFERENCES moodle_courses(course_id) ON DELETE CASCADE
);

-- Trạng thái đồng bộ (Sync state cursors)
CREATE TABLE IF NOT EXISTS sync_state (
    service     TEXT PRIMARY KEY,
    last_sync   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'idle'
);
```

---

## 4. BẢN ĐỒ PHÂN HỆ & LUỒNG DỮ LIỆU (SUBSYSTEM ARCHITECTURE)

```
                       ┌─────────────────────────────────────┐
                       │          GENESIS SEQUENCE           │
                       │ (Nickname -> 3-Question Workspace)  │
                       └──────────────────┬──────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │       MAIN APP VIEWPORT         │
                         ├─────────────────────────────────┤
                         │  Header Navigation + Alt+K HUD  │
                         └───────┬─────────────────┬───────┘
                                 │                 │
     ┌───────────────────┬───────┴────────┬────────┴───────────────┬───────────────────┐
     ▼                   ▼                ▼                        ▼                   ▼
┌─────────────┐ ┌────────────────┐ ┌──────────────┐ ┌────────────────────────┐ ┌─────────────┐
│ACADEMIC HUB │ │  EXAM RADAR    │ │ COURSES ENG  │ │ COMPETITIVE PROGRAMMING│ │ GEMINI AI   │
│(Portal Sync)│ │(Checklist/Time)│ │(Moodle/Vault)│ │ (Codeforces & Wecode)  │ │(Socratic/SSE)│
└──────┬──────┘ └────────┬───────┘ └──────┬───────┘ └───────────┬────────────┘ └──────┬──────┘
       │                 │                │                     │                     │
       └─────────────────┴────────┬───────┴─────────────────────┴─────────────────────┘
                                  ▼
                   ┌───────────────────────────────┐
                   │     ACTIVITY EVENT LEDGER     │
                   │ (First-AC, Deadline, Matrix)  │
                   └───────────────┬───────────────┘
                                  ▼
                   ┌───────────────────────────────┐
                   │    LIFE MATRIX 364-DAY MAP    │
                   │      (Pure Local SQLite)      │
                   └───────────────────────────────┘
```

### A. In-App Autonomous SSO Harvester Engine (`portal_auth.rs` & `portal_harvester.rs`)
- **Webview Windows:** `uit-sso-login`, `wecode-sso-login`, `moodle-sso-login`, và các cửa sổ chạy ngầm không giao diện (`portal-silent-sync`, `wecode-silent-sync`, `moodle-silent-sync`).
- **Autonomous Zero-Touch Pipeline:**
  1. `/api/sinh-vien/bang-diem`: Bóc tách điểm chi tiết từng học kỳ (`bySemester`), tín chỉ tích lũy, cơ cấu chương trình đào tạo (`byCtdt.statistics.total_program_credit`, `byCtdt.program_scores`).
  2. `/api/sinh-vien/diem-ren-luyen`: Trích xuất điểm rèn luyện tổng kết (`average_training_point`), xếp loại (`average_rank`), và lịch sử DRL từng học kỳ.
  3. `/sinh-vien/ho-so`: Trích xuất luồng Next.js React Server Component (RSC) Flight Data (`self.__next_f.push([1, "..."])`) lấy toàn vẹn hồ sơ sinh viên (MSSV, Họ tên, Khoa, Ngành, Lớp, Phân hệ đào tạo, Niên khóa) vượt qua rào cản DOM ảo.
- **Silent Background Sync:** Thực hiện kiểm tra phiên đăng nhập âm thầm (`visible = false`); nếu session còn hiệu lực, tự động nạp dữ liệu và phát sự kiện `academic-data-synced` mà người dùng không cần tương tác. Nếu session hết hạn (`AUTH_EXPIRED`), hệ thống kích hoạt yêu cầu đăng nhập lại an toàn.

### B. Dynamic 15-Major Curriculum Resolution & Degree Audit (`curriculum_resolver.rs`)
Phân giải chỉ tiêu và đối soát chuẩn đầu ra theo thứ tự ưu tiên 5 tầng bảo đảm tính đúng đắn tuyệt đối cho toàn bộ 15 ngành/hệ đào tạo của UIT:
1. **Portal API SSOT (Tuyệt đối):** Lấy trực tiếp `byCtdt.statistics.total_program_credit` từ cổng UIT (ví dụ `126 TC` cho KHMT CQUI). Ghi nhận vào `academic_program_summary (id='MAIN')` và `settings (total_degree_credits)` với cờ `matched_via = "portal_api_direct"`. Miễn nhiễm việc bị ghi đè bởi fallback.
2. **D-code Trực Tiếp:** Regex tĩnh `D\d{6}` $\rightarrow$ truy vấn `academic_curriculums`.
3. **Track-Specific Alias:** Token kết hợp `ACRONYM-TRACK` (ví dụ `KHMT-CLC` $\rightarrow$ 130 TC).
4. **Acronym Trần:** Token viết tắt ngành (ví dụ `KHMT` $\rightarrow$ 126 TC của CQUI).
5. **Hard Fallback:** Trả về `130 TC` generic với cờ `matched_via = "hard_fallback"`.

### C. Competitive Programming & Post-Mortem Gamification (`cf_worker.rs`, `wecode.rs`, `post_mortem.rs`)
- **Codeforces Background Poller:** Tự động đồng bộ lịch sử nộp bài mỗi 60 giây, kiểm soát qua `SyncLock` (AtomicBool) chống đụng độ với lệnh đồng bộ thủ công. Kết nối HTTP cấu hình Rustls-TLS không phụ thuộc thư viện hệ thống ngoài.
- **Binary First-AC Policy:** Chỉ nạp sự kiện `activity_events` khi `score == 100` hoặc `verdict == "OK" / "CORRECT ANSWER"`.
- **XP Weight:** +15 XP cho mỗi bài Wecode AC đầu tiên, +20 XP cho Codeforces Accepted problem, +25 XP cho Moodle assignment submission.
- **Idempotency:** Khóa `UNIQUE(plugin_id, event_type, ref_id)` chặn đứng hoàn toàn việc cộng trùng lặp XP khi đồng bộ lại lịch sử.
- **Post-Mortem Engine:** Bảng `post_mortems` cho phép ghi chú kỹ thuật giải thuật, đính kèm độ phức tạp thời gian/không gian ($O(N \log N)$), tags phân loại bài toán, và lập chỉ mục FTS5 phục vụ tra cứu kinh nghiệm trước các kỳ thi ICPC.

### D. Gemini AI Socratic Copilot Subsystem (`services/gemini.rs` & `commands/gemini.rs`)
- **BYOK (Bring Your Own Key):** Người dùng nhập API Key cá nhân trong Settings; Key được mã hóa và lưu tại bảng `settings` SQLite máy cục bộ. Không qua bất kỳ trung gian Cloud hay Proxy server nào.
- **Rust SSE Streaming Engine:** Backend Rust tạo HTTP stream tới Gemini endpoint, phân tích từng dòng `data: {...}` của SSE (Server-Sent Events) qua `parse_gemini_sse_line` và phát event `gemini-stream-{session_id}` về frontend React theo thời gian thực.
- **Socratic Pedagogical Guardrails:** Prompt hệ thống áp đặt triệt để chính sách Zero-Spoiler: Không đưa ra lời giải hoàn chỉnh, gợi mở tư duy thuật toán thông qua câu hỏi định hướng, và tự động sinh 3-5 Corner Test Cases (ví dụ $N=0$, tràn số nguyên 64-bit, dữ liệu trùng lặp) giúp sinh viên tự debug.
- **Smart Moodle Task Extractor:** Bóc tách các thông báo bằng văn xuôi tự nhiên của giảng viên trên Moodle, tự động chuyển đổi thành cấu trúc bài tập chuẩn (`title`, `course_code`, `due_date`, `task_type`) và nạp thẳng vào SQLite.

### E. Exam Radar & Daily Briefing Subsystem (`exam.rs` & `daily_briefing.rs`)
- **Exam Countdown Clock:** Bộ đếm thời gian thực tới từng ca thi, tự động tính toán thời gian nghỉ của thread dựa trên khoảng cách thi gần nhất để triệt tiêu tải trọng CPU khi không có ca thi sát giờ.
- **Exam Checklist Matrix:** Danh sách đồ dùng phòng thi (Thẻ sinh viên, máy tính bỏ túi Casio được phép, giấy tờ tùy thân, tài liệu được mang) được lưu trữ dưới dạng mảng JSON trong `academic_exams.checklist_items`.
- **Daily Briefing Scheduler:** Chạy ngầm mỗi 15 phút, tự động kích hoạt vào hai khung giờ vàng (08:00 sáng và 20:00 tối), phát thông báo Windows Native Notification (`tauri-plugin-notification`) tóm lược bài tập đến hạn trong ngày và ca thi sắp tới với cơ chế chống spam (cooldown 30 phút giữa các lần phát).

### F. Native Vault, Watcher & Material Offline Mirror (`vault.rs`, `moodle.rs`, `scaffolder.rs`)
- **Incremental Directory Watcher:** Tích hợp crate `notify` chạy ngầm, theo dõi thư mục Vault người dùng chọn. Khi có thao tác tạo, sửa, xóa file Markdown ngoài File Explorer hay Obsidian, watcher lập tức kích hoạt cập nhật chỉ mục FTS5 gia tăng mà không cần quét lại toàn bộ thư mục.
- **Material Offline Mirror:** Cho phép tải hàng loạt slide bài giảng và tài liệu PDF từ Moodle về thư mục `vault/{semester}/{course_code}/slides/`, cập nhật đường dẫn cục bộ và cho phép mở trực tiếp qua OS shell handler bằng 1-click.
- **Semester Archive Ritual:** Khi kết thúc học kỳ, thực hiện nghi thức lưu trữ: ghi nhận điểm số chính thức vào YAML frontmatter của từng ghi chú môn học, chuyển thư mục vào `01_Archive/{semester}/` và đồng bộ lại đồ thị Wikilinks FTS5.

### G. Auto-Updater & Continuous Delivery (`useAutoUpdater.ts`, `AutoUpdateModal.tsx`)
- Tích hợp `@tauri-apps/plugin-updater` và `@tauri-apps/plugin-process`.
- Xác thực chữ ký số bằng Minisign (`.sig`) theo chuẩn bảo mật Tauri v2.
- Giao diện Dark-mode Modal hiển thị chi tiết Changelog phát hành, thanh tiến trình tải theo byte/giây, và tự động khởi động lại ứng dụng sau khi cập nhật thành công.
- Pipeline GitHub Actions (`release.yml`) tự động build, ký số và phát hành release artifacts khi đẩy Git Tag (`v*`).

---

## 5. BẢNG DANH MỤC LỆNH IPC COMMANDS (TAURI v2)

Dưới đây là danh mục toàn bộ các Tauri IPC Commands đã được đăng ký trong macro `registered_commands!()` tại `lib.rs`:

| Nhóm Phân Hệ | Lệnh Rust Command | File Nguồn | Chức năng Kỹ thuật |
| :--- | :--- | :--- | :--- |
| **Core CP & Stats** | `get_today_stats` | `commands/mod.rs` | Tính tổng XP và số bài AC trong ngày hôm nay. |
| | `get_recent_submissions` | `commands/mod.rs` | Lấy danh sách nộp bài Codeforces gần nhất từ SQLite. |
| | `get_level_info` | `commands/mod.rs` | Tính Level, tổng XP, tiến độ % lên cấp tiếp theo. |
| | `get_yearly_heatmap` | `commands/mod.rs` | Truy vấn dữ liệu Heatmap hoạt động 364 ngày của Codeforces. |
| | `set_cf_handle` | `commands/mod.rs` | Lưu handle Codeforces vào SQLite và kích hoạt sync worker. |
| | `get_cf_handle` | `commands/mod.rs` | Đọc handle Codeforces đang kích hoạt. |
| | `trigger_cf_sync` | `commands/mod.rs` | Kích hoạt đồng bộ tức thời với Codeforces API (có SyncLock). |
| | `purge_cf_data` | `commands/mod.rs` | Xóa sạch dữ liệu bài nộp CF phục vụ reset hoặc đổi handle. |
| **Post-Mortem Vault** | `save_post_mortem` | `commands/post_mortem.rs` | Lưu hoặc cập nhật ghi chú giải thuật, tags, độ phức tạp cho bài tập. |
| | `get_post_mortem` | `commands/post_mortem.rs` | Đọc thông tin post-mortem của một submission ID cụ thể. |
| | `delete_post_mortem` | `commands/post_mortem.rs` | Xóa bản ghi post-mortem khỏi SQLite. |
| | `search_post_mortems` | `commands/post_mortem.rs` | Tìm kiếm bài học kinh nghiệm giải thuật theo tag hoặc từ khóa. |
| **Academic & Ingestion** | `get_academic_overview` | `commands/academic.rs` | Lấy toàn bộ tổng quan học tập (điểm, tín chỉ, DRL, hồ sơ). |
| | `get_semester_courses` | `commands/academic.rs` | Lấy danh sách môn học theo từng học kỳ kèm điểm số. |
| | `upsert_academic_courses` | `commands/academic.rs` | Thêm hoặc cập nhật danh sách môn học của một kỳ. |
| | `upsert_academic_semester` | `commands/academic.rs` | Cập nhật chỉ số GPA và trạng thái học tập của học kỳ. |
| | `sync_portal_uit_data` | `commands/academic.rs` | Đọc dữ liệu học tập đã lưu để làm tươi giao diện. |
| | `sync_uit_portal` | `commands/academic.rs` | Trigger refresh dữ liệu Portal. |
| | `submit_portal_transcript`| `commands/academic.rs` | Ingest bảng điểm trực tiếp từ payload ngoài. |
| | `get_academic_macro_metrics` | `commands/academic.rs` | Lấy chỉ số macro cGPA hệ 10, hệ 4, DRL và tín chỉ. |
| | `get_academic_macro_metrics_ssot` | `commands/academic.rs` | Lấy chỉ số macro chuẩn SSOT kết hợp cấu hình chương trình. |
| | `get_academic_radar_metrics` | `commands/academic.rs` | Tính toán điểm trung bình theo 6 khối kiến thức cho Radar Chart. |
| | `ingest_full_academic_payload` | `commands/academic.rs` | Nạp nguyên tử toàn bộ bảng điểm, DRL và hồ sơ sinh viên. |
| | `ingest_dynamic_academic_data` | `commands/academic.rs` | Xử lý payload động từ Harvester Engine. |
| | `purge_and_seed_canonical_academic_data` | `commands/academic.rs` | Seed dữ liệu chuẩn canonical cho môi trường thử nghiệm. |
| | `get_academic_curriculum` | `commands/academic.rs` | Đọc khung chương trình đào tạo chính thức (môn bắt buộc, tự chọn). |
| | `get_resolved_curriculum` | `commands/academic.rs` | Giải quyết chỉ tiêu tín chỉ tốt nghiệp theo 5 tầng ưu tiên SSOT. |
| | `get_degree_audit_report` | `commands/academic.rs` | Kiểm định tiến độ hoàn thành các quy tắc tốt nghiệp của CTĐT. |
| | `fetch_and_cache_curriculum`| `commands/academic.rs` | Tải và lưu cache khung chương trình đào tạo của ngành. |
| | `get_available_curriculums`| `commands/academic.rs` | Lấy danh sách các chuyên ngành và hệ đào tạo khả dụng. |
| | `set_student_curriculum_slug`| `commands/academic.rs` | Gán mã slug CTĐT mục tiêu cho sinh viên. |
| | `get_sync_token` | `commands/academic.rs` | Lấy mã bảo mật token cho Loopback Sync Server. |
| | `get_student_profile` | `commands/academic.rs` | Đọc thông tin hồ sơ sinh viên lưu trong SQLite. |
| | `ingest_portal_sync_payload_json` | `commands/academic.rs` | Ingest JSON thô từ Browser Extension hoặc Loopback Script. |
| **In-App SSO Harvester** | `launch_portal_sso_sync` | `commands/portal_auth.rs` | Mở WebView2 đăng nhập Portal với Guardian Script và Watchdog. |
| | `launch_wecode_sso_sync` | `commands/portal_auth.rs` | Mở WebView2 đăng nhập Wecode Judge với bộ chống loop. |
| | `launch_moodle_sso_sync` | `commands/portal_auth.rs` | Mở WebView2 đăng nhập Courses Moodle UIT. |
| | `launch_portal_silent_sync` | `commands/portal_auth.rs` | Chạy đồng bộ ngầm Portal không hiện cửa sổ nếu còn phiên. |
| | `launch_wecode_silent_sync` | `commands/portal_auth.rs` | Chạy đồng bộ ngầm Wecode không hiện cửa sổ nếu còn phiên. |
| | `launch_moodle_silent_sync` | `commands/portal_auth.rs` | Chạy đồng bộ ngầm Moodle không hiện cửa sổ nếu còn phiên. |
| **Wecode UIT** | `get_wecode_submissions` | `commands/wecode.rs` | Truy vấn danh sách bài nộp Wecode kèm phân trang và bộ lọc. |
| | `get_wecode_problems` | `commands/wecode.rs` | Lấy danh mục bài tập theo đợt thực hành và trạng thái giải. |
| | `get_wecode_assignments` | `commands/wecode.rs` | Đọc toàn bộ danh sách đợt bài tập Wecode kèm số submit/AC. |
| | `get_sync_timestamps` | `commands/wecode.rs` | Trả về thời điểm đồng bộ thành công gần nhất của các dịch vụ. |
| | `ingest_wecode_submissions_json` | `commands/wecode.rs` | Ingest lịch sử submit Wecode từ payload JSON. |
| **Moodle & Courses** | `get_moodle_courses` | `commands/moodle.rs` | Lấy danh sách các môn học Moodle đang lưu trữ trong SQLite. |
| | `get_moodle_tasks` | `commands/moodle.rs` | Lấy danh sách nhiệm vụ/bài tập Moodle (hỗ trợ lọc theo `course_id`). |
| | `get_moodle_materials` | `commands/moodle.rs` | Truy vấn danh mục slide bài giảng, giáo trình PDF theo môn học. |
| | `download_course_materials`| `commands/moodle.rs` | Tải slide tài liệu Moodle về lưu trữ ngoại tuyến trong Vault. |
| | `open_local_material` | `commands/moodle.rs` | Mở tệp slide đã tải về bằng ứng dụng mặc định của hệ điều hành. |
| | `ingest_moodle_sync_payload_json` | `commands/moodle.rs` | Ingest nguyên tử dữ liệu môn học, bài tập và tài liệu từ Harvester. |
| | `update_moodle_course_instructor` | `commands/moodle.rs` | Tùy chỉnh thông tin liên hệ giảng viên (họ tên, email, SĐT). |
| **Workspace & Quests** | `ingest_moodle_course_html`| `commands/workspace.rs` | Bóc tách HTML khóa học từ Moodle để lấy bài tập. |
| | `get_upcoming_deadlines` | `commands/workspace.rs` | Lấy danh sách deadline sắp tới từ tất cả các khóa học. |
| | `mark_deadline_submitted` | `commands/workspace.rs` | Đánh dấu trạng thái đã nộp bài cho một deadline. |
| | `upsert_workspace_config` | `commands/workspace.rs` | Lưu cấu hình đường dẫn thư mục code/workspace của môn học. |
| | `get_workspace_config` | `commands/workspace.rs` | Đọc cấu hình workspace của môn học. |
| | `check_and_launch_vscode`| `commands/workspace.rs` | Mở thư mục code của môn học trực tiếp trong VSCode. |
| **Life Matrix & XP** | `recompute_today_xp` | `commands/matrix.rs` | Tính toán lại tổng điểm XP trong ngày từ activity_events. |
| | `get_heatmap_matrix` | `commands/matrix.rs` | Đọc dữ liệu Heatmap Life Matrix tổng hợp cả năm. |
| | `get_life_matrix_range` | `commands/matrix.rs` | Lấy số liệu ma trận năng suất trong một khoảng ngày cụ thể. |
| **Native Vault & Notes**| `scan_vault` | `commands/vault.rs` | Quét thủ công thư mục Markdown, trích xuất wikilinks và FTS5. |
| | `search_vault` | `commands/vault.rs` | Tìm kiếm toàn văn FTS5 tốc độ cao với BM25 và snippet highlight. |
| | `get_vault_stats` | `commands/vault.rs` | Thống kê số lượng notes, liên kết chéo, tags và ghi chú mới nhất. |
| | `create_structured_note` | `commands/vault.rs` | Tạo ghi chú cấu trúc mới, bảo vệ file đĩa và cập nhật FTS5 ngay. |
| | `open_onenote_link` | `commands/vault.rs` | Validate an toàn giao thức `onenote:` và mở qua OS shell handler. |
| | `set_vault_path` | `commands/vault.rs` | Lưu đường dẫn thư mục Vault người dùng chọn vào SQLite settings. |
| | `get_vault_path` | `commands/vault.rs` | Đọc đường dẫn thư mục Vault đang kích hoạt. |
| | `scaffold_semester_vault` | `commands/vault.rs` | Tự động sinh cây thư mục môn học học kỳ và template ghi chú chuẩn. |
| | `open_vault_course_folder` | `commands/vault.rs` | Mở thư mục ghi chú của môn học ngoài Windows File Explorer. |
| | `start_vault_watcher` | `commands/vault.rs` | Kích hoạt watcher theo dõi thay đổi file trên thư mục Vault. |
| | `stop_vault_watcher` | `commands/vault.rs` | Dừng watcher thư mục Vault. |
| | `get_vault_watcher_status`| `commands/vault.rs` | Kiểm tra trạng thái đang chạy của Vault Watcher. |
| | `archive_semester` | `commands/vault.rs` | Thực hiện Archive Ritual: đóng gói học kỳ, ghi điểm vào frontmatter. |
| **Settings & Identity** | `get_user_profile` | `commands/settings.rs` | Đọc thông tin định danh và cài đặt người dùng. |
| | `save_user_profile` | `commands/settings.rs` | Cập nhật thông tin profile người dùng. |
| | `save_setting` | `commands/settings.rs` | Lưu cặp Key-Value tùy ý vào bảng `settings`. |
| | `get_system_storage_stats`| `commands/settings.rs` | Trả về dung lượng DB, file WAL và tổng số bản ghi trong bảng. |
| | `reset_identity_state` | `commands/settings.rs` | Xóa dữ liệu định danh tạm thời. |
| | `reset_user_data_to_genesis`| `commands/settings.rs`| Reset toàn bộ cơ sở dữ liệu về trạng thái ban đầu (Genesis). |
| **Plugin Registry** | `list_installed_plugins` | `commands/plugins.rs` | Lấy danh sách toàn bộ plugin nội bộ và cộng đồng đã cài đặt. |
| | `toggle_plugin` | `commands/plugins.rs` | Bật/tắt trạng thái plugin, kích hoạt tính toán lại Life Matrix. |
| | `plugin_storage_get` | `commands/plugins.rs` | Đọc dữ liệu từ key-value store cách ly của một plugin. |
| | `plugin_storage_set` | `commands/plugins.rs` | Ghi dữ liệu vào key-value store cách ly của một plugin. |
| | `record_activity_event` | `commands/plugins.rs` | Ghi nhận sự kiện tích lũy XP từ một plugin mở rộng. |
| | `trigger_recompute_daily_matrix`| `commands/plugins.rs`| Tính toán lại ma trận năng suất ngày từ sự kiện các plugin. |
| | `fetch_remote_registry` | `commands/plugins.rs` | Lấy danh mục Community Plugins từ remote registry. |
| | `install_remote_plugin` | `commands/plugins.rs` | Tải zip plugin, verify SHA-256, giải nén cách ly và cài đặt. |
| **Exam Radar & Briefing**| `get_exam_schedules` | `commands/exam.rs` | Truy vấn danh sách lịch thi học kỳ từ bảng `academic_exams`. |
| | `sync_exam_schedules` | `commands/exam.rs` | Ingest danh sách lịch thi trích xuất từ Portal vào SQLite. |
| | `update_exam_checklist` | `commands/exam.rs` | Cập nhật danh sách checklist đồ dùng phòng thi cho ca thi. |
| | `trigger_daily_briefing`| `commands/exam.rs` | Kích hoạt tóm tắt thông báo buổi sáng/tối và phát notification. |
| **Gemini AI Copilot** | `get_gemini_config` | `commands/gemini.rs` | Đọc cấu hình API Key và model Gemini đang dùng từ `settings`. |
| | `save_gemini_config` | `commands/gemini.rs` | Lưu API Key và model Gemini mới vào bảng `settings`. |
| | `test_gemini_key` | `commands/gemini.rs` | Gửi request thử nghiệm xác thực API Key với máy chủ Google. |
| | `trigger_socratic_debug`| `commands/gemini.rs` | Khởi chạy phiên debug Socratic qua luồng SSE Streaming. |
| | `extract_moodle_tasks` | `commands/gemini.rs` | Dùng AI bóc tách bài tập từ thông báo văn xuôi của giảng viên. |
| | `save_extracted_moodle_tasks` | `commands/gemini.rs` | Lưu các bài tập AI đã bóc tách vào bảng `moodle_tasks`. |
| **System Utilities** | `open_external_url` | `commands/mod.rs` | Mở liên kết web an toàn bằng trình duyệt mặc định của hệ thống. |
| | `hide_hud` | `commands/mod.rs` | Ẩn giao diện chính vào khay hệ thống (System Tray). |

---

## 6. ACADEMIC RADAR & GPA SIMULATOR SPECIFICATION (v1.2.0 EXTENSION)

### A. Derived Grade Scale Computation (Quy chế Đào tạo ĐHQG-HCM)
- **Bản chất**: API Portal UIT `/api/sinh-vien/bang-diem` chỉ lưu trữ điểm thô thang 10 (`diem_tk`). Điểm Hệ 4 và Điểm Chữ là dữ liệu phái sinh (Derived Data).
- **Nguyên tắc xử lý**: Thực thi Pure Domain Function hai lớp:
  - **Compute-on-Ingest (Rust)**: Tính toán và lưu vào `academic_courses` (`summary_score_4`, `grade_4`, `grade_char`, `category`). Tự động migrate và backfill qua `self_heal_academic_data`.
  - **Compute-on-Render (React / TypeScript)**: Hàm `computeGradeMetrics(score10, isGpaCalculated)` tính toán fallback trực tiếp khi hiển thị, bảo đảm không bao giờ bị khuyết (`-`).
- **Thang điểm quy đổi chuẩn ĐHQG-HCM**:
  - $TK \ge 9.0 \implies \text{A+} \ (4.0)$
  - $8.5 \le TK < 9.0 \implies \text{A} \ (3.7)$
  - $8.0 \le TK < 8.5 \implies \text{B+} \ (3.5)$
  - $7.0 \le TK < 8.0 \implies \text{B} \ (3.0)$
  - $6.0 \le TK < 7.0 \implies \text{C+} \ (2.5)$
  - $5.5 \le TK < 6.0 \implies \text{C} \ (2.0)$
  - $5.0 \le TK < 5.5 \implies \text{D+} \ (1.5)$
  - $4.0 \le TK < 5.0 \implies \text{D} \ (1.0)$
  - $TK < 4.0 \implies \text{F} \ (0.0)$ (Không đạt)

### B. Student Identity Mini Card & P0 Privacy Masking
- **Định dạng Tên Tiếng Việt**: Chuẩn hóa đảo ngược thứ tự tên phương Tây (`Gia Phạm Hoàng` $\rightarrow$ `Phạm Hoàng Gia`) qua `formatVietnameseName`.
- **Cấu trúc Mini Card 2 tầng**:
  - Tầng 1: Họ tên in đậm (`text-base font-semibold`) + Badge trạng thái đào tạo (`Đang học - Học kỳ X`).
  - Tầng 2: Metadata súc tích (`MSSV • Lớp • Hệ: Chuẩn • Khóa YYYY`), loại bỏ hiển thị trùng lặp tên khoa/ngành cạnh mã lớp.
- **P0 Presentation-Only Privacy Masking**:
  - Khi bật Demo Mode: Họ tên hiển thị viết tắt (`P. H. G.`), MSSV làm mờ 4 số cuối (`2552****`).
  - Tuyệt đối chỉ tính toán khi render (`Compute-on-Render`), không ghi đè dữ liệu che mờ ngược vào SQLite.

### C. Dual-Mode GPA Simulator Engine
- Thay thế hoàn toàn cơ chế nhập thủ công xung đột bằng 2 chế độ độc lập:
  - **Mode A (Time-driven / Số kỳ dự kiến)**: Lựa chọn mốc hoàn thành tốt nghiệp (4, 5, 6, 7 học kỳ). Tự động phân bổ số tín chỉ trung bình mỗi kỳ còn lại.
  - **Mode B (Pace-driven / Tải trọng tín chỉ mỗi kỳ)**: Điều chỉnh tải trọng học tập (12 – 26 TC/kỳ) qua slider mượt mà. Tự động tính số học kỳ cần thiết.
- **Công thức Toán học & Chuẩn hóa Phát biểu**:
  $$cGPA_{\text{cần}} = \frac{cGPA_{\text{mục tiêu}} \times TC_{\text{tổng}} - cGPA_{\text{hiện tại}} \times TC_{\text{đã tích lũy}}}{TC_{\text{còn lại}}}$$
  - Diễn giải hiển thị: *"Cần duy trì cGPA trung bình tối thiểu X trên tổng số Y tín chỉ còn lại (trung bình Z TC/kỳ) để đạt mục tiêu..."*. Khử hoàn toàn lỗi thuật ngữ "điểm/môn".

### D. Knowledge Block Tagging, Radar Chart Baseline & Viewport Budget
- **Phân loại Khối Kiến thức Chính xác**: Ưu tiên phân loại theo tiền tố mã học phần thực tế của UIT (`IT001`, `IT002`, `IT003`, `IT012`, `CS005`, `MA004`, `MA005` hiển thị chính xác là `CS ngành`, không bị gán nhầm thành `Đ.cương`).
- **Academic Radar Chart Target Baseline**: Bổ sung đa giác tham chiếu mục tiêu chuẩn (Target Baseline 8.5/10.0 nét đứt) ngăn biểu đồ bị co cụm thành một đường đơn điệu; hiển thị nhãn `(Chưa tích lũy)` đối với các khối chưa có điểm.
- **Viewport Budget & Scrollable Course Table**: Đặt `max-h-[380px] overflow-y-auto` kèm thanh cuộn mỏng chuyên biệt và `sticky thead`, giữ trọn vẹn bố cục Dashboard không bị tràn vỡ khung nhìn.

---

## 7. COURSES ENGINE, NATIVE VAULT & WECODE DEEP-LINK SPECIFICATION (v1.3.0 EXTENSION)

### A. Active Horizon Filter & Zombie Deadlines Elimination (`task_engine.rs` & `UnifiedQuestHub.tsx`)
- **Bối cảnh & Vấn đề**: Giảng viên import khóa học cũ khiến các bài tập quá hạn từ năm 2021, 2023 (`IT005.R114`) bị kéo lên đầu khối "Khẩn cấp (< 24 giờ / Quá hạn)", làm tăng giả counter đỏ và gây nhiễu loạn ưu tiên học tập.
- **Mô hình Active Horizon Filter**: Phân loại nhiệm vụ học tập theo 4 mốc thời gian chặt chẽ dựa trên khoảng cách $diff = \text{due\_date} - \text{now}$:
  1. **Khẩn cấp (`is_urgent = true`)**: $\text{due\_date} \ge \text{now} \land diff \le 86400$ (Còn hạn trong vòng 24 giờ).
  2. **Quá hạn gần đây (`is_recently_overdue = true`)**: $diff < 0 \land diff \ge -30 \times 86400$ (Quá hạn trong vòng 30 ngày trở lại).
  3. **Bài tập xác sống / Hết hạn cũ (`is_stale_zombie = true`)**: $diff < -30 \times 86400$ (Quá hạn trên 30 ngày).
  4. **Luyện tập tự do (`is_open_ended = true`)**: $\text{due\_date} \le 0$ (Bài tập không giới hạn thời gian).
- **Quy tắc hiển thị & Bảo vệ Counter**:
  - Khối **"Nhiệm vụ khẩn cấp (< 24 giờ / Quá hạn)"**: CHỈ CHỨA các task thỏa mãn $(is\_urgent \lor is\_recently\_overdue) \land \neg is\_submitted$. Counter đỏ chỉ đếm các task này.
  - Các task $is\_stale\_zombie$: Tự động đẩy vào tab **"Luyện tập tự do"** / **"Đã đóng"** với nhãn `Đã đóng (Lưu trữ)`. Tuyệt đối KHÔNG làm tăng counter đỏ và KHÔNG render trong khối Khẩn cấp.

### B. Native Vault Auto-Scaffolding Engine (`scaffolder.rs` & `vault.rs`)
- **Mục tiêu**: Tự động sinh cấu trúc thư mục học kỳ chuẩn hóa và ghi chú môn học cho sinh viên dựa trên danh sách khóa học thực tế từ `moodle_courses`, sẵn sàng cho hệ thống liên kết Wikilinks và tra cứu SQLite FTS5.
- **Hàm làm sạch tên thư mục (Path Sanitizer)**:
  - Loại bỏ hoàn toàn các ký tự cấm trên Windows/POSIX: `< > : " / \ | ? *`.
  - Chuẩn hóa khoảng trắng trùng lặp, trim khoảng trắng và dấu chấm ở cuối để tương thích 100% với Windows File System mà không cần regex nặng nề.
- **Đặc tả quy trình Auto-Scaffolding**:
  - Thư mục học kỳ: `{vault_root}/2025-2026_HK2/` (được format từ chuỗi kỳ học `HK2 2025-2026`).
  - Thư mục môn học: `{CourseBaseCode}_{CleanFullname}` (ví dụ `CS115_Toán cho khoa học máy tính`).
  - Tệp chỉ mục môn học: `00_{CourseBaseCode}_Index.md` (ví dụ `00_CS115_Index.md`).
- **Template sườn Markdown chuẩn hóa**:
  ```markdown
  ---
  course_code: "{course_code}"
  course_name: "{course_name}"
  semester: "2025-2026_HK2"
  tags:
    - course
    - uit
  ---

  # {course_name} ({course_code})

  > [!info] THÔNG TIN MÔN HỌC
  > - **Giảng viên:** {instructor_name}
  > - **Email:** {instructor_mail} | **SĐT:** {instructor_phone}
  > - 🌐 [Moodle UIT ↗]({course_url})
  > - 📂 [Thư mục Google Drive ↗]()
  > - 🧠 [Không gian ôn thi NotebookLM ↗]()

  ---

  ## 📝 Nhật Ký Bài Giảng
  - 

  ## 💡 Công Thức & Kiến Thức Cốt Lõi
  - 
  ```
- **Kỷ luật Bất biến Idempotent 100%**:
  - Kiểm tra `if !index_file.exists()` mới tiến hành ghi file; nếu file đã tồn tại thì BỎ QUA (`skipped_notes += 1`). Tuyệt đối KHÔNG BAO GIỜ ghi đè lên nội dung người dùng đã chỉnh sửa.
  - Tự động kích hoạt lập chỉ mục FTS5 (`scan_and_sync_vault`) ngay sau khi hoàn thành.
- **Tích hợp OS File Explorer (`open_vault_course_folder`)**:
  - Nút `[📂 Mở thư mục Note]` trên màn hình chi tiết môn học của Courses Engine gọi lệnh mở trực tiếp thư mục ngoài Windows Explorer hoặc trình quản lý tệp mặc định của OS qua `open::that`.

### C. Real-time Streaming Sync & Minimized Floating Dock (`SyncMoodleModal.tsx` & `moodle_harvester.js`)
- **Real-time Streaming**:
  - Thay vì đợi nạp toàn bộ khóa học xong mới ghi một lần, script cào Moodle gửi ngay danh sách khóa học ban đầu trong vòng 1 giây, sau đó hoàn tất môn nào thì stream payload (`courses`, `tasks`, `materials`) của riêng môn đó về backend ngay lập tức.
  - Backend phát sự kiện `moodle-data-synced` và `moodle-sync-progress` theo thời gian thực để Courses Dashboard và Unified Quest Hub cập nhật giao diện từng môn một mà không chớp nháy màn hình.
- **Minimized Floating Dock (Thu nhỏ không che màn hình)**:
  - Bổ sung nút **Thu nhỏ** (`Minus` icon) trên thanh tiêu đề của modal.
  - Khi thu nhỏ: Loại bỏ hoàn toàn lớp phủ mờ (`backdrop overlay`), chuyển đổi modal thành một thanh Dock nổi nhỏ gọn ở góc dưới bên phải màn hình (`bottom-6 right-6 z-50`).
  - Người dùng có thể tiếp tục tự do duyệt bài tập, tra cứu tài liệu trong ứng dụng trong lúc thanh dock hiển thị spinner, phần trăm và tên môn học đang nạp; có nút phóng to (`Maximize2`) để mở lại modal đầy đủ bất kỳ lúc nào.

### D. Deep-Link Wecode -> Quick Note "Algo Trick" (`useQuickCaptureStore.ts` & `QuickCaptureModal.tsx`)
- **Global Event & Store Dispatcher**:
  - Sử dụng Zustand store `useQuickCaptureStore` quản lý trạng thái mở modal và cấu trúc dữ liệu `QuickNotePrefill`:
    ```typescript
    interface QuickNotePrefill {
      mode: 'algo' | 'onenote' | 'teaching';
      title: string;
      platformLink: string;
      tags: string[];
      codeSnippet?: string;
      prose?: string;
    }
    ```
- **Điểm gắn kết trên Wecode**:
  - Tại **Danh sách bài tập Wecode (`WecodeProblemList.tsx`)**: Bổ sung nút `[⚡ Lưu Trick]` cạnh nút "Mở đề" trên mỗi hàng bài tập.
  - Tại **Lịch sử nộp bài Wecode (`WecodeSubmissionsList.tsx`)**: Bổ sung cột và nút `[⚡ Lưu Trick]` trên từng lượt submit.
- **Luồng hoạt động 1-Click**:
  - Khi người dùng bấm nút: Modal `QuickCaptureModal` (được mount toàn cục tại `App.tsx`) lập tức mở ra, tự động chuyển tab sang `</> Algo Trick`, điền sẵn tiêu đề bài tập (theo cú pháp chuẩn `[CourseCode] [Assignment] ProblemName`), URL bài tập trên Wecode, tags (`wecode, algo, ...`) và mã nguồn bài nộp tốt nhất.
  - Người dùng chỉ cần ghi nhận ý tưởng thuật toán và bấm lưu; ghi chú được lưu vào thư mục `vault/algo/` và lập chỉ mục FTS5 ngay lập tức.

---

## 8. GEMINI AI SOCRATIC COPILOT & SMART TASK EXTRACTOR SPECIFICATION

### A. BYOK Architecture & Direct Wire Invariants
- Khóa bí mật API cá nhân (`gemini_api_key`) và model lựa chọn (`gemini-1.5-flash`, `gemini-1.5-pro`, `gemini-2.0-flash`) được lưu cục bộ trong bảng `settings`.
- Mọi kết nối HTTP đi trực tiếp từ `diark-core` tới `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}`. Không ủy quyền qua máy chủ đám mây của bên thứ ba, bảo mật tuyệt đối mã nguồn và bài tập sinh viên.

### B. Rust SSE Streaming Engine
```rust
// Cơ chế Stream Chunk truyền phát tới React Webview
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeminiStreamChunk {
    pub text: String,
    pub is_done: bool,
    pub error: Option<String>,
}
```
- Khi nhận yêu cầu `trigger_socratic_debug`, backend Rust khởi tạo worker stream không chặn. Mỗi token nhận về được parse từ dòng `data: {...}` và emit tức thì qua kênh sự kiện `gemini-stream-{session_id}`.
- Giao diện React hiển thị chữ chạy (smooth stream typing) với con trỏ nhấp nháy, tự động cuộn xuống cuối màn hình hội thoại.

### C. Socratic Pedagogical Debugger (`SocraticDebuggerModal.tsx`)
- **Triết lý Giáo dục Socratic:** 
  - *Không bao giờ đưa ra lời giải mã nguồn hoàn chỉnh*: Ngăn chặn tâm lý ỷ lại và học vẹt.
  - *Câu hỏi chẩn đoán gợi mở*: Đặt câu hỏi phản chiếu như: "Điều gì xảy ra với con trỏ khi mảng chỉ có đúng 1 phần tử?", "Độ phức tạp hiện tại là $O(N^2)$, với $N=2 \times 10^5$ thì số phép tính là bao nhiêu?".
  - *Bộ sinh Corner Test Cases*: Tự động phân tích code và đề bài của sinh viên để chỉ ra các trường hợp biên nguy hiểm ($N=0$, số âm, số nguyên vượt giới hạn $2^{31}-1$, mảng đã sắp xếp ngược, đồ thị có chu trình tự thân).

### D. Smart Moodle Task Extractor (`SmartTaskExtractorModal.tsx`)
- **Vấn đề**: Giảng viên đại học thường gửi thông báo bài tập dưới dạng bài đăng diễn đàn hoặc email văn xuôi không có cấu trúc, khiến sinh viên dễ bỏ sót hạn nộp.
- **Giải pháp**: Người dùng dán nội dung thông báo vào modal; backend gửi prompt có cấu trúc chặt chẽ yêu cầu Gemini trích xuất dạng JSON:
  ```json
  [
    {
      "title": "Bài tập lớn Giữa kỳ - Thiết kế CSDL",
      "course_code": "IT004",
      "due_date_str": "2026-04-15 23:59:00",
      "task_type": "assignment",
      "confidence_score": 0.95
    }
  ]
  ```
- Người dùng xem trước danh sách nhiệm vụ được trích xuất trên bảng Preview, có thể chỉnh sửa ngày giờ và bấm `[Lưu vào Danh sách Nhiệm vụ]` để nạp trực tiếp vào `moodle_tasks`.

---

## 9. EXAM RADAR, CHECKLISTS & DAILY BRIEFING SPECIFICATION

### A. Exam Radar Engine (`ExamRadarCard.tsx` & `exam.rs`)
- **Đồng bộ Lịch thi Chính thức**: Trích xuất toàn diện từ Portal UIT (`/sinh-vien/lich-thi`), bao gồm: Mã môn, Tên môn, Lớp học phần, Hình thức thi (Tự luận / Trắc nghiệm / Vấn đáp / Thực hành), Ca thi, Giờ bắt đầu, Giờ kết thúc, Ngày thi, Phòng thi, Số báo danh, Ghi chú.
- **Dynamic Clock & CPU Sleep Throttling**:
  - Biểu diễn đồng hồ đếm ngược trực quan: `X ngày Y giờ Z phút`.
  - Nếu không có kỳ thi nào trong vòng 30 ngày tới: Luồng đếm giờ tự động giảm tần suất re-render hoặc tạm dừng, giữ mức tiêu thụ CPU = 0.0%.

### B. Interactive Preparation Checklist
- Mỗi ca thi lưu trữ danh sách đồ dùng cần chuẩn bị trong trường `checklist_items` (JSON):
  - `[x] Thẻ sinh viên UIT`
  - `[x] Máy tính Casio FX-580VN X`
  - `[ ] Bút bi xanh & Bút chì 2B`
  - `[ ] Giấy tờ tùy thân (CCCD)`
  - `[ ] Tờ công thức A4 viết tay (nếu môn cho phép)`
- Trạng thái checklist được lưu tức thời vào SQLite qua `update_exam_checklist`, không bị mất khi đóng ứng dụng hay khởi động lại máy.

### C. Daily Briefing Engine (`daily_briefing.rs`)
- **Khung giờ phát thông báo**: 08:00 sáng (Morning Briefing) và 20:00 tối (Evening Briefing).
- **Tổng hợp thông minh**:
  - Đếm số bài tập cần nộp trong vòng 24 giờ tới (`due_date <= now + 86400`).
  - Kiểm tra môn thi kế tiếp gần nhất và số ngày còn lại.
  - Điểm danh tài liệu hoặc slide mới được giảng viên cập nhật trong 24 giờ qua.
- **Native Windows Notification**: Sử dụng `tauri-plugin-notification` gửi banner thông báo hệ điều hành kèm âm thanh tinh tế. Có cơ chế chống spam (cooldown 30 phút giữa hai lần trigger liên tiếp).

---

## 10. MATERIAL OFFLINE MIRROR, VAULT WATCHER & SEMESTER ARCHIVE RITUAL

### A. Material Offline Mirror (`moodle.rs`)
- **Tải tài liệu hàng loạt**: Lệnh `download_course_materials` tải toàn bộ file slide, PDF, giáo trình của môn học vào thư mục cục bộ `{vault_path}/2025-2026_HK2/{Course_Name}/slides/`.
- **Bảo mật phiên tải**: Sử dụng cookie session nội bộ được trích xuất an toàn từ SSO Harvester; theo dõi tiến trình qua event `material-download-progress`.
- **Mở tài liệu 1-Click**: Lệnh `open_local_material` định vị tệp trên ổ cứng và gọi `open::that` để mở ngay bằng trình đọc PDF mặc định của Windows/macOS mà không cần vào trình duyệt.

### B. Live Incremental Vault Watcher (`vault.rs` & `notify`)
- **Kiến trúc Giám sát Gia tăng**: Khởi chạy một background thread lắng nghe sự kiện hệ thống tệp từ thư mục Vault qua crate `notify`.
- **Xử lý Debouncing**: Khi người dùng gõ phím liên tục trong Obsidian hoặc VSCode, watcher gom cụm các sự kiện sửa đổi trong vòng 1.5 giây để tránh ghi FTS5 liên tục gây lag đĩa.
- **Cập nhật Chỉ mục FTS5 Tức thì**: Chỉ đọc lại metadata và nội dung của đúng file vừa thay đổi, thực thi `UPDATE vault_notes` và `INSERT INTO vault_fts` ngay lập tức. Khôi phục hoàn toàn tính năng tìm kiếm mà không cần bấm nút "Quét lại Vault".

### C. Semester Archive Ritual (`ArchiveRitualModal.tsx` & `commands/vault.rs`)
- Khi kết thúc kỳ thi học kỳ và có điểm tổng kết đầy đủ:
  1. Người dùng mở modal **Nghi thức Lưu trữ Học kỳ**.
  2. Hệ thống đọc điểm chữ, điểm số hệ 10 và hệ 4 của từng môn từ `academic_courses`.
  3. Cập nhật YAML frontmatter của file `00_{CourseCode}_Index.md`:
     ```yaml
     final_score_10: 9.2
     final_score_4: 4.0
     final_grade_char: "A+"
     status: "Archived"
     ```
  4. Di chuyển thư mục học kỳ vào thư mục lưu trữ dài hạn: `{vault_root}/01_Archive/{semester}/`.
  5. Đồng bộ lại FTS5 và cập nhật trạng thái học kỳ thành `Đã lưu trữ`, sẵn sàng dọn sạch bảng điều khiển cho kỳ học mới.

---

## 11. AUTO-UPDATE & CONTINUOUS DELIVERY SPECIFICATION

### A. Client-Side Updater (`useAutoUpdater.ts` & `AutoUpdateModal.tsx`)
- Tích hợp `@tauri-apps/plugin-updater` giao tiếp trực tiếp với endpoint cập nhật GitHub Releases.
- **Quy trình Xác minh Chữ ký Minisign**:
  - Mỗi bản phát hành Windows binary (`.msi.zip` / `.nsis.zip`) bắt buộc đi kèm chữ ký mật mã Minisign (`.sig`).
  - Public key được biên dịch cứng vào mã nguồn app (`tauri.conf.json`). Nếu chữ ký không hợp lệ hoặc bị can thiệp, tiến trình cập nhật lập tức bị hủy bỏ để bảo đảm an toàn.
- **Tiến trình Tải Theo Byte Thực tế**: Giao diện hiển thị thanh tiến trình trực quan tính toán chính xác số MB đã tải / tổng dung lượng và tốc độ truyền.
- **Tự Động Khởi Động Lại**: Sau khi giải nén và cập nhật thành công, gọi `relaunch()` từ `@tauri-apps/plugin-process` để khởi động lại ứng dụng tức thì với phiên bản mới nhất.

### B. CI/CD Release Pipeline (`.github/workflows/release.yml`)
- Trigger tự động khi có tag Git mới dạng `v*` (ví dụ `v1.1.0`).
- Môi trường build: `windows-latest`, Node.js 22, pnpm 11, Rust stable toolchain với `x86_64-pc-windows-msvc`.
- Tự động ký số file binary bằng private key bảo mật lưu tại GitHub Secrets (`TAURI_SIGNING_PRIVATE_KEY`).
- Đẩy trực tiếp release assets, file `latest.json` chứa manifest phiên bản và changelog lên GitHub Releases.

---

## 12. PHỤ LỤC: DANH MỤC KHÓA BẢNG CÀI ĐẶT CỐT LÕI (`settings`)

| Khóa Cài Đặt (`key`) | Ý Nghĩa Kỹ Thuật | Giá Trị Mặc Định / Ví Dụ |
| :--- | :--- | :--- |
| `user_nickname` | Biệt danh hiển thị trên tiêu đề cửa sổ và HUD | `"Diark"` |
| `user_profile` | Chuỗi JSON định danh sinh viên (MSSV, Tên, Lớp) | `{"student_id":"...","name":"..."}` |
| `vault_path` | Đường dẫn tuyệt đối tới thư mục Native Vault | `"D:\\Diark_Vault"` |
| `cf_handle` | Handle thi đấu Codeforces của sinh viên | `"Diark"` |
| `total_degree_credits` | Tổng chỉ tiêu tín chỉ tốt nghiệp chuẩn (SSOT) | `"126"` |
| `gemini_api_key` | Khóa API Google Gemini cá nhân (BYOK) | `"AIzaSy..."` |
| `gemini_model` | Model AI đang được sử dụng cho Socratic Copilot | `"gemini-1.5-flash"` |
| `last_briefing_ts` | Timestamp lần gần nhất phát thông báo Daily Briefing | `"1711800000"` |
| `auto_update_enabled` | Cờ bật/tắt tự động kiểm tra bản cập nhật mới | `"true"` |
| `demo_privacy_mode` | Cờ kích hoạt che mờ thông tin cá nhân Demo Mode | `"false"` |
