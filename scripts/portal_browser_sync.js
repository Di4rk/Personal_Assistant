/**
 * DIARK // OS — PORTAL UIT 1-CLICK DIRECT API SYNC SCRIPT
 * 
 * HƯỚNG DẪN SỬ DỤNG:
 * 1. Mở trình duyệt Chrome/Edge bất kỳ nơi bạn đã đăng nhập Portal UIT: https://portal.uit.edu.vn
 * 2. Nhấn F12 (hoặc Ctrl + Shift + I) -> Chọn tab "Console".
 * 3. Dán toàn bộ script này vào Console rồi nhấn Enter.
 * 4. Dữ liệu bảng điểm & điểm rèn luyện sẽ được lấy từ API và tự động gửi về Diark OS (port 3030)!
 */

(async () => {
    console.clear();
    console.log("%c[Diark OS] 🚀 Bắt đầu đồng bộ dữ liệu Portal UIT...", "color: #38bdf8; font-weight: bold; font-size: 14px;");

    const LOCAL_SERVER_URL = "http://127.0.0.1:3030/api/v1/sync/portal";

    function showBanner(message, isSuccess = true) {
        let banner = document.getElementById("__diark_sync_banner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "__diark_sync_banner";
            banner.style.position = "fixed";
            banner.style.top = "20px";
            banner.style.right = "20px";
            banner.style.zIndex = "999999";
            banner.style.padding = "14px 20px";
            banner.style.borderRadius = "10px";
            banner.style.fontFamily = "system-ui, -apple-system, sans-serif";
            banner.style.fontSize = "13px";
            banner.style.boxShadow = "0 10px 25px rgba(0,0,0,0.4)";
            banner.style.transition = "all 0.3s ease";
            document.body.appendChild(banner);
        }
        banner.style.backgroundColor = isSuccess ? "#0f172a" : "#450a0a";
        banner.style.color = isSuccess ? "#38bdf8" : "#f87171";
        banner.style.border = isSuccess ? "1px solid #0284c7" : "1px solid #dc2626";
        banner.innerHTML = message;
    }

    try {
        showBanner("⏳ Đang tải Bảng điểm & Điểm rèn luyện từ API UIT...", true);
        console.log("[Diark OS] Đang gọi API Bảng điểm & Điểm rèn luyện...");

        const [bdResp, drlResp] = await Promise.all([
            fetch("https://portal.uit.edu.vn/api/sinh-vien/bang-diem", { credentials: "include" }),
            fetch("https://portal.uit.edu.vn/api/sinh-vien/diem-ren-luyen", { credentials: "include" }).catch(() => null)
        ]);

        if (!bdResp.ok) throw new Error("API bảng điểm trả về mã lỗi: " + bdResp.status);
        const bdData = await bdResp.json();

        if (!bdData || !bdData.bySemester) {
            throw new Error("Dữ liệu trả về từ API không chứa trường 'bySemester'. Hãy chắc chắn bạn đã đăng nhập Portal UIT.");
        }

        if (drlResp && drlResp.ok) {
            try {
                const drlData = await drlResp.json();
                bdData.drl = drlData;
                console.log("[Diark OS] Đã lấy thành công Điểm rèn luyện (ĐTB: " + drlData.average_training_point + ")");
            } catch (e) {
                console.warn("[Diark OS] Không parse được DRL JSON:", e);
            }
        }

        // Đếm số lượng môn học
        let totalCourses = 0;
        if (Array.isArray(bdData.bySemester.semester_groups)) {
            bdData.bySemester.semester_groups.forEach(g => {
                if (Array.isArray(g.subjects)) totalCourses += g.subjects.length;
            });
        }

        // Cố gắng lấy thêm hồ sơ sinh viên từ trang nếu có
        try {
            const h2 = document.querySelector("h2");
            const fullName = h2 ? h2.innerText.trim() : "";
            const bodyText = document.body ? document.body.innerText : "";
            const mId = bodyText.match(/\b(\d{8})\b/);
            const studentId = mId ? mId[1] : "";

            if (studentId || fullName) {
                bdData.profile = {
                    student_id: studentId,
                    full_name: fullName,
                    faculty: "CNTT",
                    major_code: "",
                    specialization: "",
                    student_class: "",
                    curriculum_code: ""
                };
            }
        } catch (_) {}

        // Tự động sao chép JSON vào clipboard làm bản sao lưu an toàn 100%
        try {
            await navigator.clipboard.writeText(JSON.stringify(bdData, null, 2));
            console.log("%c[Diark OS] 📋 Đã sao chép JSON tổng hợp vào Clipboard!", "color: #4ade80; font-weight: bold;");
        } catch (_) {}

        showBanner("🚀 Đang đẩy dữ liệu về Diark OS (port 3030)...", true);
        const resp = await fetch(LOCAL_SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bdData)
        });

        if (resp.ok) {
            console.log("%c[Diark OS] ✅ ĐỒNG BỘ THÀNH CÔNG!", "color: #22c55e; font-size: 16px; font-weight: bold;");
            showBanner(`✅ <b>ĐỒNG BỘ THÀNH CÔNG!</b><br>Đã nạp ${totalCourses} môn học & Điểm rèn luyện vào Diark OS.`, true);
        } else {
            throw new Error(`Local server status ${resp.status}`);
        }
    } catch (err) {
        console.error("[Diark OS] Lỗi đồng bộ:", err);
        showBanner(`⚠️ <b>ĐÃ LẤY XONG DỮ LIỆU!</b><br>JSON đã được lưu vào Clipboard.<br>Bạn có thể mở Diark OS, bấm "Dán JSON" để nạp trực tiếp.`, false);
    }
})();
