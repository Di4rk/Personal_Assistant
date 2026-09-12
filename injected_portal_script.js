(() => {
    // RÀNG BUỘC P0: TUYỆT ĐỐI CẤM TRUY CẬP document.cookie HOẶC HEADER CHỨA SESSION
    if (window.__DIARK_PORTAL_HARVESTER_V2__) return;
    window.__DIARK_PORTAL_HARVESTER_V2__ = true;

    const HARVEST_STORAGE_KEY = "__DIARK_PORTAL_HARVEST_BUFFER__";
    const BATCH_SIZE = 20; // An toàn tuyệt đối cho URL Scheme length limit (< 4KB)

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitForElement(selector, timeout = 7000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            // Kiểm tra kỹ cả element và subtree xem còn skeleton pulse hay không
            const hasPulse = el && (el.classList.contains("animate-pulse") || el.querySelector('.animate-pulse'));
            if (el && !hasPulse) return el;
            await sleep(150);
        }
        return null;
    }

    // --- BƯỚC 1: CÀO HỒ SƠ HỌC VỤ ---
    async function scrapeProfile() {
        console.log("[Diark Harvester] Scraping Profile...");

        const getValueByLabel = (label) => {
            const divs = Array.from(document.querySelectorAll('div, tr, p, dt, dd, td'));
            for (let el of divs) {
                if (el.children.length === 0 && el.textContent.trim().toUpperCase() === label.toUpperCase()) {
                    const parent = el.parentElement;
                    const nextEl = el.nextElementSibling || (parent ? parent.children[1] : null);
                    if (nextEl) return nextEl.textContent.trim();
                }
            }
            return "";
        };

        // Chờ người dùng đăng nhập nếu đang ở màn hình login (chờ tối đa 120s)
        let studentId = "";
        for (let attempt = 0; attempt < 120; attempt++) {
            // Chuyển sang tab Học vụ nếu có
            const tabs = Array.from(document.querySelectorAll('button, a'));
            const hocVuTab = tabs.find(t => t.textContent.trim() === 'Học vụ');
            if (hocVuTab) {
                hocVuTab.click();
                await sleep(300);
            }

            studentId = getValueByLabel("MÃ SINH VIÊN") || 
                        document.querySelector("header button span.text-xs")?.textContent.trim() || "";

            // Fallback trích xuất từ Next.js flight chunk nếu có
            if (!studentId && Array.isArray(window.__next_f)) {
                for (const chunk of window.__next_f) {
                    if (Array.isArray(chunk) && typeof chunk[1] === 'string') {
                        const m = chunk[1].match(/"user":\{"sub":"[^"]*","id":null,"username":"(\d{8})"/);
                        if (m) {
                            studentId = m[1];
                            break;
                        }
                    }
                }
            }

            if (studentId && studentId.length >= 5) break;
            await sleep(1000);
        }

        // Guard chống student_id rỗng sau khi chờ
        if (!studentId || studentId.length < 5) {
            window.location.href = "diark-sso://failed#reason=INVALID_STUDENT_ID";
            return;
        }

        const profileData = {
            student_id: studentId,
            full_name: document.querySelector("h1 + span, header button span.text-sm")?.textContent.trim() || "",
            faculty: getValueByLabel("KHOA") || "CNTT",
            specialization: getValueByLabel("CHUYÊN NGÀNH") || "Khoa học Máy tính",
            student_class: getValueByLabel("LỚP SINH HOẠT") || "",
            curriculum_code: getValueByLabel("CTĐT CỤ THỂ") || ""
        };

        let buffer = JSON.parse(sessionStorage.getItem(HARVEST_STORAGE_KEY) || "{}");
        buffer.profile = profileData;
        sessionStorage.setItem(HARVEST_STORAGE_KEY, JSON.stringify(buffer));

        // Điều hướng thuần túy (Không có markdown artifact)
        window.location.href = "https://portal.uit.edu.vn/sinh-vien/diem-ren-luyen";
    }

    // --- BƯỚC 2: CÀO ĐIỂM RÈN LUYỆN ---
    async function scrapeDrl() {
        console.log("[Diark Harvester] Scraping DRL...");
        await waitForElement("table tbody tr");

        let avgDrl = 0;
        const heroBlocks = Array.from(document.querySelectorAll('div'));
        for (let b of heroBlocks) {
            if (b.textContent.includes("Trung bình toàn khóa") || b.textContent.includes("Điểm TB")) {
                const numMatch = b.textContent.match(/(\d+\.?\d*)/);
                if (numMatch) {
                    avgDrl = parseFloat(numMatch[1]);
                    break;
                }
            }
        }

        const drlList = [];
        const rows = document.querySelectorAll('table tbody tr');
        rows.forEach(r => {
            const cells = r.querySelectorAll('td');
            if (cells.length >= 3) {
                const semesterText = cells[1]?.textContent.replace(/\s+/g, ' ').trim() || cells[0]?.textContent.replace(/\s+/g, ' ').trim() || "";
                let scoreText = "0";
                let gradeText = "";

                if (cells.length >= 4) {
                    scoreText = cells[3]?.textContent.trim() || cells[2]?.textContent.trim() || "0";
                    gradeText = cells[4]?.textContent.trim() || "";
                } else {
                    scoreText = cells[2]?.textContent.trim() || "0";
                }
                
                if (semesterText && scoreText) {
                    drlList.push({
                        semester: semesterText,
                        score: parseInt(scoreText, 10) || 0,
                        grade_text: gradeText
                    });
                }
            }
        });

        let buffer = JSON.parse(sessionStorage.getItem(HARVEST_STORAGE_KEY) || "{}");
        buffer.avg_drl = avgDrl;
        buffer.drl_records = drlList;
        sessionStorage.setItem(HARVEST_STORAGE_KEY, JSON.stringify(buffer));

        window.location.href = "https://portal.uit.edu.vn/sinh-vien/bang-diem";
    }

    // --- BƯỚC 3: CÀO BẢNG ĐIỂM & TIẾN ĐỘ ---
    async function scrapeTranscript() {
        console.log("[Diark Harvester] Scraping Transcript & Semesters...");
        await waitForElement('div[role="tablist"] button, button[role="tab"]');

        const tabs = Array.from(document.querySelectorAll('div[role="tablist"] button[role="tab"], button[role="tab"], [role="tablist"] button, nav button, button'));
        const tabSummary = tabs.find(t => t.textContent.includes('Tổng kết') || t.textContent.includes('theo kỳ')) || tabs[0];
        const tabDetail = tabs.find(t => t.textContent.includes('Chi tiết') || t.textContent.includes('môn học')) || tabs[1];

        // Slot 1: Tổng kết theo kỳ
        if (tabSummary) {
            tabSummary.click();
            await sleep(500);
            await waitForElement('table tbody tr');
        }

        const semesterSummaries = [];
        document.querySelectorAll('table tbody tr').forEach(r => {
            const cells = r.querySelectorAll('td');
            if (cells.length >= 6) {
                semesterSummaries.push({
                    semester: cells[0]?.textContent.trim() || cells[1]?.textContent.trim() || "",
                    gpa_semester: parseFloat(cells[1]?.textContent.trim().replace(',', '.') || cells[4]?.textContent.trim().replace(',', '.') || "0"),
                    cpa_cumulative: parseFloat(cells[2]?.textContent.trim().replace(',', '.') || cells[6]?.textContent.trim().replace(',', '.') || "0"),
                    ranking: cells[3]?.textContent.trim() || cells[9]?.textContent.trim() || "",
                    credits_semester: parseInt(cells[5]?.textContent.trim() || cells[2]?.textContent.trim() || "0", 10),
                    credits_cumulative: parseInt(cells[6]?.textContent.trim() || cells[3]?.textContent.trim() || "0", 10)
                });
            }
        });

        // Slot 2: Chi tiết môn học
        if (tabDetail) {
            tabDetail.click();
            await sleep(600);
            await waitForElement('table');
        }

        const parseHeroMetric = (label) => {
            const cards = Array.from(document.querySelectorAll('div'));
            for (let c of cards) {
                if (c.children.length === 0 && c.textContent.trim().toLowerCase() === label.toLowerCase()) {
                    const p = c.parentElement;
                    const val = p ? p.querySelector('.text-2xl, div:nth-child(2)') : null;
                    if (val) return parseFloat(val.textContent.replace(',', '.').trim());
                }
            }
            return 0.0;
        };

        const totalEarnedCredits = parseHeroMetric("TC tích lũy");
        const cumulativeGpa10 = parseHeroMetric("GPA tích lũy");

        const courses = [];
        document.querySelectorAll('table').forEach(tbl => {
            let prevHeader = tbl.parentElement?.querySelector('h2, h3, div.font-semibold');
            if (!prevHeader) {
                let prev = tbl.previousElementSibling;
                while (prev && !prevHeader) {
                    if (/Học kỳ|Năm học|HK/i.test(prev.textContent || '')) {
                        prevHeader = prev;
                        break;
                    }
                    prev = prev.previousElementSibling;
                }
            }
            const semesterName = prevHeader ? prevHeader.textContent.trim() : "Unknown";

            tbl.querySelectorAll('tbody tr').forEach(r => {
                const cells = r.querySelectorAll('td');
                if (cells.length >= 4) {
                    let codeIdx = -1;
                    if (/^[A-Z]{2,5}\d{2,4}/i.test(cells[0]?.textContent?.trim() || '')) codeIdx = 0;
                    else if (/^[A-Z]{2,5}\d{2,4}/i.test(cells[1]?.textContent?.trim() || '')) codeIdx = 1;

                    if (codeIdx >= 0) {
                        const code = cells[codeIdx]?.textContent.trim();
                        const name = cells[codeIdx + 1]?.textContent.trim() || '';
                        let cred = 0;
                        for (let c = codeIdx + 2; c < Math.min(cells.length, codeIdx + 5); c++) {
                            const val = parseInt(cells[c]?.textContent.trim() || '0', 10);
                            if (!isNaN(val) && val >= 1 && val <= 15 && /^\d+$/.test(cells[c]?.textContent.trim() || '')) {
                                cred = val;
                                break;
                            }
                        }
                        let score10 = 0.0;
                        for (let s = cells.length - 1; s > codeIdx + 1; s--) {
                            const parsed = parseFloat(cells[s]?.textContent.trim().replace(',', '.') || '0');
                            if (!isNaN(parsed) && parsed >= 0.0 && parsed <= 10.0 && /^\d+(\.\d+)?$/.test(cells[s]?.textContent.trim().replace(',', '.') || '')) {
                                score10 = parsed;
                                break;
                            }
                        }
                        courses.push({
                            course_code: code,
                            course_name: name,
                            semester: semesterName,
                            credits: cred,
                            score_10: score10,
                            is_passed: score10 >= 5.0 ? 1 : 0
                        });
                    } else if (cells.length >= 8) {
                        const code = cells[0]?.textContent.trim();
                        const name = cells[1]?.textContent.trim();
                        const cred = parseInt(cells[2]?.textContent.trim() || "0", 10);
                        const rawScore = parseFloat(cells[7]?.textContent.trim().replace(',', '.') || "0");
                        if (code && name) {
                            courses.push({
                                course_code: code,
                                course_name: name,
                                semester: semesterName,
                                credits: cred,
                                score_10: rawScore,
                                is_passed: rawScore >= 5.0 ? 1 : 0
                            });
                        }
                    }
                }
            });
        });

        let buffer = JSON.parse(sessionStorage.getItem(HARVEST_STORAGE_KEY) || "{}");
        buffer.summary = {
            total_credits: totalEarnedCredits,
            cgpa_10: cumulativeGpa10,
            semester_summaries: semesterSummaries
        };
        buffer.courses = courses;

        dispatchHarvestedData(buffer);
    }

    // --- BƯỚC 4: PHÂN ĐOÀN VÀ SỬ DỤNG HASH FRAGMENT SCHEMA ---
    function dispatchHarvestedData(fullPayload) {
        console.log("[Diark Harvester] Dispatching payload via Hash Fragment...");
        sessionStorage.removeItem(HARVEST_STORAGE_KEY);

        const courses = fullPayload.courses || [];
        const totalBatches = Math.ceil(courses.length / BATCH_SIZE) || 1;

        // Bắn Meta trước qua hash fragment
        const metaPayload = {
            profile: fullPayload.profile,
            summary: fullPayload.summary,
            avg_drl: fullPayload.avg_drl,
            drl_records: fullPayload.drl_records,
            total_course_batches: totalBatches
        };

        const iframeMeta = document.createElement('iframe');
        iframeMeta.style.display = 'none';
        iframeMeta.src = `diark-sso://partial#target=portal_meta&data=${encodeURIComponent(JSON.stringify(metaPayload))}`;
        document.body.appendChild(iframeMeta);

        // Bắn các batch khóa học qua hash fragment
        for (let i = 0; i < totalBatches; i++) {
            const chunk = courses.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            const iframeChunk = document.createElement('iframe');
            iframeChunk.style.display = 'none';
            iframeChunk.src = `diark-sso://partial#target=portal_courses&batch_idx=${i}&data=${encodeURIComponent(JSON.stringify(chunk))}`;
            document.body.appendChild(iframeChunk);
        }

        // Tín hiệu Commit cuối cùng khớp chuẩn hash fragment
        setTimeout(() => {
            window.location.href = `diark-sso://callback#target=portal&action=commit&total_courses=${courses.length}`;
        }, 600);
    }

    const path = window.location.pathname;
    const startHarvester = async () => {
        await sleep(600);
        if (path.includes('/sinh-vien/ho-so') || path === '/' || path === '/sinh-vien') {
            await scrapeProfile();
        } else if (path.includes('/sinh-vien/diem-ren-luyen')) {
            await scrapeDrl();
        } else if (path.includes('/sinh-vien/bang-diem')) {
            await scrapeTranscript();
        }
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', startHarvester);
    } else {
        startHarvester();
    }
})();
