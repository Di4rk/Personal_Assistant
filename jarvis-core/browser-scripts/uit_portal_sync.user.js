// ==UserScript==
// @name         Jarvis OS - UIT Portal Auto-Sync Hook
// @namespace    https://diark.dev/jarvis
// @version      1.0.0
// @description  Tự động đẩy bảng điểm và DRL từ UIT Portal về Jarvis Personal OS qua loopback sync server
// @author       Diark Architect
// @match        https://student.uit.edu.vn/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // CẤU HÌNH — Dán sync token từ Jarvis Dashboard vào đây
    // =========================================================================
    const JARVIS_SYNC_TOKEN = "YOUR_SYNC_TOKEN_HERE";

    // Thứ tự thử port khớp với CANDIDATE_PORTS trong sync_server.rs
    const SYNC_PORTS = [41718, 41719, 41720];
    const SYNC_ENDPOINT = "/api/sync/academic";

    // =========================================================================
    // Logger helper
    // =========================================================================
    const log = {
        info:  (...a) => console.log( "[Jarvis Sync]", ...a),
        warn:  (...a) => console.warn( "[Jarvis Sync]", ...a),
        error: (...a) => console.error("[Jarvis Sync]", ...a),
    };

    log.info("Hook loaded on UIT Portal.");

    // =========================================================================
    // Core: gửi payload về Jarvis OS, thử lần lượt các port
    // =========================================================================
    function syncToJarvis(payload, portIndex = 0) {
        if (portIndex >= SYNC_PORTS.length) {
            log.error("⚠️ Không kết nối được tới Jarvis sync server trên bất kỳ port nào.");
            return;
        }

        const port = SYNC_PORTS[portIndex];
        const url  = `http://127.0.0.1:${port}${SYNC_ENDPOINT}`;

        GM_xmlhttpRequest({
            method:  "POST",
            url:     url,
            headers: {
                "Content-Type":       "application/json",
                "X-Jarvis-Sync-Token": JARVIS_SYNC_TOKEN,
            },
            data: JSON.stringify(payload),
            onload(response) {
                if (response.status === 200) {
                    log.info(`✅ Sync thành công qua port ${port}:`, response.responseText);
                } else if (response.status === 401) {
                    log.error("❌ Token không hợp lệ — kiểm tra lại JARVIS_SYNC_TOKEN trong script.");
                } else if (response.status === 422) {
                    log.warn("⚠️ Payload trống hoặc thiếu semester_groups — không sync.");
                } else {
                    log.error(`❌ Sync thất bại [${response.status}]:`, response.responseText);
                }
            },
            onerror() {
                // Port này không phản hồi — thử port tiếp theo
                log.warn(`Port ${port} không phản hồi, thử port tiếp theo…`);
                syncToJarvis(payload, portIndex + 1);
            },
            ontimeout() {
                log.warn(`Port ${port} timeout, thử port tiếp theo…`);
                syncToJarvis(payload, portIndex + 1);
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
                console.log("[Jarvis Sync] Captured transcript payload!");
                log.info("🎓 Đã bắt được bảng điểm, đang sync…");
                const payload = buildIngestionPayload(data, null);
                payload.drl = null;
                payload.drl_history = null;
                if (payload.semester_groups.length > 0) {
                    syncToJarvis(payload);
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
                    syncToJarvis({
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
        this._jarvis_url = url;
        return _originalXHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        const url = this._jarvis_url ?? "";

        if (url.includes("/api/sinh-vien/bang-diem") ||
            url.includes("/api/student/transcript")) {
            this.addEventListener("load", () => {
                try {
                    const data    = JSON.parse(this.responseText);
                    console.log("[Jarvis Sync] Captured transcript payload!");
                    const payload = buildIngestionPayload(data, null);
                    payload.drl = null;
                    payload.drl_history = null;
                    if (payload.semester_groups.length > 0) {
                        log.info("🎓 [XHR] Đã bắt được bảng điểm, đang sync…");
                        syncToJarvis(payload);
                    }
                } catch (e) {
                    log.error("[XHR] Lỗi parse bảng điểm:", e);
                }
            });
        }

        return _originalXHRSend.apply(this, args);
    };

    log.info("✅ Fetch & XHR interceptors đã được cài đặt.");
})();
