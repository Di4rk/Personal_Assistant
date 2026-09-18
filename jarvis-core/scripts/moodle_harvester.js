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

    function isLoginPage() {
        const path = window.location.pathname.toLowerCase();
        const host = window.location.hostname.toLowerCase();
        const href = window.location.href.toLowerCase();
        
        // Đang ở các endpoint đăng nhập hoặc SSO Microsoft
        if (path.includes('/login/') || 
            host.includes('microsoft') || 
            host.includes('live.com') || 
            href.includes('/auth/oidc') || 
            href.includes('/auth/saml')) {
            return true;
        }
        
        // Kiểm tra xem có form đăng nhập trên trang không
        if (document.querySelector('form#login, form.loginform, input#username, input#password, .loginform')) {
            return true;
        }
        
        return false;
    }

    function checkIsLoggedIn() {
        // 1. Kiểm tra Moodle global config
        if (window.M && window.M.cfg) {
            if (window.M.cfg.isguest) return false;
            if (typeof window.M.cfg.userId === 'number' && window.M.cfg.userId > 1) {
                return true;
            }
        }

        // 2. Kiểm tra logout link có sesskey (dấu hiệu chắc chắn 100% đã đăng nhập)
        if (document.querySelector('a[href*="logout.php?sesskey="]')) {
            return true;
        }

        // Nếu còn đang ở trang login / SSO, chắc chắn chưa đăng nhập
        if (isLoginPage()) {
            return false;
        }

        // 3. Kiểm tra các phần tử đặc trưng khi đã đăng nhập
        const hasLogout = Boolean(document.querySelector('a[href*="logout.php"]'));
        const hasUserMenu = Boolean(document.querySelector('.usermenu .usertext, .userbutton .usertext, .usermenu img.userpicture, .userpicture'));
        const isGuestNotice = Boolean(document.querySelector('.usermenu .login, .logininfo a[href*="login"]:not([href*="logout"])'));

        return (hasLogout || hasUserMenu) && !isGuestNotice;
    }

    // --- 2.1 DATE STRING PARSER ---
    function parseMoodleDateString(str) {
        if (!str || str.trim() === '-' || str.trim() === '') return 0;
        const cleanStr = str.replace(/^(?:đến hạn|due date|hạn chót|hạn nộp|due):\s*/i, '').trim();

        const directParsed = Date.parse(cleanStr);
        if (!isNaN(directParsed) && directParsed > 0) {
            return Math.floor(directParsed / 1000);
        }

        const vnMonths = {
            'một': 1, 'mot': 1, '1': 1, '01': 1, 'january': 1, 'jan': 1,
            'hai': 2, '2': 2, '02': 2, 'february': 2, 'feb': 2,
            'ba': 3, '3': 3, '03': 3, 'march': 3, 'mar': 3,
            'tư': 4, 'tu': 4, 'bốn': 4, 'bon': 4, '4': 4, '04': 4, 'april': 4, 'apr': 4,
            'năm': 5, 'nam': 5, '5': 5, '05': 5, 'may': 5,
            'sáu': 6, 'sau': 6, '6': 6, '06': 6, 'june': 6, 'jun': 6,
            'bảy': 7, 'bay': 7, '7': 7, '07': 7, 'july': 7, 'jul': 7,
            'tám': 8, 'tam': 8, '8': 8, '08': 8, 'august': 8, 'aug': 8,
            'chín': 9, 'chin': 9, '9': 9, '09': 9, 'september': 9, 'sep': 9,
            'mười': 10, 'muoi': 10, '10': 10, 'october': 10, 'oct': 10,
            'mười một': 11, 'muoi mot': 11, '11': 11, 'november': 11, 'nov': 11,
            'mười hai': 12, 'muoi hai': 12, '12': 12, 'december': 12, 'dec': 12
        };

        const slashMatch = cleanStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/);
        if (slashMatch) {
            const day = parseInt(slashMatch[1], 10);
            const month = parseInt(slashMatch[2], 10) - 1;
            const year = parseInt(slashMatch[3], 10);
            const hours = slashMatch[4] ? parseInt(slashMatch[4], 10) : 23;
            const minutes = slashMatch[5] ? parseInt(slashMatch[5], 10) : 59;
            const d = new Date(year, month, day, hours, minutes);
            return Math.floor(d.getTime() / 1000);
        }

        const textMatch = cleanStr.match(/(\d{1,2})\s+(?:tháng|thang)?\s*([a-zA-Zà-ỹÀ-Ỹ0-9]+)\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?(?:\s*(SA|CH|AM|PM))?/i);
        if (textMatch) {
            const day = parseInt(textMatch[1], 10);
            const mKey = textMatch[2].toLowerCase().trim();
            const month = (vnMonths[mKey] !== undefined ? vnMonths[mKey] : 1) - 1;
            const year = parseInt(textMatch[3], 10);
            let hours = textMatch[4] ? parseInt(textMatch[4], 10) : 23;
            const minutes = textMatch[5] ? parseInt(textMatch[5], 10) : 59;
            const period = textMatch[6]?.toUpperCase();

            if (period === 'CH' || period === 'PM') {
                if (hours < 12) hours += 12;
            } else if (period === 'SA' || period === 'AM') {
                if (hours === 12) hours = 0;
            }

            const d = new Date(year, month, day, hours, minutes);
            return Math.floor(d.getTime() / 1000);
        }

        return 0;
    }

    // --- 3. HARVESTER EXECUTION ---
    async function runAutoHarvester(sesskey) {
        renderBanner(true, "Đang kết nối API Moodle UIT...", 15);

        let enrolledCourses = [];
        let allMaterials = [];
        const taskMap = new Map();

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
            // Fallback: Tìm các môn từ DOM nếu API trả về rỗng
            if (enrolledCourses.length === 0) {
                const courseLinks = document.querySelectorAll('a[href*="/course/view.php?id="]');
                const seenIds = new Set();
                for (const a of courseLinks) {
                    const href = a.getAttribute('href') || '';
                    const m = href.match(/id=(\d+)/);
                    if (m && m[1]) {
                        const cid = parseInt(m[1], 10);
                        if (cid > 1 && !seenIds.has(cid)) {
                            seenIds.add(cid);
                            const title = a.textContent?.trim() || a.getAttribute('title') || `Môn học ${cid}`;
                            if (title && !title.toLowerCase().includes('site home') && !title.toLowerCase().includes('trang chủ')) {
                                enrolledCourses.push({
                                    course_id: cid,
                                    course_code: title.split(' - ')[0]?.trim() || `COURSE_${cid}`,
                                    fullname: title,
                                    term: "HK2 2025-2026",
                                    instructor_name: "",
                                    instructor_mail: "",
                                    instructor_phone: "",
                                    course_url: `https://courses.uit.edu.vn/course/view.php?id=${cid}`,
                                    updated_at: Math.floor(Date.now() / 1000)
                                });
                            }
                        }
                    }
                }
                if (enrolledCourses.length > 0) {
                    console.log(`[Diark Moodle] Đã tìm thấy ${enrolledCourses.length} môn học từ DOM.`);
                }
            }

            // Gửi ngay danh sách khóa học ban đầu về backend để hiển thị trên UI ngay lập tức
            if (enrolledCourses.length > 0) {
                try {
                    await fetch(LOCAL_SERVER_URL, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            courses: enrolledCourses,
                            tasks: [],
                            materials: [],
                            is_final: false,
                            current_course: `Đã nạp danh sách ${enrolledCourses.length} môn học`,
                            progress_current: 0,
                            progress_total: enrolledCourses.length,
                            progress_pct: 15
                        })
                    });
                } catch (_) {}
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
                for (const ev of events) {
                    const urlMatch = (ev.url || ev.action?.url || "").match(/id=(\d+)/);
                    const taskId = urlMatch ? parseInt(urlMatch[1], 10) : (ev.instance || ev.id);
                    const courseId = ev.course?.id || 0;
                    const isSubmitted = Boolean(ev.action?.name?.includes("Đã nộp") || ev.action?.name?.includes("Submitted"));
                    
                    let templateFileUrl = "";
                    if (ev.description) {
                        const m = ev.description.match(/href="([^"]+\.(?:docx|pdf|zip|pptx)[^"]*)"/i);
                        if (m && m[1]) templateFileUrl = m[1];
                    }

                    taskMap.set(taskId, {
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
                    });
                }
                console.log(`[Diark Moodle] Đã tìm thấy ${taskMap.size} nhiệm vụ từ Calendar.`);
            }
        } catch (err) {
            console.warn("[Diark Moodle] Lỗi fetch calendar events:", err);
        }

    // --- 2.2 AUTO-EXTRACT INSTRUCTOR FROM PARTICIPANTS (DANH SÁCH THÀNH VIÊN) ---
    async function fetchInstructorFromParticipants(courseId, sesskey) {
        // Chiến lược 1: Moodle AJAX API core_enrol_get_enrolled_users (siêu nhanh, nhẹ)
        if (sesskey) {
            try {
                const enrolUrl = `https://courses.uit.edu.vn/lib/ajax/service.php?sesskey=${sesskey}&info=core_enrol_get_enrolled_users`;
                const enrolResp = await fetch(enrolUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify([{
                        index: 0,
                        methodname: "core_enrol_get_enrolled_users",
                        args: { courseid: courseId }
                    }])
                });
                if (enrolResp.ok) {
                    const enrolJson = await enrolResp.json();
                    const users = enrolJson?.[0]?.data || [];
                    for (const u of users) {
                        const roles = u.roles || [];
                        const isTeacher = roles.some(r => {
                            const rName = (r.name || r.shortname || '').toLowerCase();
                            return rName.includes('giảng viên') || 
                                   rName.includes('giang vien') || 
                                   rName.includes('teacher') || 
                                   rName.includes('editingteacher') ||
                                   rName.includes('trợ giảng');
                        });
                        if (isTeacher) {
                            return {
                                name: (u.fullname || `${u.firstname || ''} ${u.lastname || ''}`).trim(),
                                mail: u.email || '',
                                phone: u.phone1 || u.phone2 || ''
                            };
                        }
                    }
                }
            } catch (_) {}
        }

        // Chiến lược 2: Fetch HTML trang Danh sách thành viên (user/index.php)
        try {
            const partUrl = `https://courses.uit.edu.vn/user/index.php?id=${courseId}&perpage=100`;
            const resp = await fetch(partUrl);
            if (resp.ok) {
                const html = await resp.text();
                const doc = new DOMParser().parseFromString(html, "text/html");

                const items = doc.querySelectorAll('table#participants tbody tr, table.generaltable tbody tr, tr.userlist-item, .userlist-item');
                for (const item of items) {
                    const text = item.textContent || '';
                    const lower = text.toLowerCase();

                    const isTeacher = lower.includes('giảng viên') || 
                                      lower.includes('giang vien') || 
                                      lower.includes('teacher') || 
                                      lower.includes('editingteacher') || 
                                      lower.includes('trợ giảng');

                    if (isTeacher && !lower.includes('sinh viên chỉ') && !lower.includes('student only')) {
                        const link = item.querySelector('a[href*="/user/view.php"], a[href*="/user/profile.php"], .col-fullname a, th a');
                        const name = link ? link.textContent.trim() : '';

                        let mail = '';
                        const mailLink = item.querySelector('a[href^="mailto:"]');
                        if (mailLink) {
                            mail = mailLink.getAttribute('href').replace(/^mailto:/i, '').trim();
                        } else {
                            const mMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                            if (mMatch) mail = mMatch[0];
                        }

                        let phone = '';
                        const pMatch = text.match(/(?:(?:\+84|0)[3|5|7|8|9][0-9]{8}\b|(?:\+84|0)\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/);
                        if (pMatch) phone = pMatch[0];

                        if (name) {
                            return { name, mail, phone };
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`[Diark Moodle] Lỗi fetch danh sách thành viên cho môn ${courseId}:`, e);
        }

        return { name: '', mail: '', phone: '' };
    }

    // --- 2.3 HARVEST SINGLE COURSE DETAILS ---
    async function harvestSingleCourse(course, sesskey, taskMap, allMaterials, onCourseSynced) {
        const courseTasksMap = new Map();
        const courseMaterials = [];
        try {
            const courseViewResp = await fetch(course.course_url);
            if (!courseViewResp.ok) return;

            const htmlText = await courseViewResp.text();
            const doc = new DOMParser().parseFromString(htmlText, "text/html");

            // 1. Trích xuất giảng viên từ mô tả môn học nếu có
            const descEls = doc.querySelectorAll('.activity-description, .no-overflow');
            for (const el of descEls) {
                const txt = el.textContent || '';
                if (txt.includes('Giảng viên:') || txt.includes('Mail:') || txt.includes('SĐT:') || txt.includes('GV:') || txt.includes('Email:')) {
                    const lines = txt.split('\n');
                    for (const line of lines) {
                        const l = line.trim();
                        if ((l.startsWith('Giảng viên:') || l.startsWith('GV:')) && !course.instructor_name) {
                            course.instructor_name = l.replace(/^(?:Giảng viên|GV):\s*/i, '').trim();
                        } else if ((l.startsWith('Mail:') || l.startsWith('Email:')) && !course.instructor_mail) {
                            course.instructor_mail = l.replace(/^(?:Mail|Email):\s*/i, '').trim();
                        } else if ((l.startsWith('SĐT:') || l.startsWith('Phone:') || l.startsWith('Điện thoại:')) && !course.instructor_phone) {
                            course.instructor_phone = l.replace(/^(?:SĐT|Phone|Điện thoại):\s*/i, '').trim();
                        }
                    }
                }
            }

            // 2. Nếu trang môn học không ghi giảng viên -> Tự động truy xuất danh sách thành viên (user/index.php)
            if (!course.instructor_name) {
                const inst = await fetchInstructorFromParticipants(course.course_id, sesskey);
                if (inst.name) {
                    course.instructor_name = inst.name;
                    if (!course.instructor_mail && inst.mail) course.instructor_mail = inst.mail;
                    if (!course.instructor_phone && inst.phone) course.instructor_phone = inst.phone;
                }
            }

            // 3. Trích xuất Sections & toàn bộ Activities (Hỗ trợ tất cả format: Topics, Weeks, Collapsed, Grid, Tiles)
            const sections = doc.querySelectorAll('li.section, div.section, [data-for="section"], .course-section');
            const seenActivityIds = new Set();

            const processActivity = (act, fallbackSecName = 'Chung') => {
                const cmid = parseInt(act.getAttribute('data-id') || '0', 10);
                const idAttr = act.getAttribute('id') || '';
                const mMatch = idAttr.match(/module-(\d+)/);
                const moduleId = cmid || (mMatch ? parseInt(mMatch[1], 10) : 0);

                const linkEl = act.querySelector('a.aalink, a.stretched-link, a[href*="/mod/"]');
                const href = linkEl ? (linkEl.getAttribute('href') || '') : '';
                const urlMatchId = href.match(/id=(\d+)/);
                const finalId = moduleId || (urlMatchId ? parseInt(urlMatchId[1], 10) : 0);

                const dedupKey = finalId ? `id_${finalId}` : (href || '');
                if (!dedupKey || seenActivityIds.has(dedupKey)) return;
                seenActivityIds.add(dedupKey);

                // Section name
                const secEl = act.closest('.section, [data-for="section"], .course-section');
                let secName = fallbackSecName;
                if (secEl) {
                    secName = secEl.getAttribute('data-sectionname') || 
                              secEl.querySelector('h3.sectionname, .section-title, [data-for="section_title"]')?.textContent?.trim() || 
                              fallbackSecName;
                }

                // Tiêu đề sạch (loại bỏ .accesshide)
                const titleEl = act.querySelector('.instancename');
                let title = '';
                if (titleEl) {
                    const clone = titleEl.cloneNode(true);
                    const accessHide = clone.querySelector('.accesshide');
                    if (accessHide) accessHide.remove();
                    title = clone.textContent.trim();
                }
                if (!title) {
                    title = act.getAttribute('data-activityname') || (linkEl ? linkEl.textContent.trim() : `Mục ${finalId}`);
                }
                title = title.replace(/\s+(File|Tập tin|URL|Liên kết|Folder|Thư mục|Page|Trang|Diễn đàn|Forum|Bài tập|Trắc nghiệm|Assignment|Quiz)\s*$/i, '').trim();

                const classList = (act.className || '').toLowerCase();
                const isAssign = classList.includes('modtype_assign');
                const isQuiz = classList.includes('modtype_quiz');
                const isWorkshop = classList.includes('modtype_workshop');
                const isResource = classList.includes('modtype_resource');
                const isUrl = classList.includes('modtype_url');
                const isFolder = classList.includes('modtype_folder');
                const isPage = classList.includes('modtype_page');
                const isBook = classList.includes('modtype_book');

                // 3a. Bài tập & Trắc nghiệm
                if (isAssign || isQuiz || isWorkshop) {
                    const dateEl = act.querySelector('[data-region="activity-dates"], .activity-dates, .activity-information');
                    let dueTs = 0;
                    if (dateEl) {
                        dueTs = parseMoodleDateString(dateEl.textContent);
                    }

                    const badgeEl = act.querySelector('.activitybadge, [data-region="completion-info"]');
                    const badgeText = badgeEl ? badgeEl.textContent.trim() : '';
                    const isDone = badgeText.toLowerCase().includes('đã nộp') || 
                                   badgeText.toLowerCase().includes('hoàn thành') || 
                                   badgeText.toLowerCase().includes('done') || 
                                   badgeText.toLowerCase().includes('submitted');

                    let templateFileUrl = '';
                    const desc = act.querySelector('.activity-description');
                    if (desc) {
                        const tmplMatch = (desc.innerHTML || '').match(/href="([^"]+\.(?:docx|pdf|zip|pptx)[^"]*)"/i);
                        if (tmplMatch && tmplMatch[1]) templateFileUrl = tmplMatch[1];
                    }

                    let taskItem;
                    if (taskMap.has(finalId)) {
                        taskItem = taskMap.get(finalId);
                        if (!taskItem.due_date && dueTs > 0) taskItem.due_date = dueTs;
                        if (!taskItem.template_file_url && templateFileUrl) taskItem.template_file_url = templateFileUrl;
                        if (isDone) {
                            taskItem.is_submitted = true;
                            taskItem.submission_status = 'Đã nộp';
                        }
                    } else {
                        taskItem = {
                            task_id: finalId,
                            course_id: course.course_id,
                            title: title,
                            task_type: isQuiz ? 'quiz' : 'assign',
                            due_date: dueTs,
                            is_submitted: isDone,
                            submission_status: isDone ? 'Đã nộp' : (badgeText || 'Chưa nộp'),
                            template_file_url: templateFileUrl,
                            task_url: href || `https://courses.uit.edu.vn/mod/${isQuiz ? 'quiz' : 'assign'}/view.php?id=${finalId}`,
                            updated_at: Math.floor(Date.now() / 1000),
                            course_name: course.fullname,
                            course_code: course.course_code
                        };
                        taskMap.set(finalId, taskItem);
                    }
                    courseTasksMap.set(finalId, taskItem);
                }

                // 3b. Tài liệu / Slide / Thư mục / Liên kết ngoài / Trang
                if (isResource || isUrl || isFolder || isPage || isBook) {
                    if (!href) return;

                    const badgeEl = act.querySelector('.activitybadge');
                    const badgeText = badgeEl ? badgeEl.textContent.toLowerCase() : '';
                    const iconImg = act.querySelector('img.activityicon');
                    const iconSrc = iconImg ? (iconImg.getAttribute('src') || '').toLowerCase() : '';

                    let fileType = 'pdf';
                    if (isUrl || isPage) {
                        fileType = 'url';
                    } else if (isFolder) {
                        fileType = 'folder';
                    } else if (badgeText.includes('pdf') || href.endsWith('.pdf') || iconSrc.includes('/pdf')) {
                        fileType = 'pdf';
                    } else if (badgeText.includes('powerpoint') || badgeText.includes('pptx') || href.endsWith('.pptx') || iconSrc.includes('/powerpoint')) {
                        fileType = 'pptx';
                    } else if (badgeText.includes('word') || badgeText.includes('docx') || href.endsWith('.docx') || iconSrc.includes('/document')) {
                        fileType = 'docx';
                    } else if (iconSrc.includes('/archive') || href.endsWith('.zip') || href.endsWith('.rar')) {
                        fileType = 'zip';
                    } else if (iconSrc.includes('/spreadsheet') || href.endsWith('.xlsx')) {
                        fileType = 'xlsx';
                    }

                    const matItem = {
                        id: 0,
                        course_id: course.course_id,
                        section_name: secName,
                        title,
                        file_url: href,
                        file_type: fileType,
                        created_at: Math.floor(Date.now() / 1000)
                    };
                    allMaterials.push(matItem);
                    courseMaterials.push(matItem);
                }
            };

            // Quét qua các section
            for (const sec of sections) {
                const sName = sec.getAttribute('data-sectionname') || 
                              sec.querySelector('h3.sectionname, .section-title, [data-for="section_title"]')?.textContent?.trim() || 
                              'Chung';
                const acts = sec.querySelectorAll('.activity');
                for (const a of acts) {
                    processActivity(a, sName);
                }
            }

            // Quét bổ sung mọi activity còn sót trong DOM
            const allActs = doc.querySelectorAll('.activity');
            for (const a of allActs) {
                processActivity(a, 'Chung');
            }
        } catch (err) {
            console.warn(`[Diark Moodle] Lỗi xử lý môn ${course.course_id} (${course.course_code}):`, err);
        }

        // Cập nhật thời gian thực môn này về backend ngay lập tức
        if (typeof onCourseSynced === "function") {
            try {
                await onCourseSynced(course, Array.from(courseTasksMap.values()), courseMaterials);
            } catch (_) {}
        }
    }

        // Bước 3: Fetch chi tiết từng môn theo lô song song & streaming real-time
        const totalCourses = enrolledCourses.length;
        let completedCount = 0;

        const onCourseSynced = async (course, courseTasks, courseMaterials) => {
            completedCount++;
            const pct = 20 + Math.round((completedCount / totalCourses) * 75);
            renderBanner(true, `Đang phân tích & nạp ${course.course_code || course.fullname} (${completedCount}/${totalCourses} môn)...`, pct);

            try {
                await fetch(LOCAL_SERVER_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        courses: [course],
                        tasks: courseTasks,
                        materials: courseMaterials,
                        is_final: false,
                        current_course: `${course.course_code || ''} - ${course.fullname}`,
                        progress_current: completedCount,
                        progress_total: totalCourses,
                        progress_pct: pct
                    })
                });
            } catch (_) {}
        };

        const BATCH_SIZE = 3;
        for (let i = 0; i < totalCourses; i += BATCH_SIZE) {
            const batch = enrolledCourses.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(course => harvestSingleCourse(course, sesskey, taskMap, allMaterials, onCourseSynced)));
        }

        // Bước 4: Chốt hạ hoàn tất và gửi tín hiệu is_final = true
        renderBanner(true, `✅ Hoàn tất! Đã đồng bộ ${enrolledCourses.length} môn học Moodle. Đang đóng cửa sổ...`, 100);

        try {
            await fetch(LOCAL_SERVER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    courses: [],
                    tasks: [],
                    materials: [],
                    is_final: true,
                    current_course: "Hoàn tất đồng bộ",
                    progress_current: totalCourses,
                    progress_total: totalCourses,
                    progress_pct: 100
                })
            });
        } catch (_) {}

        await sleep(350);
        window.location.href = `diark-sso://callback#target=moodle&status=success&total_courses=${enrolledCourses.length}`;
    }

    // --- 4. STARTUP WATCHDOG & AUTH DETECTOR ---
    function initMoodleWatcher() {
        const isLoggedIn = checkIsLoggedIn();
        const sesskey = extractSesskey();

        if (isLoggedIn && sesskey) {
            console.log("[Diark Moodle] Đã đăng nhập, bắt đầu thu thập dữ liệu...");
            runAutoHarvester(sesskey);
        } else {
            console.log("[Diark Moodle] Chưa đăng nhập hoặc đang ở trang login, chờ người dùng...");
            renderBanner(false);
            const interval = setInterval(() => {
                if (checkIsLoggedIn()) {
                    const sk = extractSesskey();
                    if (sk) {
                        clearInterval(interval);
                        console.log("[Diark Moodle] Đăng nhập thành công! Bắt đầu thu thập dữ liệu...");
                        renderBanner(true, "Đăng nhập thành công! Bắt đầu thu thập dữ liệu...", 15);
                        runAutoHarvester(sk);
                    }
                }
            }, 800);
        }
    }

    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", initMoodleWatcher);
    } else {
        initMoodleWatcher();
    }
})();
