# [SYSTEM ARCHITECTURE DOSSIER] JARVIS PERSONAL OS (v1.0.0 BASELINE)

> **Document Type:** Production Architecture Dossier & System Ledger  
> **Release Version:** `v1.0.0` (Production Baseline)  
> **Git Commit Hash:** `4f49e78bafc8ebf5e8411aa5120bfab71f60a519`  
> **Git Branch:** `main` (Working Tree: Clean)  
> **Verification Status:** 98/98 Tests Passed (100%), Production Vite Bundle: 307.01 kB JS (gzip: 89.28 kB), 58.91 kB CSS (gzip: 10.10 kB).  
> **Target Machine Profile:** Acer Nitro 5 Tiger (Windows 11 x64, Intel Core i5 / AMD Ryzen 5, 16GB RAM).

---

## 1. PROJECT DNA & TARGET CONSTRAINTS

### 1.1 Target Persona
- **Primary User:** Sinh viên năm 2 ngành Khoa học Máy tính / Công nghệ Thông tin tại Trường Đại học Công nghệ Thông tin (UIT - ĐHQG-HCM).
- **Secondary Roles:**
  - **Competitive Programmer (ICPC):** Luyện thuật toán chuyên sâu trên Codeforces / VNOJ, cày điểm First-AC, phân tích lỗi hậu giải đấu (Post-Mortem taxonomy).
  - **Academic Achiever:** Theo dõi tiến độ tích lũy 10 học kỳ, tính GPA/CPA hệ 10 và hệ 4 theo quy chế ĐHQG-HCM, tự động hóa trích xuất điểm rèn luyện (DRL) và bảng điểm chính quy từ cổng sinh viên UIT.
  - **Tutor / Designer:** Soạn thảo tài liệu giảng dạy, bài giảng thuật toán (Teaching Sheets), quản lý liên kết ghi chú ngoài với Microsoft OneNote.

### 1.2 Hardware Constraints & Resource Budget
- **Memory Budget:** Idle footprint **< 80MB RAM** (Target tối đa cho desktop daemon).
- **CPU Thrift:** Zero background CPU thrashing — không dùng vòng lặp `thread::sleep` vô tận, không dùng file watcher polling nặng (`notify` polling bị cấm); thay vào đó dùng event-driven architecture (`tokio::sync::watch`, `tokio::select!`, `TcpListener::accept`).
- **Disk I/O Protection:** Bật SQLite Write-Ahead Logging (WAL) với `PRAGMA synchronous = NORMAL` và `PRAGMA cache_size = -8000` (giới hạn ~8MB page cache). Khóa `mmap_size = 0` trên Windows để chống phình ảo Virtual Address Space.

### 1.3 Technology Stack & Architectural Pillars
| Layer | Technologies & Libraries | Invariant Rules |
| :--- | :--- | :--- |
| **Host Runtime** | Tauri v2 (`tauri = "2.3"`, `tauri-build = "2.0"`) | Chạy native WebView2, kiểm soát toàn quyền IPC boundary. |
| **Core Systems** | Rust 2021 Edition, Tokio 1.x async runtime | **Zero `unwrap()` / `expect()`** trong production paths. Propagate lỗi qua `Result<T, AppError>`. |
| **Persistence** | SQLite 3 (`rusqlite = "0.32"`, `bundled`, `fts5`) | Single-writer guard qua `Arc<Mutex<Connection>>`, WAL checkpointing khi shutdown. |
| **Frontend UI** | React 18, TypeScript (Strict Mode), Vite 6 | **Zero `any`**, zero magic numbers, 4px scale, Dark mode first (slate/zinc palette). |
| **Networking** | `reqwest = "0.12"`, `httparse = "1.8"` | Zero-dependency loopback HTTP parser cho browser bridge, client timeout 15s. |

---

## 2. FUNCTIONAL MATRIX (APP LÀM ĐƯỢC GÌ VÀ VẬN HÀNH NHƯ THẾ NÀO?)

```
+-------------------------------------------------------------------------------------------------------+
|                                          JARVIS PERSONAL OS                                           |
+-------------------------------------------------------------------------------------------------------+
|  [Global Daemon & HUD]            [Browser Bridge Server]                [CF Sync Worker]             |
|   - System Tray (TrayIcon)         - Loopback TCP (127.0.0.1:41718)       - Ephemeral Poller (60s)    |
|   - Global Shortcut (Alt+K)        - Zero-dependency HTTP Parse           - Exponential Backoff       |
|   - Raycast-style Palette          - Bearer Token Auth                    - AtomicBool SyncLock       |
+------------------------------------+--------------------------------------+---------------------------+
                                      |                                      |
                                      v                                      v
+-------------------------------------------------------------------------------------------------------+
|                                        DATABASE STORAGE LAYER                                         |
|  - SQLite 3 (WAL Mode, synchronous=NORMAL, cache_size=-8000, mmap_size=0, busy_timeout=5000ms)        |
|  - Tables: submissions, life_matrix_daily, academic_courses, academic_macro_metrics, vault_notes...   |
|  - Virtual Engines: post_mortems_fts (FTS5 external content), vault_fts (FTS5 contentless multi-col)  |
+-------------------------------------------------------------------------------------------------------+
                                      ^                                      ^
                                      |                                      |
+-------------------------------------+--------------------------------------+--------------------------+
|  [Competitive Engine]              [Academic Automation]                  [Native Vault Engine]       |
|   - First-AC CTE Deduplication      - UIT Portal SSO & Tampermonkey        - Markdown Scanner (mtime) |
|   - UTC+07:00 Normalization         - Non-destructive DRL Retention        - FTS5 BM25 (title, prose) |
|   - Tiered XP State Calculation     - Radar & Simulation Engine            - OneNote Scheme Guard     |
+-------------------------------------------------------------------------------------------------------+
```

### 2.1 Module 1 & 2: Competitive Programming Engine & Post-Mortem Taxonomy
- **First-AC CTE Deduplication:**
  - Để ngăn chặn gian lận XP khi nộp nhiều lần cho cùng một bài tập (hoặc khi contest replay), hệ thống sử dụng truy vấn SQL Recursive / Window CTE tính `MIN(submission_time)` cho mỗi cặp `(contest_id, problem_index)`.
  - Chỉ submission đầu tiên đạt verdict `OK` / `ACCEPTED` mới được đánh dấu `is_first_ac = 1` và cộng 15 XP. Các lượt nộp sau đó nhận 0 XP hoặc XP penalty theo cấu hình.
- **Chuẩn hóa múi giờ UTC+7 (ICT):**
  - Mọi timestamp Unix Epoch từ Codeforces API đều được chuẩn hóa chính xác vào ngày làm việc theo công thức: `date(datetime(ts, 'unixepoch', '+7 hours'))`.
- **Background Worker Concurrency:**
  - Background worker chạy chu kỳ 60s bằng `tokio::select!` kết hợp `watch::Receiver<bool>` để nhận tín hiệu shutdown.
  - Sử dụng cờ nguyên tử `SyncLock (Arc<AtomicBool>)` để ngăn ngừa race condition giữa tiến trình chạy tự động ngầm và nút bấm thủ công `trigger_cf_sync` trên giao diện.
- **Post-Mortem Error Taxonomy:**
  - Phân loại lỗi theo 5 nhóm chuẩn kỹ thuật: `LOGIC_BUG`, `CORNER_CASE`, `TIME_COMPLEXITY`, `IMPLEMENTATION`, `MISREAD`.
  - Tích hợp bảng ảo FTS5 `post_mortems_fts` dạng *external content*, đồng bộ tự động 100% qua 3 triggers: `AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE` (dùng lệnh `'delete'` chuyên dụng để dọn dẹp shadow tables).

### 2.2 Module 3: Life Matrix Heatmap Engine
- **364-Cell Continuous Calendar Grid:**
  - Khởi tạo chính xác dải 364 ô liên tục (52 tuần $\times$ 7 ngày) từ SQLite mà không cần loop tính toán ở frontend, thông qua Recursive CTE:
    ```sql
    WITH RECURSIVE date_range(d) AS (
        SELECT date(?1)
        UNION ALL
        SELECT date(d, '+1 day') FROM date_range WHERE d < date(?2)
    )
    SELECT date_range.d, COALESCE(lmd.ac_count, 0), COALESCE(lmd.total_xp, 0), COALESCE(lmd.state_tier, 0)
    FROM date_range
    LEFT JOIN life_matrix_daily lmd ON lmd.date = date_range.d
    ORDER BY date_range.d ASC;
    ```
- **State Tier Calculation:**
  - Điểm tổng hợp hàng ngày kết hợp: `Total XP = (Distinct First-AC * 15) + (OnTime Deadlines * 20) + (Late Deadlines * 5)`.
  - Phân tầng trạng thái 5 bậc: `Tier 0 (Idle: <=0 XP)`, `Tier 1 (Low: 1..30 XP)`, `Tier 2 (Mid: 31..60 XP)`, `Tier 3 (High: 61..90 XP)`, `Tier 4 (God Mode: >90 XP)`.
- **Frontend Zero-Reflow Performance:**
  - Giao diện sử dụng kỹ thuật Event Delegation (chỉ 1 listener duy nhất trên toàn bộ grid SVG/DOM), tính toán tooltip position qua CSS GPU transform (`translate3d`) lồng trong `requestAnimationFrame`, loại bỏ hoàn toàn hiện tượng layout reflow.

### 2.3 Module 4 & 6: Academic Automation & UIT Portal Browser Bridge
- **Loopback HTTP Sync Server (Port 41718):**
  - Triển khai server TCP siêu nhẹ bằng `tokio::net::TcpListener` và bộ parser zero-dependency `httparse`. Tuyệt đối không kéo các web framework cồng kềnh như `axum` hay `actix-web`.
  - Tự động fallback sang port 41719, 41720 nếu port 41718 bị chiếm dụng.
- **Security Boundary:**
  - Chỉ bind trên giao tiếp nội bộ `127.0.0.1`.
  - Mọi request đều bắt buộc chứa header `X-Jarvis-Sync-Token` khớp với token bảo mật ngẫu nhiên lưu trong bảng `settings`.
- **Tampermonkey Userscript Bridge:**
  - Userscript chạy trên `student.uit.edu.vn` và `portal.uit.edu.vn`. Tự động cào bảng điểm, danh sách môn học và điểm rèn luyện (DRL), đóng gói thành JSON và gửi thẳng vào loopback port.
- **Bảo vệ DRL Không Bị Ghi Đè (Data Retention Invariant):**
  - Khi người dùng nạp bảng điểm học tập mà trường DRL bị khuyết hoặc rỗng (`drl: null`), logic tại tầng `spawn_blocking` kiểm tra và duy trì nguyên vẹn điểm DRL đã ghi nhận trước đó trong `academic_macro_metrics`, bảo vệ Single Source of Truth (SSOT).
- **Grading Engine ĐHQG-HCM:**
  - Quy đổi điểm hệ 10 sang thang chữ (A+, A, B+, B, C+, C, D+, D, F) và hệ 4 (4.0, 3.7, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 0.0) tuân thủ 100% quy chế tín chỉ ĐHQG-HCM. Điểm tổng kết và GPA được tính toán động (dynamic aggregates) để tránh hiện tượng trôi dạt dữ liệu (denormalization drift).

### 2.4 Module 5: Native Knowledge Vault & Quick Capture
- **Incremental Scanner:**
  - Quét thư mục Markdown cục bộ, so sánh `file_mtime` (thời điểm sửa đổi) với dữ liệu trong `vault_notes`. Chỉ đọc và phân tích những file có nội dung thay đổi.
- **FTS5 Multi-Column Search & BM25 Weighting:**
  - Bảng ảo `vault_fts` tách biệt 3 cột: `title`, `prose`, `code`.
  - Sử dụng bộ tokenizer `unicode61 remove_diacritics 2` để hỗ trợ tìm kiếm tiếng Việt không dấu.
  - Phân bổ trọng số BM25: `bm25(vault_fts, 10.0, 5.0, 1.0)` — ưu tiên tiêu đề bài viết gấp 10 lần, phần thân văn bản gấp 5 lần so với code block.
  - Snippet trích dẫn kết quả chỉ được tạo trên cột `prose` để tránh làm vỡ định dạng code block.
- **OneNote Deep-Link Security Guard:**
  - Ngăn chặn triệt để lỗ hổng Command Injection / Shell Injection thông qua hàm `validate_onenote_uri`:
    1. Bắt buộc URI phải bắt đầu bằng scheme `onenote:`.
    2. Chiều dài URI $\le 1024$ ký tự.
    3. Tuyệt đối cấm ký tự nháy kép `"` hoặc ký tự điều khiển shell.
    4. Ký tự hợp lệ phải thuộc whitelist an toàn (alphanumeric, `/`, `?`, `=`, `&`, `-`, `_`, `%`, v.v.).
- **Windows-Safe Slug Generator & Auto-Disambiguation:**
  - Tự động loại bỏ các ký tự cấm trên Windows (`\ / : * ? " < > |`).
  - Chống va chạm với các tên thiết bị dành riêng của hệ điều hành DOS/Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`).
  - Áp dụng cơ chế *check-then-write disambiguation*: nếu `algorithms/dp.md` đã tồn tại, file mới sẽ tự động được đánh số tăng dần `algorithms/dp-2.md`, bảo đảm zero data loss.

### 2.5 Module 7: OS Daemon & Global HUD
- **System Tray Lifecycle:**
  - Khi người dùng nhấn nút đóng cửa sổ 'X', sự kiện `CloseRequested` bị chặn lại (`api.prevent_close()`), cửa sổ chính tự động ẩn vào khay hệ thống (System Tray).
  - Menu khay hệ thống bao gồm: `Show HUD (Alt+K)`, trạng thái kết nối `Status: Running`, và `Quit Jarvis OS`.
- **Global Shortcut `Alt+K` (Command Palette):**
  - Đăng ký hotkey toàn cục `Alt+K` thông qua `tauri-plugin-global-shortcut`.
  - Cơ chế Focus Guarantee: Khi HUD được mở, hệ thống gửi event `hud-shown` đến frontend. Giao diện React lập tức kích hoạt `requestAnimationFrame` để focus vào ô tìm kiếm, người dùng có thể gõ phím ngay tức khắc không cần click chuột.
- **Graceful Shutdown:**
  - Khi thoát ứng dụng từ System Tray (`quit`), hệ thống kích hoạt hàm `graceful_shutdown`:
    1. Gửi cờ `true` qua kênh `watch::Sender<bool>` để dừng các worker async.
    2. Chờ thời gian grace period 500ms để hoàn tất các transaction dở dang.
    3. Thực thi câu lệnh `PRAGMA wal_checkpoint(TRUNCATE)` để flush toàn bộ dữ liệu từ file WAL (`jarvis.sqlite3-wal`) vào file DB chính và thu gọn kích thước file về 0.
    4. Gọi `app.exit(0)` kết thúc tiến trình an toàn tuyệt đối.

---

## 3. DATABASE SCHEMA & MEMORY PRAGMAS

### 3.1 SQLite Initialization & Connection PRAGMAs
```rust
// Cấu hình tối ưu bộ nhớ và bảo toàn dữ liệu (src-tauri/src/db/schema.rs)
conn.busy_timeout(Duration::from_millis(5000))?;
conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
conn.pragma_update(None, "synchronous", "NORMAL")?;
conn.pragma_update(None, "foreign_keys", "ON")?;
conn.pragma_update(None, "cache_size", -8000)?; // Khóa trần cache ~8MB (8000 KiB)
conn.pragma_update_and_check(None, "mmap_size", 0, |row| row.get(0))?; // Tắt mmap chống phình RAM Windows
```

### 3.2 Data Definition Language (DDL) Ledger

```sql
-- 1. SUBMISSIONS & COMPETITIVE ACTIVITY
CREATE TABLE IF NOT EXISTS submissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    problem_id      TEXT NOT NULL,
    problem_name    TEXT NOT NULL,
    verdict         TEXT NOT NULL,
    language        TEXT,
    contest_id      TEXT,
    xp_awarded      INTEGER NOT NULL DEFAULT 0,
    submitted_at    TEXT NOT NULL,
    raw_payload     TEXT,
    cf_submission_id INTEGER,
    is_first_ac     INTEGER NOT NULL DEFAULT 0,
    submission_time INTEGER,
    problem_index   TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions (submitted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_cf_id ON submissions (cf_submission_id) WHERE cf_submission_id IS NOT NULL;

-- 2. DAILY ACTIVITY SUMMARY (LEGACY & CP TRACKER)
CREATE TABLE IF NOT EXISTS daily_activity (
    date            TEXT PRIMARY KEY,   -- Format: YYYY-MM-DD
    total_xp        INTEGER NOT NULL DEFAULT 0,
    ac_count        INTEGER NOT NULL DEFAULT 0,
    wa_count        INTEGER NOT NULL DEFAULT 0,
    other_count     INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL
);

-- 3. MASTER LIFE MATRIX DAILY (CANONICAL 364-DAY HEATMAP)
CREATE TABLE IF NOT EXISTS life_matrix_daily (
    date              TEXT PRIMARY KEY, -- Format: 'YYYY-MM-DD' (Normalized to UTC+07:00 ICT)
    ac_count          INTEGER NOT NULL DEFAULT 0,
    deadlines_cleared INTEGER NOT NULL DEFAULT 0,
    total_xp          INTEGER NOT NULL DEFAULT 0,
    state_tier        INTEGER NOT NULL DEFAULT 0, -- 0: Idle, 1: Low, 2: Mid, 3: High, 4: God Mode
    updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_life_matrix_date ON life_matrix_daily(date);

-- 4. POST-MORTEM REFLECTION & TAXONOMY
CREATE TABLE IF NOT EXISTS post_mortems (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    problem_id    TEXT NOT NULL UNIQUE,
    problem_name  TEXT NOT NULL,
    platform      TEXT NOT NULL DEFAULT 'codeforces',
    root_cause    TEXT NOT NULL CHECK (
        root_cause IN ('LOGIC_BUG', 'CORNER_CASE', 'TIME_COMPLEXITY', 'IMPLEMENTATION', 'MISREAD')
    ),
    key_insight   TEXT NOT NULL,
    tags          TEXT NOT NULL,        -- Comma-separated normalized tags
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- FTS5 External Content Virtual Table for Post-Mortem
CREATE VIRTUAL TABLE IF NOT EXISTS post_mortems_fts USING fts5(
    problem_id UNINDEXED,
    problem_name,
    key_insight,
    tags,
    content='post_mortems',
    content_rowid='id'
);

-- Triggers maintaining Post-Mortem FTS Index
CREATE TRIGGER IF NOT EXISTS post_mortems_ai AFTER INSERT ON post_mortems BEGIN
    INSERT INTO post_mortems_fts(rowid, problem_id, problem_name, key_insight, tags)
    VALUES (new.id, new.problem_id, new.problem_name, new.key_insight, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS post_mortems_ad AFTER DELETE ON post_mortems BEGIN
    INSERT INTO post_mortems_fts(post_mortems_fts, rowid, problem_id, problem_name, key_insight, tags)
    VALUES ('delete', old.id, old.problem_id, old.problem_name, old.key_insight, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS post_mortems_au AFTER UPDATE ON post_mortems BEGIN
    INSERT INTO post_mortems_fts(post_mortems_fts, rowid, problem_id, problem_name, key_insight, tags)
    VALUES ('delete', old.id, old.problem_id, old.problem_name, old.key_insight, old.tags);
    INSERT INTO post_mortems_fts(rowid, problem_id, problem_name, key_insight, tags)
    VALUES (new.id, new.problem_id, new.problem_name, new.key_insight, new.tags);
END;

-- 5. ACADEMIC SEMESTERS (METADATA & TARGETS ONLY - COMPUTED STATS LIVE)
CREATE TABLE IF NOT EXISTS academic_semesters (
    id             TEXT PRIMARY KEY,    -- e.g. "2025-2026.1"
    academic_year  TEXT NOT NULL,
    semester_term  INTEGER NOT NULL,
    target_gpa     REAL,
    target_drl     INTEGER,
    is_completed   INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

-- 6. ACADEMIC COURSES
CREATE TABLE IF NOT EXISTS academic_courses (
    id                 TEXT PRIMARY KEY, -- UUID v4
    semester_id        TEXT NOT NULL,
    course_code        TEXT NOT NULL,
    course_name        TEXT NOT NULL,
    credits            INTEGER NOT NULL,
    process_point      REAL,
    midterm_score      REAL,
    practice_point     REAL,
    final_point        REAL,
    course_point       REAL NOT NULL DEFAULT 0.0,
    status             TEXT NOT NULL DEFAULT 'normal',
    note               TEXT,
    final_score        REAL,
    other_scores       TEXT,
    summary_score_10   REAL,
    summary_score_4    REAL,
    grade_char         TEXT,
    is_passed          INTEGER NOT NULL DEFAULT 0,
    is_gpa_calculated  INTEGER NOT NULL DEFAULT 1,
    grade_4            REAL,
    result_status      TEXT NOT NULL DEFAULT 'Đạt',
    category           TEXT NOT NULL DEFAULT 'dai_cuong',
    created_at         INTEGER NOT NULL DEFAULT 0,
    updated_at         INTEGER NOT NULL,
    FOREIGN KEY(semester_id) REFERENCES academic_semesters(id) ON DELETE CASCADE,
    UNIQUE(semester_id, course_code)
);
CREATE INDEX IF NOT EXISTS idx_courses_semester ON academic_courses(semester_id);

-- 7. ACADEMIC DRL EVENTS
CREATE TABLE IF NOT EXISTS academic_drl_events (
    id           TEXT PRIMARY KEY,
    semester_id  TEXT NOT NULL,
    event_name   TEXT NOT NULL,
    category     TEXT NOT NULL CHECK (category IN ('DAO_DUC','HOC_TAP','THE_CHAT','TINH_NGUYEN','HOI_NHAP')),
    points       INTEGER NOT NULL,
    proof_url    TEXT,
    status       TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','CONFIRMED','REJECTED')),
    created_at   INTEGER NOT NULL,
    FOREIGN KEY(semester_id) REFERENCES academic_semesters(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drl_semester ON academic_drl_events(semester_id);

-- 8. ACADEMIC MACRO METRICS (SINGLE SOURCE OF TRUTH FOR OVERVIEW & DRL)
CREATE TABLE IF NOT EXISTS academic_macro_metrics (
    semester_id        TEXT PRIMARY KEY,
    semester_label     TEXT NOT NULL DEFAULT '',
    year_name          TEXT NOT NULL DEFAULT '',
    term_gpa           REAL NOT NULL DEFAULT 0.0,
    cumulative_gpa     REAL NOT NULL DEFAULT 0.0,
    term_credits       INTEGER NOT NULL DEFAULT 0,
    cumulative_credits INTEGER NOT NULL DEFAULT 0,
    drl_score          INTEGER NOT NULL DEFAULT 0,
    rank_label         TEXT NOT NULL DEFAULT 'Chưa xếp loại',
    classification     TEXT NOT NULL DEFAULT 'Chưa xếp loại',
    drl                INTEGER,
    updated_at         INTEGER NOT NULL
);

-- 9. ACADEMIC CURRICULUM (CHƯƠNG TRÌNH ĐÀO TẠO CHUẨN UIT)
CREATE TABLE IF NOT EXISTS academic_curriculum (
    course_code TEXT PRIMARY KEY,
    course_name TEXT NOT NULL,
    credits     INTEGER NOT NULL,
    course_type TEXT NOT NULL,          -- 'Bắt buộc' | 'Tự chọn'
    ideal_term  INTEGER NOT NULL,          -- 1..7, 20
    status      TEXT NOT NULL,          -- 'Đã qua' | 'Đang học' | 'Chưa học'
    final_score REAL,
    updated_at  INTEGER NOT NULL
);

-- 10. ACADEMIC PROGRAM SUMMARY (SENTINEL 'MAIN' ROW)
CREATE TABLE IF NOT EXISTS academic_program_summary (
    id                   TEXT PRIMARY KEY, -- 'MAIN'
    cumulative_gpa       REAL,
    cumulative_drl       REAL,
    cumulative_credits   INTEGER,
    total_degree_credits INTEGER DEFAULT 126,
    classification       TEXT,
    drl_classification   TEXT,
    updated_at           INTEGER NOT NULL
);

-- 11. MOODLE DEADLINE TRACKER & WORKSPACE CONFIG
CREATE TABLE IF NOT EXISTS course_workspace_config (
    course_code    TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    target_score   REAL DEFAULT 8.5,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS course_deadlines (
    id             TEXT PRIMARY KEY,    -- Format: "{course_code}_{cmid}"
    course_code    TEXT NOT NULL,
    title          TEXT NOT NULL,
    due_timestamp  INTEGER NOT NULL,    -- Unix epoch UTC
    due_date_raw   TEXT NOT NULL,       -- e.g. "18/09/2026 23:59"
    source_url     TEXT NOT NULL,
    is_submitted   INTEGER DEFAULT 0,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deadlines_course ON course_deadlines(course_code);
CREATE INDEX IF NOT EXISTS idx_deadlines_due ON course_deadlines(due_timestamp) WHERE is_submitted = 0;

-- 12. NATIVE KNOWLEDGE VAULT NOTES & WIKILINKS
CREATE TABLE IF NOT EXISTS vault_notes (
    rowid_key        INTEGER PRIMARY KEY AUTOINCREMENT,
    id               TEXT UNIQUE NOT NULL, -- Relative path (e.g. 'cs/dp.md')
    title            TEXT NOT NULL,
    tags             TEXT,                 -- JSON array: '["icpc"]'
    frontmatter_json TEXT,
    file_mtime       INTEGER NOT NULL,     -- Unix timestamp for sync
    content_cache    TEXT NOT NULL DEFAULT '',
    updated_at       INTEGER NOT NULL,
    note_type        TEXT DEFAULT 'GENERAL', -- GENERAL | TEACHING_SHEET | DESIGN | RESEARCH
    external_uri     TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vault_links (
    source_id         TEXT NOT NULL,
    target_id         TEXT,                 -- NULL if unresolved
    unresolved_target TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_id, unresolved_target),
    FOREIGN KEY(source_id) REFERENCES vault_notes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vault_links_target ON vault_links(target_id);
CREATE INDEX IF NOT EXISTS idx_vault_links_unresolved ON vault_links(unresolved_target) WHERE target_id IS NULL;

-- Contentless Multi-Column FTS5 Engine for Knowledge Vault
CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
    title,
    prose,
    code,
    content='',
    tokenize='unicode61 remove_diacritics 2'
);

-- 13. APPLICATION SETTINGS & CREDENTIALS
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

---

## 4. IPC REGISTRY & NETWORK BOUNDARY

### 4.1 IPC Command to Frontend Binding Matrix
Toàn bộ các lệnh gọi IPC giữa React UI (`src/lib/tauri-client.ts`) và backend Rust (`src-tauri/src/commands/`) được liệt kê trong bảng dưới đây:

| Module | Tauri Command (`invoke`) | Frontend Function (`tauri-client.ts`) | Input Parameters | Return Type | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Core CP** | `get_today_stats` | `fetchTodayStats()` | *None* | `DailyStats` | Thống kê số bài AC, WA, XP tích lũy trong ngày. |
| **Core CP** | `get_recent_submissions` | `fetchRecentSubmissions(limit)` | `{ limit: number }` | `SubmissionRecord[]` | Danh sách bài nộp Codeforces gần đây. |
| **Core CP** | `get_level_info` | `fetchLevelInfo()` | *None* | `LevelInfo \| null` | Cấp độ hiện tại, XP tiến độ đến level tiếp theo. |
| **Core CP** | `get_yearly_heatmap` | `fetchYearlyHeatmap(year)` | `{ year: number }` | `HeatmapDay[]` | Mảng hoạt động 365 ngày theo năm dương lịch. |
| **Core CP** | `get_cf_handle` | `getCfHandle()` | *None* | `string \| null` | Đọc Codeforces handle đã lưu từ `settings`. |
| **Core CP** | `set_cf_handle` | `setCfHandle(handle)` | `{ handle: string }` | `void` | Ghi Codeforces handle mới vào `settings`. |
| **Core CP** | `trigger_cf_sync` | `triggerCfSync()` | *None* | `SyncCompletePayload` | Kích hoạt ngay 1 chu kỳ cào dữ liệu Codeforces API. |
| **Post-Mortem** | `save_post_mortem` | `savePostMortem(input)` | `{ input: PostMortemInput }` | `PostMortemRecord` | Lưu phân tích nguyên nhân lỗi vào SQLite + FTS5. |
| **Post-Mortem** | `get_post_mortem` | `getPostMortem(problemId)` | `{ problemId: string }` | `PostMortemRecord \| null` | Lấy chi tiết bài học kinh nghiệm của 1 problem. |
| **Post-Mortem** | `delete_post_mortem` | `deletePostMortem(problemId)` | `{ problemId: string }` | `boolean` | Xóa bản ghi post-mortem và trigger dọn sạch FTS5. |
| **Post-Mortem** | `search_post_mortems` | `searchPostMortems(query, limit)`| `{ query: string, limit: number }` | `PostMortemSearchResult[]` | Tìm kiếm toàn văn FTS5 theo tag, bài học, tên bài. |
| **Academic** | `get_academic_overview` | `getAcademicOverview()` | *None* | `AcademicOverviewDto[]` | Danh sách học kỳ kèm GPA10, GPA4, DRL tính động. |
| **Academic** | `get_semester_courses` | `getSemesterCourses(semesterId)` | `{ semesterId: string }` | `AcademicCourseRecord[]` | Danh sách môn học, điểm quá trình, GK, CK. |
| **Academic** | `upsert_academic_courses`| `upsertAcademicCourses(courses)` | `{ courses: UpsertCourseDto[] }` | `void` | Batch cập nhật điểm môn học và tính GPA tức thì. |
| **Academic** | `upsert_academic_semester`| `upsertAcademicSemester(semester)`| `{ semester: UpsertSemesterDto }` | `void` | Tạo mới hoặc cập nhật target GPA, target DRL học kỳ. |
| **Academic** | `sync_portal_uit_data` | `syncPortalUitData()` | *None* | `AcademicOverviewDto` | Khởi động Webview popup đăng nhập portal UIT. |
| **Academic** | `sync_uit_portal` | `syncUitPortal()` | *None* | `AcademicOverviewDto` | Luồng SSO bảo vệ Zero-Trust cho portal sinh viên. |
| **Academic** | `submit_portal_transcript`| `submitPortalTranscript(semesters)`| `{ semesters: RawPortalSemester[] }`| `AcademicOverviewDto` | Nhận bảng điểm trích xuất DOM từ Webview/script. |
| **Academic** | `get_academic_macro_metrics`| *(internal command)* | *None* | `AcademicMacroMetricSSOT[]` | Lấy danh sách macro metrics lưu trong DB. |
| **Academic** | `get_academic_macro_metrics_ssot` | `getAcademicMacroMetricsSsot()` | *None* | `AcademicMacroMetricSSOT[]` | Single Source of Truth cho Dashboard cards & Radar. |
| **Academic** | `ingest_full_academic_payload` | `ingestFullAcademicPayload(payload)`| `{ payload?: FullPortalIngestionRequest }` | `void` | Nạp trực tiếp payload bảng điểm + DRL vào SQLite. |
| **Academic** | `ingest_dynamic_academic_data` | `ingestDynamicAcademicData(payloadJson)`| `{ payloadJson: string }` | `void` | Parse và nạp JSON linh hoạt từ Userscript. |
| **Academic** | `purge_and_seed_canonical_academic_data` | `purgeAndSeedCanonicalAcademicData()` | *None* | `void` | Xóa dữ liệu cũ, nạp 100% dữ liệu chuẩn chính quy UIT. |
| **Academic** | `get_academic_curriculum`| *(CurriculumTab)* | *None* | `AcademicCurriculumRecord[]` | Danh mục môn học khung CTĐT 126-130 tín chỉ UIT. |
| **Academic** | `get_sync_token` | `getSyncToken()` | *None* | `string` | Đọc sync token dùng để cấu hình Userscript. |
| **Workspace** | `ingest_moodle_course_html` | *(Moodle sync)* | `{ courseCode, html }` | `IngestResult` | Bóc tách deadline bài tập từ mã HTML Moodle UIT. |
| **Workspace** | `get_upcoming_deadlines` | *(DeadlineList)* | *None* | `CourseDeadlineDto[]` | Danh sách deadline chưa nộp sắp đến hạn. |
| **Workspace** | `mark_deadline_submitted` | *(DeadlineList)* | `{ deadlineId: string }` | `void` | Đánh dấu bài tập đã nộp để tính XP hoàn thành. |
| **Workspace** | `upsert_workspace_config` | *(WorkspaceSettings)* | `{ config }` | `void` | Lưu đường dẫn thư mục code môn học cho VS Code. |
| **Workspace** | `get_workspace_config` | *(WorkspaceSettings)* | `{ courseCode }` | `WorkspaceConfigDto \| null` | Lấy cấu hình workspace cục bộ của môn học. |
| **Workspace** | `check_and_launch_vscode`| *(CourseCard)* | `{ courseCode }` | `boolean` | Mở trực tiếp Visual Studio Code vào thư mục bài tập. |
| **Life Matrix**| `recompute_today_xp` | *(Dashboard ticker)* | *None* | `void` | Tính lại tức thì First-AC XP & deadline XP hôm nay. |
| **Life Matrix**| `get_heatmap_matrix` | *(LifeMatrix)* | *None* | `LifeMatrixDto` | Lấy ma trận hoạt động tổng hợp của người dùng. |
| **Life Matrix**| `get_life_matrix_range` | `getLifeMatrixRange(start, end)` | `{ startDate, endDate }` | `LifeMatrixEntryDto[]` | Lấy chính xác 364 ngày liên tục qua SQLite CTE. |
| **Vault** | `scan_vault` | `scanVault(vaultPath)` | `{ vaultPath: string }` | `VaultStatsDto` | Quét thư mục Markdown, đồng bộ file mới/đổi. |
| **Vault** | `search_vault` | `searchVault(query)` | `{ query: string }` | `VaultSearchResultDto[]` | Tìm kiếm FTS5 BM25 trên ghi chú (tiêu đề, nội dung). |
| **Vault** | `get_vault_stats` | `getVaultStats()` | *None* | `VaultStatsDto` | Thống kê số notes, số outlinks, tổng dung lượng. |
| **Vault** | `create_structured_note`| `createStructuredNote(dto)` | `{ dto: CreateStructuredNoteDto }` | `string` | Tạo file note mới, chống trùng lặp tên file. |
| **Vault** | `open_onenote_link` | `openOnenoteLink(uri)` | `{ uri: string }` | `void` | Mở liên kết Microsoft OneNote an toàn tuyệt đối. |

### 4.2 Network Boundary & External Interfaces
1. **Loopback Browser Bridge (`127.0.0.1:41718`):**
   - **Protocol:** HTTP/1.1 over TCP loopback.
   - **Inbound Paths:**
     - `POST /sync/academic`: Tiếp nhận payload bảng điểm và DRL từ Tampermonkey userscript trên UIT student portal.
     - `OPTIONS *`: Xử lý CORS preflight tự động.
   - **Authentication:** Kiểm tra bắt buộc header `X-Jarvis-Sync-Token`. Reject ngay bằng mã lỗi `401 Unauthorized` nếu token sai hoặc thiếu.
2. **Codeforces Public API (`api.codeforces.com`):**
   - **Protocol:** HTTPS GET qua `reqwest::Client` (Timeout 15 giây, User-Agent chuyên dụng).
   - **Endpoint:** `GET https://codeforces.com/api/user.status?handle={handle}&from=1&count=50`.
   - **Rate Limiting & Safety:** Giãn cách 60s giữa các lần sync, tự động kích hoạt exponential backoff khi gặp mã lỗi 429 / 503 hoặc network drop.

---

## 5. EXTERNAL AI REVIEW INSTRUCTIONS

> **Hướng dẫn dành riêng cho Mô hình AI Đánh giá Độc lập (External AI System Auditor):**  
> Khi tiếp nhận toàn bộ tài liệu hồ sơ kiến trúc này, bạn hãy tiến hành phân tích đa chiều mã nguồn và thiết kế hệ thống của **JARVIS Personal OS (v1.0.0)**, sau đó trả lời 3 câu hỏi đánh giá cốt lõi sau:

### Câu hỏi 1: Memory & Resource Safety Assessment
- *Đánh giá cấu hình SQLite PRAGMA (`cache_size = -8000`, `mmap_size = 0`, `WAL mode`) kết hợp với mô hình xử lý thread Tokio:* 
- Liệu hệ thống có đảm bảo duy trì ngưỡng **Idle RAM < 80MB** trên Windows 11 trong điều kiện vận hành nền liên tục 7 ngày hay không? 
- Có nguy cơ tiềm ẩn nào về rò rỉ bộ nhớ (memory leaks), bế tắc khóa kết nối (`rusqlite::Connection` deadlocks khi có đồng thời cả UI query, sync worker ghi và loopback server accept), hoặc zombie thread khi ứng dụng bị shutdown đột ngột hay không?

### Câu hỏi 2: Architecture Rigor & Security Boundary Audit
- *Đánh giá tính an toàn tại các ranh giới mạng và IPC:*
- Cơ chế xác thực qua `X-Jarvis-Sync-Token` trên loopback port 41718 có lỗ hổng CSRF / SSRF cục bộ nào không khi một trang web độc hại chạy trên trình duyệt của người dùng cố gắng gửi request vào `127.0.0.1`?
- Bộ lọc `validate_onenote_uri` và cơ chế sinh slug Windows (`slugify_title` chặn ký tự cấm và tên thiết bị hệ thống) đã hoàn toàn miễn nhiễm trước các vector tấn công Command Injection / Path Traversal hay chưa?
- Việc triệt tiêu hoàn toàn `unwrap()` trong production path của Rust đã đạt chuẩn Zero-Crash của một hệ điều hành cá nhân hay chưa?

### Câu hỏi 3: Data Integrity, Concurrency & Extensibility
- *Đánh giá tính nhất quán của dữ liệu (Data Integrity) và tiềm năng mở rộng:*
- Quy trình phân loại First-AC qua SQL CTE và cơ chế bảo vệ DRL không bị ghi đè (`DRL Retention Invariant`) có chịu được tình huống xung đột race condition nếu nhiều payload đồng bộ gửi tới cùng lúc không?
- Đánh giá kiến trúc bảng ảo FTS5 (sử dụng *external content* cho Post-Mortem và *contentless multi-column* cho Vault) về mặt hiệu năng đánh chỉ mục và dung lượng đĩa khi quy mô ghi chú tăng lên 10.000 file Markdown.
- Những điểm nghẽn kiến trúc nào cần được tái cấu trúc trước khi nâng cấp hệ thống lên phiên bản đa người dùng (Multi-Profile Desktop OS)?
