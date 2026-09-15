import React from "react";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
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
  className?: string;
}

export const AcademicCourseTable: React.FC<AcademicCourseTableProps> = ({
  courses,
  isLoading = false,
  currentMacro = null,
  currentSemester = null,
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

  return (
    <div
      className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 overflow-hidden ${className}`}
    >
      {/* Table Header with Semester Metrics */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">
            {currentMacro
              ? `Bảng Điểm Chi Tiết: ${currentMacro.semesterLabel}`
              : currentSemester
              ? `Bảng Điểm Chi Tiết: Học kỳ ${currentSemester.semesterTerm} (${currentSemester.academicYear})`
              : "Chi Tiết Môn Học"}
          </h3>
          {currentMacro ? (
            <p className="text-xs text-zinc-400 mt-1">
              GPA:{" "}
              <span className="font-mono text-violet-400 font-bold">
                {currentMacro.termGpa.toFixed(2)}
              </span>{" "}
              <span className="text-zinc-400">({gpaClassification})</span>{" "}
              • DRL:{" "}
              <span className="font-mono text-amber-400 font-bold">
                {currentMacro.drlScore > 0 ? currentMacro.drlScore : "Chưa đồng bộ DRL"}
              </span>{" "}
              • Thi đua:{" "}
              <span className="font-semibold text-emerald-400">
                {compositeReward}
              </span>{" "}
              • Tín chỉ:{" "}
              <span className="font-mono text-zinc-300 font-bold">
                {currentMacro.termCredits} TC
              </span>
            </p>
          ) : currentSemester ? (
            <p className="text-xs text-zinc-400 mt-1">
              GPA:{" "}
              <span className="font-mono text-violet-400 font-bold">
                {currentSemester.actualGpa10
                  ? currentSemester.actualGpa10.toFixed(2)
                  : "—"}
              </span>{" "}
              {currentSemester.actualGpa10 && (
                <span className="text-zinc-400">({gpaClassification})</span>
              )}{" "}
              • DRL:{" "}
              <span className="font-mono text-amber-400 font-bold">
                {currentSemester.actualDrl > 0 ? currentSemester.actualDrl : "Chưa đồng bộ DRL"}
              </span>{" "}
              • Thi đua:{" "}
              <span className="font-semibold text-emerald-400">
                {compositeReward}
              </span>{" "}
              • Tín chỉ:{" "}
              <span className="font-mono text-zinc-300 font-bold">
                {currentSemester.passedCredits} / {currentSemester.totalCredits} TC
              </span>
            </p>
          ) : null}
        </div>
        <span className="text-xs font-mono text-zinc-500">
          {courses.length} môn
        </span>
      </div>

      {isLoading ? (
        <div className="py-12 flex flex-col items-center justify-center gap-2 text-xs text-zinc-500">
          <RefreshCw className="w-5 h-5 animate-spin text-violet-500" />
          <span>Đang tải bảng điểm môn học...</span>
        </div>
      ) : courses.length === 0 ? (
        <div className="py-8 text-center text-xs text-zinc-500">
          Học kỳ này chưa có môn học nào hoặc chưa được chọn.
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 px-4 max-h-[380px] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-zinc-900/50">
          <table className="w-full text-left text-xs text-zinc-300">
            <thead className="sticky top-0 z-10 bg-zinc-950 text-zinc-400 uppercase tracking-wider text-[10px] font-semibold border-b border-zinc-800 shadow-sm">
              <tr>
                <th className="py-2.5 px-3">Mã MH</th>
                <th className="py-2.5 px-3">Tên Môn Học</th>
                <th className="py-2.5 px-2 text-center">Khối</th>
                <th className="py-2.5 px-2 text-center">TC</th>
                <th className="py-2.5 px-2 text-center">QT</th>
                <th className="py-2.5 px-2 text-center">TH</th>
                <th className="py-2.5 px-2 text-center">GK</th>
                <th className="py-2.5 px-2 text-center">CK</th>
                <th className="py-2.5 px-2 text-center">TK 10</th>
                <th className="py-2.5 px-2 text-center">Hệ 4</th>
                <th className="py-2.5 px-2 text-center">Chữ</th>
                <th className="py-2.5 px-3 text-center">Kết Quả</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-sans">
              {courses.map((course) => {
                // Ưu tiên phân loại chuẩn mã môn UIT (IT001-IT012, CS005 là Cơ sở ngành), sau đó đối soát course.category
                const codeClassified = classifyCourseCategory(course.courseCode);
                const category =
                  codeClassified === "foundational"
                    ? "foundational"
                    : course.category === "co_so_nganh"
                    ? "foundational"
                    : course.category === "specialized"
                    ? "specialized"
                    : codeClassified;

                const finalPt = course.finalPoint ?? course.finalScore;
                const tk10 = course.coursePoint ?? course.summaryScore10;
                
                // Fallback tính toán Hệ 4 và Điểm Chữ theo chuẩn ĐHQG-HCM nếu DB chưa nạp
                const computed =
                  tk10 !== null && tk10 !== undefined && !isNaN(tk10)
                    ? computeGradeMetrics(tk10, course.isGpaCalculated ?? true)
                    : null;

                const he4 = course.grade4 ?? course.summaryScore4 ?? computed?.score4;
                const gradeChar =
                  course.gradeChar && course.gradeChar !== "—"
                    ? course.gradeChar
                    : computed?.gradeChar ?? "—";

                const isPassed =
                  course.resultStatus === "Đạt" ||
                  course.resultStatus === "passed" ||
                  course.isPassed ||
                  (computed ? computed.isPassed : false);

                return (
                  <tr
                    key={course.id}
                    className="hover:bg-zinc-800/40 transition-colors"
                  >
                    <td className="py-2.5 px-3 font-mono font-medium text-zinc-200 whitespace-nowrap">
                      {course.courseCode}
                    </td>
                    <td className="py-2.5 px-3 text-zinc-300 font-medium min-w-[170px]">
                      {course.courseName}
                    </td>
                    <td className="py-2.5 px-2 text-center whitespace-nowrap">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          category === "foundational"
                            ? "bg-blue-950/60 text-blue-400 border border-blue-800/40"
                            : category === "specialized"
                            ? "bg-violet-950/60 text-violet-400 border border-violet-800/40"
                            : category === "auxiliary"
                            ? "bg-zinc-800 text-zinc-400 border border-zinc-700"
                            : "bg-emerald-950/60 text-emerald-400 border border-emerald-800/40"
                        }`}
                      >
                        {category === "foundational"
                          ? "CS ngành"
                          : category === "specialized"
                          ? "C.ngành"
                          : category === "auxiliary"
                          ? "Bổ trợ"
                          : "Đ.cương"}
                      </span>
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono text-zinc-300">
                      {course.credits}
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono text-zinc-400">
                      {formatScore(course.processPoint)}
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono text-zinc-400">
                      {formatScore(course.practicePoint)}
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono text-zinc-400">
                      {formatScore(course.midtermScore)}
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono text-zinc-400">
                      {formatScore(finalPt)}
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono font-bold text-zinc-100">
                      {formatScore(tk10)}
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono text-violet-400 font-medium">
                      {formatScore(he4)}
                    </td>
                    <td className="py-2.5 px-2 text-center font-mono font-semibold text-zinc-300">
                      {gradeChar}
                    </td>
                    <td className="py-2.5 px-3 text-center whitespace-nowrap">
                      {isPassed ? (
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

