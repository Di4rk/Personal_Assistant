import React, { useMemo } from "react";
import { CheckCircle2, FolderArchive, RefreshCw, XCircle } from "lucide-react";
import type {
  AcademicCourseRecord,
  AcademicMacroMetricSSOT,
  AcademicOverviewDto,
} from "../types";
import { classifyCourseCategory } from "../utils/forecastEngine";
import {
  calculateCompositeRewardRank,
  getGpaClassification,
  computeGradeMetrics,
} from "../utils/grading";

export interface AcademicCourseTableProps {
  courses: AcademicCourseRecord[];
  isLoading?: boolean;
  currentMacro?: AcademicMacroMetricSSOT | null;
  currentSemester?: AcademicOverviewDto | null;
  onArchiveClick?: () => void;
  className?: string;
}

interface BlockBadgeInfo {
  label: string;
  badgeClass: string;
  dotClass: string;
}

export function resolveCourseBlockBadge(categoryRaw?: string | null, courseCode?: string): BlockBadgeInfo {
  const norm = (categoryRaw || "").trim().toLowerCase();
  const code = (courseCode || "").trim().toUpperCase();

  // 1. Thể chất, GDQP, ngoại ngữ điều kiện
  if (
    code.startsWith("PE") ||
    code.startsWith("ME") ||
    norm.includes("bo tro") ||
    norm === "auxiliary" ||
    norm.includes("dieu kien")
  ) {
    return {
      label: "Bổ trợ",
      badgeClass: "bg-zinc-800 text-zinc-400 border border-zinc-700/60",
      dotClass: "bg-zinc-500",
    };
  }

  // 2. Đại cương (ĐC, dai_cuong, hoặc chứa "dai cuong")
  if (norm === "đc" || norm === "dc" || norm.includes("dai cuong") || norm === "dai_cuong") {
    return {
      label: "Đại cương",
      badgeClass: "bg-emerald-950/60 text-emerald-400 border border-emerald-800/40",
      dotClass: "bg-emerald-400",
    };
  }

  // 3. Cơ sở ngành (CSN, co_so_nganh, hoặc chứa "co so")
  if (norm === "csn" || norm.includes("co so") || norm === "co_so_nganh") {
    return {
      label: "Cơ sở ngành",
      badgeClass: "bg-sky-950/60 text-sky-400 border border-sky-800/40",
      dotClass: "bg-sky-400",
    };
  }

  // 4. Chuyên ngành (CN, chuyen_nganh, hoặc chứa "chuyen nganh")
  if (norm === "cn" || norm.includes("chuyen") || norm === "chuyen_nganh") {
    return {
      label: "Chuyên ngành",
      badgeClass: "bg-zinc-800 text-zinc-200 border border-zinc-700",
      dotClass: "bg-zinc-200",
    };
  }

  // 5. Khóa luận / Thực tập tốt nghiệp
  if (norm === "kltn" || norm.includes("khoa luan") || norm.includes("tot nghiep")) {
    return {
      label: "Tốt nghiệp",
      badgeClass: "bg-amber-950/60 text-amber-400 border border-amber-800/40",
      dotClass: "bg-amber-400",
    };
  }

  // 6. Tự chọn tự do
  if (norm.includes("tu do") || norm.includes("tu_do")) {
    return {
      label: "Tự chọn tự do",
      badgeClass: "bg-zinc-800/80 text-zinc-300 border border-zinc-700/60",
      dotClass: "bg-zinc-400",
    };
  }

  // 7. Heuristic fallback theo mã môn UIT chuẩn
  const fallbackCat = classifyCourseCategory(code);
  if (fallbackCat === "foundational") {
    return {
      label: "Cơ sở ngành",
      badgeClass: "bg-sky-950/60 text-sky-400 border border-sky-800/40",
      dotClass: "bg-sky-400",
    };
  }
  if (fallbackCat === "specialized") {
    return {
      label: "Chuyên ngành",
      badgeClass: "bg-zinc-800 text-zinc-200 border border-zinc-700",
      dotClass: "bg-zinc-200",
    };
  }
  if (fallbackCat === "auxiliary") {
    return {
      label: "Bổ trợ",
      badgeClass: "bg-zinc-800 text-zinc-400 border border-zinc-700/60",
      dotClass: "bg-zinc-500",
    };
  }
  return {
    label: "Đại cương",
    badgeClass: "bg-emerald-950/60 text-emerald-400 border border-emerald-800/40",
    dotClass: "bg-emerald-400",
  };
}

export const AcademicCourseTable: React.FC<AcademicCourseTableProps> = ({
  courses,
  isLoading = false,
  currentMacro = null,
  currentSemester = null,
  onArchiveClick,
  className = "",
}) => {
  const formatScore = (val: number | null | undefined): string => {
    if (val === null || val === undefined || isNaN(val)) {
      return "—";
    }
    return val.toFixed(1);
  };

  const gpa10Val = currentMacro
    ? currentMacro.termGpa
    : currentSemester?.actualGpa10 ?? 0;
  const drlVal = currentMacro
    ? currentMacro.drlScore
    : currentSemester?.actualDrl ?? 0;
  const gpaClassification = getGpaClassification(gpa10Val);
  const compositeReward = calculateCompositeRewardRank(gpa10Val, drlVal);

  const totalCreditsInTable = useMemo(
    () => courses.reduce((sum, c) => sum + c.credits, 0),
    [courses]
  );

  const hasUngradedCourses = useMemo(
    () =>
      courses.some((course) => {
        const statusLower = `${course.resultStatus || ""} ${course.note || ""}`.toLowerCase();
        const isExempt =
          statusLower.includes("miễn") ||
          statusLower.includes("exempt") ||
          course.status === "exempt";
        const score =
          course.summaryScore10 !== null && course.summaryScore10 !== undefined
            ? course.summaryScore10
            : course.coursePoint !== null &&
              course.coursePoint !== undefined &&
              course.coursePoint > 0
            ? course.coursePoint
            : null;
        return !isExempt && score === null;
      }),
    [courses]
  );

  const isOngoingSemester =
    hasUngradedCourses ||
    (currentMacro
      ? currentMacro.termGpa <= 0 && courses.length > 0
      : currentSemester
      ? !currentSemester.isCompleted
      : false);

  return (
    <div
      className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 overflow-hidden ${className}`}
    >
      {/* Table Header with Semester Metrics */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">
            {currentMacro
              ? `Bảng Điểm Chi Tiết: ${currentMacro.semesterLabel}`
              : currentSemester
              ? `Bảng Điểm Chi Tiết: Học kỳ ${currentSemester.semesterTerm} (${currentSemester.academicYear})`
              : "Chi Tiết Môn Học"}
          </h3>
          {isOngoingSemester ? (
            <p className="text-xs text-zinc-400 mt-1">
              <span className="font-semibold text-amber-400">Đang học</span>
              {" · "}
              <span className="font-mono text-zinc-300 font-bold">
                {currentMacro && currentMacro.termCredits > 0
                  ? currentMacro.termCredits
                  : totalCreditsInTable}{" "}
                TC
              </span>
              {" · "}
              <span className="text-zinc-500">Chưa có điểm tổng kết cuối kỳ</span>
            </p>
          ) : currentMacro ? (
            <p className="text-xs text-zinc-400 mt-1">
              GPA:{" "}
              <span className="font-mono text-emerald-400 font-bold">
                {currentMacro.termGpa.toFixed(2)}
              </span>{" "}
              <span className="text-zinc-400">({gpaClassification})</span>{" "}
              · ĐRL:{" "}
              <span className="font-mono text-amber-400 font-bold">
                {currentMacro.drlScore > 0 ? currentMacro.drlScore : "Chưa có ĐRL"}
              </span>{" "}
              · Thi đua:{" "}
              <span className="font-semibold text-emerald-400">
                {compositeReward}
              </span>{" "}
              · Tín chỉ:{" "}
              <span className="font-mono text-zinc-300 font-bold">
                {currentMacro.termCredits} TC
              </span>
            </p>
          ) : currentSemester ? (
            <p className="text-xs text-zinc-400 mt-1">
              GPA:{" "}
              <span className="font-mono text-emerald-400 font-bold">
                {currentSemester.actualGpa10
                  ? currentSemester.actualGpa10.toFixed(2)
                  : "—"}
              </span>{" "}
              {currentSemester.actualGpa10 && (
                <span className="text-zinc-400">({gpaClassification})</span>
              )}{" "}
              · ĐRL:{" "}
              <span className="font-mono text-amber-400 font-bold">
                {currentSemester.actualDrl > 0 ? currentSemester.actualDrl : "Chưa có ĐRL"}
              </span>{" "}
              · Thi đua:{" "}
              <span className="font-semibold text-emerald-400">
                {compositeReward}
              </span>{" "}
              · Tín chỉ:{" "}
              <span className="font-mono text-zinc-300 font-bold">
                {currentSemester.passedCredits} / {currentSemester.totalCredits} TC
              </span>
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {onArchiveClick && !isOngoingSemester && (
            <button
              type="button"
              onClick={onArchiveClick}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                currentSemester?.isCompleted
                  ? "bg-zinc-800/80 hover:bg-zinc-800 text-zinc-300 border-zinc-700"
                  : "bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-500/30 shadow-sm"
              }`}
              title={
                currentSemester?.isCompleted
                  ? "Học kỳ này đã được chốt. Bấm để xem lại."
                  : "Lưu kết quả học kỳ này vào kho lưu trữ và chốt điểm tổng kết"
              }
            >
              <FolderArchive className="w-3.5 h-3.5 text-amber-400" />
              <span>
                {currentSemester?.isCompleted
                  ? "Đã đóng kỳ (Xem)"
                  : `Đóng kỳ ${currentSemester ? `HK${currentSemester.semesterTerm}` : ""}`}
              </span>
            </button>
          )}
          <span className="text-xs font-mono text-zinc-500">
            {courses.length} môn
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 flex flex-col items-center justify-center gap-2 text-xs text-zinc-500">
          <RefreshCw className="w-5 h-5 animate-spin text-zinc-400" />
          <span>Đang tải bảng điểm môn học...</span>
        </div>
      ) : courses.length === 0 ? (
        <div className="py-8 text-center text-xs text-zinc-500">
          Học kỳ này chưa có môn học nào hoặc chưa được chọn.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full text-left text-xs text-zinc-300">
            <thead className="border-b border-zinc-800 bg-zinc-950/80 text-[11px] font-medium text-zinc-400">
              <tr>
                <th className="py-2.5 pr-3 pl-2">Môn học</th>
                <th className="py-2.5 px-2 text-right w-12">TC</th>
                <th className="py-2.5 px-2 text-right w-12">QT</th>
                <th className="py-2.5 px-2 text-right w-12">TH</th>
                <th className="py-2.5 px-2 text-right w-12">GK</th>
                <th className="py-2.5 px-2 text-right w-12">CK</th>
                <th className="py-2.5 px-3 text-right w-32">Tổng kết</th>
                <th className="py-2.5 pl-2 pr-2 text-center w-20">Kết quả</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-sans">
              {courses.map((course) => {
                const blockInfo = resolveCourseBlockBadge(course.category, course.courseCode);

                const finalPt = course.finalPoint ?? course.finalScore;
                const tk10: number | null =
                  course.summaryScore10 !== null && course.summaryScore10 !== undefined
                    ? course.summaryScore10
                    : course.coursePoint !== null &&
                      course.coursePoint !== undefined &&
                      course.coursePoint > 0
                    ? course.coursePoint
                    : null;

                const statusLower = `${course.resultStatus || ""} ${course.note || ""}`.toLowerCase();
                const isExempt =
                  statusLower.includes("miễn") ||
                  statusLower.includes("exempt") ||
                  course.status === "exempt";

                const isUngraded = tk10 === null && !isExempt;

                const computed =
                  tk10 !== null && !isNaN(tk10)
                    ? computeGradeMetrics(tk10, course.isGpaCalculated ?? true)
                    : null;

                const he4 = course.grade4 ?? course.summaryScore4 ?? computed?.score4;
                const gradeChar =
                  course.gradeChar && course.gradeChar !== "—"
                    ? course.gradeChar
                    : computed?.gradeChar ?? "—";

                const isPassed =
                  !isUngraded &&
                  (course.resultStatus === "Đạt" ||
                    course.resultStatus === "passed" ||
                    course.isPassed ||
                    (computed ? computed.isPassed : false));

                return (
                  <tr
                    key={course.id}
                    className="hover:bg-zinc-800/40 transition-colors"
                  >
                    <td className="py-2.5 pr-3 pl-2 min-w-0">
                      <div className="font-medium text-zinc-100 leading-snug">
                        {course.courseName}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <span
                          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${blockInfo.dotClass}`}
                          title={blockInfo.label}
                          aria-label={blockInfo.label}
                        />
                        <span className="font-mono">{course.courseCode}</span>
                        <span className="text-zinc-600">·</span>
                        <span>{blockInfo.label}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono tabular-nums text-zinc-300">
                      {course.credits}
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono tabular-nums text-zinc-400">
                      {formatScore(course.processPoint)}
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono tabular-nums text-zinc-400">
                      {formatScore(course.practicePoint)}
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono tabular-nums text-zinc-400">
                      {formatScore(course.midtermScore)}
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono tabular-nums text-zinc-400">
                      {formatScore(finalPt)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                      {isUngraded ? (
                        <span className="font-semibold text-zinc-500">—</span>
                      ) : (
                        <>
                          <span className="font-semibold text-zinc-100">
                            {formatScore(tk10)}
                          </span>
                          {(gradeChar !== "—" || (he4 !== null && he4 !== undefined && !isNaN(he4))) && (
                            <span className="ml-1.5 text-[11px] text-zinc-400">
                              {gradeChar} · {formatScore(he4)}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="py-2.5 pl-2 pr-2 text-center whitespace-nowrap">
                      {isExempt ? (
                        <span className="inline-flex items-center rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                          Miễn
                        </span>
                      ) : isUngraded ? (
                        <span className="inline-flex items-center rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                          Đang học
                        </span>
                      ) : isPassed ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
                          <CheckCircle2 className="w-3 h-3" />
                          Đạt
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-400 bg-rose-950/40 px-2 py-0.5 rounded border border-rose-800/40">
                          <XCircle className="w-3 h-3" />
                          Nợ
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

