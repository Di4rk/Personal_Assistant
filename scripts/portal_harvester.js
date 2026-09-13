(() => {
    // RÀNG BUỘC P0: TUYỆT ĐỐI CẤM TRUY CẬP document.cookie HOẶC HEADER CHỨA SESSION
    if (window.__DIARK_PORTAL_HARVESTER_V2__) return;
    window.__DIARK_PORTAL_HARVESTER_V2__ = true;

    const HARVEST_STORAGE_KEY = "__DIARK_PORTAL_HARVEST_BUFFER__";
    const BATCH_SIZE = 20; // An toàn tuyệt đối cho URL Scheme length limit (< 4KB)

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Auth Gatekeeper: Nếu đang ở màn hình đăng nhập CAS / SSO, chờ người dùng đăng nhập
    function isAuthGateScreen() {
        const host = (window.location.hostname || "").toLowerCase();
        const path = (window.location.pathname || "").toLowerCase();
        return host.includes("dangnhap") || host.includes("cas") || path.includes("/login") || path.includes("/cas");
    }

    async function waitForElement(selector, timeout = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            const hasPulse = el && (el.classList.contains("animate-pulse") || el.querySelector('.animate-pulse'));
            if (el && !hasPulse) return el;
            await sleep(150);
        }
        return null;
    }

    async function triggerSyntheticClick(el) {
        if (!el) return;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        el.click();
        await sleep(350);
        const start = Date.now();
        while (Date.now() - start < 6000) {
            const pulses = document.querySelectorAll('.animate-pulse');
            if (pulses.length === 0) break;
            await sleep(150);
        }
    }

    // --- BƯỚC 1: CÀO HỒ SƠ HỌC VỤ (/sinh-vien/ho-so) ---
    async function scrapeProfile() {
        console.log("[Diark Harvester] Scraping Profile at /sinh-vien/ho-so...");

        let fullName = "";
        let studentId = "";
        let faculty = "";
        let specialization = "";
        let curriculumCode = "";
        let studentClass = "";

        for (let attempt = 0; attempt < 60; attempt++) {
            if (isAuthGateScreen()) {
                console.log("[Diark Harvester] Login screen detected. Idling...");
                await sleep(1000);
                continue;
            }

            // A. Định danh: document.querySelector('h2').innerText.trim()
            const h2El = document.querySelector('h2');
            if (h2El && h2El.innerText.trim()) {
                fullName = h2El.innerText.trim();
            }

            // B. Tab Học vụ: Trigger button[role="tab"] với innerText === 'Học vụ'
            const hocVuBtn = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.innerText.trim() === 'Học vụ');
            if (hocVuBtn && hocVuBtn.getAttribute('aria-selected') !== 'true') {
                await triggerSyntheticClick(hocVuBtn);
                await sleep(300);
            }

            // Container: div[role="tabpanel"] chứa "Thông tin học vụ"
            const panels = Array.from(document.querySelectorAll('div[role="tabpanel"]'));
            const tabpanel = panels.find(p => (p.innerText || '').includes("Thông tin học vụ")) || document.querySelector('div[role="tabpanel"]');

            if (tabpanel) {
                const text = tabpanel.innerText || '';
                const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

                const getValueAfterLabel = (label) => {
                    const target = label.toUpperCase();
                    const idx = lines.findIndex(l => l.toUpperCase() === target || l.toUpperCase().startsWith(target + ":") || l.toUpperCase() === target + ":");
                    if (idx !== -1) {
                        if (lines[idx].includes(':')) {
                            const parts = lines[idx].split(':');
                            if (parts.length > 1 && parts[1].trim()) return parts[1].trim();
                        }
                        if (idx + 1 < lines.length) {
                            return lines[idx + 1];
                        }
                    }
                    return "";
                };

                const getDomLabelValue = (label) => {
                    const target = label.toUpperCase();
                    const allEls = Array.from(tabpanel.querySelectorAll('*'));
                    for (const el of allEls) {
                        if (el.children.length === 0 && el.innerText.trim().toUpperCase() === target) {
                            const next = el.nextElementSibling || (el.parentElement ? el.parentElement.children[1] : null);
                            if (next && next.innerText.trim()) return next.innerText.trim();
                        }
                    }
                    return "";
                };

                const getField = (label) => getValueAfterLabel(label) || getDomLabelValue(label);

                const rawId = getField("MÃ SINH VIÊN");
                if (/^\d{8}$/.test(rawId)) {
                    studentId = rawId;
                } else {
                    const fallbackId = lines.find(l => /^\d{8}$/.test(l));
                    if (fallbackId) studentId = fallbackId;
                }

                faculty = getField("KHOA");
                specialization = getField("CHUYÊN NGÀNH");
                curriculumCode = getField("CTĐT CỤ THỂ");
                studentClass = getField("LỚP SINH HOẠT");

                if (studentId) break;
            }

            await sleep(1000);
        }

        if (!studentId) {
            console.warn("[Diark Harvester] Cannot find student ID on /sinh-vien/ho-so after waiting.");
            return;
        }

        const profileData = {
            student_id: studentId,
            full_name: fullName || document.querySelector("header button span.text-sm")?.innerText.trim() || "",
            faculty: faculty || "CNTT",
            major_code: "",
            specialization: specialization || "Khoa học Máy tính",
            student_class: studentClass || "",
            curriculum_code: curriculumCode || ""
        };

        console.log("[Diark Harvester] Scraped profile successfully:", profileData);
        let buffer = JSON.parse(sessionStorage.getItem(HARVEST_STORAGE_KEY) || "{}");
        buffer.profile = profileData;
        sessionStorage.setItem(HARVEST_STORAGE_KEY, JSON.stringify(buffer));

        // Điều hướng sang DRL
        window.location.href = "https://portal.uit.edu.vn/sinh-vien/diem-ren-luyen";
    }

    // --- BƯỚC 2: CÀO ĐIỂM RÈN LUYỆN (/sinh-vien/diem-ren-luyen) ---
    function normalizeDrlSemester(rawText) {
        if (!rawText) return "";
        const clean = rawText.replace(/\s+/g, ' ').trim();
        const m = clean.match(/(?:Học\s*kỳ|HK)\s*(\d+|hè|he).*?(\d{4})\s*[-–_]\s*(\d{4})/i);
        if (m) {
            let term = m[1].toLowerCase();
            if (term === 'hè' || term === 'he') term = '3';
            return `HK${term}_${m[2]}_${m[3]}`;
        }
        return clean;
    }

    async function scrapeDrl() {
        console.log("[Diark Harvester] Scraping DRL at /sinh-vien/diem-ren-luyen...");
        await waitForElement("table tbody tr");

        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        const drlRecords = [];
        let sumScore = 0;
        let validCount = 0;

        rows.forEach(r => {
            const cells = r.querySelectorAll('td');
            // Contract: td[1] = semester, td[3] = score, td[4] = grade_text
            if (cells.length >= 4) {
                const rawSem = cells[1]?.innerText?.trim() || "";
                const rawScore = cells[3]?.innerText?.trim() || "";
                const gradeText = cells[4]?.innerText?.trim() || "";

                const semester = normalizeDrlSemester(rawSem);
                const score = parseInt(rawScore, 10);

                if (semester && !isNaN(score)) {
                    drlRecords.push({
                        semester: semester,
                        score: score,
                        grade_text: gradeText
                    });
                    sumScore += score;
                    validCount++;
                }
            }
        });

        // Điểm TB toàn khóa nếu có hero block hoặc tính trung bình
        let avgDrl = validCount > 0 ? parseFloat((sumScore / validCount).toFixed(1)) : 0.0;
        const heroBlocks = Array.from(document.querySelectorAll('div, p, span'));
        for (let b of heroBlocks) {
            if ((b.innerText || '').includes("Trung bình toàn khóa") || (b.innerText || '').includes("Điểm TB")) {
                const numMatch = (b.innerText || '').match(/(\d+\.?\d*)/);
                if (numMatch) {
                    avgDrl = parseFloat(numMatch[1]);
                    break;
                }
            }
        }

        console.log(`[Diark Harvester] Scraped DRL successfully: ${drlRecords.length} records, avg: ${avgDrl}`);
        let buffer = JSON.parse(sessionStorage.getItem(HARVEST_STORAGE_KEY) || "{}");
        buffer.avg_drl = avgDrl;
        buffer.drl_records = drlRecords;
        sessionStorage.setItem(HARVEST_STORAGE_KEY, JSON.stringify(buffer));

        // Điều hướng sang Bảng điểm
        window.location.href = "https://portal.uit.edu.vn/sinh-vien/bang-diem";
    }

    // --- BƯỚC 3: CÀO BẢNG ĐIỂM & TIẾN ĐỘ (/sinh-vien/bang-diem) ---
    async function scrapeTranscript() {
        console.log("[Diark Harvester] Scraping Transcript & Semesters at /sinh-vien/bang-diem...");
        await waitForElement('button[role="tab"]');

        const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
        const tabSummary = tabs[0] || tabs.find(t => (t.innerText || '').includes('Tổng kết') || (t.innerText || '').includes('theo kỳ'));
        const tabDetail = tabs[1] || tabs.find(t => (t.innerText || '').includes('Chi tiết') || (t.innerText || '').includes('môn học'));

        // Slot 0: 'Tổng kết theo kỳ' (tabs[0])
        if (tabSummary) {
            await triggerSyntheticClick(tabSummary);
            await waitForElement('div[role="tabpanel"] table tbody tr');
        }

        const semesterSummaries = [];
        const summaryRows = Array.from(document.querySelectorAll('div[role="tabpanel"] table tbody tr'));
        summaryRows.forEach(r => {
            const cells = r.querySelectorAll('td');
            if (cells.length >= 7) {
                const semester = cells[0]?.innerText?.trim() || "";
                const gpaSemester = parseFloat(cells[1]?.innerText?.trim().replace(',', '.') || "0");
                const cpaCumulative = parseFloat(cells[2]?.innerText?.trim().replace(',', '.') || "0");
                const ranking = cells[3]?.innerText?.trim() || "";
                const creditsSemester = parseInt(cells[5]?.innerText?.trim() || "0", 10);
                const creditsCumulative = parseInt(cells[6]?.innerText?.trim() || "0", 10);

                if (semester) {
                    semesterSummaries.push({
                        semester: semester,
                        gpa_semester: isNaN(gpaSemester) ? null : gpaSemester,
                        cpa_cumulative: isNaN(cpaCumulative) ? null : cpaCumulative,
                        ranking: ranking,
                        credits_semester: isNaN(creditsSemester) ? null : creditsSemester,
                        credits_cumulative: isNaN(creditsCumulative) ? null : creditsCumulative
                    });
                }
            }
        });

        // Slot 1: 'Chi tiết môn học' (tabs[1])
        const freshTabs = Array.from(document.querySelectorAll('button[role="tab"]'));
        const activeTabDetail = freshTabs[1] || freshTabs.find(t => (t.innerText || '').includes('Chi tiết') || (t.innerText || '').includes('môn học'));
        if (activeTabDetail) {
            await triggerSyntheticClick(activeTabDetail);
            await waitForElement('div[role="tabpanel"] table');
            await sleep(400);
        }

        // Hero Metrics: Text chứa "TC tích lũy <TC> GPA toàn khóa <GPA>"
        let totalEarnedCredits = 0.0;
        let cumulativeGpa10 = 0.0;

        const panel = document.querySelector('div[role="tabpanel"]');
        const panelText = panel ? panel.innerText : document.body.innerText;

        const tcMatch = panelText.match(/TC\s*tích\s*lũy\s*[:\s]*(\d+)/i);
        if (tcMatch) totalEarnedCredits = parseFloat(tcMatch[1]);

        const gpaMatch = panelText.match(/GPA\s*(?:toàn\s*khóa|tích\s*lũy)\s*[:\s]*([\d\.,]+)/i);
        if (gpaMatch) cumulativeGpa10 = parseFloat(gpaMatch[1].replace(',', '.'));

        const parseScore = (text) => {
            if (!text) return null;
            const clean = text.trim();
            if (clean === '—' || clean === '-' || clean === '' || clean === 'null') return null;
            const val = parseFloat(clean.replace(',', '.'));
            return isNaN(val) ? null : val;
        };

        const courses = [];
        const courseTables = Array.from(document.querySelectorAll('div[role="tabpanel"] table'));

        courseTables.forEach(tbl => {
            let semesterName = "Unknown";
            let prev = tbl.previousElementSibling;
            while (prev) {
                if (/Học kỳ|Năm học|HK/i.test(prev.innerText || '')) {
                    semesterName = prev.innerText.trim();
                    break;
                }
                prev = prev.previousElementSibling;
            }
            if (semesterName === "Unknown" && tbl.parentElement) {
                const h = tbl.parentElement.querySelector('h2, h3, h4, div.font-semibold, div.font-bold');
                if (h && /Học kỳ|Năm học|HK/i.test(h.innerText || '')) {
                    semesterName = h.innerText.trim();
                }
            }

            const rows = Array.from(tbl.querySelectorAll('tbody tr'));
            rows.forEach(r => {
                const cells = r.querySelectorAll('td');
                if (cells.length >= 8) {
                    const courseCode = cells[0]?.innerText?.trim() || "";
                    const courseName = cells[1]?.innerText?.trim() || "";
                    const credits = parseInt(cells[2]?.innerText?.trim() || "0", 10);
                    const scoreQt = parseScore(cells[3]?.innerText);
                    const scoreTh = parseScore(cells[4]?.innerText);
                    const scoreGk = parseScore(cells[5]?.innerText);
                    const scoreCk = parseScore(cells[6]?.innerText);
                    const score10 = parseScore(cells[7]?.innerText) || 0.0;
                    const isPassed = score10 >= 5.0 ? 1 : 0;

                    if (courseCode && courseName) {
                        courses.push({
                            course_code: courseCode,
                            course_name: courseName,
                            semester: semesterName,
                            credits: isNaN(credits) ? 0 : credits,
                            score_qt: scoreQt,
                            score_th: scoreTh,
                            score_gk: scoreGk,
                            score_ck: scoreCk,
                            score_10: score10,
                            is_passed: isPassed
                        });
                    }
                }
            });
        });

        console.log(`[Diark Harvester] Scraped transcript successfully: ${courses.length} courses, ${semesterSummaries.length} semester summaries`);

        let buffer = JSON.parse(sessionStorage.getItem(HARVEST_STORAGE_KEY) || "{}");
        buffer.summary = {
            total_credits: totalEarnedCredits,
            cgpa_10: cumulativeGpa10,
            semester_summaries: semesterSummaries
        };
        buffer.courses = courses;

        await dispatchHarvestedData(buffer);
    }

    // --- BƯỚC 4: DISPATCH VIA SEQUENTIAL TOP-LEVEL QUEUE ---
    async function dispatchHarvestedData(fullPayload) {
        console.log("[Diark Harvester] Dispatching payload via Sequential Top-Level Navigation Queue...");
        sessionStorage.removeItem(HARVEST_STORAGE_KEY);

        const courses = fullPayload.courses || [];
        const totalBatches = Math.ceil(courses.length / BATCH_SIZE) || 1;

        const queue = [];

        // 1. Meta batch
        const metaPayload = {
            profile: fullPayload.profile,
            summary: fullPayload.summary,
            avg_drl: fullPayload.avg_drl,
            drl_records: fullPayload.drl_records,
            total_course_batches: totalBatches
        };
        queue.push(`diark-sso://partial#target=portal_meta&data=${encodeURIComponent(JSON.stringify(metaPayload))}`);

        // 2. Chunks khóa học (cách nhau an toàn)
        for (let i = 0; i < totalBatches; i++) {
            const chunk = courses.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            queue.push(`diark-sso://partial#target=portal_courses&batch_idx=${i}&data=${encodeURIComponent(JSON.stringify(chunk))}`);
        }

        // 3. Commit callback cuối cùng
        queue.push(`diark-sso://callback#target=portal&action=commit&total_courses=${courses.length}`);

        for (let i = 0; i < queue.length; i++) {
            console.log(`[Diark Harvester] Emitting navigation step ${i + 1}/${queue.length}`);
            window.location.href = queue[i];
            await sleep(90); // 80ms - 100ms safe interval
        }
    }

    // --- KHỞI TẠO HARVESTER THEO ĐÚNG ROUTE ---
    const path = (window.location.pathname || "").toLowerCase();
    const host = (window.location.hostname || "").toLowerCase();

    const startHarvester = async () => {
        if (isAuthGateScreen()) {
            console.log("[Diark Harvester] SSO Login screen detected. Harvester waiting for authentication...");
            const intervalId = setInterval(() => {
                if (!isAuthGateScreen()) {
                    clearInterval(intervalId);
                    console.log("[Diark Harvester] Authenticated! Starting harvester...");
                    startHarvester();
                }
            }, 1000);
            return;
        }

        await sleep(500);

        if (path.includes('/sinh-vien/ho-so')) {
            await scrapeProfile();
        } else if (path.includes('/sinh-vien/diem-ren-luyen')) {
            await scrapeDrl();
        } else if (path.includes('/sinh-vien/bang-diem')) {
            await scrapeTranscript();
        } else if (host.includes('portal.uit.edu.vn') && (path === '/' || path === '' || path.includes('/home') || path.includes('/trang-chu') || path === '/sinh-vien')) {
            console.log("[Diark Harvester] Redirecting to /sinh-vien/ho-so...");
            window.location.href = "https://portal.uit.edu.vn/sinh-vien/ho-so";
        }
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', startHarvester);
    } else {
        startHarvester();
    }
})();
