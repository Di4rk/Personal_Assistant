# DIARK // OS (JARVIS PERSONAL OS) — MASTER ARCHITECTURAL DOSSIER (v1.0.0 BASELINE)

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

-- Hồ sơ sinh viên trích xuất từ Portal SSO
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

-- Môn học tích lũy
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

-- Điểm rèn luyện theo học kỳ
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

### A. In-App Headless SSO Engine (`portal_auth.rs`)
- **Webview Window:** `uit-sso-login` và `wecode-sso-login`.
- **Pre-injection Script:** Bơm `UNIVERSAL_GUARDIAN_SCRIPT` trước khi render HTML.
- **Proxy Interception:**
  - Can thiệp `window.fetch` để bắt trực tiếp payload `/api/sinh-vien/*`.
  - Fallback: `MutationObserver` chờ đúng landmark `Mã sinh viên` (timeout 8s).
- **Watchdog Engine:**
  - `WatchdogRegistry` quản lý `CancellationToken` cho từng window label.
  - Tự động hủy task sleep ngay lập tức khi nhận callback thành công hoặc thất bại sớm.
  - Quá 120s không hoàn tất $\rightarrow$ cưỡng chế gọi `window.destroy()`.

### B. Dynamic Curriculum Resolution (`curriculum_resolver.rs`)
Phân giải theo thứ tự ưu tiên 4 tầng:
1. **D-code Trực Tiếp:** Regex tĩnh `D\d{6}` $\rightarrow$ truy vấn `academic_curriculums`.
2. **Track-Specific Alias:** Token kết hợp `ACRONYM-TRACK` (ví dụ `KHMT-CLC` $\rightarrow$ 130 TC).
3. **Acronym Trần:** Token viết tắt ngành (ví dụ `KHMT` $\rightarrow$ 126 TC của CQUI).
4. **Hard Fallback:** Trả về `130 TC` generic với cờ `matched_via = "hard_fallback"`.

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
| `save_student_profile` | `academic.rs` | Ghi đè hồ sơ sinh viên vào SQLite. |
| `ingest_full_academic_payload` | `academic.rs` | Lưu trữ bảng điểm và DRL nguyên tử (Atomic Transaction). |
| `get_academic_radar_metrics` | `academic.rs` | Tính toán cGPA hệ 10, cGPA hệ 4, DRL và tín chỉ theo ngành động. |
| `get_wecode_submissions` | `wecode.rs` | Truy vấn lịch sử nộp bài Wecode kèm phân trang và lọc theo bài tập. |
| `fetch_remote_registry` | `plugins.rs` | Lấy danh mục Community Plugins từ remote registry. |
| `install_remote_plugin` | `plugins.rs` | Tải zip, verify SHA-256, giải nén cách ly và ghi danh vào SQLite. |
| `toggle_plugin` | `plugins.rs` | Bật/tắt trạng thái phân hệ, kích hoạt recalculate Life Matrix. |
| `get_system_storage_stats` | `settings.rs` | Trả về dung lượng DB, file WAL và tổng số bản ghi. |
| `save_setting` | `settings.rs` | Lưu cặp Key-Value vào bảng `settings`. |
