(() => {
    // RÀNG BUỘC P0: TUYỆT ĐỐI CẤM TRUY CẬP document.cookie HOẶC HEADER CHỨA SESSION
    if (window.__DIARK_WECODE_HARVESTER_ACTIVE__) return;

    const WECODE_STORAGE_KEY = "__DIARK_WECODE_HARVEST_BUFFER__";
    const LOCAL_SERVER_URL = "http://127.0.0.1:3030/api/v1/sync/wecode";
    const BATCH_SIZE = 20;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // --- 1. UI BANNER / PROGRESS HUD ---
    function renderBanner(isLoggedIn, statusText = "", percent = 0) {
        let el = document.getElementById("__diark_wecode_overlay");
        if (!el) {
            el = document.createElement("div");
            el.id = "__diark_wecode_overlay";
            el.style.position = "fixed";
            el.style.top = "16px";
            el.style.left = "50%";
            el.style.transform = "translateX(-50%)";
            el.style.zIndex = "99999999";
            el.style.borderRadius = "12px";
            el.style.fontFamily = "system-ui, -apple-system, sans-serif";
            el.style.fontSize = "13px";
            el.style.boxShadow = "0 14px 40px rgba(0,0,0,0.6)";
            el.style.transition = "all 0.3s ease";
            document.body.appendChild(el);
        }

        if (!isLoggedIn) {
            el.style.backgroundColor = "rgba(15, 23, 42, 0.95)";
            el.style.backdropFilter = "blur(12px)";
            el.style.border = "1px solid rgba(16, 185, 129, 0.4)";
            el.style.color = "#e2e8f0";
            el.style.padding = "12px 20px";
            el.style.display = "flex";
            el.style.alignItems = "center";
            el.style.gap = "12px";
            el.innerHTML = `
                <span style="font-size: 20px;">🔐</span>
                <div>
                    <div style="font-weight: 700; color: #34d399; font-size: 13px;">Diark OS • Tự động đồng bộ Wecode</div>
                    <div style="color: #94a3b8; font-size: 11px; margin-top: 2px;">Vui lòng đăng nhập tài khoản Wecode. Sau khi đăng nhập, hệ thống sẽ tự động thu thập và đóng cửa sổ này.</div>
                </div>
            `;
        } else {
            el.style.backgroundColor = "rgba(9, 9, 11, 0.96)";
            el.style.backdropFilter = "blur(12px)";
            el.style.border = "1px solid #059669";
            el.style.color = "#f4f4f5";
            el.style.padding = "14px 22px";
            el.style.minWidth = "360px";
            el.style.maxWidth = "90vw";
            el.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 18px;">🚀</span>
                        <span style="font-weight: 700; color: #34d399; font-size: 13px;">Diark OS • Đang tự động thu thập</span>
                    </div>
                    <span style="font-size: 11px; font-weight: 600; color: #10b981; font-family: monospace;">${Math.round(percent)}%</span>
                </div>
                <div style="font-size: 11px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${statusText}</div>
                <div style="width: 100%; background: #27272a; height: 6px; border-radius: 3px; margin-top: 8px; overflow: hidden;">
                    <div style="width: ${percent}%; height: 100%; background: linear-gradient(90deg, #059669, #10b981); transition: width 0.2s ease;"></div>
                </div>
            `;
        }
    }

    // --- 2. AUTH DETECTION ---
    function extractWecodeUserId() {
        // 1. Check user profile / submissions link
        const userProfileLink = document.querySelector('a[href*="/users/"]');
        if (userProfileLink) {
            const m = (userProfileLink.getAttribute('href') || '').match(/\/users\/(\d+)/);
            if (m && m[1]) return m[1];
        }
        const subLink = document.querySelector('a[href*="/user/"]');
        if (subLink) {
            const m = (subLink.getAttribute('href') || '').match(/\/user\/(\d+)/);
            if (m && m[1]) return m[1];
        }
        const profileContainer = document.querySelector('#profile_link')?.closest('li');
        if (profileContainer) {
            const link = profileContainer.querySelector('a[href*="/users/"]');
            if (link) {
                const m = (link.getAttribute('href') || '').match(/\/users\/(\d+)/);
                if (m && m[1]) return m[1];
            }
        }
        // 2. Fallback check: if user is authenticated via logout form / profile link
        const hasSignOut = Boolean(document.querySelector('form[action*="/logout"], a[href*="/logout"]'));
        const hasProfile = Boolean(document.querySelector('#profile_link'));
        if (hasSignOut || hasProfile) {
            const anyUserMatch = document.body ? document.body.innerHTML.match(/\/user\/(\d+)/) : null;
            if (anyUserMatch && anyUserMatch[1]) return anyUserMatch[1];
            const anyUsersMatch = document.body ? document.body.innerHTML.match(/\/users\/(\d+)/) : null;
            if (anyUsersMatch && anyUsersMatch[1]) return anyUsersMatch[1];
        }
        return null;
    }

    function extractBasePrefix() {
        if (window.wcj && window.wcj.site_url) {
            try {
                return new URL(window.wcj.site_url).pathname.replace(/\/+$/, '');
            } catch (_) {}
        }
        if (window.site_url) {
            try {
                return new URL(window.site_url).pathname.replace(/\/+$/, '');
            } catch (_) {}
        }
        const userProfileLink = document.querySelector('a[href*="/users/"]');
        if (userProfileLink) {
            const href = userProfileLink.getAttribute('href') || '';
            const m = href.match(/^(\/.*)\/users\/\d+/);
            if (m && m[1]) return m[1];
        }
        const path = window.location.pathname || "";
        const parts = path.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[0].includes('wecode')) {
            return `/${parts[0]}/${parts[1]}`;
        }
        if (parts.length >= 1 && parts[0].includes('wecode')) {
            return `/${parts[0]}`;
        }
        return "";
    }

    // --- 3. AUTO HARVESTING ENGINE ---
    async function runAutoHarvester(wecodeUserId) {
        if (window.__DIARK_WECODE_HARVESTER_ACTIVE__) return;
        window.__DIARK_WECODE_HARVESTER_ACTIVE__ = true;

        const basePrefix = extractBasePrefix();
        renderBanner(true, "Đang quét danh mục bài tập...", 5);

        // Thu thập danh sách assignments
        const assignmentMap = new Map();

        function parseAssignmentRows(doc) {
            // RÀNG BUỘC P0: Bảng bài tập Wecode LUÔN sử dụng thẻ tr có data-id: <tr data-id="1452">
            // Tuyệt đối không query "table tbody tr" tránh nhầm lẫn bảng ví dụ đề bài hoặc widget!
            const rows = Array.from(doc.querySelectorAll("tr[data-id]"));
            rows.forEach((row) => {
                if (row.classList.contains("dataTables_empty") || row.querySelectorAll("td").length < 3) return;
                const idAttr = row.getAttribute("data-id");
                const assignId = parseInt(idAttr || "", 10);
                if (!assignId || isNaN(assignId) || assignId <= 0) return;

                let assignName = "";
                const strongEl = row.querySelector("td:nth-child(3) strong");
                if (strongEl) {
                    assignName = strongEl.innerText.trim();
                } else {
                    const nameLink = row.querySelector('td:nth-child(3) a');
                    if (nameLink) {
                        assignName = nameLink.innerText.trim().split('\n')[0].trim();
                    }
                }

                let subUrl = "";
                const subLinkEl = row.querySelector('td:nth-child(4) a[href*="/submissions/"]');
                if (subLinkEl) {
                    subUrl = (subLinkEl.getAttribute("href") || "").trim();
                }
                if (!subUrl) {
                    subUrl = `${basePrefix}/submissions/assignment/${assignId}/user/${wecodeUserId}/problem/all/view/all`;
                }

                let classBadges = [];
                const classTd = row.querySelector("td:nth-child(2)");
                if (classTd) {
                    const badgeEls = Array.from(classTd.querySelectorAll(".badge, span, a"))
                        .map(el => el.innerText.trim())
                        .filter(b => b.length > 0 && !b.startsWith("#"));
                    classBadges = Array.from(new Set(badgeEls));
                }

                let totalProblems = 0;
                const submitTd = row.querySelector("td:nth-child(4)");
                if (submitTd) {
                    const probMatch = submitTd.innerText.match(/(\d+)\s+prob/);
                    if (probMatch) {
                        totalProblems = parseInt(probMatch[1], 10) || 0;
                    }
                }

                let startTime = "";
                const startTd = row.querySelector("td:nth-child(5)");
                if (startTd) {
                    startTime = (startTd.querySelector("small")?.innerText || startTd.innerText || "").trim();
                }

                let finishTime = "";
                const finishTd = row.querySelector("td:nth-child(6)");
                if (finishTd) {
                    finishTime = (finishTd.querySelector("small")?.innerText || finishTd.innerText || "").trim();
                }

                assignmentMap.set(assignId, {
                    id: assignId,
                    name: assignName || `Assignment #${assignId}`,
                    classes: classBadges.join(", "),
                    totalProblems: totalProblems,
                    subUrl: subUrl,
                    startTime: startTime,
                    finishTime: finishTime,
                    baseUrl: `${window.location.origin}${basePrefix}`
                });
            });
        }

        // 1. Nếu trang hiện tại có chứa bảng assignments chuẩn với tr[data-id], parse ngay
        const isAssignmentsRoute = window.location.pathname.includes('/home') ||
                                   window.location.pathname.includes('/assignments') ||
                                   window.location.pathname.endsWith('/it00x') ||
                                   window.location.pathname.endsWith('/it00x/');
        if (isAssignmentsRoute && document.querySelectorAll("tr[data-id]").length > 0) {
            parseAssignmentRows(document);
        }

        // 2. Nếu chưa có (ví dụ người dùng đang ở trang /assignment/.../0 hoặc profile),
        // luôn fetch trang canonical /home (trang danh mục chuẩn của Wecode UIT)
        if (assignmentMap.size === 0) {
            try {
                const homeResp = await fetch(`${basePrefix}/home`, { credentials: "include" });
                if (homeResp.ok) {
                    const homeHtml = await homeResp.text();
                    const parser = new DOMParser();
                    const homeDoc = parser.parseFromString(homeHtml, "text/html");
                    parseAssignmentRows(homeDoc);
                }
            } catch (err) {
                console.warn("[Diark Wecode] Lỗi fetch /home:", err);
            }
        }

        // 3. Fallback: fetch từ /assignments nếu /home không có
        if (assignmentMap.size === 0) {
            try {
                const assignResp = await fetch(`${basePrefix}/assignments`, { credentials: "include" });
                if (assignResp.ok) {
                    const assignHtml = await assignResp.text();
                    const parser = new DOMParser();
                    const assignDoc = parser.parseFromString(assignHtml, "text/html");
                    parseAssignmentRows(assignDoc);
                }
            } catch (err) {
                console.warn("[Diark Wecode] Lỗi fetch assignments:", err);
            }
        }

        const sortedAssignments = Array.from(assignmentMap.values()).sort((a, b) => b.id - a.id);
        console.log(`[Diark Wecode] Tìm thấy ${sortedAssignments.length} assignments.`);

        if (sortedAssignments.length === 0) {
            renderBanner(true, "Không tìm thấy bài tập nào. Hoàn tất!", 100);
            await sleep(500);
            window.location.href = "diark-sso://callback#target=wecode&action=commit&total_items=0";
            return;
        }

        const allSubmissions = [];
        const allProblems = [];
        const parser = new DOMParser();
        let completed = 0;

        for (const assign of sortedAssignments) {
            completed++;
            const pct = 10 + (completed / sortedAssignments.length) * 75;
            renderBanner(true, `[${completed}/${sortedAssignments.length}] ${assign.name}`, pct);

            const rawSubUrl = (assign.subUrl || "").trim();
            const subUrl = rawSubUrl && rawSubUrl.startsWith("http")
                ? rawSubUrl
                : rawSubUrl
                ? `${window.location.origin}${rawSubUrl.startsWith("/") ? "" : "/"}${rawSubUrl}`
                : `${basePrefix}/submissions/assignment/${assign.id}/user/${wecodeUserId}/problem/all/view/all`;

            const assignDetailUrl = `${basePrefix}/assignment/${assign.id}/0`;

            try {
                // Fetch song song trang chi tiết assignment (chứa toàn bộ danh sách problems) và trang submissions
                const [assignHtml, subHtml] = await Promise.all([
                    fetch(assignDetailUrl, { credentials: "include" }).then(r => r.text()).catch(() => ""),
                    fetch(subUrl, { credentials: "include" }).then(r => r.text()).catch(() => "")
                ]);

                // 1. Phân tích problem catalog từ problems_widget
                if (assignHtml) {
                    const assignDoc = parser.parseFromString(assignHtml, "text/html");
                    const probWidget = assignDoc.querySelector(".problems_widget");
                    if (probWidget) {
                        const countBadge = probWidget.querySelector(".count_problems");
                        if (countBadge) {
                            const cnt = parseInt(countBadge.innerText.trim(), 10);
                            if (!isNaN(cnt) && cnt > 0) assign.totalProblems = cnt;
                        }

                        const seenProbIds = new Set();
                        const problemRows = probWidget.querySelectorAll("tr");
                        problemRows.forEach(tr => {
                            if (tr.querySelector("th")) return;
                            const a = tr.querySelector('a[href*="/assignment/"]');
                            if (!a) return;
                            const m = (a.getAttribute("href") || "").match(/\/assignment\/\d+\/(\d+)/);
                            if (!m) return;
                            const pid = parseInt(m[1], 10);
                            if (!pid || isNaN(pid) || seenProbIds.has(pid)) return;
                            seenProbIds.add(pid);

                            const order = parseInt(tr.querySelector("td:nth-child(1)")?.innerText.trim() || "0", 10);
                            const name = a.innerText.trim();
                            const scoreTd = tr.querySelector("td:nth-child(3)");
                            const maxScore = parseInt(scoreTd?.innerText.trim() || "100", 10);
                            const isAc = scoreTd?.classList.contains("bg-success") || false;

                            const rawHref = a.href || a.getAttribute("href") || "";
                            const problemUrl = rawHref.startsWith("http")
                                ? rawHref
                                : (rawHref ? `${window.location.origin}${rawHref.startsWith("/") ? "" : "/"}${rawHref}` : "");

                            allProblems.push({
                                assignment_id: assign.id,
                                problem_id: pid,
                                problem_name: name,
                                problem_order: isNaN(order) ? 0 : order,
                                max_score: isNaN(maxScore) ? 100 : maxScore,
                                is_ac: isAc,
                                problem_url: problemUrl
                            });
                        });
                    }
                }

                // 2. Phân tích lịch sử bài nộp submissions
                if (subHtml) {
                    const subDoc = parser.parseFromString(subHtml, "text/html");
                    const allRows = Array.from(subDoc.querySelectorAll("tr"));
                    const rows = allRows.filter((tr) => {
                        return tr.hasAttribute("data-p") ||
                               tr.hasAttribute("data-u") ||
                               Boolean(tr.querySelector(".js-verdict")) ||
                               Boolean(tr.querySelector(".set_final"));
                    });

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
                                const pMatch = pLink.getAttribute("href")?.match(/\/(?:problem|assignment\/\d+)\/(\d+)/);
                                if (pMatch) pId = parseInt(pMatch[1], 10);
                            }
                        } else if (tds[2]) {
                            pName = tds[2].innerText.trim();
                        }

                        const rawTime = tds[3]?.querySelector(".small")?.innerText?.trim() || tds[3]?.innerText?.trim() || "";
                        const timeMatch = rawTime.match(/[A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}/);
                        const submitTimeStr = timeMatch ? timeMatch[0] : rawTime.split('\n')[0].trim();

                        const verdictEl = tr.querySelector(".js-verdict, [class*='verdict']") || tds[4];
                        const verdict = verdictEl?.innerText?.trim() || "";

                        const timeEl = tr.querySelector(".js-time") || tds[5];
                        const executionTime = parseFloat(timeEl?.innerText?.replace("s", "")?.trim() || "0") || 0.0;

                        const memEl = tr.querySelector(".js-mem") || tds[6];
                        const memoryKib = parseInt(memEl?.innerText?.replace(/[^\d]/g, "")?.trim() || "0", 10) || 0;

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
                            classes: assign.classes || "",
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
                    });
                }
                await sleep(50);
            } catch (err) {
                console.warn(`[Diark Wecode] Lỗi fetch Assignment #${assign.id}:`, err);
            }
        }

        // --- 4. GỬI DỮ LIỆU VỀ DIARK OS ---
        renderBanner(true, `Đang nạp ${allSubmissions.length} bài nộp & ${allProblems.length} câu hỏi vào Diark OS...`, 95);

        const syncPayload = {
            submissions: allSubmissions,
            assignments: sortedAssignments.map(a => ({
                id: a.id,
                name: a.name,
                classes: a.classes || "",
                total_problems: a.totalProblems || 0,
                start_time: a.startTime || "",
                finish_time: a.finishTime || "",
                base_url: a.baseUrl || ""
            })),
            problems: allProblems
        };

        // Kênh 1: Gửi thẳng tới Local Server port 3030 (nhanh nhất & không giới hạn URL Scheme)
        let committedViaPort = false;
        try {
            const resp = await fetch(LOCAL_SERVER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(syncPayload)
            });
            if (resp.ok) {
                committedViaPort = true;
                console.log("[Diark Wecode] Đã commit thành công qua Local Port 3030!");
            }
        } catch (_) {}

        if (committedViaPort) {
            renderBanner(true, `✅ Hoàn tất! Đã đồng bộ ${allSubmissions.length} bài nộp. Đang đóng cửa sổ...`, 100);
            await sleep(400);
            window.location.href = `diark-sso://callback#target=wecode&status=success&total_items=${allSubmissions.length}`;
            return;
        }

        // Kênh 2: Dự phòng qua URL Scheme Chunks nếu port 3030 không phản hồi
        console.log("[Diark Wecode] Fallback sang URL Scheme Chunks...");
        const totalBatches = Math.ceil(allSubmissions.length / BATCH_SIZE) || 1;
        for (let i = 0; i < totalBatches; i++) {
            const chunk = allSubmissions.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            const schemeUri = `diark-sso://partial#target=wecode_submissions&batch_idx=${i}&total_batches=${totalBatches}&data=${encodeURIComponent(JSON.stringify(chunk))}`;
            window.location.href = schemeUri;
            await sleep(60);
        }

        renderBanner(true, `✅ Hoàn tất! Đã đồng bộ ${allSubmissions.length} bài nộp. Đang đóng cửa sổ...`, 100);
        await sleep(300);
        window.location.href = `diark-sso://callback#target=wecode&action=commit&total_items=${allSubmissions.length}`;
    }

    // --- 5. ĐIỀU PHỐI KHỞI ĐỘNG (WATCHDOG & AUTH DETECTOR) ---
    function initHarvesterWatcher() {
        const userId = extractWecodeUserId();
        if (userId) {
            // Đã đăng nhập: tiến hành thu thập ngay
            runAutoHarvester(userId);
        } else {
            // Chưa đăng nhập: hiển thị banner hướng dẫn người dùng đăng nhập
            renderBanner(false);

            // Giám sát liên tục cho đến khi người dùng đăng nhập thành công
            const interval = setInterval(() => {
                const id = extractWecodeUserId();
                if (id) {
                    clearInterval(interval);
                    runAutoHarvester(id);
                }
            }, 500);
        }
    }

    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", initHarvesterWatcher);
    } else {
        initHarvesterWatcher();
    }
})();
