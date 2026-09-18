import type {
  WecodeSubmission,
  WecodeProblemSummary,
  WecodeAssignmentGroup,
  WecodeCourseSummary,
  WecodeAssignmentMeta,
  WecodeProblemRecord,
  WecodeDeadlineInfo,
} from "../../../types/wecode";

/**
 * Bảng chuyển đổi tên tháng viết tắt tiếng Anh sang số chuẩn (2 chữ số).
 */
const MONTH_MAP: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/**
 * Phân tích chuỗi ngày giờ từ Wecode thành timestamp milliseconds và năm,
 * luôn cố định múi giờ UTC+7 (Việt Nam) để tránh lệch giờ do môi trường chạy.
 */
export function parseWecodeDateToUtc7Ms(dateStr?: string): { timestampMs: number | null; year: number | null } {
  if (!dateStr || !dateStr.trim()) return { timestampMs: null, year: null };
  const trimmed = dateStr.trim();

  // Định dạng chuẩn Sharif Judge: "Wed, 3 Jun 2026 03:33" hoặc "Sun, 4 Apr 1999 03:36:00"
  const m = trimmed.match(/(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
  if (m) {
    const day = m[1].padStart(2, "0");
    const mon = MONTH_MAP[m[2].toLowerCase()];
    const year = parseInt(m[3], 10);
    const hour = m[4].padStart(2, "0");
    const min = m[5].padStart(2, "0");
    const sec = (m[6] || "00").padStart(2, "0");
    if (mon && !isNaN(year)) {
      const isoStr = `${year}-${mon}-${day}T${hour}:${min}:${sec}+07:00`;
      const ts = Date.parse(isoStr);
      return { timestampMs: isNaN(ts) ? null : ts, year };
    }
  }

  // Định dạng ISO hoặc Date.parse thông thường
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    return { timestampMs: parsed, year: d.getFullYear() };
  }

  return { timestampMs: null, year: null };
}

/**
 * Đánh giá trạng thái hạn chót (Deadline) của bài tập Wecode.
 * 
 * QUY TẮC SỐNG CÒN (Hard Rules):
 * 1. Năm <= 2000 (điển hình là 1999 trên Sharif Judge): Là bài "Vô thời hạn" (Thực hành tự do).
 *    TUYỆT ĐỐI KHÔNG coi là Đã đóng hay Cần làm gấp!
 * 2. Deadline thực tế:
 *    - diffMs <= 0: "Đã đóng"
 *    - diffMs <= 24h: "Còn Xh" (critical)
 *    - diffMs <= 3 ngày: "Còn X ngày" (urgent)
 *    - Còn lại: "Đang mở" (open)
 */
export function evaluateWecodeDeadline(
  finishTimeStr?: string,
  nowMs: number = Date.now()
): WecodeDeadlineInfo {
  if (!finishTimeStr || !finishTimeStr.trim()) {
    return {
      status: "unlimited",
      label: "Vô thời hạn",
      badgeColor: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
      finishTimeStr: "",
    };
  }

  const { timestampMs, year } = parseWecodeDateToUtc7Ms(finishTimeStr);

  // Bẫy ngầm 1: Năm 1999/2000 là bài tự do vô thời hạn
  if (year !== null && year <= 2000) {
    return {
      status: "unlimited",
      label: "Vô thời hạn",
      badgeColor: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
      finishTimeStr,
    };
  }

  if (timestampMs === null) {
    return {
      status: "open",
      label: finishTimeStr,
      badgeColor: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
      finishTimeStr,
    };
  }

  const diffMs = timestampMs - nowMs;

  if (diffMs <= 0) {
    return {
      status: "closed",
      label: "Đã đóng",
      badgeColor: "bg-zinc-800 text-zinc-400 border-zinc-700",
      finishTimeStr,
    };
  }

  const hoursLeft = Math.max(1, Math.ceil(diffMs / (60 * 60 * 1000)));
  if (diffMs <= 24 * 60 * 60 * 1000) {
    return {
      status: "critical",
      label: `Còn ${hoursLeft}h`,
      badgeColor: "bg-rose-500/20 text-rose-300 border-rose-500/40",
      finishTimeStr,
    };
  }

  const daysLeft = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  if (diffMs <= 3 * 24 * 60 * 60 * 1000) {
    return {
      status: "urgent",
      label: `Còn ${daysLeft} ngày`,
      badgeColor: "bg-amber-500/20 text-amber-300 border-amber-500/40",
      finishTimeStr,
    };
  }

  return {
    status: "open",
    label: "Đang mở",
    badgeColor: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    finishTimeStr,
  };
}

/**
 * Định danh lớp học ưu tiên của sinh viên:
 * Nếu sinh viên thuộc lớp `IT003.Q27.1`, ưu tiên hiển thị lớp đó làm primaryClass,
 * các lớp clone khác sẽ gom vào additionalClasses để hiển thị tooltip "+X lớp khác".
 */
export function resolveStudentClass(
  classList: string[],
  studentClass?: string
): { primaryClass?: string; additionalClasses: string[] } {
  if (!classList || classList.length === 0) {
    return { primaryClass: undefined, additionalClasses: [] };
  }

  if (studentClass && studentClass.trim()) {
    const target = studentClass.trim().toLowerCase();
    const matchedIdx = classList.findIndex((c) => c.toLowerCase() === target || c.toLowerCase().includes(target));
    if (matchedIdx >= 0) {
      const primary = classList[matchedIdx];
      const additional = classList.filter((_, idx) => idx !== matchedIdx);
      return { primaryClass: primary, additionalClasses: additional };
    }
  }

  return {
    primaryClass: classList[0],
    additionalClasses: classList.slice(1),
  };
}

/**
 * Hiển thị nhãn verdict chi tiết kèm số testcase và điểm số.
 * Ví dụ: "Sai test #18 • 60đ", "Quá giờ test #21 • 0đ", "AC • 100đ".
 */
export function formatVerdictLabel(
  sub?: WecodeSubmission,
  isSolved?: boolean
): { text: string; colorClass: string } {
  if (isSolved) {
    const score = sub?.score ?? 100;
    return {
      text: `AC • ${score}đ`,
      colorClass: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
    };
  }

  if (!sub) {
    return {
      text: "Chưa nộp",
      colorClass: "text-zinc-400 bg-zinc-800/50 border-zinc-700/50",
    };
  }

  const v = (sub.verdict || "").toUpperCase().trim();
  const score = sub.score || 0;

  if (v.includes("CORRECT") || v === "AC") {
    return {
      text: `AC • ${score}đ`,
      colorClass: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
    };
  }

  const wrongMatch = v.match(/WRONG\s*(\d+)/i);
  if (wrongMatch) {
    return {
      text: `Sai test #${wrongMatch[1]} • ${score}đ`,
      colorClass: "text-rose-400 bg-rose-500/10 border-rose-500/30",
    };
  }

  const tleMatch = v.match(/TIME LIMIT.*?(\d+)/i);
  if (tleMatch) {
    return {
      text: `Quá giờ test #${tleMatch[1]} • ${score}đ`,
      colorClass: "text-amber-400 bg-amber-500/10 border-amber-500/30",
    };
  }

  if (v.includes("COMPILATION") || v.includes("CE")) {
    return {
      text: `Lỗi biên dịch • ${score}đ`,
      colorClass: "text-red-400 bg-red-500/10 border-red-500/30",
    };
  }

  if (v.includes("MEMORY") || v.includes("MLE")) {
    return {
      text: `Quá bộ nhớ • ${score}đ`,
      colorClass: "text-orange-400 bg-orange-500/10 border-orange-500/30",
    };
  }

  if (v.includes("RUNTIME") || v.includes("RTE")) {
    return {
      text: `Lỗi thực thi • ${score}đ`,
      colorClass: "text-purple-400 bg-purple-500/10 border-purple-500/30",
    };
  }

  return {
    text: `${sub.verdict || "Chưa đạt"} • ${score}đ`,
    colorClass: "text-zinc-300 bg-zinc-800/80 border-zinc-700",
  };
}

/**
 * Tính trọng số xếp hạng cho một bài nộp theo đúng thứ tự ưu tiên chất lượng:
 * 1. AC (100đ hoặc verdict CORRECT ANSWER) - Trọng số cao nhất
 * 2. Điểm một phần (Partial Score > 0, điểm càng cao càng ngon)
 * 3. WRONG (Pass càng nhiều testcase càng ngon, e.g. WRONG 18 > WRONG 4)
 * 4. TIME LIMIT EXCEEDED (Chạy hết giờ)
 * 5. MEMORY LIMIT EXCEEDED / RUNTIME ERROR
 * 6. COMPILATION ERROR (Không build được - Thấp nhất)
 */
export function getVerdictWeight(sub: WecodeSubmission): number {
  const v = (sub.verdict || "").toUpperCase().trim();
  const score = sub.score || 0;

  // 1. Full AC
  if (score >= 100 || v.includes("CORRECT") || v === "AC") {
    return 1_000_000 + score;
  }

  // 2. Partial score (> 0)
  if (score > 0) {
    return 800_000 + score * 100;
  }

  // 3. Zero score, nhưng chạy qua được trình biên dịch: WRONG
  if (v.includes("WRONG")) {
    const match = v.match(/WRONG\s*(\d+)/i);
    const testIdx = match ? parseInt(match[1], 10) : 0;
    return 600_000 + testIdx;
  }

  // 4. TIME LIMIT EXCEEDED (TLE)
  if (v.includes("TIME LIMIT") || v.includes("TLE")) {
    const match = v.match(/TIME LIMIT.*?(\d+)/i);
    const testIdx = match ? parseInt(match[1], 10) : 0;
    return 400_000 + testIdx;
  }

  // 5. MEMORY LIMIT EXCEEDED
  if (v.includes("MEMORY LIMIT") || v.includes("MLE")) {
    return 300_000;
  }

  // 6. RUNTIME ERROR
  if (v.includes("RUNTIME") || v.includes("RTE")) {
    return 200_000;
  }

  // 7. COMPILATION ERROR
  if (v.includes("COMPILATION") || v.includes("CE")) {
    return 100_000;
  }

  return 0;
}

/**
 * Chọn ra bài nộp ngon nhất (Best Submission) trong danh sách các lần submit của problem.
 */
export function pickBestSubmission(submissions: WecodeSubmission[]): WecodeSubmission {
  if (submissions.length === 0) {
    throw new Error("Cannot pick best submission from empty list");
  }

  const sorted = [...submissions].sort((a, b) => {
    const weightDiff = getVerdictWeight(b) - getVerdictWeight(a);
    if (weightDiff !== 0) return weightDiff;

    // Nếu cả 2 đều là AC, ưu tiên bài có execution time nhanh hơn
    const aIsAc = a.score === 100 || a.verdict.toUpperCase().includes("CORRECT");
    const bIsAc = b.score === 100 || b.verdict.toUpperCase().includes("CORRECT");
    if (aIsAc && bIsAc && a.execution_time > 0 && b.execution_time > 0) {
      return a.execution_time - b.execution_time;
    }

    // Nếu không, ưu tiên lần nộp mới hơn
    return b.submission_id - a.submission_id;
  });

  return sorted[0];
}

/**
 * Trích xuất mã môn học chuẩn UIT (Regex: 2+ chữ cái kèm 3 số, e.g. IT003, IT001, CS112, MA006).
 */
export function extractCourseCode(classesStr?: string, assignmentName?: string): string {
  if (classesStr) {
    const m = classesStr.match(/([A-Za-z]{2,}\d{3})/);
    if (m && m[1]) return m[1].toUpperCase();
  }

  if (assignmentName) {
    const m = assignmentName.match(/([A-Za-z]{2,}\d{3})/);
    if (m && m[1]) return m[1].toUpperCase();
  }

  return "OTHER";
}

/**
 * Phân tách danh sách các lớp (e.g. ["IT003.Q210.1", "IT003.Q27.1"]) từ chuỗi classes hoặc tên bài tập.
 */
export function extractClassList(classesStr?: string, assignmentName?: string): string[] {
  const result = new Set<string>();

  if (classesStr && classesStr.trim()) {
    const parts = classesStr.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    parts.forEach((p) => result.add(p));
  }

  if (result.size === 0 && assignmentName) {
    const matches = assignmentName.match(/[A-Za-z]{2,}\d{3}(?:\.[A-Za-z0-9]+)*/g);
    if (matches) {
      matches.forEach((m) => result.add(m));
    }
  }

  return Array.from(result);
}

export interface WecodeHierarchyResult {
  courses: WecodeCourseSummary[];
  assignments: WecodeAssignmentGroup[];
  totalSubmissions: number;
  totalAcSubmissions: number;
}

/**
 * Tổng hợp danh sách phẳng submissions cùng danh mục bài tập thành cấu trúc phân cấp:
 * Courses -> Assignments -> Problems -> Submissions (Logs).
 */
export function aggregateWecodeHierarchy(
  submissions: WecodeSubmission[],
  storedAssignments?: WecodeAssignmentMeta[],
  storedProblems?: WecodeProblemRecord[],
  studentClass?: string
): WecodeHierarchyResult {
  const assignmentMap = new Map<number, {
    id: number;
    name: string;
    classesStr: string;
    totalProblemsConfigured: number;
    startTime: string;
    finishTime: string;
    baseUrl: string;
    submissionsByProblem: Map<number, WecodeSubmission[]>;
    catalogProblems: Map<number, WecodeProblemRecord>;
  }>();

  // 1. Khởi tạo danh mục assignments từ DB nếu có
  if (storedAssignments) {
    for (const sa of storedAssignments) {
      assignmentMap.set(sa.id, {
        id: sa.id,
        name: sa.name,
        classesStr: sa.classes || "",
        totalProblemsConfigured: sa.total_problems || 0,
        startTime: sa.start_time || "",
        finishTime: sa.finish_time || "",
        baseUrl: sa.base_url || "",
        submissionsByProblem: new Map(),
        catalogProblems: new Map(),
      });
    }
  }

  // 2. Khởi tạo danh mục problems từ DB nếu có
  if (storedProblems) {
    for (const sp of storedProblems) {
      let aData = assignmentMap.get(sp.assignment_id);
      if (!aData) {
        aData = {
          id: sp.assignment_id,
          name: `Assignment #${sp.assignment_id}`,
          classesStr: "",
          totalProblemsConfigured: 0,
          startTime: "",
          finishTime: "",
          baseUrl: "",
          submissionsByProblem: new Map(),
          catalogProblems: new Map(),
        };
        assignmentMap.set(sp.assignment_id, aData);
      }
      aData.catalogProblems.set(sp.problem_id, sp);
    }
  }

  let totalAcSubmissions = 0;

  // 3. Phân nhóm submissions theo assignment_id và problem_id
  for (const sub of submissions) {
    if (sub.score === 100 || sub.verdict.toUpperCase().includes("CORRECT")) {
      totalAcSubmissions++;
    }

    let aData = assignmentMap.get(sub.assignment_id);
    if (!aData) {
      aData = {
        id: sub.assignment_id,
        name: sub.assignment_name && sub.assignment_name.trim() !== ""
          ? sub.assignment_name
          : `Assignment #${sub.assignment_id}`,
        classesStr: sub.classes || "",
        totalProblemsConfigured: 0,
        startTime: "",
        finishTime: "",
        baseUrl: "",
        submissionsByProblem: new Map(),
        catalogProblems: new Map(),
      };
      assignmentMap.set(sub.assignment_id, aData);
    } else {
      if (!aData.classesStr && sub.classes) {
        aData.classesStr = sub.classes;
      }
      if (
        (!aData.name || aData.name.startsWith("Assignment #")) &&
        sub.assignment_name &&
        !sub.assignment_name.startsWith("Assignment #")
      ) {
        aData.name = sub.assignment_name;
      }
    }

    let probSubs = aData.submissionsByProblem.get(sub.problem_id);
    if (!probSubs) {
      probSubs = [];
      aData.submissionsByProblem.set(sub.problem_id, probSubs);
    }
    probSubs.push(sub);
  }

  // 4. Chuyển đổi thành danh sách WecodeAssignmentGroup
  const assignmentGroups: WecodeAssignmentGroup[] = [];

  for (const aData of assignmentMap.values()) {
    const courseCode = extractCourseCode(aData.classesStr, aData.name);
    const classes = extractClassList(aData.classesStr, aData.name);
    const { primaryClass, additionalClasses } = resolveStudentClass(classes, studentClass);
    const deadline = evaluateWecodeDeadline(aData.finishTime);

    const problems: WecodeProblemSummary[] = [];
    let solvedProblems = 0;
    let earnedScore = 0;
    let totalAssignSubmissions = 0;

    // Hợp nhất toàn bộ problem_id từ catalog và submissions
    const allProbIds = new Set<number>([
      ...Array.from(aData.catalogProblems.keys()),
      ...Array.from(aData.submissionsByProblem.keys()),
    ]);

    for (const probId of allProbIds) {
      const catalogP = aData.catalogProblems.get(probId);
      const probSubs = aData.submissionsByProblem.get(probId) || [];
      const problemUrl = catalogP?.problem_url || (aData.baseUrl ? `${aData.baseUrl}/assignment/${aData.id}/${probId}` : undefined);

      if (probSubs.length > 0) {
        const sortedSubs = [...probSubs].sort((a, b) => b.submission_id - a.submission_id);
        const best = pickBestSubmission(sortedSubs);
        const isSolved = best.score === 100 || best.verdict.toUpperCase().includes("CORRECT") || Boolean(catalogP?.is_ac);
        const bestScore = Math.max(best.score, (catalogP?.is_ac ? (catalogP.max_score || 100) : 0));

        if (isSolved) {
          solvedProblems++;
        }
        earnedScore += bestScore;
        totalAssignSubmissions += sortedSubs.length;

        const problemName = catalogP?.problem_name || sortedSubs[0].problem_name || `Problem #${probId}`;

        problems.push({
          problem_id: probId,
          problem_name: problemName,
          assignment_id: aData.id,
          assignment_name: aData.name,
          bestSubmission: best,
          submissions: sortedSubs,
          totalAttempts: sortedSubs.length,
          isSolved,
          bestScore,
          order: catalogP?.problem_order || 0,
          maxScore: catalogP?.max_score || 100,
          problem_url: problemUrl,
        });
      } else if (catalogP) {
        const isSolved = Boolean(catalogP.is_ac);
        const bestScore = isSolved ? (catalogP.max_score || 100) : 0;

        if (isSolved) {
          solvedProblems++;
        }
        earnedScore += bestScore;

        problems.push({
          problem_id: probId,
          problem_name: catalogP.problem_name || `Problem #${probId}`,
          assignment_id: aData.id,
          assignment_name: aData.name,
          bestSubmission: undefined,
          submissions: [],
          totalAttempts: 0,
          isSolved,
          bestScore,
          order: catalogP.problem_order || 0,
          maxScore: catalogP.max_score || 100,
          problem_url: problemUrl,
        });
      }
    }

    // Sắp xếp problems theo thứ tự order nếu có, sau đó theo problem_id
    problems.sort((a, b) => {
      const orderA = a.order && a.order > 0 ? a.order : 99999;
      const orderB = b.order && b.order > 0 ? b.order : 99999;
      if (orderA !== orderB) return orderA - orderB;
      return a.problem_id - b.problem_id;
    });

    const totalProblems = Math.max(problems.length, aData.totalProblemsConfigured || 0);

    assignmentGroups.push({
      id: aData.id,
      name: aData.name,
      classes,
      courseCode,
      problems,
      totalProblems,
      solvedProblems,
      totalSubmissions: totalAssignSubmissions,
      earnedScore,
      start_time: aData.startTime,
      finish_time: aData.finishTime,
      base_url: aData.baseUrl,
      deadlineStatus: deadline.status,
      deadlineLabel: deadline.label,
      deadlineBadgeColor: deadline.badgeColor,
      primaryClass,
      additionalClasses,
    });
  }

  // Sắp xếp assignments theo id mới nhất lên trước
  assignmentGroups.sort((a, b) => b.id - a.id);

  // 5. Nhóm các Assignment theo Course Code
  const courseMap = new Map<string, WecodeAssignmentGroup[]>();

  for (const assign of assignmentGroups) {
    let list = courseMap.get(assign.courseCode);
    if (!list) {
      list = [];
      courseMap.set(assign.courseCode, list);
    }
    list.push(assign);
  }

  const courses: WecodeCourseSummary[] = [];
  for (const [code, assigns] of courseMap.entries()) {
    let totalProblems = 0;
    let solvedProblems = 0;
    for (const a of assigns) {
      totalProblems += a.totalProblems;
      solvedProblems += a.solvedProblems;
    }

    courses.push({
      courseCode: code,
      totalAssignments: assigns.length,
      assignments: assigns,
      totalProblems,
      solvedProblems,
    });
  }

  courses.sort((a, b) => {
    if (a.courseCode === "OTHER") return 1;
    if (b.courseCode === "OTHER") return -1;
    return b.totalAssignments - a.totalAssignments || a.courseCode.localeCompare(b.courseCode);
  });

  return {
    courses,
    assignments: assignmentGroups,
    totalSubmissions: submissions.length,
    totalAcSubmissions,
  };
}
