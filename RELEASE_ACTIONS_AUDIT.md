# BÁO CÁO RÀ SOÁT CI/CD GITHUB ACTIONS (DEVOPS AUDIT)

## 1. Kiểm tra hiện trạng
- **Thư mục workflow**: Đã tồn tại file `.github/workflows/release.yml`.
- **Hệ điều hành runner**: `runs-on: windows-latest` (đáp ứng đúng yêu cầu build ứng dụng Tauri cho Windows).
- **Trigger**: 
  - `push.tags: ['v*']` (kích hoạt khi push tag dạng `v1.0.0`, `v1.0.1`,...).
  - `workflow_dispatch` (cho phép kích hoạt thủ công từ GitHub UI).
- **Permissions**: Đã cấp `permissions: contents: write` đúng chuẩn.

---

## 2. Các nguyên nhân chính khiến GitHub Actions không tạo được GitHub Release

### 2.1. Thiếu tham số `githubToken` trong `with:` của `tauri-action`
- **Chi tiết**: Trong file `release.yml` ban đầu, `GITHUB_TOKEN` chỉ được truyền qua block `env:`, nhưng hành động `tauri-apps/tauri-action@v0` yêu cầu bắt buộc phải truyền trực tiếp qua tham số `with: githubToken: ${{ secrets.GITHUB_TOKEN }}` để xác thực quyền tạo release và upload asset lên GitHub.
- **Giải pháp đã thực hiện**: Đã patch lại file `.github/workflows/release.yml` để bổ sung `githubToken: ${{ secrets.GITHUB_TOKEN }}` vào phần `with:`.

### 2.2. Vấn đề Tag Push trước khi Workflow tồn tại
- **Chi tiết**: Các tag hiện tại trên repository (`v1.0.0` đến `v1.0.7`) đã được push *trước* khi file workflow `release.yml` được đưa lên nhánh chính (default branch). GitHub Actions **không** tự động chạy lại workflow cho các tag cũ đã tồn tại trước đó.
- **Giải pháp**: Cần trigger thủ công qua `workflow_dispatch` trên GitHub Actions hoặc push một tag mới (ví dụ `v1.0.8`).

### 2.3. Cấu hình Permissions ở Repository Level
- **Chi tiết**: Ngoài `permissions: contents: write` trong file YAML, thiết lập bảo mật của Repository trên GitHub cần cho phép GitHub Actions ghi.
- **Giải pháp**: Vào **Settings** > **Actions** > **General** > **Workflow permissions** và chọn **"Read and write permissions"**.

### 2.4. Dependencies & Môi trường Runner Windows
- **Chi tiết**: Runner dùng `windows-latest` kết hợp `dtolnay/rust-toolchain@stable` (target `x86_64-pc-windows-msvc`), Node.js 20, pnpm 11, và cài đặt dependencies thành công (`pnpm install --no-frozen-lockfile`). Không thiếu dependencies cơ bản cho Tauri v2 hay FastEmbed trên Windows (MSVC build tools đã có sẵn trên `windows-latest`).

---

## 3. Các bước hành động để kích hoạt Release trên GitHub

1. **Commit và Push thay đổi workflow lên nhánh chính**:
   ```bash
   git add .github/workflows/release.yml
   git commit -m "fix(ci): add githubToken to tauri-action parameters"
   git push origin fix-release-audit
   ```
   *(Sau đó merge PR vào nhánh chính `main` hoặc `master`).*

2. **Kiểm tra thiết lập Repository trên GitHub**:
   - Truy cập GitHub repository -> **Settings** -> **Actions** -> **General**.
   - Mục **Workflow permissions** -> Chọn **Read and write permissions** -> Nhấn **Save**.

3. **Chạy Release Workflow**:
   - **Cách 1 (Thủ công)**: Vào tab **Actions** -> chọn **Release DIARK OS** -> nhấn **Run workflow**.
   - **Cách 2 (Push tag mới)**:
     ```bash
     git tag v1.0.8
     git push origin v1.0.8
     ```
