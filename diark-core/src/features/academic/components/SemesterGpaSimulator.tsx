import React, { useState, useMemo, useEffect } from "react";
import { RotateCcw } from "lucide-react";
import type { AcademicCourseRecord } from "../types";
import {
  COMPONENT_KEYS,
  COMPONENT_LABELS,
  UIT_WEIGHT_PRESETS,
  calculateCourseTarget,
  getDefaultWeightsForCourse,
  type ComponentKey,
  type ComponentScores,
  type ComponentWeights,
} from "../utils/courseTargetEngine";

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
  portalScores: ComponentScores;
  scores: ComponentScores;
  weights: ComponentWeights;
}

const WEIGHTS_STORAGE_KEY = "diark_course_weights_v1";

function loadSavedWeightsMap(): Record<string, ComponentWeights> {
  try {
    const raw = window.localStorage.getItem(WEIGHTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, ComponentWeights>;
  } catch {
    return {};
  }
}

function saveCourseWeights(courseCode: string, weights: ComponentWeights): void {
  try {
    const current = loadSavedWeightsMap();
    current[courseCode] = weights;
    window.localStorage.setItem(WEIGHTS_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // ignore storage quota errors
  }
}

function formatWeightBadge(weights: ComponentWeights): string {
  return `${weights.qt}/${weights.th}/${weights.gk}/${weights.ck}`;
}

function formatKnownComponentsSummary(scores: ComponentScores): string {
  const parts: string[] = [];
  for (const key of COMPONENT_KEYS) {
    const v = scores[key];
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      parts.push(`${COMPONENT_LABELS[key]} ${v.toFixed(1)}`);
    }
  }
  return parts.join(" · ");
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
    const savedWeights = loadSavedWeightsMap();

    if (!activeCourses || activeCourses.length === 0) {
      const fallbacks = [
        { courseCode: "IT004", courseName: "Cơ sở dữ liệu", credits: 4, expectedScore10: 8.5 },
        { courseCode: "IT007", courseName: "Hệ điều hành", credits: 4, expectedScore10: 8.0 },
        { courseCode: "IT005", courseName: "Nhập môn Mạng máy tính", credits: 4, expectedScore10: 8.0 },
        { courseCode: "MA005", courseName: "Xác suất thống kê", credits: 3, expectedScore10: 7.5 },
        { courseCode: "SS009", courseName: "Chủ nghĩa xã hội khoa học", credits: 2, expectedScore10: 8.0 },
      ];
      return fallbacks.map((item) => {
        const emptyScores: ComponentScores = { qt: null, th: null, gk: null, ck: null };
        const weights =
          savedWeights[item.courseCode] ??
          getDefaultWeightsForCourse(item.courseCode, item.credits, false);
        return {
          ...item,
          portalScores: emptyScores,
          scores: { ...emptyScores },
          weights,
        };
      });
    }

    return activeCourses
      .filter((c) => c.isGpaCalculated)
      .map((c) => {
        const credits = c.credits > 0 ? c.credits : 3;
        const portalScores: ComponentScores = {
          qt: c.processPoint ?? null,
          th: c.practicePoint ?? null,
          gk: c.midtermScore ?? null,
          ck: c.finalPoint ?? c.finalScore ?? null,
        };
        const weights =
          savedWeights[c.courseCode] ??
          getDefaultWeightsForCourse(
            c.courseCode,
            credits,
            portalScores.th !== null && portalScores.th !== undefined
          );
        const calc = calculateCourseTarget(portalScores, weights, 8.0);
        const expectedScore10 =
          c.summaryScore10 !== null && c.summaryScore10 !== undefined && c.summaryScore10 > 0
            ? c.summaryScore10
            : calc.projectedTotalScore !== null
            ? calc.projectedTotalScore
            : 8.0;

        return {
          courseCode: c.courseCode,
          courseName: c.courseName,
          credits,
          expectedScore10,
          portalScores,
          scores: { ...portalScores },
          weights,
        };
      });
  }, [activeCourses]);

  const [simulatedCourses, setSimulatedCourses] = useState<SimulatedCourseState[]>(initialItems);
  const [expandedWeights, setExpandedWeights] = useState<Record<string, boolean>>({});

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

  const handleComponentScoreChange = (
    courseCode: string,
    key: ComponentKey,
    rawVal: string
  ) => {
    const trimmed = rawVal.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    const nextVal =
      parsed !== null && Number.isFinite(parsed)
        ? Math.min(10.0, Math.max(0.0, Number(parsed.toFixed(2))))
        : null;

    setSimulatedCourses((prev) =>
      prev.map((item) => {
        if (item.courseCode !== courseCode) return item;
        const nextScores: ComponentScores = { ...item.scores, [key]: nextVal };
        const calc = calculateCourseTarget(nextScores, item.weights, item.expectedScore10);
        return {
          ...item,
          scores: nextScores,
          expectedScore10:
            calc.projectedTotalScore !== null ? calc.projectedTotalScore : item.expectedScore10,
        };
      })
    );
  };

  const handleWeightsChange = (courseCode: string, nextWeights: ComponentWeights) => {
    saveCourseWeights(courseCode, nextWeights);
    setSimulatedCourses((prev) =>
      prev.map((item) => {
        if (item.courseCode !== courseCode) return item;
        const calc = calculateCourseTarget(item.scores, nextWeights, item.expectedScore10);
        return {
          ...item,
          weights: nextWeights,
          expectedScore10:
            calc.projectedTotalScore !== null ? calc.projectedTotalScore : item.expectedScore10,
        };
      })
    );
  };

  const handleResetCoursePortalScores = (courseCode: string) => {
    setSimulatedCourses((prev) =>
      prev.map((item) => {
        if (item.courseCode !== courseCode) return item;
        const resetScores = { ...item.portalScores };
        const calc = calculateCourseTarget(resetScores, item.weights, item.expectedScore10);
        return {
          ...item,
          scores: resetScores,
          expectedScore10:
            calc.projectedTotalScore !== null ? calc.projectedTotalScore : item.expectedScore10,
        };
      })
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
            Giả lập điểm thành phần theo trọng số &amp; tính điểm mục tiêu cần đạt cho học kỳ
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

      {/* 3. Course-level Target Sliders & Weighted Component Calculator */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between px-1 text-xs font-medium text-zinc-400">
          <span>Danh sách môn học kỳ này ({simulatedCourses.length} môn)</span>
          <span className="font-mono text-[11px] text-zinc-500">
            Mục tiêu môn hoặc mở Trọng số QT/TH/GK/CK
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
            const isWeightOpen = Boolean(expandedWeights[course.courseCode]);
            const portalSummary = formatKnownComponentsSummary(course.portalScores);
            const targetCalc = calculateCourseTarget(
              course.scores,
              course.weights,
              course.expectedScore10
            );
            const isComponentScoreLocked =
              targetCalc.isValidWeightSum && targetCalc.remainingWeight === 0;

            return (
              <div
                key={course.courseCode}
                className="rounded-lg border border-[#1D263B] bg-[#080B12] transition-colors hover:border-[#2F6BFF]/35"
              >
                <div className="flex flex-col justify-between gap-3 p-3 md:flex-row md:items-center">
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
                      {portalSummary && (
                        <span className="rounded border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.12] px-1.5 py-0.2 font-mono text-[10px] text-[#6B9BFF]">
                          {portalSummary}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-500">
                      <span>
                        Quy đổi: <strong className="text-zinc-300">{gradeChar}</strong> (
                        {grade4.toFixed(1)}/4.0)
                      </span>
                      <span>·</span>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedWeights((prev) => ({
                            ...prev,
                            [course.courseCode]: !prev[course.courseCode],
                          }))
                        }
                        className={`rounded border px-1.5 py-0.2 text-[10px] font-medium transition-colors cursor-pointer ${
                          isWeightOpen
                            ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                            : "border-[#1D263B] bg-[#0F1420] text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        Trọng số ({formatWeightBadge(course.weights)})
                      </button>
                    </div>
                  </div>

                  {/* Target / Projected Score Controls */}
                  <div className="flex shrink-0 items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="10"
                      step="0.1"
                      disabled={isComponentScoreLocked}
                      value={course.expectedScore10}
                      onChange={(e) =>
                        handleScoreChange(course.courseCode, parseFloat(e.target.value))
                      }
                      className="h-1.5 w-28 cursor-pointer appearance-none rounded-lg bg-[#1D263B] accent-[#2F6BFF] disabled:opacity-50 sm:w-36"
                    />

                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="0"
                        max="10"
                        step="0.1"
                        disabled={isComponentScoreLocked}
                        value={course.expectedScore10}
                        onChange={(e) =>
                          handleScoreChange(course.courseCode, parseFloat(e.target.value) || 0)
                        }
                        className="w-14 rounded-md border border-[#1D263B] bg-[#0F1420] px-2 py-1 text-center font-mono text-xs font-bold text-white focus:border-[#2F6BFF] focus:outline-none disabled:opacity-70"
                      />
                      <span className="font-mono text-xs text-zinc-500">/10</span>
                    </div>
                  </div>
                </div>

                {/* Expanded Weighted Component & Target Calculator */}
                {isWeightOpen && (
                  <div className="space-y-3 border-t border-[#1D263B] bg-[#0F1420]/70 px-3 py-3">
                    {/* Preset Weights Row */}
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-zinc-500">Mẫu UIT:</span>
                        {UIT_WEIGHT_PRESETS.map((preset) => {
                          const isCurrentPreset =
                            formatWeightBadge(course.weights) === formatWeightBadge(preset.weights);
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() =>
                                handleWeightsChange(course.courseCode, { ...preset.weights })
                              }
                              className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors cursor-pointer ${
                                isCurrentPreset
                                  ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                                  : "border-[#1D263B] bg-[#080B12] text-zinc-400 hover:text-zinc-200"
                              }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>

                      <div className="flex items-center gap-2 font-mono text-[10px]">
                        <span
                          className={
                            targetCalc.isValidWeightSum
                              ? "text-zinc-400"
                              : "font-semibold text-rose-400"
                          }
                        >
                          Tổng: {targetCalc.totalWeight}%
                        </span>
                        <button
                          type="button"
                          onClick={() => handleResetCoursePortalScores(course.courseCode)}
                          className="rounded border border-[#1D263B] bg-[#080B12] px-2 py-0.5 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          Khôi phục điểm Portal
                        </button>
                      </div>
                    </div>

                    {/* 4 Component Inputs: QT, TH, GK, CK */}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {COMPONENT_KEYS.map((key) => {
                        const weightVal = course.weights[key];
                        const scoreVal = course.scores[key];
                        const portalVal = course.portalScores[key];
                        const hasPortalVal = portalVal !== null && portalVal !== undefined;
                        return (
                          <div
                            key={key}
                            className="space-y-1.5 rounded-lg border border-[#1D263B] bg-[#080B12] p-2"
                          >
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="font-mono font-semibold text-zinc-200">
                                {COMPONENT_LABELS[key]}
                              </span>
                              {hasPortalVal ? (
                                <span className="font-mono text-[10px] text-[#6B9BFF]">
                                  Portal: {portalVal.toFixed(1)}
                                </span>
                              ) : (
                                <span className="text-[10px] text-zinc-600">Chưa có</span>
                              )}
                            </div>

                            <div className="grid grid-cols-2 gap-1.5">
                              <label className="block space-y-0.5">
                                <span className="block text-[9px] text-zinc-500">Trọng số %</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  step={5}
                                  value={weightVal}
                                  onChange={(e) => {
                                    const nextW = Math.min(
                                      100,
                                      Math.max(0, parseInt(e.target.value, 10) || 0)
                                    );
                                    handleWeightsChange(course.courseCode, {
                                      ...course.weights,
                                      [key]: nextW,
                                    });
                                  }}
                                  className="w-full rounded border border-[#1D263B] bg-[#0F1420] px-1.5 py-1 text-center font-mono text-[11px] text-zinc-300 focus:border-[#2F6BFF] focus:outline-none"
                                />
                              </label>

                              <label className="block space-y-0.5">
                                <span className="block text-[9px] text-zinc-500">Điểm</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={10}
                                  step={0.1}
                                  disabled={weightVal <= 0}
                                  placeholder={weightVal <= 0 ? "—" : "Trống"}
                                  value={scoreVal === null ? "" : scoreVal}
                                  onChange={(e) =>
                                    handleComponentScoreChange(
                                      course.courseCode,
                                      key,
                                      e.target.value
                                    )
                                  }
                                  className="w-full rounded border border-[#1D263B] bg-[#0F1420] px-1.5 py-1 text-center font-mono text-[11px] font-semibold text-white placeholder:text-zinc-600 focus:border-[#2F6BFF] focus:outline-none disabled:opacity-40"
                                />
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Live Target Calculation & Quick Target Chips */}
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        {!targetCalc.isValidWeightSum ? (
                          <span className="text-amber-400">
                            Tổng trọng số hiện là {targetCalc.totalWeight}% — cần điều chỉnh đúng 100% để tính điểm mục tiêu.
                          </span>
                        ) : targetCalc.remainingWeight === 0 ? (
                          <span className="text-zinc-300">
                            Tổng kết theo trọng số:{" "}
                            <span className="font-mono font-bold text-[#6B9BFF]">
                              {targetCalc.projectedTotalScore?.toFixed(2)} / 10
                            </span>{" "}
                            <span className="text-zinc-500">(đã đồng bộ lên giả lập kỳ)</span>
                          </span>
                        ) : targetCalc.isAlreadyGuaranteed ? (
                          <span className="text-emerald-400">
                            Đã chắc chắn đạt mục tiêu {course.expectedScore10.toFixed(1)} (tối thiểu đạt{" "}
                            <span className="font-mono font-semibold">
                              {targetCalc.minPossibleScore.toFixed(2)}
                            </span>
                            ).
                          </span>
                        ) : !targetCalc.isAchievable ? (
                          <span className="text-rose-400">
                            Mục tiêu {course.expectedScore10.toFixed(1)} vượt trần (cần{" "}
                            <span className="font-mono font-semibold">
                              {targetCalc.requiredScore?.toFixed(2)}
                            </span>
                            /10 cho phần còn lại; tối đa đạt{" "}
                            <span className="font-mono font-semibold">
                              {targetCalc.maxPossibleScore.toFixed(2)}
                            </span>
                            ).
                          </span>
                        ) : (
                          <span className="text-zinc-300">
                            Để đạt{" "}
                            <span className="font-mono font-semibold text-white">
                              {course.expectedScore10.toFixed(1)}
                            </span>
                            , cần trung bình{" "}
                            <span className="font-mono font-bold text-[#6B9BFF]">
                              {targetCalc.requiredScore?.toFixed(2)}
                            </span>{" "}
                            ở{" "}
                            <span className="font-mono text-zinc-200">
                              {targetCalc.missingComponents
                                .map((k) => COMPONENT_LABELS[k])
                                .join(", ")}{" "}
                              ({targetCalc.remainingWeight}%)
                            </span>
                            <span className="text-zinc-500">
                              {" "}
                              · Biên độ: {targetCalc.minPossibleScore.toFixed(1)}–
                              {targetCalc.maxPossibleScore.toFixed(1)}
                            </span>
                          </span>
                        )}
                      </div>

                      {!isComponentScoreLocked && (
                        <div className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
                          <span className="text-zinc-500">Mục tiêu:</span>
                          {[8.0, 8.5, 9.0].map((target) => (
                            <button
                              key={target}
                              type="button"
                              onClick={() => handleScoreChange(course.courseCode, target)}
                              className={`rounded border px-1.5 py-0.5 transition-colors cursor-pointer ${
                                Math.abs(course.expectedScore10 - target) < 0.05
                                  ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                                  : "border-[#1D263B] bg-[#0F1420] text-zinc-400 hover:text-zinc-200"
                              }`}
                            >
                              {target.toFixed(1)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
