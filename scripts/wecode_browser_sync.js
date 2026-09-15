/**
 * DIARK // OS — WECODE UIT DIRECT BROWSER SYNC SCRIPT
 * 
 * HƯỚNG DẪN SỬ DỤNG (KHÔNG CẦN WEBVIEW):
 * 1. Mở trình duyệt Chrome/Edge và truy cập khóa học Wecode của bạn:
 *    Ví dụ: https://khmt.uit.edu.vn/wecode25/it00x hoặc trang bài tập bất kỳ trên Wecode UIT.
 * 2. Đăng nhập tài khoản Wecode như bình thường.
 * 3. Nhấn F12 (hoặc Ctrl + Shift + I) -> Chọn tab "Console".
 * 4. Dán toàn bộ script này vào Console rồi nhấn Enter.
 * 5. Script sẽ tự động duyệt tất cả bài tập & submissions của bạn, gửi trực tiếp về Diark OS (port 3030),
 *    đồng thời copy sẵn JSON vào Clipboard để làm bản sao lưu an toàn!
 */

(async () => {
    console.clear();
    console.log("%c[Diark OS] 🚀 Bắt đầu tiến trình đồng bộ Wecode Submissions...", "color: #10b981; font-weight: bold; font-size: 14px;");

    const LOCAL_SERVER_URL = "http://127.0.0.1:3030/api/v1/sync/wecode";
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Hiển thị banner nổi trên góc màn hình Wecode
    function showBanner(message, isSuccess = true) {
        let banner = document.getElementById("__diark_wecode_sync_banner");
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "__diark_wecode_sync_banner";
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
        banner.style.backgroundColor = isSuccess ? "#064e3b" : "#450a0a";
        banner.style.color = isSuccess ? "#6ee7b7" : "#f87171";
        banner.style.border = isSuccess ? "1px solid #059669" : "1px solid #dc2626";
        banner.innerHTML = message;
    }

    try {
        // --- BƯỚC 1: XÁC THỰC DANH TÍNH & BASE PREFIX ---
        showBanner("⏳ Đang kiểm tra đăng nhập Wecode...", true);

        const profileLink = document.querySelector('#profile_link, a[href*="/users/"]');
        if (!profileLink) {
            throw new Error("Không tìm thấy thông tin đăng nhập! Hãy chắc chắn bạn đã đăng nhập Wecode.");
        }

        const href = profileLink.getAttribute("href") || "";
        const userMatch = href.match(/\/users\/(\d+)/);
        if (!userMatch) {
            throw new Error("Không trích xuất được User ID dạng số từ profile link: " + href);
        }
        const wecodeUserId = parseInt(userMatch[1], 10);

        // Xác định basePrefix từ href hoặc pathname
        // Ví dụ: href là "/wecode25/it00x/users/2429" -> basePrefix = "/wecode25/it00x"
        let basePrefix = "";
        const prefixMatch = href.match(/^(\/.*)\/users\/\d+/);
        if (prefixMatch && prefixMatch[1]) {
            basePrefix = prefixMatch[1];
        } else {
            // Lấy từ pathname
            const p = window.location.pathname;
            const pm = p.match(/^(\/[^\/]+\/[^\/]+)/);
            if (pm) basePrefix = pm[1];
        }

        console.log(`[Diark OS] ✅ Đã nhận diện User ID: ${wecodeUserId}, Base Prefix: "${basePrefix}"`);

        // --- BƯỚC 2: TẢI DANH MỤC BÀI TẬP (/assignments) ---
        showBanner(`⏳ Đang lấy danh sách bài tập...`, true);
        console.log(`[Diark OS] Đang truy vấn danh sách Assignments từ ${basePrefix}/assignments ...`);

        const assignResp = await fetch(`${basePrefix}/assignments`, { credentials: "include" });
        const assignHtml = await assignResp.text();
        const parser = new DOMParser();
        const assignDoc = parser.parseFromString(assignHtml, "text/html");

        const assignmentIds = new Set();
        const assignRows = Array.from(assignDoc.querySelectorAll("#DataTables_Table_0 tbody tr, table tbody tr"));

        assignRows.forEach((row) => {
            if (row.classList.contains("dataTables_empty") || row.querySelectorAll("td").length <= 1) return;

            // 1. data-id
            const dataId = row.getAttribute("data-id");
            if (dataId && !isNaN(parseInt(dataId, 10))) {
                assignmentIds.add(parseInt(dataId, 10));
                return;
            }

            // 2. Link chứa /assignment/
            const aLink = row.querySelector('a[href*="/assignment/"], a[href*="/assignments/"]');
            if (aLink) {
                const m = aLink.getAttribute("href")?.match(/\/assignments?\/(\d+)/);
                if (m) {
                    assignmentIds.add(parseInt(m[1], 10));
                    return;
                }
            }

            // 3. Cột đầu tiên
            const firstTd = row.querySelector("td");
            if (firstTd) {
                const idVal = parseInt(firstTd.innerText.trim(), 10);
                if (!isNaN(idVal) && idVal > 0) {
                    assignmentIds.add(idVal);
                }
            }
        });

        // Nếu trên trang hiện tại có assignment_id đang mở
        const currentUrlMatch = window.location.pathname.match(/\/assignment\/(\d+)/);
        if (currentUrlMatch) {
            assignmentIds.add(parseInt(currentUrlMatch[1], 10));
        }

        const sortedAssignmentIds = Array.from(assignmentIds).sort((a, b) => b - a);
        console.log(`[Diark OS] Tìm thấy ${sortedAssignmentIds.length} assignments:`, sortedAssignmentIds);

        if (sortedAssignmentIds.length === 0) {
            throw new Error("Không tìm thấy bài tập nào trong danh mục assignments.");
        }

        // --- BƯỚC 3: TẢI SUBMISSIONS CỦA TỪNG ASSIGNMENT ---
        const allSubmissions = [];
        let completedAssignments = 0;

        for (const assignId of sortedAssignmentIds) {
            completedAssignments++;
            showBanner(`⏳ Đang cào submissions bài tập ${completedAssignments}/${sortedAssignmentIds.length} (Assignment #${assignId})...`, true);

            const subUrl = `${basePrefix}/submissions/assignment/${assignId}/user/${wecodeUserId}/problem/all/view/all`;
            try {
                const subResp = await fetch(subUrl, { credentials: "include" });
                const subHtml = await subResp.text();
                const subDoc = parser.parseFromString(subHtml, "text/html");

                const rows = Array.from(subDoc.querySelectorAll("table tbody tr"));
                let countForThis = 0;

                rows.forEach((tr) => {
                    if (tr.classList.contains("dataTables_empty") || tr.querySelectorAll("td").length < 5) return;

                    const tds = tr.querySelectorAll("td");

                    // 1. submission_id
                    let subId = parseInt(tr.getAttribute("data-id") || "", 10);
                    if (isNaN(subId) && tds[0]) {
                        subId = parseInt(tds[0].innerText.trim(), 10);
                    }
                    if (isNaN(subId)) return;

                    // 2. assignment_id
                    let aId = parseInt(tr.getAttribute("data-a") || "", 10);
                    if (isNaN(aId)) aId = assignId;

                    // 3. problem_id
                    let pId = parseInt(tr.getAttribute("data-p") || "0", 10);
                    if (isNaN(pId)) pId = 0;

                    // 4. problem_name
                    let pName = "";
                    const pLink = tds[2]?.querySelector("a") || tr.querySelector('a[href*="/problem/"]');
                    if (pLink) {
                        pName = pLink.innerText.trim();
                        if (!pId) {
                            const pMatch = pLink.getAttribute("href")?.match(/\/problem\/(\d+)/);
                            if (pMatch) pId = parseInt(pMatch[1], 10);
                        }
                    } else if (tds[2]) {
                        pName = tds[2].innerText.trim();
                    }

                    // 5. submit_time_str
                    const submitTimeStr = tds[3]?.innerText?.trim() || "";

                    // 6. verdict
                    const verdictEl = tr.querySelector(".js-verdict, [class*='verdict']") || tds[4];
                    const verdict = verdictEl?.innerText?.trim() || "";

                    // 7. score
                    const scoreEl = tr.querySelector(".js-score span, .js-score") || tds[5];
                    const score = parseInt(scoreEl?.innerText?.trim() || "0", 10);

                    // 8. execution_time
                    const timeEl = tr.querySelector(".js-time") || tds[6];
                    const executionTime = parseFloat(timeEl?.innerText?.replace("s", "")?.trim() || "0") || 0.0;

                    // 9. memory_kib
                    const memEl = tr.querySelector(".js-mem") || tds[7];
                    const memoryKib = parseInt(memEl?.innerText?.replace(/[^\d]/g, "")?.trim() || "0", 10) || 0;

                    // 10. language
                    const langEl = tr.querySelector('div[data-type="code"]') || tds[8];
                    const language = langEl?.innerText?.trim() || "C++";

                    // 11. is_final
                    const isFinal = tr.querySelector(".set_final")?.classList.contains("bi-check-circle") ||
                                    tr.querySelector(".bi-check-circle") !== null ||
                                    tr.querySelector("i.text-success") !== null;

                    allSubmissions.push({
                        submission_id: subId,
                        assignment_id: aId,
                        problem_id: pId,
                        problem_name: pName || `Problem ${pId}`,
                        submit_time_str: submitTimeStr,
                        verdict: verdict,
                        score: isNaN(score) ? 0 : score,
                        execution_time: executionTime,
                        memory_kib: memoryKib,
                        language: language,
                        is_final: Boolean(isFinal)
                    });
                    countForThis++;
                });

                console.log(`[Diark OS] Assignment #${assignId}: Đã lấy ${countForThis} submissions.`);
                await sleep(150); // Nhẹ nhàng với server Wecode
            } catch (err) {
                console.warn(`[Diark OS] Lỗi khi tải submissions cho Assignment #${assignId}:`, err);
            }
        }

        console.log(`[Diark OS] 🏁 Hoàn tất thu thập! Tổng cộng ${allSubmissions.length} submissions.`);

        // --- BƯỚC 4: LƯU CLIPBOARD & GỬI VỀ LOCALHOST PORT 3030 ---
        try {
            await navigator.clipboard.writeText(JSON.stringify(allSubmissions, null, 2));
            console.log("%c[Diark OS] 📋 Đã sao chép toàn bộ JSON vào Clipboard!", "color: #34d399; font-weight: bold;");
        } catch (_) {}

        showBanner(`🚀 Đang gửi ${allSubmissions.length} bài nộp về Diark OS (port 3030)...`, true);

        try {
            const resp = await fetch(LOCAL_SERVER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(allSubmissions)
            });

            if (resp.ok) {
                console.log("%c[Diark OS] ✅ ĐỒNG BỘ WECODE THÀNH CÔNG!", "color: #10b981; font-size: 16px; font-weight: bold;");
                showBanner(`✅ <b>ĐỒNG BỘ WECODE THÀNH CÔNG!</b><br>Đã nạp ${allSubmissions.length} submissions vào Diark OS.`, true);
            } else {
                const errText = await resp.text();
                throw new Error(`Server status ${resp.status}: ${errText}`);
            }
        } catch (serverErr) {
            console.warn("[Diark OS] Không thể gửi trực tiếp qua port 3030:", serverErr);
            showBanner(`⚠️ <b>ĐÃ CÀO ${allSubmissions.length} BÀI NỘP!</b><br>Dữ liệu JSON đã sao chép vào Clipboard.<br>Bạn có thể dán vào Diark nếu port 3030 chưa mở.`, false);
        }

    } catch (err) {
        console.error("[Diark OS] Lỗi đồng bộ Wecode:", err);
        showBanner(`❌ <b>LỖI ĐỒNG BỘ WECODE:</b> ${err.message}`, false);
    }
})();
