# WECODE UIT DOM CONTRACT (EMPIRICAL SPECIFICATION)
**Domain:** `https://khmt.uit.edu.vn/wecode25/it00x` (Dynamic prefix support: `/[wecode_cohort]/[class_code]`)
**Architecture:** Multi-Page Web App (DataTables + Bootstrap + FontAwesome / Bootstrap Icons)
**Security Policy:** Read-Only DOM Traversal. Zero document.cookie access.

---

## 1. AUTH GATEKEEPER & USER IDENTITY

### A. Gatekeeper Indicator
- **Selector:** `#profile_link, a[href*="/users/"]`
- Chờ phần tử này xuất hiện trên DOM trước khi kích hoạt bất kỳ tiến trình cào nào.
- Nếu người dùng đang ở màn hình đăng nhập (`/login`), script ở trạng thái chờ (polling định kỳ mỗi 500ms).

### B. User ID Extraction
- **Href Pattern:** `href="/users/{wecode_user_id}"` hoặc `href="/wecode25/it00x/users/{wecode_user_id}"`
- **Regex:** `/\/users\/(\d+)/`
- **Trích xuất:** Lấy ID dạng số (ví dụ: `2429`).
- **Lưu ý đặc biệt:** TUYỆT ĐỐI KHÔNG dùng text hiển thị của thẻ (MSSV của sinh viên) vì Wecode lọc submissions theo ID số nội bộ.

### C. Base Prefix Extraction
- Lấy đường dẫn gốc của môn học (ví dụ: `/wecode25/it00x`) từ đường dẫn của `#profile_link` hoặc `window.location.pathname`.

---

## 2. ROUTE: `/assignments` (DANH MỤC BÀI TẬP)

### A. Container & Table
- **Selector:** `#DataTables_Table_0 tbody tr, table tbody tr`
- Loại bỏ các dòng rỗng (`dataTables_empty` hoặc `td.length <= 1`).

### B. Trích xuất Mã bài tập (`assignment_id`)
- Lấy từ thuộc tính `data-id` của thẻ `<tr>`.
- Hoặc từ liên kết chứa `/assignment/`: `a[href*="/assignment/"]` (Regex: `/\/assignments?\/(\d+)/`).
- Hoặc từ cột đầu tiên (`td:nth-child(1)`).
- Chuyển đổi thành integer và lưu vào mảng `assignment_ids` (loại trừ trùng lặp).

---

## 3. ROUTE: `/submissions` (BẢNG NỘP BÀI TỪNG BÀI TẬP)

### A. Cấu trúc URL Điều hướng
- Với mỗi `assignment_id` trong danh sách, điều hướng tuần tự đến:
  `${basePrefix}/submissions/assignment/${assignment_id}/user/${wecode_user_id}/problem/all/view/all`

### B. Bảng Kết quả Nộp bài
- **Selector:** `table tbody tr[data-id], #DataTables_Table_0 tbody tr, table tbody tr`
- Bỏ qua các dòng rỗng (`.dataTables_empty`).

### C. Cột Dữ liệu Trích xuất (`WecodeSubmissionDto`)
1. **`submission_id`** (int): `tr.getAttribute('data-id')` hoặc `td[0].innerText.trim()`.
2. **`assignment_id`** (int): `tr.getAttribute('data-a')` hoặc `assignment_id` hiện tại.
3. **`problem_id`** (int): `tr.getAttribute('data-p')` hoặc `0`.
4. **`problem_name`** (string): `td:nth-child(3) a` hoặc `a[href*="/problem/"]`.
5. **`submit_time_str`** (string): `td:nth-child(4)` (ví dụ: `"Fri, 17 Jul 2026 01:50:46"`).
6. **`verdict`** (string): `td.js-verdict` hoặc `span[class*="verdict"]` hoặc `td[4]`.
7. **`score`** (int): `td.js-score span` hoặc `td.js-score`.
8. **`execution_time`** (float): `td.js-time` (tính bằng giây).
9. **`memory_kib`** (int): `td.js-mem` (tính bằng KiB).
10. **`language`** (string): `td div[data-type="code"]` hoặc `td:nth-child(9)` (mặc định: `"C++"`).
11. **`is_final`** (bool): `tr.querySelector('.set_final')?.classList.contains('bi-check-circle') || tr.querySelector('.bi-check-circle') !== null`.

---

## 4. GIAO THỨC TRUYỀN DỮ LIỆU TOP-LEVEL (NO IFRAMES)

- Dữ liệu submissions sau khi duyệt hết các bài tập được phân mảnh (batch size = 20):
  `window.location.href = "diark-sso://partial#target=wecode_submissions&batch_idx=${i}&total_batches=${totalBatches}&data=${encodeURIComponent(JSON.stringify(chunk))}"`
- Tín hiệu kết thúc và commit:
  `window.location.href = "diark-sso://callback#target=wecode&action=commit&total_items=${submissions.length}"`
