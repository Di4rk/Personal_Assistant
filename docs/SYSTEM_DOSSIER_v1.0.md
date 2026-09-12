# [SYSTEM ARCHITECTURE DOSSIER] DIARK // OS (v1.0.0 PRODUCTION BASELINE)

> **Document Type:** Production Architecture Dossier & System Ledger  
> **System Name:** DIARK // OS (formerly JARVIS Personal OS)  
> **Release Version:** `v1.0.0` (Production Baseline Tagged)  
> **Git Commit Hash:** `ab6fb3620c38626d7dcebe4e8704c8ea36f695e2`  
> **Git Branch:** `main` (Working Tree: Clean)  
> **Verification Status:** 101/101 Tests Passed (99 Unit + 2 Integration, 100%), Production Vite Bundle: 303.43 kB JS (gzip: 88.40 kB), 69.50 kB CSS (gzip: 11.39 kB).  
> **Target Machine Profile:** Acer Nitro 5 Tiger (Windows 11 x64, 16GB RAM).

---

## 1. PROJECT DNA & SYSTEM TENETS

### 1.1 Target Persona & Core User Profiles
- **Primary User:** Sinh viên năm 2 ngành Khoa học Máy tính / Công nghệ Thông tin tại Trường Đại học Công nghệ Thông tin (UIT - ĐHQG-HCM).
- **Secondary Roles:**
  - **Competitive Programmer (ICPC):** Luyện thuật toán chuyên sâu trên Codeforces / VNOJ, cày điểm First-AC, lưu trữ phân tích nguyên nhân lỗi sau giải đấu (Post-Mortem taxonomy).
  - **Academic Achiever:** Theo dõi tiến độ tích lũy 10 học kỳ, tính GPA/CPA hệ 10 và hệ 4 theo chuẩn ĐHQG-HCM, tự động hóa trích xuất điểm rèn luyện (DRL) và bảng điểm chính quy từ cổng sinh viên UIT, mô phỏng mục tiêu tốt nghiệp.
  - **Tutor / Designer:** Soạn thảo tài liệu giảng dạy, bài giảng thuật toán (Teaching Sheets), quản lý liên kết ghi chú ngoài với Microsoft OneNote.

### 1.2 Hardware Budget & Runtime Constraints
- **Memory Budget:** Idle RAM nghiêm ngặt **< 80MB** (Rust daemon chiếm ~15-25MB RSS, WebView2 shell ~60-70MB).
- **CPU Thrift:** Zero background CPU thrashing — không dùng vòng lặp `thread::sleep` vô tận, không dùng file watcher polling nặng (`notify` polling bị cấm); thay vào đó sử dụng kiến trúc event-driven (`tokio::sync::watch`, `tokio::select!`, `TcpListener::accept`).
- **Disk I/O Protection:** Bật SQLite Write-Ahead Logging (WAL) với `PRAGMA synchronous = NORMAL` và `PRAGMA cache_size = -8000` (giới hạn ~8MB page cache). Khóa `mmap_size = 0` trên Windows để chống phình ảo Virtual Address Space.

### 1.3 Core Architectural Tenets
- **Zero-Effort Automation:** Bất đối xứng I/O, máy tự bắt gói tin ngầm từ portal UIT qua loopback TCP (port 41718), người dùng chỉ việc nộp bài hoặc tra cứu mà không cần thao tác thủ công.
- **Single Source of Truth (SSOT):** Versioning và cấu hình chuẩn hóa qua hằng số `APP_VERSION = 'v1.0.0'` và `src/constants/app.ts`, triệt tiêu hoàn toàn các chuỗi hardcode phân mảnh (`v0.3.3`, `JARVIS`).
- **Local-First Hardware Identity:** Không dùng tài khoản/mật khẩu hay xác thực đám mây; định danh gắn liền với SQLite cục bộ (`user_nickname`, `user_major`) và quyền truy cập profile hệ điều hành.

---

## 2. FUNCTIONAL SUBSYSTEMS & RUNTIME MATRIX

```
+-------------------------------------------------------------------------------------------------------+
|                                             DIARK // OS                                               |
+-------------------------------------------------------------------------------------------------------+
|  [Global Daemon & HUD]            [Browser Bridge Server]                [CF Sync Worker]             |
|   - System Tray (TrayIcon)         - Loopback TCP (127.0.0.1:41718)       - Ephemeral Poller (60s)    |
|   - Global Shortcut (Alt+K)        - Zero-dependency HTTP Parse           - Exponential Backoff       |
|   - Raycast-style Palette          - Bearer Token Auth                    - AtomicBool SyncLock       |
|   - Idle WAL Passive (15m)         - Atomic DRL Retention                 - Safe CF Purge Routine     |
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
|   - UTC+07:00 Normalization         - Atomic DRL COALESCE Retention        - FTS5 BM25 (title, prose) |
|   - Tiered XP State Calculation     - Composite Reward & Simulator         - OneNote Guard & Dialog   |
+-------------------------------------------------------------------------------------------------------+
```

### 2.1 Identity Subsystem & Genesis Lifecycle
- **Window Lifecycle Guarantee (Zero-Flash):**
  - Cấu hình `"visible": false` và `"title": "// OS"` trong `tauri.conf.json`.
  - Trong `setup()` hook của Rust, tiến trình đọc SQLite blocking từ bảng `settings`: lấy `user_nickname` (fallback `"Diark"`), đồng bộ native window title dạng `"{nickname} // OS"`, sau đó mới kích hoạt `window.show()`. Cơ chế này loại bỏ 100% hiện tượng chớp title bar hoặc nháy giao diện khi ứng dụng khởi động.
- **Genesis Modal Flow:**
  - Khi khởi chạy lần đầu (`system_initialized` chưa tồn tại trong `settings`), React root chuyển sang trạng thái `needs-onboarding`, hiển thị `GenesisModal` Cyberpunk tối giản (`bg-slate-950/95`, border `cyan-500/30`, shadow cyan glow).
  - Cho phép người dùng thiết lập biệt danh (mặc định: `Diark`) và ngành học (mặc định: `CS`).
  - Form hỗ trợ phím `Enter` tự động submit, zero-cloud, ghi nhận nguyên tử vào SQLite transaction.
- **Runtime Identity Mutation:**
  - Hỗ trợ đổi biệt danh trực tiếp từ panel Settings (`CfSettingsPanel.tsx`), lập tức gọi `save_user_profile` cập nhật header ứng dụng và native window title bar mà không cần reload trang.

### 2.2 Competitive Programming Engine & Life Matrix
- **First-AC CTE Deduplication:**
  - Để ngăn chặn gian lận XP khi nộp nhiều lần cho cùng một bài tập, hệ thống sử dụng truy vấn SQL CTE đánh giá `MIN(submission_time)` cho mỗi cặp `(contest_id, problem_index)` đạt verdict `OK` / `ACCEPTED`. Chỉ submission đầu tiên mới nhận `is_first_ac = 1` (+15 XP).
- **Chuẩn hóa UTC+7 (ICT):**
  - Mọi timestamp Unix Epoch từ Codeforces API đều được quy đổi về ngày làm việc hành chính Việt Nam: `date(datetime(ts, 'unixepoch', '+7 hours'))`.
- **Safe Purge Execution:**
  - Command `purge_cf_data` xóa sạch các bảng `submissions`, `post_mortems`, `daily_activity`, và khóa `cf_handle` trong `settings`.
  - Cập nhật `ac_count = 0` trên `life_matrix_daily` và recompute theo từng ngày bị ảnh hưởng; **bảo toàn 100% `deadlines_cleared`** từ Moodle của người dùng.
- **UI & Titles:**
  - Bảng màu Cyberpunk / Monokai (`slate-900`, `cyan-400`, `emerald-400`), hệ thống danh hiệu IT UIT theo cấp độ (Level 1: *Script Kiddie*, Level 5: *Code Monkey*, Level 10: *Bug Hunter*, Level 20: *Senior Specialist*, Level 36+: *Grandmaster Architect*).

### 2.3 Academic Automation & Grading Engine
- **Loopback Sync Server (Port 41718):**
  - HTTP loopback server siêu nhẹ dùng `httparse`, bind trên `127.0.0.1`, xác thực qua header `X-Jarvis-Sync-Token`. Tự động tiếp nhận transcript & DRL từ Tampermonkey userscript chạy trên cổng thông tin sinh viên UIT.
- **Atomic DRL Retention:**
  - Câu lệnh SQL UPSERT trong `portal_ingestion.rs` và `db/academic.rs` sử dụng kỹ thuật:
    ```sql
    ON CONFLICT(semester_id) DO UPDATE SET
        ...
        drl_score = COALESCE(excluded.drl_score, academic_macro_metrics.drl_score),
        drl = COALESCE(excluded.drl, academic_macro_metrics.drl),
        updated_at = excluded.updated_at;
    ```
  - Đảm bảo khi đồng bộ bảng điểm học kỳ mà payload không mang DRL (`drl: null`), điểm rèn luyện đã có trong hệ thống tuyệt đối không bị mất hay reset.
- **Composite Reward Classification:**
  - Phân tách rạch ròi giữa Xếp loại Học lực theo GPA và Xếp loại Thi đua/Khen thưởng ĐHQG-HCM tính toán dạng compute-on-read: `calculateCompositeRewardRank(gpa10, drl)`. Nếu DRL < 50 hoặc bị cảnh cáo, hạ bậc thi đua tương ứng theo quy chế chính thức.
- **Graduation Simulator:**
  - Chuẩn hóa CTĐT UIT 126 tín chỉ, dynamic pills gợi ý số kỳ còn lại (3.5 năm - 5 kỳ, 4 năm - 6 kỳ, 4.5 năm - 7 kỳ), hỗ trợ nhập trực tiếp số tín chỉ dự kiến/kỳ để tính toán GPA mục tiêu cần đạt.

### 2.4 Native Knowledge Vault
- **Incremental Scanner:**
  - Quét thư mục Markdown cục bộ, so khớp `file_mtime` với dữ liệu lưu trữ trong `vault_notes`, chỉ phân tích và re-index những tệp có thay đổi nội dung.
- **Multi-Column FTS5:**
  - Bảng ảo `vault_fts` tách biệt 3 cột `(title, prose, code)`, áp dụng trọng số BM25 `(10.0, 5.0, 1.0)`, bộ tokenizer `unicode61 remove_diacritics 2` hỗ trợ tìm kiếm tiếng Việt không dấu.
- **Directory Picker & URI Sanitization:**
  - Tích hợp `tauri-plugin-dialog = "2"` cho phép chọn thư mục vault qua native folder dialog (chỉ cấp quyền `dialog:allow-open` cho window `main`).
  - Bộ lọc `validate_onenote_uri` chặn đứng ký tự nháy kép `"` và các chuỗi URL-encoded nguy hiểm (`%22`, `%27`), chống tấn công Command/Shell Injection.
  - Cơ chế *auto-disambiguation* chống ghi đè file (`slug-2.md`).

### 2.5 OS Daemon & Global HUD
- **System Tray Daemon:**
  - Khi người dùng nhấn nút đóng cửa sổ 'X', sự kiện `CloseRequested` bị chặn lại (`api.prevent_close()`), cửa sổ chính tự động ẩn vào khay hệ thống (System Tray).
  - Khi thoát ứng dụng từ Tray (`quit`), hàm `graceful_shutdown` kích hoạt kênh `watch::Sender<bool>`, chờ 500ms hoàn tất transaction dở dang và thực thi `PRAGMA wal_checkpoint(TRUNCATE)` trước khi gọi `app.exit(0)`.
- **Global Shortcut `Alt+K`:**
  - Kích hoạt Command Palette Raycast-style; cơ chế `set_always_on_top(true)` tạm thời bảo đảm kéo focus Win32 lập tức qua `requestAnimationFrame`. Phím `Escape` gọi command `hide_hud` thu nhỏ xuống tray.
- **Idle WAL Passive Checkpoint:**
  - Background task định kỳ mỗi 15 phút (900 giây) gọi `PRAGMA wal_checkpoint(PASSIVE);`, chống phình file `-wal` trong điều kiện máy chạy nền liên tục 7 ngày.

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

## 4. IPC COMMAND REGISTRY

Bảng ánh xạ 2 chiều đầy đủ giữa các command Rust (`src-tauri/src/commands/`) và TypeScript API wrapper (`src/lib/tauri-client.ts`):

| Module | Tauri Command (`invoke`) | Frontend Function (`tauri-client.ts`) | Input Parameters | Return Type | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Identity** | `get_user_profile` | `getUserProfile()` | *None* | `UserProfileDto` | Đọc `user_nickname`, `user_major`, `is_initialized` từ DB. |
| **Identity** | `save_user_profile` | `saveUserProfile(nickname, major)` | `{ nickname: string, major: string }` | `void` | Lưu profile vào SQLite transaction, cập nhật native window title. |
| **Core CP** | `get_today_stats` | `fetchTodayStats()` | *None* | `DailyStats` | Thống kê số bài AC, WA, XP tích lũy trong ngày. |
| **Core CP** | `get_recent_submissions` | `fetchRecentSubmissions(limit)` | `{ limit: number }` | `SubmissionRecord[]` | Danh sách bài nộp Codeforces gần đây. |
| **Core CP** | `get_level_info` | `fetchLevelInfo()` | *None* | `LevelInfo \| null` | Cấp độ hiện tại, XP tiến độ đến level tiếp theo. |
| **Core CP** | `get_yearly_heatmap` | `fetchYearlyHeatmap(year)` | `{ year: number }` | `HeatmapDay[]` | Mảng hoạt động 365 ngày theo năm dương lịch. |
| **Core CP** | `get_cf_handle` | `getCfHandle()` | *None* | `string \| null` | Đọc Codeforces handle đã lưu từ `settings`. |
| **Core CP** | `set_cf_handle` | `setCfHandle(handle)` | `{ handle: string }` | `void` | Ghi Codeforces handle mới vào `settings`. |
| **Core CP** | `trigger_cf_sync` | `triggerCfSync()` | *None* | `SyncCompletePayload` | Kích hoạt ngay 1 chu kỳ cào dữ liệu Codeforces API. |
| **Core CP** | `purge_cf_data` | `purgeCfData()` | *None* | `void` | Xóa dữ liệu CF an toàn, bảo toàn 100% deadline Moodle. |
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
| **Vault** | `set_vault_path` | `setVaultPath(path)` | `{ path: string }` | `void` | Lưu thư mục vault markdown vào settings DB. |
| **Vault** | `get_vault_path` | `getVaultPath()` | *None* | `string \| null` | Lấy đường dẫn thư mục vault hiện tại. |
| **HUD / OS** | `hide_hud` | `hideHud()` | *None* | `void` | Ẩn HUD xuống System Tray. |

---

## 5. EXTERNAL AI AUDIT QUESTIONS (CHO SPRINT TIẾP THEO)

> **Dành cho Mô hình AI Đánh giá Độc lập (External AI System Auditor):**  
> Khi tiếp nhận bản hồ sơ kiến trúc cập nhật của **DIARK // OS (v1.0.0)**, hãy tập trung phân tích 2 bài toán then chốt sau:

### Câu hỏi 1: Dev/Prod Runtime Isolation
- *Làm thế nào để phân tách triệt để giữa môi trường `tauri dev` (cần dev dock, test reset identity, debug logs) và `tauri build` (release sạch, khóa các lệnh reset nguy hiểm) bằng `#[cfg(debug_assertions)]` và `import.meta.env.DEV` mà không làm phân mảnh kiến trúc codebase?*
- Đánh giá khả năng rò rỉ các chức năng privileged testing ra môi trường binary phát hành (release bundle) và đề xuất pattern đóng gói compile-time gating an toàn nhất cho Tauri v2.

### Câu hỏi 2: Identity State Reset Invariants
- *Khi thực thi `reset_identity_state`, cần cơ chế đồng bộ nào giữa SQLite transaction và React state tree để đảm bảo không xảy ra race condition với các worker đang chạy nền (CF poller, sync server) và title bar native lập tức quay về `// OS`?*
- Phân tích rủi ro bế tắc (deadlock) hoặc trôi dạt trạng thái (state drift) nếu reset xảy ra đúng lúc background worker đang giữ write-lock trên file SQLite WAL.
