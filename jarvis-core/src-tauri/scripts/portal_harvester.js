/**
 * DIARK OS — Automated Zero-Friction UIT Portal Harvester v3.0
 * 
 * Auto-detects authenticated session, fetches official APIs (Transcript, DRL, Profile)
 * in parallel, dispatches directly to Diark OS local sync server (port 3030), and closes window.
 * Zero manual F12, zero console pasting required.
 */
(() => {
    if (window.__DIARK_PORTAL_HARVESTER_V3__) return;
    window.__DIARK_PORTAL_HARVESTER_V3__ = true;

    const LOCAL_SYNC_ENDPOINT = "http://127.0.0.1:3030/api/v1/sync/portal";

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- SLEEK FLOATING STATUS PILL ---
    let pillEl = null;
    function showPill(text, type = "info") {
        try {
            if (!pillEl) {
                pillEl = document.createElement("div");
                pillEl.id = "__diark_sync_pill";
                pillEl.style.position = "fixed";
                pillEl.style.top = "16px";
                pillEl.style.right = "16px";
                pillEl.style.zIndex = "99999999";
                pillEl.style.padding = "10px 18px";
                pillEl.style.borderRadius = "10px";
                pillEl.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
                pillEl.style.fontSize = "12px";
                pillEl.style.fontWeight = "600";
                pillEl.style.boxShadow = "0 8px 30px rgba(0,0,0,0.45)";
                pillEl.style.transition = "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)";
                pillEl.style.display = "flex";
                pillEl.style.alignItems = "center";
                pillEl.style.gap = "8px";
                pillEl.style.backdropFilter = "blur(8px)";
                document.body?.appendChild(pillEl);
            }

            if (type === "success") {
                pillEl.style.backgroundColor = "rgba(12, 74, 110, 0.92)"; // sky-950
                pillEl.style.border = "1px solid rgba(56, 189, 248, 0.5)"; // sky-400
                pillEl.style.color = "#38bdf8";
            } else if (type === "error") {
                pillEl.style.backgroundColor = "rgba(136, 19, 55, 0.92)"; // rose-950
                pillEl.style.border = "1px solid rgba(251, 113, 133, 0.5)"; // rose-400
                pillEl.style.color = "#fb7185";
            } else {
                pillEl.style.backgroundColor = "rgba(24, 24, 27, 0.92)"; // zinc-900
                pillEl.style.border = "1px solid rgba(82, 82, 91, 0.6)"; // zinc-600
                pillEl.style.color = "#e4e4e7"; // zinc-200
            }

            pillEl.innerHTML = text;
        } catch (_) {}
    }

    // --- STUDENT IDENTITY PARSER ---
    function extractStudentIdentityFromDOM() {
        let student_id = "";
        let full_name = "";

        // 1. Header user chip
        const idElem = document.querySelector('header button span.text-xs') || document.querySelector('header span.text-muted-foreground');
        const nameElem = document.querySelector('header button span.text-sm') || document.querySelector('header span.font-medium');

        if (idElem && /^\d{8}$/.test(idElem.textContent.trim())) {
            student_id = idElem.textContent.trim();
        }
        if (nameElem && nameElem.textContent.trim()) {
            full_name = nameElem.textContent.trim();
        }

        // 2. Next.js Flight Data stream
        if ((!student_id || !full_name) && Array.isArray(window.__next_f)) {
            for (const chunk of window.__next_f) {
                if (Array.isArray(chunk) && typeof chunk[1] === "string") {
                    const match = chunk[1].match(/"user":\{"sub":"[^"]*","id":null,"username":"(\d{8})","displayName":"([^"]+)","email":"([^"]+)"/);
                    if (match) {
                        if (!student_id) student_id = match[1];
                        if (!full_name) full_name = match[2];
                        break;
                    }
                }
            }
        }

        // 3. Fallback H2
        if (!full_name) {
            const h2 = document.querySelector("h2");
            if (h2 && h2.textContent.trim()) {
                full_name = h2.textContent.trim();
            }
        }

        return { student_id, full_name };
    }

    // --- BACKGROUND PROFILE ENRICHMENT ---
    async function tryEnrichProfileFromHoSo(existingProfile) {
        try {
            let rawText = "";

            // 1. Kiểm tra nếu đang ở trang /sinh-vien/ho-so và có sẵn window.__next_f
            if (Array.isArray(window.__next_f)) {
                for (const chunk of window.__next_f) {
                    if (Array.isArray(chunk) && typeof chunk[1] === "string" && chunk[1].includes('"academic":')) {
                        rawText = chunk[1];
                        break;
                    }
                }
            }

            // 2. Nếu chưa có, fetch thẳng /sinh-vien/ho-so (session cookie gửi tự động)
            if (!rawText) {
                const res = await fetch("/sinh-vien/ho-so", { credentials: "include" });
                if (res.ok) {
                    rawText = await res.text();
                }
            }

            if (rawText) {
                // Xử lý unescape nếu nằm trong chuỗi flight data JSON của Next.js
                const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

                const extractMatch = (regex) => {
                    const m = unescaped.match(regex);
                    return m && m[1] ? m[1].trim() : "";
                };

                const studentCode = extractMatch(/"studentCode"\s*:\s*"(\d{8})"/i) || extractMatch(/"student_code"\s*:\s*"(\d{8})"/i);
                const fullName = extractMatch(/"fullName"\s*:\s*"([^"]+)"/i) || extractMatch(/"full_name"\s*:\s*"([^"]+)"/i);
                const className = extractMatch(/"class_name"\s*:\s*"([^"]+)"/i) || extractMatch(/"student_class"\s*:\s*"([^"]+)"/i);
                const specialization = extractMatch(/"specialization"\s*:\s*"([^"]+)"/i);
                const faculty = extractMatch(/"faculty_name"\s*:\s*"([^"]+)"/i) || extractMatch(/"faculty"\s*:\s*"([^"]+)"/i);
                const majorCode = extractMatch(/"major_name"\s*:\s*"([^"]+)"/i) || extractMatch(/"major_code"\s*:\s*"([^"]+)"/i);
                const trainingProgram = extractMatch(/"training_program"\s*:\s*"([^"]+)"/i) || extractMatch(/"curriculum_code"\s*:\s*"([^"]+)"/i);
                const cohort = extractMatch(/"cohort_label"\s*:\s*"([^"]+)"/i) || extractMatch(/"admission_year"\s*:\s*"([^"]+)"/i);

                if (studentCode && !existingProfile.student_id) existingProfile.student_id = studentCode;
                if (fullName && !existingProfile.full_name) existingProfile.full_name = fullName;
                if (className) existingProfile.student_class = className;
                if (specialization) existingProfile.specialization = specialization;
                if (faculty) existingProfile.faculty = faculty;
                if (majorCode) existingProfile.major_code = majorCode;
                if (trainingProgram) existingProfile.curriculum_code = trainingProgram;
                if (cohort) existingProfile.cohort = cohort;
            }

            // Fallback: DOM query selector nếu trang render static
            if (!existingProfile.student_class || !existingProfile.specialization) {
                const doc = new DOMParser().parseFromString(rawText, "text/html");
                const nodes = Array.from(doc.querySelectorAll("div, span, td, p, dt, dd"));
                const findVal = (label) => {
                    const l = label.toLowerCase();
                    const node = nodes.find(n => n.textContent?.trim().toLowerCase().startsWith(l));
                    if (!node) return "";
                    const valNode = node.nextElementSibling || node.parentElement?.querySelector(".font-medium, .font-semibold, dd") || node.parentElement?.children[1];
                    return valNode?.textContent?.trim() || "";
                };

                if (!existingProfile.student_class) existingProfile.student_class = findVal("lớp sinh hoạt") || findVal("lớp");
                if (!existingProfile.specialization) existingProfile.specialization = findVal("chuyên ngành") || findVal("ngành");
                if (!existingProfile.faculty) existingProfile.faculty = findVal("khoa");
            }
        } catch (_) {}
        return existingProfile;
    }

    // --- MAIN ENGINE ---
    let harvestRunning = false;
    async function runAutoHarvester() {
        if (harvestRunning) return;
        harvestRunning = true;

        console.log("[Diark OS] Starting Auto-Harvester Engine...");
        showPill("<span>⚡ Diark OS: Đang kiểm tra phiên làm việc...</span>", "info");

        // 1. Fetch official Transcript API
        let transcriptData = null;
        try {
            const res = await fetch("/api/sinh-vien/bang-diem", { credentials: "include" });
            if (!res.ok) {
                harvestRunning = false;
                return false;
            }
            transcriptData = await res.json();
        } catch (e) {
            harvestRunning = false;
            return false;
        }

        if (!transcriptData || !transcriptData.bySemester) {
            harvestRunning = false;
            return false;
        }

        showPill("<span>📥 Đã nhận diện phiên đăng nhập! Đang kéo Bảng điểm & DRL...</span>", "info");

        // 2. Fetch official DRL API
        let drlData = null;
        try {
            const drlRes = await fetch("/api/sinh-vien/diem-ren-luyen", { credentials: "include" });
            if (drlRes.ok) {
                drlData = await drlRes.json();
            }
        } catch (_) {}

        // 3. Extract Student Identity
        const identity = extractStudentIdentityFromDOM();
        let studentClass = "";
        if (drlData?.training_point_history && Array.isArray(drlData.training_point_history)) {
            for (const item of drlData.training_point_history) {
                if (item.specialized_class_name && item.specialized_class_name.trim()) {
                    studentClass = item.specialized_class_name.trim();
                    break;
                }
            }
        }

        let profile = {
            student_id: identity.student_id || "",
            full_name: identity.full_name || "",
            faculty: "",
            major_code: "",
            specialization: "",
            student_class: studentClass,
            curriculum_code: ""
        };

        // 4. Enrich Profile from /sinh-vien/ho-so in background (quick non-blocking)
        try {
            profile = await tryEnrichProfileFromHoSo(profile);
        } catch (_) {}

        // 5. Construct Unified Payload
        const unifiedPayload = {
            ...transcriptData,
            drl: drlData,
            profile: profile
        };

        console.log("[Diark OS] Unified payload assembled:", {
            student_id: profile.student_id,
            student_name: profile.full_name,
            class: profile.student_class,
            semesters: transcriptData.bySemester?.semester_groups?.length || 0,
            has_drl: Boolean(drlData),
            total_program_credit: transcriptData.byCtdt?.statistics?.total_program_credit
        });

        // 6. Push to Diark OS Local Sync Server (Port 3030)
        showPill("<span>💾 Đang nạp dữ liệu vào Diark OS (SQLite)...</span>", "info");
        try {
            const syncResponse = await fetch(LOCAL_SYNC_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(unifiedPayload)
            });

            if (syncResponse.ok) {
                const json = await syncResponse.json();
                console.log("[Diark OS] Sync Server Response:", json);
                showPill("<span>✅ Đồng bộ thành công 100%! Cửa sổ sẽ đóng lại...</span>", "success");

                // Dispatch callback scheme to close Webview window
                setTimeout(() => {
                    window.location.href = "diark-sso://callback#target=portal&status=success";
                }, 1000);
                return true;
            } else {
                throw new Error("Sync server returned status " + syncResponse.status);
            }
        } catch (err) {
            console.warn("[Diark OS] Local server sync failed, falling back to scheme navigation:", err);
            // Fallback: Dispatch via diark-sso scheme
            showPill("<span>✅ Đã chuyển dữ liệu về ứng dụng...</span>", "success");
            const fallbackUri = "diark-sso://callback#target=academic&data=" + encodeURIComponent(JSON.stringify(unifiedPayload));
            window.location.href = fallbackUri;
            return true;
        }
    }

    // --- LIFECYCLE POLLER ---
    let pollInterval = null;
    function startPoller() {
        const hostname = (window.location.hostname || "").toLowerCase();
        // Skip Microsoft login pages
        if (hostname.includes("microsoft") || hostname.includes("live.com") || hostname.includes("msft")) {
            return;
        }

        if (!hostname.includes("portal.uit.edu.vn")) {
            return;
        }

        let attempts = 0;
        const maxAttempts = 120; // 120 x 1s = 2 minutes

        pollInterval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(pollInterval);
                showPill("<span>⚠️ Quá thời gian chờ đăng nhập UIT.</span>", "error");
                return;
            }

            const success = await runAutoHarvester();
            if (success) {
                clearInterval(pollInterval);
            }
        }, 1000);
    }

    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", startPoller);
    } else {
        startPoller();
    }
})();
