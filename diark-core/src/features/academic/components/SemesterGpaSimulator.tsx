import React, { useState, useMemo, useEffect } from "react";
import { RotateCcw } from "lucide-react";
import type { AcademicCourseRecord } from "../types";

export interface SemesterGpaSimulatorProps {
  currentGpaCredits: number;
  currentTotalWeighted10: number;
  currentGpa10: number;
  currentGpa4?: number;
  activeSemesterId?: string;
  activeCourses: AcademicCourseRecord[];
  className?: string;
}

interface SimulatedCourseState {
  courseCode: string;
  courseName: string;
  credits: number;
  expectedScore10: number;
}

function score10ToScale4(score: number): { grade4: number; gradeChar: string } {
  if (score >= 9.0) return { grade4: 4.0, gradeChar: "A+" };
  if (score >= 8.5) return { grade4: 3.7, gradeChar: "A" };
  if (score >= 8.0) return { grade4: 3.5, gradeChar: "B+" };
  if (score >= 7.0) return { grade4: 3.0, gradeChar: "B" };
  if (score >= 6.0) return { grade4: 2.5, gradeChar: "C+" };
  if (score >= 5.5) return { grade4: 2.0, gradeChar: "C" };
  if (score >= 5.0) return { grade4: 1.5, gradeChar: "D+" };
  if (score >= 4.0) return { grade4: 1.0, gradeChar: "D" };
  return { grade4: 0.0, gradeChar: "F" };
}

export const SemesterGpaSimulator: React.FC<SemesterGpaSimulatorProps> = ({
  currentGpaCredits,
  currentTotalWeighted10,
  currentGpa10,
  activeCourses,
  className = "",
}) => {
  const initialItems: SimulatedCourseState[] = useMemo(() => {
    if (!activeCourses || activeCourses.length === 0) {
      return [
        { courseCode: "IT004", courseName: "Cơ sở dữ liệu", credits: 4, expectedScore10: 8.5 },
        { courseCode: "IT007", courseName: "Hệ điều hành", credits: 4, expectedScore10: 8.0 },
        { courseCode: "IT005", courseName: "Nhập môn Mạng máy tính", credits: 4, expectedScore10: 8.0 },
        { courseCode: "MA005", courseName: "Xác suất thống kê", credits: 3, expectedScore10: 7.5 },
        { courseCode: "SS009", courseName: "Chủ nghĩa xã hội khoa học", credits: 2, expectedScore10: 8.0 },
      ];
    }

    return activeCourses
      .filter((c) => c.isGpaCalculated)
      .map((c) => ({
        courseCode: c.courseCode,
        courseName: c.courseName,
        credits: c.credits > 0 ? c.credits : 3,
        expectedScore10:
          c.summaryScore10 !== null && c.summaryScore10 !== undefined && c.summaryScore10 > 0
            ? c.summaryScore10
            : 8.0,
      }));
  }, [activeCourses]);

  const [simulatedCourses, setSimulatedCourses] = useState<SimulatedCourseState[]>(initialItems);

  useEffect(() => {
    setSimulatedCourses(initialItems);
  }, [initialItems]);

  const handleScoreChange = (courseCode: string, newScore: number) => {
    const clamped = Math.min(10.0, Math.max(0.0, Number(newScore.toFixed(1))));
    setSimulatedCourses((prev) =>
      prev.map((item) =>
        item.courseCode === courseCode ? { ...item, expectedScore10: clamped } : item
      )
    );
  };

  const handlePresetApply = (presetType: "8.0" | "8.5" | "9.0" | "leverage") => {
    setSimulatedCourses((prev) =>
      prev.map((item) => {
        if (presetType === "8.0") return { ...item, expectedScore10: 8.0 };
        if (presetType === "8.5") return { ...item, expectedScore10: 8.5 };
        if (presetType === "9.0") return { ...item, expectedScore10: 9.0 };
        if (presetType === "leverage") {
          return { ...item, expectedScore10: item.credits >= 4 ? 9.0 : 8.0 };
        }
        return item;
      })
    );
  };

  const handleReset = () => {
    setSimulatedCourses(initialItems);
  };

  const calculations = useMemo(() => {
    let termCredits = 0;
    let termWeighted10 = 0;
    let termWeighted4 = 0;
    let hasFailedCourse = false;

    for (const item of simulatedCourses) {
      termCredits += item.credits;
      termWeighted10 += item.expectedScore10 * item.credits;
      const { grade4 } = score10ToScale4(item.expectedScore10);
      termWeighted4 += grade4 * item.credits;
      if (item.expectedScore10 < 5.0) {
        hasFailedCourse = true;
      }
    }

    const termGpa10 = termCredits > 0 ? Number((termWeighted10 / termCredits).toFixed(2)) : 0;
    const termGpa4 = termCredits > 0 ? Number((termWeighted4 / termCredits).toFixed(2)) : 0;

    const newTotalCredits = currentGpaCredits + termCredits;
    const newTotalWeighted10 = currentTotalWeighted10 + termWeighted10;
    const newCgpa10 =
      newTotalCredits > 0 ? Number((newTotalWeighted10 / newTotalCredits).toFixed(2)) : currentGpa10;
    const deltaCgpa = Number((newCgpa10 - currentGpa10).toFixed(2));

    const distanceToGioi = Number((8.0 - newCgpa10).toFixed(2));
    const distanceToXuatSac = Number((9.0 - newCgpa10).toFixed(2));

    const isScholarshipCreditEligible = termCredits >= 14;
    const isScholarshipGpaEligible = termGpa10 >= 8.0;
    const isScholarshipEligible =
      isScholarshipCreditEligible && isScholarshipGpaEligible && !hasFailedCourse;

    return {
      termCredits,
      termGpa10,
      termGpa4,
      newTotalCredits,
      newCgpa10,
      deltaCgpa,
      distanceToGioi,
      distanceToXuatSac,
      hasFailedCourse,
      isScholarshipCreditEligible,
      isScholarshipGpaEligible,
      isScholarshipEligible,
    };
  }, [simulatedCourses, currentGpaCredits, currentTotalWeighted10, currentGpa10]);

  const presetBtnCls =
    "rounded-md border border-[#1D263B] bg-[#151C2C] px-2.5 py-1 font-mono text-[11px] text-zinc-200 transition-colors hover:border-[#2F6BFF]/50 hover:text-white cursor-pointer";

  return (
    <div className={`space-y-5 rounded-xl border border-[#1D263B] bg-[#0F1420] p-5 shadow-sm ${className}`}>
      {/* 1. Header & Presets */}
      <div className="flex flex-col justify-between gap-3 border-b border-[#1D263B] pb-3.5 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-sm font-bold text-white">GPA Target Simulator</h3>
          <p className="text-[11px] text-zinc-400">
            Giả lập điểm thi từng môn để dự báo bước nhảy cGPA và điều kiện học bổng KKHT UIT
          </p>
        </div>

        {/* Quick Presets */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => handlePresetApply("8.0")}
            className={presetBtnCls}
            title="Đặt tất cả môn 8.0"
          >
            Đều 8.0
          </button>
          <button
            type="button"
            onClick={() => handlePresetApply("8.5")}
            className={presetBtnCls}
            title="Đặt tất cả môn 8.5 (Chuẩn Giỏi)"
          >
            HB Giỏi (8.5)
          </button>
          <button
            type="button"
            onClick={() => handlePresetApply("9.0")}
            className={presetBtnCls}
            title="Đặt tất cả môn 9.0 (Chuẩn Xuất sắc)"
          >
            HB X.Sắc (9.0)
          </button>
          <button
            type="button"
            onClick={() => handlePresetApply("leverage")}
            className={presetBtnCls}
            title="Đẩy môn 4 tín chỉ lên 9.0, các môn khác 8.0"
          >
            Đòn bẩy TC
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-white cursor-pointer"
            title="Đặt lại ban đầu"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Impact Hero KPI Cards — 2x2 Grid so values never truncate */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Card A: GPA Dự kiến kỳ này */}
        <div className="space-y-1 rounded-lg border border-[#1D263B] bg-[#080B12] p-3.5">
          <span className="text-[11px] font-medium text-zinc-400">GPA Dự kiến kỳ này</span>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold text-white tabular-nums">
              {calculations.termGpa10.toFixed(2)}
            </span>
            <span className="font-mono text-xs text-zinc-400 tabular-nums">
              / 10 ({calculations.termGpa4.toFixed(2)} / 4)
            </span>
          </div>
          <div className="font-mono text-[11px] text-zinc-500">
            Tổng {calculations.termCredits} tín chỉ mô phỏng
          </div>
        </div>

        {/* Card B: Bước nhảy cGPA toàn khóa */}
        <div className="space-y-1 rounded-lg border border-[#1D263B] bg-[#080B12] p-3.5">
          <span className="text-[11px] font-medium text-zinc-400">cGPA Tích lũy mới</span>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold text-[#6B9BFF] tabular-nums">
              {calculations.newCgpa10.toFixed(2)}
            </span>
            <span
              className={`font-mono text-xs font-semibold tabular-nums ${
                calculations.deltaCgpa > 0
                  ? "text-emerald-400"
                  : calculations.deltaCgpa < 0
                  ? "text-rose-400"
                  : "text-zinc-400"
              }`}
            >
              {calculations.deltaCgpa > 0 ? `+${calculations.deltaCgpa}` : calculations.deltaCgpa}
            </span>
          </div>
          <div className="font-mono text-[11px] text-zinc-500">
            Từ {currentGpa10.toFixed(2)} ({currentGpaCredits} TC)
          </div>
        </div>

        {/* Card C: Khoảng cách tới danh hiệu */}
        <div className="space-y-1 rounded-lg border border-[#1D263B] bg-[#080B12] p-3.5">
          <span className="text-[11px] font-medium text-zinc-400">Ngưỡng Danh Hiệu</span>
          <div className="space-y-0.5 pt-0.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Loại Giỏi (8.0):</span>
              {calculations.distanceToGioi <= 0 ? (
                <span className="font-mono text-[11px] font-semibold text-emerald-400">
                  ✓ Đã đạt
                </span>
              ) : (
                <span className="font-mono text-[11px] text-amber-400">
                  Cần +{calculations.distanceToGioi}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Xuất sắc (9.0):</span>
              {calculations.distanceToXuatSac <= 0 ? (
                <span className="font-mono text-[11px] font-semibold text-emerald-400">
                  ✓ Đã đạt
                </span>
              ) : (
                <span className="font-mono text-[11px] text-zinc-400">
                  Cần +{calculations.distanceToXuatSac}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Card D: Điều kiện xét học bổng KKHT UIT */}
        <div className="space-y-1 rounded-lg border border-[#1D263B] bg-[#080B12] p-3.5">
          <span className="text-[11px] font-medium text-zinc-400">Học bổng KKHT UIT</span>
          <div className="pt-0.5">
            {calculations.isScholarshipEligible ? (
              <div className="text-xs font-semibold text-emerald-400">
                Đủ tiêu chuẩn xét HB
              </div>
            ) : (
              <div className="text-xs font-medium text-amber-400">
                {!calculations.isScholarshipCreditEligible
                  ? "Dưới sàn 14 TC"
                  : calculations.hasFailedCourse
                  ? "Có môn rớt (<5.0)"
                  : "Chưa chạm mốc 8.0"}
              </div>
            )}
          </div>
          <div className="font-mono text-[11px] text-zinc-500">
            TC: {calculations.termCredits}/14 • GPA: {calculations.termGpa10.toFixed(1)}/8.0
          </div>
        </div>
      </div>

      {/* 3. Course-level Target Sliders Table */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between px-1 text-xs font-medium text-zinc-400">
          <span>Danh sách môn học kỳ này ({simulatedCourses.length} môn)</span>
          <span className="font-mono text-[11px] text-zinc-500">
            Kéo thanh trượt hoặc nhập trực tiếp điểm số
          </span>
        </div>

        <div className="space-y-2">
          {simulatedCourses.map((course) => {
            const { grade4, gradeChar } = score10ToScale4(course.expectedScore10);
            const leverageRatio =
              calculations.newTotalCredits > 0
                ? ((course.credits / calculations.newTotalCredits) * 100).toFixed(1)
                : "0";
            const isHighCredit = course.credits >= 4;

            return (
              <div
                key={course.courseCode}
                className="group flex flex-col justify-between gap-3 rounded-lg border border-[#1D263B] bg-[#080B12] p-3 transition-colors hover:border-[#2F6BFF]/35 hover:bg-[#151C2C]/45 md:flex-row md:items-center"
              >
                {/* Course Metadata */}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-zinc-200">
                      {course.courseCode}
                    </span>
                    <span className="truncate text-xs font-medium text-zinc-300">
                      {course.courseName}
                    </span>
                    <span className="rounded border border-[#1D263B] bg-[#151C2C] px-1.5 py-0.2 font-mono text-[10px] text-zinc-400">
                      {course.credits} TC
                    </span>
                    {isHighCredit && (
                      <span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.2 font-mono text-[10px] text-amber-400">
                        Đòn bẩy cao ({leverageRatio}%)
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-[11px] text-zinc-500">
                    Quy đổi: <strong className="text-zinc-300">{gradeChar}</strong> ({grade4.toFixed(1)}/4.0)
                  </div>
                </div>

                {/* Score Controls: Slider + Number Input */}
                <div className="flex shrink-0 items-center gap-3">
                  <input
                    type="range"
                    min="0"
                    max="10"
                    step="0.1"
                    value={course.expectedScore10}
                    onChange={(e) =>
                      handleScoreChange(course.courseCode, parseFloat(e.target.value))
                    }
                    className="h-1.5 w-28 cursor-pointer appearance-none rounded-lg bg-[#1D263B] accent-[#2F6BFF] sm:w-36"
                  />

                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min="0"
                      max="10"
                      step="0.1"
                      value={course.expectedScore10}
                      onChange={(e) =>
                        handleScoreChange(course.courseCode, parseFloat(e.target.value) || 0)
                      }
                      className="w-14 rounded-md border border-[#1D263B] bg-[#0F1420] px-2 py-1 text-center font-mono text-xs font-bold text-white focus:border-[#2F6BFF] focus:outline-none"
                    />
                    <span className="font-mono text-xs text-zinc-500">/10</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
