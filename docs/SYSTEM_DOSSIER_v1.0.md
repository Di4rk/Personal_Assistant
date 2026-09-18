# DIARK // OS — MASTER ARCHITECTURAL DOSSIER (v1.3.0 BASELINE)

## 1. TỔNG QUAN HỆ THỐNG & NHÂN THỨC NGƯỜI DÙNG (PERSONA & HARDWARE)
- **Chủ sở hữu hệ thống:** Sinh viên CS/IT năm 2 (UIT - ĐHQG-HCM), định hướng Competitive Programming (ICPC), Nghiên cứu AI và An toàn thông tin; Visual Designer thương hiệu Diark.
- **Triết lý Vận hành:** Zero-Cloud, Pure Local Identity, Zero-Effort Automation, Zero Tampermonkey Dependency.
- **Ngân sách Phần cứng (Acer Nitro 5 Tiger):**
  - **Idle RAM:** < 150MB.
  - **Active Peak RAM:** < 500MB (khi mở Webview In-App SSO đồng bộ).
  - **CPU Usage:** 0.0% khi ở trạng thái nghỉ, triệt tiêu background polling vô ích.

---

## 2. TECH STACK & INVARIANTS KỸ THUẬT

### A. Core Stack
- **Native Host:** Tauri v2 (Rust 2021 edition).
- **Database Layer:** SQLite 3 qua `rusqlite`, cấu hình chuẩn:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  ```
- **Concurrency:** `Arc<Mutex<Connection>>` tuần tự hóa ghi chép, chống race conditions.
- **Frontend Layer:** React 18, Vite, TypeScript, Tailwind CSS, Zustand Stores.
- **Timezone Invariant:** Toàn bộ timestamp được chuẩn hóa về Unix Epoch UTC+7 (Asia/Ho_Chi_Minh).

### B. Security & Safety Invariants (P0 Rules)
1. **P0 Invariant — Zero IPC on Remote Webviews:** Mọi Webview bên ngoài (`uit-sso-login`, `wecode-sso-login`) là Remote Origin không đáng tin cậy, **TUYỆT ĐỐI KHÔNG** được cấp bất kỳ Tauri IPC capability nào (`invoke`, `listen`, `emit`).
2. **P0 Invariant — Zero Cookie Exfiltration:** Hệ thống không bóc tách hay lưu trữ cookie thô (`MoodleSession`, `laravel_session`, `ums_session`). Webview tự mang phiên same-origin; dữ liệu được gửi về qua Navigation Scheme Interception:
   ```
   diark-sso://callback#target=<service>&data=<url_encoded_json>
   diark-sso://failed#reason=<error_code>
   ```
3. **P0 Invariant — Zero Code Panic:** 0 `unwrap()` trên production paths của Rust; 0 `any` trong TypeScript codebase.
4. **P0 Invariant — Presentation-Only Privacy Masking:** Demo Mode chỉ che mờ lúc render giao diện (`Compute-on-Render`), tuyệt đối không ghi đè dữ liệu che mờ ngược vào SQLite.

---

## 3. DATABASE SCHEMA TOPOLOGY (SQLITE WAL)

```sql
-- Cấu hình hệ thống & Key-Value Store
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Chương trình đào tạo & Chuẩn tín chỉ tốt nghiệp
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
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (course_code, semester)
);

-- Khung chương trình đào tạo chính thức (bóc tách từ Portal byCtdt.program_scores theo 15 ngành)
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

-- Điểm rèn luyện theo học kỳ (bóc tách từ /api/sinh-vien/diem-ren-luyen)
CREATE TABLE IF NOT EXISTS academic_drl (
    semester    TEXT PRIMARY KEY,
    score       INTEGER NOT NULL,
    grade_text  TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Bài tập Wecode UIT
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

-- Event Sourcing Ledger (Life Matrix & XP Engine)
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

-- Ma trận năng suất hàng ngày (Aggregated Heatmap)
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

-- Khóa học Moodle UIT (Courses Engine)
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

-- Nhiệm vụ & Bài tập Moodle UIT
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

-- Tài liệu học tập Moodle UIT
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

-- Native Vault Metadata Table
CREATE TABLE IF NOT EXISTS vault_notes (
    rowid_key         INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT UNIQUE NOT NULL,       -- Đường dẫn tương đối (ví dụ '2025-2026_HK2/CS115_.../00_CS115_Index.md')
    title             TEXT NOT NULL,
    tags              TEXT,                       -- JSON string array: '["course", "uit"]'
    frontmatter_json  TEXT,                       -- Raw metadata JSON
    file_mtime        INTEGER NOT NULL,           -- Unix timestamp cho incremental sync
    content_cache     TEXT NOT NULL DEFAULT '',   -- Bộ đệm nội dung phục vụ FTS5 delete
    updated_at        INTEGER NOT NULL,
    note_type         TEXT DEFAULT 'GENERAL',     -- 'ALGO_TRICK', 'ACADEMIC_SUMMARY', 'TEACHING_SHEET', 'ONENOTE_LINK', 'GENERAL'
    external_uri      TEXT DEFAULT ''
);

-- Native Vault Full-Text Search Virtual Table (FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
    title,
    prose,
    code,
    content='',
    tokenize='porter unicode61'
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
                         │  Header Navigation + Settings   │
                         └───────┬─────────────────┬───────┘
                                 │                 │
             ┌───────────────────┴────┐       ┌────┴────────────────────┐
             ▼                        ▼       ▼                         ▼
   ┌───────────────────┐    ┌──────────────┐ ┌───────────────┐  ┌─────────────┐
   │  ACADEMIC RADAR   │    │ WECODE TRACK │ │ CODEFORCES ENG│  │ SETTINGS HUB│
   │ (Portal Ingestion)│    │  (Wecode QA) │ │ (Rating Radar)│  │ (Mod Center)│
   └─────────┬─────────┘    └──────┬───────┘ └───────┬───────┘  └──────┬──────┘
             │                     │                 │                 │
             └─────────────────────┼─────────────────┴─────────────────┘
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
- **Webview Window:** `uit-sso-login` và `wecode-sso-login`.
- **Pre-injection Script:** Bơm `UNIVERSAL_GUARDIAN_SCRIPT` (`scripts/portal_harvester.js`) trước khi render DOM.
- **Autonomous Zero-Touch Pipeline:**
  - **Auto-Detection:** Kiểm tra URL và Auth Cookie (`token`, `ss_id`); khi người dùng vừa hoàn tất đăng nhập SSO, lập tức kích hoạt bộ ba trình cào chạy song song ngầm không cần bất kỳ thao tác bấm nút nào:
    1. `/api/sinh-vien/bang-diem`: Trích xuất bảng điểm chi tiết theo kỳ (`bySemester`) và cơ cấu CTĐT (`byCtdt.statistics.total_program_credit`, `byCtdt.program_scores`).
    2. `/api/sinh-vien/diem-ren-luyen`: Trích xuất điểm rèn luyện tổng kết (`average_training_point`), xếp loại (`average_rank`), và lịch sử DRL từng học kỳ (`training_point_history`).
    3. `/sinh-vien/ho-so`: Trích xuất luồng Next.js React Server Component (RSC) Flight Data (`self.__next_f.push([1, "..."])`) lấy toàn vẹn hồ sơ sinh viên (MSSV, Họ tên, Khoa, Ngành, Lớp, Phân hệ đào tạo, Niên khóa) vượt qua rào cản DOM ảo.
  - **Local HTTP Dispatch:** Payload hợp nhất được tự động gửi qua `POST http://127.0.0.1:3030/api/v1/sync/portal` (hoặc fallback qua Tauri Custom Scheme `diark-sso://callback#target=portal&data=...`).
  - **Self-Closing & Success Pill:** Hiển thị notification pill tinh tế góc màn hình thông báo đồng bộ thành công và tự động đóng Webview (`window.close()` / watchdog termination).

### B. Dynamic 15-Major Curriculum Resolution & SSOT (`curriculum_resolver.rs`)
Phân giải theo thứ tự ưu tiên 5 tầng bảo đảm tính đúng đắn tuyệt đối cho toàn bộ 15 ngành/hệ đào tạo của UIT:
1. **Portal API SSOT (Tuyệt đối):** Lấy trực tiếp `byCtdt.statistics.total_program_credit` từ cổng UIT (ví dụ `126 TC` cho KHMT CQUI). Ghi nhận vào `academic_program_summary (id='MAIN')` và `settings (total_degree_credits)` với cờ `matched_via = "portal_api_direct"`. Miễn nhiễm việc bị ghi đè bởi fallback.
2. **D-code Trực Tiếp:** Regex tĩnh `D\d{6}` $\rightarrow$ truy vấn `academic_curriculums`.
3. **Track-Specific Alias:** Token kết hợp `ACRONYM-TRACK` (ví dụ `KHMT-CLC` $\rightarrow$ 130 TC).
4. **Acronym Trần:** Token viết tắt ngành (ví dụ `KHMT` $\rightarrow$ 126 TC của CQUI).
5. **Hard Fallback:** Trả về `130 TC` generic với cờ `matched_via = "hard_fallback"`.

### C. Gamification & Deduplication Engine (`wecode.rs`)
- **Binary First-AC Policy:** Chỉ nạp sự kiện `activity_events` khi `score == 100` hoặc `verdict == "CORRECT ANSWER"`.
- **XP Weight:** +15 XP cho mỗi bài Wecode AC đầu tiên, +20 XP cho Codeforces Accepted problem, +25 XP cho Moodle assignment submission.
- **Idempotency:** Khóa `UNIQUE(plugin_id, event_type, ref_id)` chặn đứng hoàn toàn việc cộng trùng lặp XP khi đồng bộ lại lịch sử.

### D. Universal Settings Hub (`SettingsModal.tsx`)
- Gom toàn bộ trung tâm điều khiển về một modal 2 cột:
  - **Tab Profile:** Xem thông tin định danh sinh viên, đổi Handle/Nickname.
  - **Tab Plugins:** Quản lý bật/tắt toàn bộ First-Party và Community Mods.
  - **Tab Services Sync:** Điều hướng đăng nhập và đồng bộ Portal UIT, Courses Moodle, Wecode Judge.
  - **Tab System:** Bật/tắt Demo Privacy Mode, thống kê dung lượng SQLite DB/WAL.

---

## 5. BẢNG DANH MỤC LỆNH IPC COMMANDS (TAURI v2)

| Lệnh Rust Command | File Nguồn | Chức năng Kỹ thuật |
| --- | --- | --- |
| `launch_portal_sso_sync` | `portal_auth.rs` | Khởi tạo WebView2 đăng nhập Portal với Guardian Script và Watchdog Token. |
| `launch_wecode_sso_sync` | `portal_auth.rs` | Khởi tạo WebView2 đăng nhập Wecode với State Machine chống redirect loop. |
| `sync_official_portal_data` | `academic.rs` | Tiếp nhận và ingest toàn diện bảng điểm (bySemester), CTĐT (byCtdt), DRL và hồ sơ sinh viên vào SQLite nguyên tử. |
| `get_academic_curriculum` | `academic.rs` | Truy vấn danh sách toàn bộ học phần trong khung CTĐT chính thức (môn bắt buộc, tự chọn, trạng thái học tập). |
| `get_resolved_curriculum` | `academic.rs` | Lấy chỉ tiêu tín chỉ tốt nghiệp chuẩn hóa (ưu tiên SSOT từ Portal API). |
| `save_student_profile` | `academic.rs` | Ghi đè hồ sơ sinh viên vào SQLite. |
| `ingest_full_academic_payload` | `academic.rs` | Lưu trữ bảng điểm và DRL nguyên tử (Atomic Transaction). |
| `get_academic_radar_metrics` | `academic.rs` | Tính toán cGPA hệ 10, cGPA hệ 4, DRL và tín chỉ theo ngành động. |
| `get_wecode_submissions` | `wecode.rs` | Truy vấn lịch sử nộp bài Wecode kèm phân trang và lọc theo bài tập. |
| `fetch_remote_registry` | `plugins.rs` | Lấy danh mục Community Plugins từ remote registry. |
| `install_remote_plugin` | `plugins.rs` | Tải zip, verify SHA-256, giải nén cách ly và ghi danh vào SQLite. |
| `toggle_plugin` | `plugins.rs` | Bật/tắt trạng thái phân hệ, kích hoạt recalculate Life Matrix. |
| `get_system_storage_stats` | `settings.rs` | Trả về dung lượng DB, file WAL và tổng số bản ghi. |
| `save_setting` | `settings.rs` | Lưu cặp Key-Value vào bảng `settings`. |
| `get_moodle_courses` | `moodle.rs` | Truy vấn danh sách toàn bộ các môn học Moodle đang lưu trữ trong SQLite. |
| `get_moodle_tasks` | `moodle.rs` | Lấy danh sách nhiệm vụ/bài tập Moodle (hỗ trợ lọc theo `course_id`). |
| `get_moodle_materials` | `moodle.rs` | Truy vấn danh mục slide bài giảng, giáo trình PDF theo môn học. |
| `update_moodle_course_instructor` | `moodle.rs` | Tùy chỉnh thông tin liên hệ giảng viên (họ tên, email, SĐT) cho từng môn. |
| `ingest_moodle_sync_payload_json` | `moodle.rs` | Ingest nguyên tử dữ liệu môn học, bài tập và tài liệu từ Harvester. |
| `scan_vault` | `vault.rs` | Quét thư mục Markdown cục bộ, trích xuất wikilinks và đồng bộ FTS5 gia tăng. |
| `search_vault` | `vault.rs` | Tìm kiếm toàn văn FTS5 tốc độ cao với thuật toán BM25 và snippet highlight. |
| `get_vault_stats` | `vault.rs` | Lấy số liệu thống kê tổng notes, wikilinks, tags và ghi chú gần đây. |
| `create_structured_note` | `vault.rs` | Tạo ghi chú cấu trúc mới, ghi file an toàn chống đè và cập nhật FTS5. |
| `open_onenote_link` | `vault.rs` | Validate an toàn giao thức `onenote:` và mở qua OS shell handler. |
| `set_vault_path` | `vault.rs` | Lưu đường dẫn thư mục Vault người dùng chọn vào bảng `settings`. |
| `get_vault_path` | `vault.rs` | Đọc đường dẫn thư mục Vault đang kích hoạt từ bảng `settings`. |
| `scaffold_semester_vault` | `vault.rs` | Tự động tạo cây thư mục môn học HK2 và ghi chú khởi tạo từ Moodle (Idempotent 100%). |
| `open_vault_course_folder` | `vault.rs` | Mở trực tiếp thư mục ghi chú của môn học ngoài File Explorer hệ điều hành. |

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


