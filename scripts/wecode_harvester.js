(() => {
    // RÀNG BUỘC P0: TUYỆT ĐỐI CẤM TRUY CẬP document.cookie HOẶC HEADER CHỨA SESSION
    if (window.__DIARK_WECODE_HARVESTER__) return;
    window.__DIARK_WECODE_HARVESTER__ = true;

    const WECODE_STORAGE_KEY = "__DIARK_WECODE_HARVEST_BUFFER__";
    const BATCH_SIZE = 20; // An toàn cho giới hạn URL Scheme (< 4KB)

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isAuthGateScreen() {
        const path = (window.location.pathname || "").toLowerCase();
        // Nếu ở màn hình login hoặc chưa có thẻ profile người dùng
        if (path.includes('/login') || path.includes('/cas')) return true;
        const profileEl = document.querySelector('#profile_link, a[href*="/users/"]');
        return !profileEl;
    }

    function extractBasePrefix() {
        const path = window.location.pathname || "";
        const parts = path.split('/').filter(Boolean);
        // e.g. /wecode25/it00x/... -> /wecode25/it00x
        if (parts.length >= 2 && parts[0].includes('wecode')) {
            return `/${parts[0]}/${parts[1]}`;
        }
        return "";
    }

    async function waitForElement(selector, timeout = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const el = document.querySelector(selector);
            const isSpinning = document.querySelector('.loading-spinner, .ant-spin, [aria-busy="true"], .spinner-border, .spinner');
            if (el && !isSpinning) return el;
            await sleep(150);
        }
        return null;
    }

    // --- BƯỚC 1: XÁC THỰC DANH TÍNH & CÀO DANH SÁCH BÀI TẬP ---
    async function scrapeAssignments() {
        console.log("[Diark Wecode Harvester] Scraping Assignments...");

        const profileEl = document.querySelector('#profile_link, a[href*="/users/"]');
        const href = profileEl ? (profileEl.getAttribute('href') || '') : '';
        const match = href.match(/\/users\/(\d+)/);
        const wecodeUserId = match ? match[1] : '';

        if (!wecodeUserId) {
            console.warn("[Diark Wecode Harvester] Could not extract wecode_user_id from #profile_link.");
            return;
        }

        const basePrefix = extractBasePrefix();
        await waitForElement('#DataTables_Table_0 tbody tr, table tbody tr');

        const rows = Array.from(document.querySelectorAll('#DataTables_Table_0 tbody tr, table tbody tr'));
        const realRows = rows.filter(r => !r.classList.contains('dataTables_empty') && !r.querySelector('.dataTables_empty') && r.querySelectorAll('td').length > 1);

        const assignmentIds = [];
        realRows.forEach(tr => {
            const idStr = tr.getAttribute('data-id') || 
                          tr.querySelector('td:nth-child(1)')?.textContent?.trim() || 
                          tr.querySelector('a[href*="/assignment/"]')?.getAttribute('href')?.match(/\/assignment\/(\d+)/)?.[1] || 
                          '0';
            const parsed = parseInt(idStr, 10);
            if (!isNaN(parsed) && parsed > 0 && !assignmentIds.includes(parsed)) {
                assignmentIds.push(parsed);
            }
        });

        console.log(`[Diark Wecode Harvester] Found ${assignmentIds.length} assignments for user ${wecodeUserId}.`);

        const buffer = {
            wecode_user_id: wecodeUserId,
            base_prefix: basePrefix,
            assignments: assignmentIds,
            current_idx: 0,
            all_submissions: []
        };

        if (assignmentIds.length === 0) {
            // Không có bài tập nào, commit rỗng an toàn
            sessionStorage.removeItem(WECODE_STORAGE_KEY);
            window.location.href = "diark-sso://callback#target=wecode&action=commit&total_items=0";
            return;
        }

        sessionStorage.setItem(WECODE_STORAGE_KEY, JSON.stringify(buffer));

        // Tự động điều hướng sang assignment đầu tiên
        const firstAssignId = assignmentIds[0];
        window.location.href = `${basePrefix}/submissions/assignment/${firstAssignId}/user/${wecodeUserId}/problem/all/view/all`;
    }

    // --- BƯỚC 2: CÀO SUBMISSIONS TỪNG ASSIGNMENT ---
    async function scrapeSubmissions() {
        console.log("[Diark Wecode Harvester] Scraping Submissions Page...");

        let bufferStr = sessionStorage.getItem(WECODE_STORAGE_KEY);
        if (!bufferStr) {
            console.log("[Diark Wecode Harvester] No active harvest session. Inspecting assignments first.");
            const basePrefix = extractBasePrefix();
            window.location.href = `${basePrefix}/assignments`;
            return;
        }

        let buffer = JSON.parse(bufferStr);
        const currentAssignId = buffer.assignments[buffer.current_idx] || 0;

        await waitForElement('table tbody tr, .dataTables_empty, table');
        await sleep(400);

        const rows = Array.from(document.querySelectorAll('table tbody tr[data-id], #DataTables_Table_0 tbody tr, table tbody tr'));
        const submissions = [];

        rows.forEach(tr => {
            if (tr.classList.contains('dataTables_empty') || tr.querySelector('.dataTables_empty')) return;
            const cells = tr.querySelectorAll('td');
            if (cells.length < 5) return;

            const subId = parseInt(tr.getAttribute('data-id') || cells[0]?.textContent?.trim() || '0', 10);
            if (isNaN(subId) || subId <= 0) return;

            const assignId = parseInt(tr.getAttribute('data-a') || currentAssignId, 10);
            const probId = parseInt(tr.getAttribute('data-p') || '0', 10);

            const isFinal = tr.querySelector('.set_final')?.classList.contains('bi-check-circle') || 
                            tr.querySelector('.bi-check-circle') !== null || false;
            const problemName = tr.querySelector('td:nth-child(3) a, a[href*="/problem/"]')?.textContent?.trim() || cells[2]?.textContent?.trim() || '';
            const timeText = tr.querySelector('td:nth-child(4) .small, td:nth-child(4)')?.textContent?.trim() || cells[3]?.textContent?.trim() || '';
            const verdict = tr.querySelector('td.js-verdict div, td.js-verdict')?.textContent?.trim() || 
                            tr.querySelector('span[class*="verdict"]')?.textContent?.trim() || cells[4]?.textContent?.trim() || '';
            const execTime = parseFloat(tr.querySelector('td.js-time')?.textContent?.trim() || '0');
            const memKib = parseInt(tr.querySelector('td.js-mem')?.textContent?.trim() || '0', 10);
            const score = parseInt(tr.querySelector('td.js-score span, td.js-score')?.textContent?.trim() || '0', 10);
            const lang = tr.querySelector('td div[data-type="code"], td:nth-child(9)')?.textContent?.trim() || 'C++';

            submissions.push({
                submission_id: subId,
                assignment_id: assignId,
                problem_id: probId,
                problem_name: problemName,
                submit_time_str: timeText,
                verdict: verdict,
                score: score,
                execution_time: execTime,
                memory_kib: memKib,
                language: lang,
                is_final: isFinal
            });
        });

        // Dedup theo submission_id
        const existingIds = new Set(buffer.all_submissions.map(s => s.submission_id));
        for (const sub of submissions) {
            if (!existingIds.has(sub.submission_id)) {
                buffer.all_submissions.push(sub);
                existingIds.add(sub.submission_id);
            }
        }

        console.log(`[Diark Wecode Harvester] Assignment ${currentAssignId} harvested: ${submissions.length} subs. Total collected: ${buffer.all_submissions.length}`);

        buffer.current_idx += 1;

        if (buffer.current_idx < buffer.assignments.length) {
            // Còn assignment tiếp theo cần cào
            sessionStorage.setItem(WECODE_STORAGE_KEY, JSON.stringify(buffer));
            const nextAssignId = buffer.assignments[buffer.current_idx];
            console.log(`[Diark Wecode Harvester] Navigating to next assignment: ${nextAssignId} (${buffer.current_idx + 1}/${buffer.assignments.length})`);
            window.location.href = `${buffer.base_prefix}/submissions/assignment/${nextAssignId}/user/${buffer.wecode_user_id}/problem/all/view/all`;
        } else {
            // Đã hoàn thành toàn bộ assignment: Phân đoạn và dispatch dữ liệu
            await dispatchWecodeData(buffer.all_submissions);
        }
    }

    // --- BƯỚC 3: SEQUENTIAL TOP-LEVEL NAVIGATION QUEUE (NO IFRAMES) ---
    async function dispatchWecodeData(submissions) {
        console.log(`[Diark Wecode Harvester] Dispatching ${submissions.length} submissions via Sequential Top-Level Navigation Queue...`);
        sessionStorage.removeItem(WECODE_STORAGE_KEY);

        const totalBatches = Math.ceil(submissions.length / BATCH_SIZE) || 1;
        const queue = [];

        for (let i = 0; i < totalBatches; i++) {
            const chunk = submissions.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            queue.push(`diark-sso://partial#target=wecode_submissions&batch_idx=${i}&total_batches=${totalBatches}&data=${encodeURIComponent(JSON.stringify(chunk))}`);
        }

        // Tín hiệu Commit cuối cùng
        queue.push(`diark-sso://callback#target=wecode&action=commit&total_items=${submissions.length}`);

        for (let i = 0; i < queue.length; i++) {
            console.log(`[Diark Wecode Harvester] Emitting navigation step ${i + 1}/${queue.length}`);
            window.location.href = queue[i];
            await sleep(90); // 80ms - 100ms safe interval
        }
    }

    const path = (window.location.pathname || "").toLowerCase();
    const startHarvester = async () => {
        if (isAuthGateScreen()) {
            console.log("[Diark Wecode Harvester] User is at login screen or unauthenticated. Harvester stands by.");
            return;
        }

        await sleep(500);
        if (path.includes('/submissions/')) {
            await scrapeSubmissions();
        } else if (path.includes('/assignments') || path.includes('/home') || path.endsWith('/it00x')) {
            await scrapeAssignments();
        } else {
            // Fallback điều hướng về assignments để lấy danh sách
            const basePrefix = extractBasePrefix();
            if (basePrefix) {
                window.location.href = `${basePrefix}/assignments`;
            }
        }
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', startHarvester);
    } else {
        startHarvester();
    }
})();
