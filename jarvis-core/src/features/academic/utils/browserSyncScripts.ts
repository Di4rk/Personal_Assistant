/**
 * Scripts đồng bộ dữ liệu trực tiếp từ trình duyệt (Console Snippet)
 * Thay thế hoàn toàn In-App Webview. Không phụ thuộc vào Next.js router hay Webview2 scheme.
 */

export const PORTAL_BROWSER_SYNC_SCRIPT = `(async () => {
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

        // Cố gắng lấy thêm hồ sơ sinh viên đầy đủ từ /sinh-vien/ho-so (Next.js RSC Flight Stream)
        try {
            let hsText = "";
            if (Array.isArray(window.__next_f)) {
                for (const chunk of window.__next_f) {
                    if (Array.isArray(chunk) && typeof chunk[1] === "string" && chunk[1].includes('"academic":')) {
                        hsText = chunk[1];
                        break;
                    }
                }
            }
            if (!hsText) {
                const hsResp = await fetch("https://portal.uit.edu.vn/sinh-vien/ho-so", { credentials: "include" }).catch(() => null);
                if (hsResp && hsResp.ok) hsText = await hsResp.text();
            }

            let profileObj = {
                student_id: "",
                full_name: "",
                faculty: "",
                major_code: "",
                specialization: "",
                student_class: "",
                curriculum_code: ""
            };

            if (hsText) {
                const unescaped = hsText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                const extractMatch = (regex) => {
                    const m = unescaped.match(regex);
                    return m && m[1] ? m[1].trim() : "";
                };
                profileObj.student_id = extractMatch(/"studentCode"\\s*:\\s*"(\\d{8})"/i) || extractMatch(/"student_code"\\s*:\\s*"(\\d{8})"/i);
                profileObj.full_name = extractMatch(/"fullName"\\s*:\\s*"([^"]+)"/i) || extractMatch(/"full_name"\\s*:\\s*"([^"]+)"/i);
                profileObj.student_class = extractMatch(/"class_name"\\s*:\\s*"([^"]+)"/i) || extractMatch(/"student_class"\\s*:\\s*"([^"]+)"/i);
                profileObj.specialization = extractMatch(/"specialization"\\s*:\\s*"([^"]+)"/i);
                profileObj.faculty = extractMatch(/"faculty_name"\\s*:\\s*"([^"]+)"/i);
                profileObj.major_code = extractMatch(/"major_name"\\s*:\\s*"([^"]+)"/i);
                profileObj.curriculum_code = extractMatch(/"training_program"\\s*:\\s*"([^"]+)"/i);
            }

            if (!profileObj.student_id) {
                const bodyText = document.body ? document.body.innerText : "";
                const mId = bodyText.match(/\\b(\\d{8})\\b/);
                if (mId) profileObj.student_id = mId[1];
            }
            if (!profileObj.full_name) {
                const h2 = document.querySelector("h2");
                if (h2) profileObj.full_name = h2.innerText.trim();
            }

            if (profileObj.student_id || profileObj.full_name) {
                bdData.profile = profileObj;
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
            showBanner(\`✅ <b>ĐỒNG BỘ THÀNH CÔNG!</b><br>Đã nạp \${totalCourses} môn học & Điểm rèn luyện vào Diark OS.\`, true);
        } else {
            throw new Error(\`Local server status \${resp.status}\`);
        }
    } catch (err) {
        console.error("[Diark OS] Lỗi đồng bộ:", err);
        showBanner(\`⚠️ <b>ĐÃ LẤY XONG DỮ LIỆU BẢNG ĐIỂM!</b><br>JSON đã được lưu vào Clipboard.<br>Bạn có thể mở Diark OS, bấm "Dán JSON" để nạp trực tiếp.\`, false);
    }
})();`;

export const WECODE_BROWSER_SYNC_SCRIPT = `(async () => {
    console.clear();
    console.log("%c[Diark OS] 🚀 Bắt đầu tiến trình đồng bộ Wecode Submissions...", "color: #10b981; font-weight: bold; font-size: 14px;");

    const LOCAL_SERVER_URL = "http://127.0.0.1:3030/api/v1/sync/wecode";
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        showBanner("⏳ Đang kiểm tra đăng nhập Wecode...", true);

        // 1. Trích xuất Wecode User ID số (ví dụ: 2429, KHÔNG lấy MSSV như 25520458)
        let wecodeUserId = null;
        const profileUserLink = document.querySelector('a[href*="/users/"]');
        if (profileUserLink) {
            const m = (profileUserLink.getAttribute("href") || "").match(/\\/users\\/(\\d+)/);
            if (m && m[1]) wecodeUserId = parseInt(m[1], 10);
        }
        if (!wecodeUserId) {
            const anySubLink = document.querySelector('a[href*="/user/"]');
            if (anySubLink) {
                const m = (anySubLink.getAttribute("href") || "").match(/\\/user\\/(\\d+)/);
                if (m && m[1]) wecodeUserId = parseInt(m[1], 10);
            }
        }
        if (!wecodeUserId) {
            const profileContainer = document.querySelector("#profile_link")?.closest("li");
            const dropdownLink = profileContainer?.querySelector('a[href*="/users/"]');
            if (dropdownLink) {
                const m = (dropdownLink.getAttribute("href") || "").match(/\\/users\\/(\\d+)/);
                if (m && m[1]) wecodeUserId = parseInt(m[1], 10);
            }
        }

        if (!wecodeUserId) {
            throw new Error("Không trích xuất được User ID Wecode! Hãy chắc chắn bạn đã đăng nhập và đang ở trang Wecode.");
        }

        // 2. Trích xuất Base Prefix (ví dụ: /wecode25/it00x)
        let basePrefix = "";
        if (window.wcj && window.wcj.site_url) {
            try {
                basePrefix = new URL(window.wcj.site_url).pathname.replace(/\\/+$/, "");
            } catch (_) {}
        }
        if (!basePrefix && window.site_url) {
            try {
                basePrefix = new URL(window.site_url).pathname.replace(/\\/+$/, "");
            } catch (_) {}
        }
        if (!basePrefix && profileUserLink) {
            const href = profileUserLink.getAttribute("href") || "";
            const m = href.match(/^(\\/.*)\\/users\\/\\d+/);
            if (m && m[1]) basePrefix = m[1];
        }
        if (!basePrefix) {
            const p = window.location.pathname;
            const pm = p.match(/^(\\/[^\\/]+\\/[^\\/]+)/);
            if (pm) basePrefix = pm[1];
        }

        showBanner("⏳ Đang lấy danh sách bài tập...", true);

        // Map lưu assignment_id -> { id, name, subUrl }
        const assignmentMap = new Map();

        function parseAssignmentRows(doc) {
            const rows = Array.from(doc.querySelectorAll("table tbody tr, tr[data-id]"));
            rows.forEach((row) => {
                if (row.classList.contains("dataTables_empty") || row.querySelectorAll("td").length <= 1) return;
                let assignId = parseInt(row.getAttribute("data-id") || "", 10);
                if (isNaN(assignId)) {
                    const aLink = row.querySelector('a[href*="/assignment/"], a[href*="/assignments/"]');
                    if (aLink) {
                        const m = aLink.getAttribute("href")?.match(/\\/assignments?\\/(\\d+)/);
                        if (m) assignId = parseInt(m[1], 10);
                    }
                }
                if (isNaN(assignId)) {
                    const firstTd = row.querySelector("td");
                    if (firstTd) {
                        const idVal = parseInt(firstTd.innerText.trim(), 10);
                        if (!isNaN(idVal) && idVal > 0) assignId = idVal;
                    }
                }
                if (!assignId || isNaN(assignId)) return;

                // Tên bài tập ở cột 3 (thường có strong hoặc thẻ a)
                let assignName = "";
                const strongEl = row.querySelector("td:nth-child(3) strong");
                if (strongEl) {
                    assignName = strongEl.innerText.trim();
                } else {
                    const nameLink = row.querySelector('td:nth-child(3) a[href*="/assignment/"]');
                    if (nameLink) {
                        const fullTxt = nameLink.innerText.trim();
                        assignName = fullTxt.split('\\n')[0].trim();
                    }
                }

                // Link submissions trực tiếp ở cột 4 nếu có
                let subUrl = "";
                const subLinkEl = row.querySelector('td:nth-child(4) a[href*="/submissions/"]');
                if (subLinkEl) {
                    subUrl = subLinkEl.getAttribute("href") || "";
                }

                assignmentMap.set(assignId, {
                    id: assignId,
                    name: assignName || \`Assignment #\${assignId}\`,
                    subUrl: subUrl
                });
            });
        }

        // Thử parse từ DOM hiện tại nếu đang ở /home hoặc /assignments
        parseAssignmentRows(document);

        // Nếu chưa có hoặc ít bài tập, fetch thêm từ /assignments
        if (assignmentMap.size === 0) {
            const assignResp = await fetch(\`\${basePrefix}/assignments\`, { credentials: "include" });
            const assignHtml = await assignResp.text();
            const parser = new DOMParser();
            const assignDoc = parser.parseFromString(assignHtml, "text/html");
            parseAssignmentRows(assignDoc);
        }

        const sortedAssignments = Array.from(assignmentMap.values()).sort((a, b) => b.id - a.id);
        if (sortedAssignments.length === 0) {
            throw new Error("Không tìm thấy bài tập nào trong danh mục assignments.");
        }

        console.log(\`[Diark OS] Tìm thấy \${sortedAssignments.length} assignments:\`, sortedAssignments);

        const allSubmissions = [];
        let completed = 0;
        const parser = new DOMParser();

        for (const assign of sortedAssignments) {
            completed++;
            showBanner(\`⏳ Đang lấy bài nộp \${completed}/\${sortedAssignments.length}: \${assign.name}...\`, true);

            const subUrl = assign.subUrl && assign.subUrl.startsWith("http")
                ? assign.subUrl
                : assign.subUrl
                ? \`\${window.location.origin}\${assign.subUrl}\`
                : \`\${basePrefix}/submissions/assignment/\${assign.id}/user/\${wecodeUserId}/problem/all/view/all\`;

            try {
                const subResp = await fetch(subUrl, { credentials: "include" });
                const subHtml = await subResp.text();
                const subDoc = parser.parseFromString(subHtml, "text/html");
                const rows = Array.from(subDoc.querySelectorAll("table tbody tr, tr[data-id]"));

                rows.forEach((tr) => {
                    if (tr.classList.contains("dataTables_empty") || tr.querySelectorAll("td").length < 5) return;
                    const tds = tr.querySelectorAll("td");

                    let subId = parseInt(tr.getAttribute("data-id") || "", 10);
                    if (isNaN(subId) && tds[1]) subId = parseInt(tds[1].innerText.trim(), 10);
                    if (isNaN(subId) && tds[0]) subId = parseInt(tds[0].innerText.trim(), 10);
                    if (isNaN(subId)) return;

                    let aId = parseInt(tr.getAttribute("data-a") || "", 10);
                    if (isNaN(aId)) aId = assign.id;

                    let pId = parseInt(tr.getAttribute("data-p") || "0", 10);
                    let pName = "";
                    const pLink = tds[2]?.querySelector("a") || tr.querySelector('a[href*="/assignment/"], a[href*="/problem/"]');
                    if (pLink) {
                        pName = pLink.innerText.trim();
                        if (!pId) {
                            const pMatch = pLink.getAttribute("href")?.match(/\\/(?:problem|assignment\\/\\d+)\\/(\\d+)/);
                            if (pMatch) pId = parseInt(pMatch[1], 10);
                        }
                    } else if (tds[2]) {
                        pName = tds[2].innerText.trim();
                    }

                    // Trích xuất chính xác timestamp, loại bỏ các dòng ghi chú trễ ("1mo 1w late")
                    const rawTime = tds[3]?.querySelector(".small")?.innerText?.trim() || tds[3]?.innerText?.trim() || "";
                    const timeMatch = rawTime.match(/[A-Za-z]{3},\\s+\\d{1,2}\\s+[A-Za-z]{3}\\s+\\d{4}\\s+\\d{2}:\\d{2}:\\d{2}/);
                    const submitTimeStr = timeMatch ? timeMatch[0] : rawTime.split('\\n')[0].trim();

                    const verdictEl = tr.querySelector(".js-verdict, [class*='verdict']") || tds[4];
                    const verdict = verdictEl?.innerText?.trim() || "";

                    const timeEl = tr.querySelector(".js-time") || tds[5];
                    const executionTime = parseFloat(timeEl?.innerText?.replace("s", "")?.trim() || "0") || 0.0;

                    const memEl = tr.querySelector(".js-mem") || tds[6];
                    const memoryKib = parseInt(memEl?.innerText?.replace(/[^\\d]/g, "")?.trim() || "0", 10) || 0;

                    const scoreEl = tr.querySelector(".js-score span, .js-score, .status span") || tds[7];
                    const score = parseInt(scoreEl?.innerText?.trim() || "0", 10);

                    const langEl = tr.querySelector('div[data-type="code"]') || tds[8];
                    const language = langEl?.innerText?.trim() || "C++";

                    const isFinal = tr.querySelector(".set_final")?.classList.contains("bi-check-circle") ||
                                    tr.querySelector(".bi-check-circle") !== null;

                    allSubmissions.push({
                        submission_id: subId,
                        assignment_id: aId,
                        assignment_name: assign.name,
                        problem_id: pId,
                        problem_name: pName || \`Problem \${pId}\`,
                        submit_time_str: submitTimeStr,
                        verdict: verdict,
                        score: isNaN(score) ? 0 : score,
                        execution_time: executionTime,
                        memory_kib: memoryKib,
                        language: language,
                        is_final: Boolean(isFinal)
                    });
                });
                await sleep(150);
            } catch (err) {
                console.warn(\`Lỗi fetch Assignment #\${assign.id}:\`, err);
            }
        }

        try {
            await navigator.clipboard.writeText(JSON.stringify(allSubmissions, null, 2));
            console.log("%c[Diark OS] 📋 Đã copy JSON vào Clipboard!", "color: #34d399;");
        } catch (_) {}

        showBanner(\`🚀 Đang gửi \${allSubmissions.length} bài nộp về Diark OS (port 3030)...\`, true);
        const resp = await fetch(LOCAL_SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(allSubmissions)
        });

        if (resp.ok) {
            showBanner(\`✅ <b>ĐỒNG BỘ WECODE THÀNH CÔNG!</b><br>Đã nạp \${allSubmissions.length} submissions từ \${sortedAssignments.length} assignments vào Diark OS.\`, true);
        } else {
            throw new Error(\`Server status \${resp.status}\`);
        }
    } catch (err) {
        console.error("[Diark OS] Lỗi đồng bộ:", err);
        showBanner(\`⚠️ <b>ĐÃ THU THẬP XONG!</b><br>JSON submissions đã được copy vào Clipboard.<br>Bạn có thể dán trực tiếp vào Diark OS.\`, false);
    }
})();`;
