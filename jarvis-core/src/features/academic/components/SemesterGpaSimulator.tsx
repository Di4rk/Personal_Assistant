import React, { useState, useMemo, useEffect } from "react";
import {
  Sliders,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Zap,
} from "lucide-react";
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
  // Initialize simulated courses from active courses
  const initialItems: SimulatedCourseState[] = useMemo(() => {
    if (!activeCourses || activeCourses.length === 0) {
      // Fallback sample courses if semester courses aren't loaded yet
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
        expectedScore10: c.summaryScore10 !== null && c.summaryScore10 !== undefined && c.summaryScore10 > 0
          ? c.summaryScore10
          : 8.0,
      }));
  }, [activeCourses]);

  const [simulatedCourses, setSimulatedCourses] = useState<SimulatedCourseState[]>(initialItems);

  // Synchronize when activeCourses changes
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
          // Focus effort on high-credit courses (>= 4 TC get 9.0, others 8.0)
          return { ...item, expectedScore10: item.credits >= 4 ? 9.0 : 8.0 };
        }
        return item;
      })
    );
  };

  const handleReset = () => {
    setSimulatedCourses(initialItems);
  };

  // Calculations
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

    // Cumulative calculations
    const newTotalCredits = currentGpaCredits + termCredits;
    const newTotalWeighted10 = currentTotalWeighted10 + termWeighted10;
    const newCgpa10 =
      newTotalCredits > 0 ? Number((newTotalWeighted10 / newTotalCredits).toFixed(2)) : currentGpa10;
    const deltaCgpa = Number((newCgpa10 - currentGpa10).toFixed(2));

    // Distance to Honors (Loại Giỏi >= 8.0, Xuất sắc >= 9.0)
    const distanceToGioi = Number((8.0 - newCgpa10).toFixed(2));
    const distanceToXuatSac = Number((9.0 - newCgpa10).toFixed(2));

    // UIT KKHT Scholarship Assessment (>= 14 TC, no score < 5.0, term GPA >= 8.0)
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

  return (
    <div className={`space-y-5 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-sm ${className}`}>
      {/* 1. Header & Presets */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/80 pb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Sliders className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>GPA Target Simulator</span>
              <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded bg-indigo-950/60 text-indigo-300 border border-indigo-800/40">
                Chiến thuật kỳ này
              </span>
            </h3>
            <p className="text-[11px] text-zinc-400">
              Giả lập điểm thi từng môn để dự báo bước nhảy cGPA và điều kiện học bổng KKHT UIT
            </p>
          </div>
        </div>

        {/* Quick Presets */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => handlePresetApply("8.0")}
            className="px-2 py-1 rounded text-[11px] font-mono bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors cursor-pointer"
            title="Đặt tất cả môn 8.0"
          >
            Đều 8.0
          </button>
          <button
            type="button"
            onClick={() => handlePresetApply("8.5")}
            className="px-2 py-1 rounded text-[11px] font-mono bg-indigo-950/60 hover:bg-indigo-900/80 text-indigo-300 border border-indigo-800/50 transition-colors cursor-pointer"
            title="Đặt tất cả môn 8.5 (Chuẩn Giỏi)"
          >
            HB Giỏi (8.5)
          </button>
          <button
            type="button"
            onClick={() => handlePresetApply("9.0")}
            className="px-2 py-1 rounded text-[11px] font-mono bg-amber-950/60 hover:bg-amber-900/80 text-amber-300 border border-amber-800/50 transition-colors cursor-pointer"
            title="Đặt tất cả môn 9.0 (Chuẩn Xuất sắc)"
          >
            HB X.Sắc (9.0)
          </button>
          <button
            type="button"
            onClick={() => handlePresetApply("leverage")}
            className="px-2 py-1 rounded text-[11px] font-mono bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/50 transition-colors cursor-pointer"
            title="Đẩy môn 4 tín chỉ lên 9.0, các môn khác 8.0"
          >
            <Zap className="inline h-3 w-3 mr-0.5 text-emerald-400" />
            Đòn bẩy TC
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Đặt lại ban đầu"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Impact Hero KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card A: GPA Dự kiến kỳ này */}
        <div className="rounded-lg bg-zinc-950 border border-zinc-800/80 p-3 space-y-1">
          <span className="text-[11px] text-zinc-400 font-medium">GPA Dự kiến kỳ này</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold font-mono text-white">
              {calculations.termGpa10.toFixed(2)}
            </span>
            <span className="text-xs font-mono text-zinc-400">
              / 10 ({calculations.termGpa4.toFixed(2)} / 4)
            </span>
          </div>
          <div className="text-[11px] text-zinc-500 font-mono">
            Tổng {calculations.termCredits} tín chỉ mô phỏng
          </div>
        </div>

        {/* Card B: Bước nhảy cGPA toàn khóa */}
        <div className="rounded-lg bg-zinc-950 border border-zinc-800/80 p-3 space-y-1">
          <span className="text-[11px] text-zinc-400 font-medium">cGPA Tích lũy mới</span>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold font-mono text-indigo-400">
              {calculations.newCgpa10.toFixed(2)}
            </span>
            <span
              className={`text-xs font-mono font-semibold ${
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
          <div className="text-[11px] text-zinc-500 font-mono">
            Từ {currentGpa10.toFixed(2)} ({currentGpaCredits} TC)
          </div>
        </div>

        {/* Card C: Khoảng cách tới danh hiệu */}
        <div className="rounded-lg bg-zinc-950 border border-zinc-800/80 p-3 space-y-1">
          <span className="text-[11px] text-zinc-400 font-medium">Ngưỡng Danh Hiệu</span>
          <div className="space-y-0.5 pt-0.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Loại Giỏi (8.0):</span>
              {calculations.distanceToGioi <= 0 ? (
                <span className="text-emerald-400 font-semibold font-mono text-[11px]">
                  ✓ Đã đạt
                </span>
              ) : (
                <span className="text-amber-400 font-mono text-[11px]">
                  Cần +{calculations.distanceToGioi}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">Xuất sắc (9.0):</span>
              {calculations.distanceToXuatSac <= 0 ? (
                <span className="text-emerald-400 font-semibold font-mono text-[11px]">
                  🏆 Đã đạt
                </span>
              ) : (
                <span className="text-zinc-400 font-mono text-[11px]">
                  Cần +{calculations.distanceToXuatSac}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Card D: Điều kiện xét học bổng KKHT UIT */}
        <div className="rounded-lg bg-zinc-950 border border-zinc-800/80 p-3 space-y-1">
          <span className="text-[11px] text-zinc-400 font-medium">Học bổng KKHT UIT</span>
          <div className="pt-0.5">
            {calculations.isScholarshipEligible ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span>Đủ tiêu chuẩn xét HB</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                <span>
                  {!calculations.isScholarshipCreditEligible
                    ? "Dưới sàn 14 TC"
                    : calculations.hasFailedCourse
                    ? "Có môn rớt (<5.0)"
                    : "Chưa chạm mốc 8.0"}
                </span>
              </div>
            )}
          </div>
          <div className="text-[10px] text-zinc-500 font-mono truncate">
            TC: {calculations.termCredits}/14 • GPA: {calculations.termGpa10.toFixed(1)}/8.0
          </div>
        </div>
      </div>

      {/* 3. Course-level Target Sliders Table */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between text-xs text-zinc-400 font-medium px-1">
          <span>Danh sách môn học kỳ này ({simulatedCourses.length} môn)</span>
          <span className="text-[11px] font-mono text-zinc-500">
            Kéo thanh trượt hoặc nhập trực tiếp điểm số
          </span>
        </div>

        <div className="space-y-2">
          {simulatedCourses.map((course) => {
            const { grade4, gradeChar } = score10ToScale4(course.expectedScore10);
            const leverageRatio = calculations.newTotalCredits > 0
              ? ((course.credits / calculations.newTotalCredits) * 100).toFixed(1)
              : "0";
            const isHighCredit = course.credits >= 4;

            return (
              <div
                key={course.courseCode}
                className="group flex flex-col md:flex-row md:items-center justify-between p-3 rounded-lg border border-zinc-800/70 bg-zinc-950/60 hover:border-zinc-700 transition-colors gap-3"
              >
                {/* Course Metadata */}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-semibold text-zinc-200">
                      {course.courseCode}
                    </span>
                    <span className="text-xs text-zinc-300 font-medium truncate">
                      {course.courseName}
                    </span>
                    <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-zinc-800 text-zinc-400 border border-zinc-700">
                      {course.credits} TC
                    </span>
                    {isHighCredit && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        Đòn bẩy cao ({leverageRatio}%)
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-zinc-500">
                    Quy đổi: <strong className="text-zinc-300">{gradeChar}</strong> ({grade4.toFixed(1)}/4.0)
                  </div>
                </div>

                {/* Score Controls: Slider + Number Input */}
                <div className="flex items-center gap-3 shrink-0">
                  <input
                    type="range"
                    min="0"
                    max="10"
                    step="0.1"
                    value={course.expectedScore10}
                    onChange={(e) =>
                      handleScoreChange(course.courseCode, parseFloat(e.target.value))
                    }
                    className="w-28 sm:w-36 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
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
                      className="w-14 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-center font-mono text-xs font-bold text-white focus:border-indigo-500 focus:outline-none"
                    />
                    <span className="text-xs font-mono text-zinc-500">/10</span>
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
