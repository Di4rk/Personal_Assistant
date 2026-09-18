# PORTAL UIT DOM CONTRACT (EMPIRICAL SPECIFICATION)
**Domain:** `https://portal.uit.edu.vn`
**Architecture:** Next.js 14 App Router + Radix UI Tabs + Tailwind CSS
**Security Policy:** Read-Only DOM Traversal. Zero document.cookie access.

---

## 1. ROUTE: `/sinh-vien/ho-so`

### A. Định danh
- **Full Name:** `document.querySelector('h2').innerText.trim()`

### B. Tab Học vụ
- **Trigger:** `Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.innerText.trim() === 'Học vụ')`
- **Container:** `document.querySelector('div[role="tabpanel"]')` chứa chuỗi `"Thông tin học vụ"`.
- **Trích xuất Cặp Label - Value:**
  Duyệt text nodes / lines trong tabpanel. Giá trị của trường là dòng kế tiếp ngay sau nhãn:
  - `MÃ SINH VIÊN` -> `student_id` (Regex: `^\d{8}$`)
  - `KHOA` -> `faculty`
  - `CHUYÊN NGÀNH` -> `specialization`
  - `CTĐT CỤ THỂ` -> `curriculum_code` (e.g. `KHMT-CQUI-D480101 K20`)
  - `LỚP SINH HOẠT` -> `student_class`

---

## 2. ROUTE: `/sinh-vien/diem-ren-luyen`

### A. Bảng Điểm Rèn Luyện
- **Selector:** `document.querySelectorAll('table tbody tr')`
- **Cột Trích xuất:**
  - `td[1]` (Học kỳ): Text dạng `Học kỳ 2  Năm học 2025-2026` -> Normalize: `HK2_2025_2026`
  - `td[3]` (Điểm): Parse integer -> `score` (e.g. `100`, `95`)
  - `td[4]` (Xếp loại): String -> `grade_text` (e.g. `Xuất sắc`)

---

## 3. ROUTE: `/sinh-vien/bang-diem`

### A. Danh mục Tab Triggers
- `const tabs = document.querySelectorAll('button[role="tab"]');`
- `tabs[0]`: 'Tổng kết theo kỳ'
- `tabs[1]`: 'Chi tiết môn học'
- `tabs[2]`: 'Theo CTĐT'

### B. Slot 0: Tổng kết theo kỳ (`tabs[0]`)
- **Selector:** `document.querySelectorAll('div[role="tabpanel"] table tbody tr')`
- **Cột Trích xuất:**
  - `td[0]`: `semester` (e.g. `HK1 · 2025`)
  - `td[1]`: `gpa_semester` (float)
  - `td[2]`: `cpa_cumulative` (float)
  - `td[3]`: `ranking` (string)
  - `td[5]`: `credits_semester` (int)
  - `td[6]`: `credits_cumulative` (int)

### C. Slot 1: Chi tiết môn học (`tabs[1]`)
- **Hero Metrics:** Text chứa `TC tích lũy <TC> GPA toàn khóa <GPA>` -> Lấy tổng tín chỉ & GPA tích lũy.
- **Danh sách Bảng:** `document.querySelectorAll('div[role="tabpanel"] table')`
  Mỗi bảng tương ứng 1 học kỳ. Học kỳ lấy từ thẻ heading/label liền trước bảng.
- **Cột Môn học (`table tbody tr`):**
  - `td[0]`: `course_code` (e.g. `IT002`)
  - `td[1]`: `course_name` (e.g. `Lập trình hướng đối tượng`)
  - `td[2]`: `credits` (int)
  - `td[3]`: `score_qt` (float hoặc null nếu `—`)
  - `td[4]`: `score_th` (float hoặc null nếu `—`)
  - `td[5]`: `score_gk` (float hoặc null nếu `—`)
  - `td[6]`: `score_ck` (float hoặc null nếu `—`)
  - `td[7]`: `score_10` (float, dấu phẩy thay bằng dấu chấm)
  - `is_passed`: `score_10 >= 5.0 ? 1 : 0`
