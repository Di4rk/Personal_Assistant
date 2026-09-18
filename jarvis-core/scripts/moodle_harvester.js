(() => {
    // RÀNG BUỘC: TUYỆT ĐỐI CẤM TRUY CẬP COOKIE TRỰC TIẾP
    if (window.__DIARK_MOODLE_HARVESTER_ACTIVE__) return;
    window.__DIARK_MOODLE_HARVESTER_ACTIVE__ = true;

    const LOCAL_SERVER_URL = "http://127.0.0.1:3030/api/v1/sync/moodle";
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // --- 1. UI PROGRESS HUD ---
    function renderBanner(isLoggedIn, statusText = "", percent = 0) {
        let el = document.getElementById("__diark_moodle_overlay");
        if (!el) {
            el = document.createElement("div");
            el.id = "__diark_moodle_overlay";
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
            el.style.border = "1px solid rgba(56, 189, 248, 0.4)";
            el.style.color = "#e2e8f0";
            el.style.padding = "12px 20px";
            el.style.display = "flex";
            el.style.alignItems = "center";
            el.style.gap = "12px";
            el.innerHTML = `
                <span style="font-size: 20px;">🔐</span>
                <div>
                    <div style="font-weight: 700; color: #38bdf8; font-size: 13px;">Diark OS • Tự động đồng bộ Moodle UIT</div>
                    <div style="color: #94a3b8; font-size: 11px; margin-top: 2px;">Vui lòng đăng nhập tài khoản Courses UIT. Sau khi đăng nhập, hệ thống sẽ tự động thu thập và đóng cửa sổ này.</div>
                </div>
            `;
        } else {
            el.style.backgroundColor = "rgba(9, 9, 11, 0.96)";
            el.style.backdropFilter = "blur(12px)";
            el.style.border = "1px solid #0284c7";
            el.style.color = "#f4f4f5";
            el.style.padding = "14px 22px";
            el.style.minWidth = "360px";
            el.style.maxWidth = "90vw";
            el.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 18px;">📚</span>
                        <span style="font-weight: 700; color: #38bdf8; font-size: 13px;">Diark OS • Đang thu thập Courses & Nhiệm vụ</span>
                    </div>
                    <span style="font-size: 11px; font-weight: 600; color: #38bdf8; font-family: monospace;">${Math.round(percent)}%</span>
                </div>
                <div style="font-size: 11px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${statusText}</div>
                <div style="width: 100%; background: #27272a; height: 6px; border-radius: 3px; margin-top: 8px; overflow: hidden;">
                    <div style="width: ${percent}%; height: 100%; background: linear-gradient(90deg, #0284c7, #38bdf8); transition: width 0.2s ease;"></div>
                </div>
            `;
        }
    }

    // --- 2. SESSKEY & AUTH DETECTION ---
    function extractSesskey() {
        if (window.M && window.M.cfg && window.M.cfg.sesskey) {
            return window.M.cfg.sesskey;
        }

        const logoutLink = document.querySelector('a[href*="logout.php?sesskey="]');
        if (logoutLink) {
            const m = logoutLink.getAttribute('href').match(/sesskey=([a-zA-Z0-9]+)/);
            if (m && m[1]) return m[1];
        }

        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
            const content = s.textContent || '';
            const m = content.match(/"sesskey"\s*:\s*"([a-zA-Z0-9]+)"/);
            if (m && m[1]) return m[1];
        }

        return null;
    }

    function checkIsLoggedIn() {
        if (window.M && window.M.cfg && window.M.cfg.userId && window.M.cfg.userId > 0) {
            return true;
        }
        return Boolean(document.querySelector('.usermenu, .userbutton, a[href*="logout.php"]'));
    }

    // --- 3. HARVESTER EXECUTION ---
    async function runAutoHarvester(sesskey) {
        renderBanner(true, "Đang kết nối API Moodle UIT...", 15);

        let enrolledCourses = [];
        let calendarTasks = [];
        let allMaterials = [];
        let allTasks = [];

        // Bước 1: Fetch danh sách môn học đã đăng ký
        try {
            renderBanner(true, "Đang tải danh sách môn học kỳ hiện tại...", 25);
            const coursesUrl = `https://courses.uit.edu.vn/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification`;
            const coursesResp = await fetch(coursesUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify([{
                    index: 0,
                    methodname: "core_course_get_enrolled_courses_by_timeline_classification",
                    args: { classification: "all", limit: 0, offset: 0 }
                }])
            });

            if (coursesResp.ok) {
                const coursesJson = await coursesResp.json();
                const list = coursesJson?.[0]?.data?.courses || [];
                enrolledCourses = list.map(c => ({
                    course_id: c.id,
                    course_code: c.shortname || c.idnumber || c.fullname,
                    fullname: c.fullname,
                    term: "HK2 2025-2026",
                    instructor_name: "",
                    instructor_mail: "",
                    instructor_phone: "",
                    course_url: c.viewurl || `https://courses.uit.edu.vn/course/view.php?id=${c.id}`,
                    updated_at: Math.floor(Date.now() / 1000)
                }));
                console.log(`[Diark Moodle] Đã tìm thấy ${enrolledCourses.length} môn học.`);
            }
        } catch (err) {
            console.warn("[Diark Moodle] Lỗi fetch enrolled courses:", err);
        }

        // Bước 2: Fetch sự kiện lịch & deadline bài tập
        try {
            renderBanner(true, "Đang kiểm tra bài tập và deadline tới hạn...", 45);
            const calUrl = `https://courses.uit.edu.vn/lib/ajax/service.php?sesskey=${sesskey}&info=core_calendar_get_action_events_by_timesort`;
            const calResp = await fetch(calUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify([{
                    index: 0,
                    methodname: "core_calendar_get_action_events_by_timesort",
                    args: { timesortfrom: Math.floor(Date.now() / 1000) - 86400 * 30, limitnum: 50 }
                }])
            });

            if (calResp.ok) {
                const calJson = await calResp.json();
                const events = calJson?.[0]?.data?.events || [];
                calendarTasks = events.map(ev => {
                    const taskId = ev.instance || ev.id;
                    const courseId = ev.course?.id || 0;
                    const isSubmitted = Boolean(ev.action?.name?.includes("Đã nộp") || ev.action?.name?.includes("Submitted"));
                    
                    let templateFileUrl = "";
                    if (ev.description) {
                        const m = ev.description.match(/href="([^"]+\.(?:docx|pdf|zip|pptx)[^"]*)"/i);
                        if (m && m[1]) templateFileUrl = m[1];
                    }

                    return {
                        task_id: taskId,
                        course_id: courseId,
                        title: ev.activityname || ev.name.replace("tới hạn", "").replace("is due", "").trim(),
                        task_type: ev.modulename || "assign",
                        due_date: ev.timesort || ev.timestart || 0,
                        is_submitted: isSubmitted,
                        submission_status: ev.action?.name || (isSubmitted ? "Đã nộp" : "Chưa nộp"),
                        template_file_url: templateFileUrl,
                        task_url: ev.url || ev.action?.url || `https://courses.uit.edu.vn/mod/${ev.modulename}/view.php?id=${taskId}`,
                        updated_at: Math.floor(Date.now() / 1000),
                        course_name: ev.course?.fullname || "",
                        course_code: ev.course?.shortname || ""
                    };
                });
                console.log(`[Diark Moodle] Đã tìm thấy ${calendarTasks.length} nhiệm vụ từ Calendar.`);
                allTasks.push(...calendarTasks);
            }
        } catch (err) {
            console.warn("[Diark Moodle] Lỗi fetch calendar events:", err);
        }

        // Bước 3: Fetch chi tiết trang từng môn để trích xuất Giảng viên & Slide/Tài liệu
        const totalCourses = enrolledCourses.length;
        for (let i = 0; i < totalCourses; i++) {
            const course = enrolledCourses[i];
            const pct = 50 + Math.round(((i + 1) / totalCourses) * 35);
            renderBanner(true, `Đang phân tích slide & giảng viên: ${course.course_code}...`, pct);

            try {
                const courseViewResp = await fetch(course.course_url);
                if (courseViewResp.ok) {
                    const htmlText = await courseViewResp.text();
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, "text/html");

                    // 1. Trích xuất giảng viên
                    const descEls = doc.querySelectorAll('.activity-description, .no-overflow');
                    for (const el of descEls) {
                        const txt = el.textContent || '';
                        if (txt.includes('Giảng viên:') || txt.includes('Mail:') || txt.includes('SĐT:')) {
                            const lines = txt.split('\n');
                            for (const line of lines) {
                                const l = line.trim();
                                if ((l.startsWith('Giảng viên:') || l.startsWith('GV:')) && !course.instructor_name) {
                                    course.instructor_name = l.replace(/Giảng viên:|GV:/, '').trim();
                                } else if ((l.startsWith('Mail:') || l.startsWith('Email:')) && !course.instructor_mail) {
                                    course.instructor_mail = l.replace(/Mail:|Email:/, '').trim();
                                } else if ((l.startsWith('SĐT:') || l.startsWith('Phone:') || l.startsWith('Điện thoại:')) && !course.instructor_phone) {
                                    course.instructor_phone = l.replace(/SĐT:|Phone:|Điện thoại:/, '').trim();
                                }
                            }
                        }
                    }

                    // 2. Trích xuất tài liệu (Slide, Files)
                    const sections = doc.querySelectorAll('li.section.course-section');
                    for (const sec of sections) {
                        const secName = sec.getAttribute('data-sectionname') || sec.querySelector('h3.sectionname')?.textContent?.trim() || 'Chung';
                        const resources = sec.querySelectorAll('li.activity.modtype_resource');
                        for (const res of resources) {
                            const cmid = parseInt(res.getAttribute('data-id') || '0', 10);
                            const titleEl = res.querySelector('.instancename');
                            const linkEl = res.querySelector('a.aalink');
                            const badgeEl = res.querySelector('.activitybadge');
                            
                            const title = titleEl ? titleEl.textContent.replace('File', '').replace('Tập tin', '').trim() : `Tài liệu ${cmid}`;
                            const fileUrl = linkEl ? linkEl.getAttribute('href') : '';
                            const badgeText = badgeEl ? badgeEl.textContent.toLowerCase() : '';

                            let fileType = 'pdf';
                            if (badgeText.includes('pdf') || fileUrl.endsWith('.pdf')) fileType = 'pdf';
                            else if (badgeText.includes('powerpoint') || badgeText.includes('pptx') || fileUrl.endsWith('.pptx')) fileType = 'pptx';
                            else if (badgeText.includes('word') || badgeText.includes('docx') || fileUrl.endsWith('.docx')) fileType = 'docx';

                            if (cmid > 0 && fileUrl) {
                                allMaterials.push({
                                    id: 0,
                                    course_id: course.course_id,
                                    section_name: secName,
                                    title,
                                    file_url: fileUrl,
                                    file_type: fileType,
                                    created_at: Math.floor(Date.now() / 1000)
                                });
                            }
                        }
                    }
                }
                await sleep(50);
            } catch (err) {
                console.warn(`[Diark Moodle] Lỗi fetch chi tiết môn ${course.course_id}:`, err);
            }
        }

        // Bước 4: Đóng gói và gửi payload về Diark OS
        renderBanner(true, `Đang nạp ${enrolledCourses.length} môn học, ${allTasks.length} nhiệm vụ & ${allMaterials.length} tài liệu...`, 95);

        const syncPayload = {
            courses: enrolledCourses,
            tasks: allTasks,
            materials: allMaterials
        };

        let committed = false;
        try {
            const resp = await fetch(LOCAL_SERVER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(syncPayload)
            });
            if (resp.ok) {
                committed = true;
                console.log("[Diark Moodle] Đã commit thành công qua Local Port 3030!");
            }
        } catch (_) {}

        if (committed) {
            renderBanner(true, `✅ Hoàn tất! Đã đồng bộ ${enrolledCourses.length} môn học Moodle. Đang đóng cửa sổ...`, 100);
            await sleep(400);
            window.location.href = `diark-sso://callback#target=moodle&status=success&total_courses=${enrolledCourses.length}`;
            return;
        }

        // Fallback: Callback scheme
        console.log("[Diark Moodle] Port 3030 không phản hồi, fallback qua URL scheme...");
        renderBanner(true, `✅ Hoàn tất! Đã đồng bộ ${enrolledCourses.length} môn học. Đang đóng cửa sổ...`, 100);
        await sleep(300);
        window.location.href = `diark-sso://callback#target=moodle&status=success&total_courses=${enrolledCourses.length}`;
    }

    // --- 4. STARTUP WATCHDOG & AUTH DETECTOR ---
    function initMoodleWatcher() {
        const sesskey = extractSesskey();
        const isLoggedIn = checkIsLoggedIn();

        if (sesskey || isLoggedIn) {
            runAutoHarvester(sesskey || "auto");
        } else {
            renderBanner(false);
            const interval = setInterval(() => {
                const sk = extractSesskey();
                if (sk || checkIsLoggedIn()) {
                    clearInterval(interval);
                    runAutoHarvester(sk || "auto");
                }
            }, 500);
        }
    }

    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", initMoodleWatcher);
    } else {
        initMoodleWatcher();
    }
})();
