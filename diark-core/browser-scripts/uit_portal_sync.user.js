// ==UserScript==
// @name         Diark OS - UIT Portal Auto-Sync Hook
// @namespace    https://diark.dev
// @version      1.2.0
// @description  Tự động đẩy bảng điểm, DRL và hồ sơ sinh viên từ UIT Portal về Diark Personal OS qua loopback sync server
// @author       Diark Architect
// @match        https://student.uit.edu.vn/*
// @match        https://portal.uit.edu.vn/sinh-vien/ho-so*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // CẤU HÌNH — Dán sync token từ Diark Dashboard vào đây
    // =========================================================================
    const DIARK_SYNC_TOKEN = "YOUR_SYNC_TOKEN_HERE";
    const JARVIS_SYNC_TOKEN = DIARK_SYNC_TOKEN; // Backward-compat

    // Thứ tự thử port khớp với CANDIDATE_PORTS trong sync_server.rs
    const SYNC_PORTS = [41718, 41719, 41720];
    const SYNC_ENDPOINT = "/api/sync/academic";

    // =========================================================================
    // Logger helper
    // =========================================================================
    const log = {
        info:  (...a) => console.log( "[Diark Sync]", ...a),
        warn:  (...a) => console.warn( "[Diark Sync]", ...a),
        error: (...a) => console.error("[Diark Sync]", ...a),
    };

    log.info("Hook loaded on UIT Portal.");

    // =========================================================================
    // Core: gửi payload về Diark OS, thử lần lượt các port
    // =========================================================================
    function syncToDiark(payload, portIndex = 0) {
        if (portIndex >= SYNC_PORTS.length) {
            log.error("⚠️ Không kết nối được tới Diark sync server trên bất kỳ port nào.");
            return;
        }

        const port = SYNC_PORTS[portIndex];
        const url  = `http://127.0.0.1:${port}${SYNC_ENDPOINT}`;

        GM_xmlhttpRequest({
            method:  "POST",
            url:     url,
            headers: {
                "Content-Type":       "application/json",
                "X-Diark-Sync-Token":  DIARK_SYNC_TOKEN,
                "X-Jarvis-Sync-Token": DIARK_SYNC_TOKEN,
            },
            data: JSON.stringify(payload),
            onload(response) {
                if (response.status === 200) {
                    log.info(`✅ Sync thành công qua port ${port}:`, response.responseText);
                } else if (response.status === 401) {
                    log.error("❌ Token không hợp lệ — kiểm tra lại DIARK_SYNC_TOKEN trong script.");
                } else if (response.status === 422) {
                    log.warn("⚠️ Payload trống hoặc thiếu semester_groups — không sync.");
                } else {
                    log.error(`❌ Sync thất bại [${response.status}]:`, response.responseText);
                }
            },
            onerror() {
                // Port này không phản hồi — thử port tiếp theo
                log.warn(`Port ${port} không phản hồi, thử port tiếp theo…`);
                syncToDiark(payload, portIndex + 1);
            },
            ontimeout() {
                log.warn(`Port ${port} timeout, thử port tiếp theo…`);
                syncToDiark(payload, portIndex + 1);
            },
            timeout: 3000,
        });
    }

    // =========================================================================
    // Xây dựng payload từ response JSON của portal
    // =========================================================================

    /**
     * Chuyển đổi dữ liệu bảng điểm thô từ portal UIT sang IngestionPayload
     * khớp với struct `IngestionPayload` trong portal_ingestion.rs.
     *
     * @param {object} transcriptData — Dữ liệu JSON từ endpoint bang-diem
     * @param {Array}  drlHistory     — Dữ liệu DRL nếu có, mặc định []
     */
    function buildIngestionPayload(transcriptData, drlHistory = null) {
        // Portal trả về mảng học kỳ, mỗi học kỳ có danh sách môn học
        const semesterGroups = [];
        const termSummaries  = [];

        const semesters = Array.isArray(transcriptData)
            ? transcriptData
            : transcriptData?.data ?? transcriptData?.semesters ?? [];

        for (const sem of semesters) {
            const semesterKey   = sem.semester_key   ?? sem.semesterId   ?? sem.hoc_ky    ?? "";
            const semesterLabel = sem.semester_label ?? sem.semesterName ?? sem.ten_hoc_ky ?? semesterKey;
            const yearName      = sem.year_name      ?? sem.namHoc       ?? "";

            const subjects = (sem.subjects ?? sem.monHoc ?? sem.courses ?? []).map((s) => ({
                id:               s.id              ?? null,
                subject_code:     s.subject_code    ?? s.maMonHoc    ?? s.courseCode  ?? "",
                subject_name:     s.subject_name    ?? s.tenMonHoc   ?? s.courseName  ?? "",
                number_of_credit: Number(s.number_of_credit ?? s.soTinChi ?? s.credits ?? 0),
                course_point:     String(s.course_point   ?? s.diemTongKet ?? s.finalGrade  ?? ""),
                midterm_score:    String(s.midterm_score  ?? s.diemGiuaKy  ?? s.midterm      ?? "") || null,
                practice_point:   String(s.practice_point ?? s.diemThucHanh ?? s.practice    ?? "") || null,
                final_point:      String(s.final_point    ?? s.diemCuoiKy  ?? s.final        ?? "") || null,
                process_point:    String(s.process_point  ?? s.diemQuaTrinh ?? s.process      ?? "") || null,
                note:             s.note            ?? s.ghiChu      ?? null,
            }));

            semesterGroups.push({
                semester_key:   semesterKey,
                semester_label: semesterLabel,
                year_name:      yearName,
                total_credit:   sem.total_credit   ?? sem.tongTinChi   ?? null,
                average_point:  sem.average_point  ?? sem.diemTrungBinh ?? null,
                subjects,
            });

            // Term summary nếu có
            if (sem.term_gpa != null || sem.gpaHocKy != null) {
                termSummaries.push({
                    semester:          semesterKey,
                    term_gpa:          sem.term_gpa        ?? sem.gpaHocKy     ?? null,
                    cumulative_gpa:    sem.cumulative_gpa  ?? sem.gpaTichLuy   ?? null,
                    term_credit:       sem.term_credit     ?? sem.tcHocKy      ?? null,
                    accumulated_credit: sem.accumulated_credit ?? sem.tcTichLuy ?? null,
                    classify_label:    sem.classify_label  ?? sem.xepLoai      ?? null,
                });
            }
        }

        const validDrl = (Array.isArray(drlHistory) && drlHistory.length > 0) ? drlHistory : null;
        return {
            semester_groups: semesterGroups,
            term_summaries:  termSummaries.length > 0 ? termSummaries : null,
            drl:             validDrl,
            drl_history:     validDrl,
        };
    }

    // =========================================================================
    // Intercept fetch API
    // =========================================================================
    const _originalFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const response = await _originalFetch(...args);

        const url = typeof args[0] === "string"
            ? args[0]
            : args[0]?.url ?? "";

        // Bảng điểm
        if (url.includes("/api/sinh-vien/bang-diem") ||
            url.includes("/api/student/transcript") ||
            url.includes("/api/sinhvien/bangdiem")) {
            try {
                const clone = response.clone();
                const data  = await clone.json();
                console.log("[Diark Sync] Captured transcript payload!");
                log.info("🎓 Đã bắt được bảng điểm, đang sync…");
                const payload = buildIngestionPayload(data, null);
                payload.drl = null;
                payload.drl_history = null;
                if (payload.semester_groups.length > 0) {
                    syncToDiark(payload);
                } else {
                    log.warn("Bảng điểm trống, bỏ qua sync.");
                }
            } catch (e) {
                log.error("Lỗi parse bảng điểm:", e);
            }
        }

        // DRL
        if (url.includes("/api/sinh-vien/rl") ||
            url.includes("/api/student/drl") ||
            url.includes("/api/sinhvien/drl")) {
            try {
                const clone   = response.clone();
                const data    = await clone.json();
                const drlList = Array.isArray(data) ? data : data?.data ?? [];
                const drlHistory = drlList.map((item) => ({
                    semester: item.semester ?? item.hoc_ky ?? item.semesterId ?? "",
                    point:    Number(item.point ?? item.diem ?? item.drl ?? 0),
                })).filter((d) => d.semester !== "");

                if (drlHistory.length > 0) {
                    log.info("📊 Đã bắt được DRL, đang sync…");
                    syncToDiark({
                        semester_groups: [],
                        term_summaries:  null,
                        drl:             drlHistory,
                        drl_history:     drlHistory,
                    });
                }
            } catch (e) {
                log.error("Lỗi parse DRL:", e);
            }
        }

        return response;
    };

    // =========================================================================
    // Intercept XMLHttpRequest (fallback cho portal dùng XHR thay vì fetch)
    // =========================================================================
    const _originalXHROpen = XMLHttpRequest.prototype.open;
    const _originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._req_url = url;
        return _originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        const url = this._req_url ?? "";

        if (url.includes("/api/sinh-vien/bang-diem") ||
            url.includes("/api/student/transcript")) {
            this.addEventListener("load", () => {
                try {
                    const data    = JSON.parse(this.responseText);
                    console.log("[Diark Sync] Captured transcript payload!");
                    const payload = buildIngestionPayload(data, null);
                    payload.drl = null;
                    payload.drl_history = null;
                    if (payload.semester_groups.length > 0) {
                        log.info("🎓 [XHR] Đã bắt được bảng điểm, đang sync…");
                        syncToDiark(payload);
                    }
                } catch (e) {
                    log.error("[XHR] Lỗi parse bảng điểm:", e);
                }
            });
        }

        return _originalXHRSend.apply(this, args);
    };

    log.info("✅ Fetch & XHR interceptors đã được cài đặt.");

    // =========================================================================
    // Module: Đồng bộ Hồ sơ sinh viên (Passive Network Interception & DOM Fallback)
    // =========================================================================
    const PROFILE_API_PATTERN = /\/api\/.*(ho-so|sinh-vien|profile)/i;
    const NETWORK_CAPTURE_TIMEOUT_MS = 4000;
    let profileAlreadySynced = false;

    function normalizeProfilePayload(raw) {
        const pick = (...candidates) => {
            for (const key of candidates) {
                if (raw?.[key] != null && raw[key] !== "") return String(raw[key]);
            }
            return null;
        };

        return {
            student_id: pick("maSv", "ma_sv", "studentId", "mssv", "username"),
            full_name: pick("hoTen", "ho_ten", "fullName", "tenSinhVien", "displayName"),
            faculty: pick("khoa", "tenKhoa", "faculty"),
            major_code: pick("maNganh", "majorCode") || "",
            specialization: pick("chuyenNganh", "specialization") || "",
            student_class: pick("lopSinhHoat", "lop", "studentClass"),
            curriculum_code: pick("ctdt", "maCtdt", "curriculumCode") || "",
            cohort: pick("khoaHoc", "namNhapHoc", "cohort") || "",
        };
    }

    function isCompleteProfilePayload(p) {
        return Boolean(p.student_id && p.full_name && p.faculty && p.student_class);
    }

    function sendStudentProfile(payload, portIndex = 0) {
        if (profileAlreadySynced) return;
        if (portIndex >= SYNC_PORTS.length) {
            log.error("⚠️ Không thể gửi hồ sơ sinh viên: không kết nối được sync server.");
            return;
        }

        const port = SYNC_PORTS[portIndex];
        const url = `http://127.0.0.1:${port}/sync/student-profile`;
        const token = (typeof GM_getValue === "function" ? GM_getValue("sync_token", "") : "") || DIARK_SYNC_TOKEN;

        GM_xmlhttpRequest({
            method: "POST",
            url: url,
            headers: {
                "Content-Type": "application/json",
                "X-Diark-Sync-Token": token,
                "X-Jarvis-Sync-Token": token,
            },
            data: JSON.stringify(payload),
            onload(response) {
                if (response.status === 200) {
                    profileAlreadySynced = true;
                    log.info("[DIARK // OS] Hồ sơ sinh viên đã được đồng bộ thành công.");
                } else if (response.status === 401) {
                    log.error("❌ Token không hợp lệ khi đồng bộ hồ sơ sinh viên.");
                } else {
                    log.error(`❌ Đồng bộ hồ sơ sinh viên thất bại [${response.status}]:`, response.responseText);
                }
            },
            onerror() {
                sendStudentProfile(payload, portIndex + 1);
            },
            ontimeout() {
                sendStudentProfile(payload, portIndex + 1);
            },
            timeout: 3000,
        });
    }

    // Passive fetch capture cho Profile API
    const _profileOriginalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await _profileOriginalFetch.apply(this, args);
        try {
            const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
            if (url && PROFILE_API_PATTERN.test(url)) {
                response.clone().json().then((json) => {
                    const payload = normalizeProfilePayload(json?.data ?? json);
                    if (isCompleteProfilePayload(payload)) {
                        sendStudentProfile(payload);
                    }
                }).catch(() => {});
            }
        } catch (e) {}
        return response;
    };

    // Label-based DOM Fallback
    function scrapeByLabel(labelText) {
        const nodes = Array.from(document.querySelectorAll("div, span, td"));
        const labelNode = nodes.find((n) => n.textContent?.trim().startsWith(labelText));
        if (!labelNode) return null;
        const sibling = labelNode.nextElementSibling ?? labelNode.parentElement?.querySelector(".font-medium, .font-semibold");
        return sibling?.textContent?.trim() || null;
    }

    function fallbackScrapeProfile() {
        if (profileAlreadySynced) return;
        const payload = {
            student_id: scrapeByLabel("Mã sinh viên"),
            full_name: scrapeByLabel("Họ và tên") || document.querySelector("h2.font-heading")?.textContent?.trim(),
            faculty: scrapeByLabel("Khoa"),
            major_code: scrapeByLabel("Ngành") || "",
            specialization: scrapeByLabel("Chuyên ngành") || "",
            student_class: scrapeByLabel("Lớp sinh hoạt"),
            curriculum_code: scrapeByLabel("CTĐT cụ thể") || "",
            cohort: scrapeByLabel("Khóa") || "",
        };
        if (isCompleteProfilePayload(payload)) {
            sendStudentProfile(payload);
        }
    }

    if (window.location.href.includes("/sinh-vien/ho-so")) {
        window.addEventListener("DOMContentLoaded", () => {
            setTimeout(() => {
                if (!profileAlreadySynced) fallbackScrapeProfile();
            }, NETWORK_CAPTURE_TIMEOUT_MS);
        });
        setTimeout(() => {
            if (!profileAlreadySynced) fallbackScrapeProfile();
        }, NETWORK_CAPTURE_TIMEOUT_MS + 2000);
    }
})();
