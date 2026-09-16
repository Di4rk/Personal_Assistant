import {
  getVerdictWeight,
  pickBestSubmission,
  extractCourseCode,
  extractClassList,
  parseWecodeDateToUtc7Ms,
  evaluateWecodeDeadline,
  resolveStudentClass,
  formatVerdictLabel,
  aggregateWecodeHierarchy,
} from "./wecodeHierarchy";
import type { WecodeSubmission } from "../../../types/wecode";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[AssertionFailed] ${message}`);
  }
}

export function runWecodeHierarchyTests(): void {
  // 1. Verdict Weight & Ranking
  const subAc: WecodeSubmission = {
    submission_id: 1,
    assignment_id: 10,
    problem_id: 100,
    problem_name: "Two Sum",
    submit_time_str: "Wed, 16 Sep 2026 10:00:00",
    verdict: "CORRECT ANSWER",
    score: 100,
    execution_time: 0.05,
    memory_kib: 1024,
    language: "C++",
    is_final: true,
  };

  const subPartial: WecodeSubmission = {
    ...subAc,
    submission_id: 2,
    verdict: "WRONG 18",
    score: 50,
  };

  const subWrong18: WecodeSubmission = {
    ...subAc,
    submission_id: 3,
    verdict: "WRONG 18",
    score: 0,
  };

  const subWrong4: WecodeSubmission = {
    ...subAc,
    submission_id: 4,
    verdict: "WRONG 4",
    score: 0,
  };

  const subTle: WecodeSubmission = {
    ...subAc,
    submission_id: 5,
    verdict: "TIME LIMIT EXCEEDED 21",
    score: 0,
  };

  const subCe: WecodeSubmission = {
    ...subAc,
    submission_id: 6,
    verdict: "COMPILATION ERROR",
    score: 0,
  };

  assert(getVerdictWeight(subAc) > getVerdictWeight(subPartial), "AC must beat partial score");
  assert(getVerdictWeight(subPartial) > getVerdictWeight(subWrong18), "Partial score must beat zero-score wrong");
  assert(getVerdictWeight(subWrong18) > getVerdictWeight(subWrong4), "WRONG 18 must beat WRONG 4");
  assert(getVerdictWeight(subWrong4) > getVerdictWeight(subTle), "WRONG must beat TLE");
  assert(getVerdictWeight(subTle) > getVerdictWeight(subCe), "TLE must beat CE");

  // 2. pickBestSubmission
  const attempts: WecodeSubmission[] = [subCe, subWrong4, subAc, subWrong18];
  const best = pickBestSubmission(attempts);
  assert(best.submission_id === subAc.submission_id, "pickBestSubmission must pick the AC submission");

  // 3. Course and Class Extraction
  const classesStr = "IT003.Q210.1, IT003.Q210.2, IT003.Q27.1";
  assert(extractCourseCode(classesStr, "Hate Me First") === "IT003", "Should extract IT003 from classesStr");
  const classList = extractClassList(classesStr, "Hate Me First");
  assert(classList.length === 3 && classList.includes("IT003.Q27.1"), "Should extract all 3 classes");

  const nameWithClass = "[IT001.Q11.1] Assignment 6";
  assert(extractCourseCode("", nameWithClass) === "IT001", "Should extract IT001 from name");
  const classListName = extractClassList("", nameWithClass);
  assert(classListName.includes("IT001.Q11.1"), "Should extract IT001.Q11.1 from name");

  // 4. resolveStudentClass (Compact Class Chips)
  const resolved = resolveStudentClass(["IT003.Q210.1", "IT003.Q27.1", "IT003.Q210.2"], "IT003.Q27.1");
  assert(resolved.primaryClass === "IT003.Q27.1", "Primary class must match student's class IT003.Q27.1");
  assert(resolved.additionalClasses.length === 2, "Must fold 2 other classes into additionalClasses");
  assert(resolved.additionalClasses.includes("IT003.Q210.1"), "Additional must include IT003.Q210.1");

  // 5. Date Parsing & Deadline Evaluation (UTC+7 & Year 1999 Rules)
  const parsed1999 = parseWecodeDateToUtc7Ms("Sun, 4 Apr 1999 03:36");
  assert(parsed1999.year === 1999, "Must parse year 1999");
  assert(parsed1999.timestampMs !== null, "Must parse valid timestamp for 1999");

  // Bẫy ngầm 1: Năm 1999 là Vô thời hạn (Unlimited), KHÔNG PHẢI Đã đóng hay Cần làm gấp
  const deadline1999 = evaluateWecodeDeadline("Sun, 4 Apr 1999 03:36");
  assert(deadline1999.status === "unlimited", "Year 1999 must have status 'unlimited'");
  assert(deadline1999.label === "Vô thời hạn", "Year 1999 must have label 'Vô thời hạn'");

  // Test Hard Rule lọc tab: Không được lọt vào tab "⚡ Cần làm gấp"
  const isCompleted = false;
  const isUrgentTab = !isCompleted && (deadline1999.status === "urgent" || deadline1999.status === "critical");
  assert(isUrgentTab === false, "Unlimited assignment MUST NOT be classified as urgent in filter tab!");

  // Test closed deadline
  const fixedNow = Date.parse("2026-06-01T12:00:00+07:00");
  const closedDeadline = evaluateWecodeDeadline("Sun, 31 May 2026 23:59", fixedNow);
  assert(closedDeadline.status === "closed", "Past deadline must be closed");

  // Test critical deadline (<= 24h)
  const criticalDeadline = evaluateWecodeDeadline("Mon, 1 Jun 2026 18:00", fixedNow);
  assert(criticalDeadline.status === "critical", "Deadline within 6 hours must be critical");
  assert(criticalDeadline.label.includes("h"), "Label must be in hours");

  // Test urgent deadline (<= 3 days)
  const urgentDeadline = evaluateWecodeDeadline("Wed, 3 Jun 2026 12:00", fixedNow);
  assert(urgentDeadline.status === "urgent", "Deadline within 2 days must be urgent");
  assert(urgentDeadline.label.includes("ngày"), "Label must be in days");

  // Test open deadline (> 3 days)
  const openDeadline = evaluateWecodeDeadline("Wed, 10 Jun 2026 12:00", fixedNow);
  assert(openDeadline.status === "open", "Deadline > 3 days must be open");

  // 6. formatVerdictLabel
  const vAc = formatVerdictLabel({ ...subAc, score: 100 }, true);
  assert(vAc.text === "AC • 100đ", "AC label formatting");
  const vWrong = formatVerdictLabel({ ...subWrong18, score: 60 }, false);
  assert(vWrong.text === "Sai test #18 • 60đ", "WRONG 18 label formatting");
  const vTle = formatVerdictLabel({ ...subTle, score: 0 }, false);
  assert(vTle.text === "Quá giờ test #21 • 0đ", "TLE label formatting");

  // 7. Aggregation with Deadlines & Classes
  const subs: WecodeSubmission[] = [
    {
      submission_id: 1,
      assignment_id: 1452,
      assignment_name: "Hate Me First",
      classes: "IT003.Q210.1, IT003.Q27.1",
      problem_id: 2275,
      problem_name: "Tìm kiếm",
      submit_time_str: "Wed, 16 Sep 2026 10:00:00",
      verdict: "CORRECT ANSWER",
      score: 100,
      execution_time: 0.05,
      memory_kib: 1024,
      language: "C++",
      is_final: true,
    },
  ];

  const storedAssignments = [
    {
      id: 1452,
      name: "Hate Me First, Love Me Later",
      classes: "IT003.Q210.1, IT003.Q27.1",
      total_problems: 34,
      start_time: "Thu, 4 Jun 2026 03:33",
      finish_time: "Sun, 4 Apr 1999 03:36",
      base_url: "https://khmt.uit.edu.vn/wecode25/it00x",
    },
  ];

  const storedProblems = [
    {
      assignment_id: 1452,
      problem_id: 2275,
      problem_name: "Tìm kiếm",
      problem_order: 1,
      max_score: 100,
      is_ac: true,
      problem_url: "https://khmt.uit.edu.vn/wecode25/it00x/assignment/1452/2275",
    },
  ];

  const hierarchy = aggregateWecodeHierarchy(subs, storedAssignments, storedProblems, "IT003.Q27.1");
  const assignGroup = hierarchy.assignments.find((a) => a.id === 1452);
  assert(assignGroup !== undefined, "Must find assignment 1452");
  assert(assignGroup?.deadlineStatus === "unlimited", "Assignment with finish_time 1999 must have status unlimited");
  assert(assignGroup?.primaryClass === "IT003.Q27.1", "Primary class must be IT003.Q27.1 matching student");
  assert(Boolean(assignGroup?.additionalClasses.includes("IT003.Q210.1")), "Additional class must be IT003.Q210.1");
  assert(assignGroup?.problems[0].problem_url === "https://khmt.uit.edu.vn/wecode25/it00x/assignment/1452/2275", "Problem URL must match");
}

// Run tests
runWecodeHierarchyTests();
console.log("✅ [wecodeHierarchy.test] All unit tests passed!");
