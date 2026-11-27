import React, { useState, useMemo, useEffect, useCallback } from "react";
import { RotateCcw } from "lucide-react";
import type { AcademicCourseRecord } from "../types";
import { getCourseSyllabusWeights } from "../../../lib/tauri-client";
import { useTauriEvent } from "../../../hooks/useTauriEvent";
import {
  COMPONENT_KEYS,
  COMPONENT_LABELS,
  UIT_WEIGHT_PRESETS,
  calculateCourseTarget,
  computeCourseCurrentAverage,
  computeSemesterCurrentGpa,
  getDefaultWeightsForCourse,
  solveSemesterTargetDistribution,
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
  weightSource: "manual" | "syllabus" | "default";
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

function clearCourseWeightsOverride(courseCode: string): void {
  try {
    const current = loadSavedWeightsMap();
    delete current[courseCode];
    window.localStorage.setItem(WEIGHTS_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // ignore storage quota errors
  }
}

function formatWeightBadge(weights: ComponentWeights): string {
  return `${weights.qt}/${weights.th}/${weights.gk}/${weights.ck}`;
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
  const [syllabusWeightsMap, setSyllabusWeightsMap] = useState<Record<string, ComponentWeights>>(
    {}
  );

  const loadOfficialSyllabusWeights = useCallback(async () => {
    try {
      const list = await getCourseSyllabusWeights();
      const map: Record<string, ComponentWeights> = {};
      for (const item of list) {
        map[item.subject_code.trim().toUpperCase()] = {
          qt: item.qt_weight,
          th: item.th_weight,
          gk: item.gk_weight,
          ck: item.ck_weight,
        };
      }
      setSyllabusWeightsMap(map);
    } catch {
      // ignore if outside Tauri runtime
    }
  }, []);

  useEffect(() => {
    void loadOfficialSyllabusWeights();
  }, [loadOfficialSyllabusWeights]);

  useTauriEvent("portal-extra-synced", () => {
    void loadOfficialSyllabusWeights();
  });

  const initialItems: SimulatedCourseState[] = useMemo(() => {
    const savedWeights = loadSavedWeightsMap();

    const resolveCourseWeights = (
      courseCode: string,
      credits: number,
      hasPractice: boolean
    ): { weights: ComponentWeights; weightSource: "manual" | "syllabus" | "default" } => {
      const upper = courseCode.trim().toUpperCase();
      if (savedWeights[courseCode]) {
        return { weights: savedWeights[courseCode], weightSource: "manual" };
      }
      if (syllabusWeightsMap[upper]) {
        return { weights: syllabusWeightsMap[upper], weightSource: "syllabus" };
      }
      return {
        weights: getDefaultWeightsForCourse(courseCode, credits, hasPractice),
        weightSource: "default",
      };
    };

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
        const { weights, weightSource } = resolveCourseWeights(
          item.courseCode,
          item.credits,
          false
        );
        return {
          ...item,
          portalScores: emptyScores,
          scores: { ...emptyScores },
          weights,
          weightSource,
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
        const { weights, weightSource } = resolveCourseWeights(
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
          weightSource,
        };
      });
  }, [activeCourses, syllabusWeightsMap]);

  const [simulatedCourses, setSimulatedCourses] = useState<SimulatedCourseState[]>(initialItems);
  const [expandedWeightCode, setExpandedWeightCode] = useState<string | null>(null);
  const [isEditingAllWeights, setIsEditingAllWeights] = useState<boolean>(false);
  const [termTargetUnachievable, setTermTargetUnachievable] = useState<boolean>(false);

  useEffect(() => {
    setSimulatedCourses(initialItems);
    setTermTargetUnachievable(false);
  }, [initialItems]);

  const handleExpectedScoreChange = (courseCode: string, newScore: number) => {
    const clamped = Math.min(10.0, Math.max(0.0, Number(newScore.toFixed(2))));
    setTermTargetUnachievable(false);
    setSimulatedCourses((prev) =>
      prev.map((item) =>
        item.courseCode === courseCode ? { ...item, expectedScore10: clamped } : item
      )
    );
  };

  const handleSemesterTargetInput = (rawVal: string) => {
    const parsed = parseFloat(rawVal);
    if (!Number.isFinite(parsed)) return;
    const clampedTarget = Math.min(10.0, Math.max(0.0, parsed));

    setSimulatedCourses((prev) => {
      const dist = solveSemesterTargetDistribution(
        prev.map((item) => {
          const calc = calculateCourseTarget(item.scores, item.weights, item.expectedScore10);
          const isLocked = calc.isValidWeightSum && calc.remainingWeight === 0;
          return {
            courseCode: item.courseCode,
            credits: item.credits,
            isLocked,
            lockedScore: calc.projectedTotalScore ?? item.expectedScore10,
            minPossible: calc.isValidWeightSum ? calc.minPossibleScore : 0,
            maxPossible: calc.isValidWeightSum ? calc.maxPossibleScore : 10,
          };
        }),
        clampedTarget
      );

      setTermTargetUnachievable(!dist.isAchievable);
      return prev.map((item) => ({
        ...item,
        expectedScore10: dist.targetsByCode[item.courseCode] ?? item.expectedScore10,
      }));
    });
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

    setTermTargetUnachievable(false);
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
    setTermTargetUnachievable(false);
    setSimulatedCourses((prev) =>
      prev.map((item) => {
        if (item.courseCode !== courseCode) return item;
        const calc = calculateCourseTarget(item.scores, nextWeights, item.expectedScore10);
        return {
          ...item,
          weights: nextWeights,
          weightSource: "manual",
          expectedScore10:
            calc.projectedTotalScore !== null ? calc.projectedTotalScore : item.expectedScore10,
        };
      })
    );
  };

  const handleRestoreOfficialSyllabusWeights = (courseCode: string) => {
    const official = syllabusWeightsMap[courseCode.trim().toUpperCase()];
    if (!official) return;
    clearCourseWeightsOverride(courseCode);
    setSimulatedCourses((prev) =>
      prev.map((item) => {
        if (item.courseCode !== courseCode) return item;
        const calc = calculateCourseTarget(item.scores, official, item.expectedScore10);
        return {
          ...item,
          weights: { ...official },
          weightSource: "syllabus",
          expectedScore10:
            calc.projectedTotalScore !== null ? calc.projectedTotalScore : item.expectedScore10,
        };
      })
    );
  };

  const handleResetCoursePortalScores = (courseCode: string) => {
    setTermTargetUnachievable(false);
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
    setTermTargetUnachievable(false);
    setSimulatedCourses((prev) =>
      prev.map((item) => {
        const calc = calculateCourseTarget(item.scores, item.weights, item.expectedScore10);
        if (calc.isValidWeightSum && calc.remainingWeight === 0 && calc.projectedTotalScore !== null) {
          return { ...item, expectedScore10: calc.projectedTotalScore };
        }
        const desired =
          presetType === "8.0"
            ? 8.0
            : presetType === "8.5"
            ? 8.5
            : presetType === "9.0"
            ? 9.0
            : item.credits >= 4
            ? 9.0
            : 8.0;
        return { ...item, expectedScore10: desired };
      })
    );
  };

  const handleReset = () => {
    setTermTargetUnachievable(false);
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

    const currentTermSummary = computeSemesterCurrentGpa(simulatedCourses);

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
      currentTermGpa10: currentTermSummary.currentGpa10,
      gradedTermCredits: currentTermSummary.gradedCredits,
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
    <div
      className={`space-y-4 rounded-xl border border-[#1D263B] bg-[#0F1420] p-5 shadow-sm ${className}`}
    >
      {/* 1. Header & Presets */}
      <div className="flex flex-col justify-between gap-3 border-b border-[#1D263B] pb-3.5 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-sm font-bold text-white">GPA Target Simulator</h3>
          <p className="text-[11px] text-zinc-400">
            Bảng tính xuôi/ngược: nhập điểm thành phần hoặc nhập điểm kỳ vọng để tự suy ra điểm cần đạt
          </p>
        </div>

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

      {/* 2. Impact Hero KPI Cards — 4 Columns on Wide View */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* Card A: Bidirectional Semester Current vs Expected GPA */}
        <div className="space-y-2 rounded-lg border border-[#1D263B] bg-[#080B12] p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-zinc-400">GPA kỳ này</span>
            <span className="font-mono text-[10px] text-zinc-500">
              {calculations.gradedTermCredits}/{calculations.termCredits} TC đã có điểm
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-zinc-500">Hiện tại</div>
              <div className="mt-0.5 font-mono text-lg font-bold text-zinc-100 tabular-nums">
                {calculations.currentTermGpa10 !== null
                  ? calculations.currentTermGpa10.toFixed(2)
                  : "—"}
              </div>
            </div>

            <div>
              <label htmlFor="term-target-gpa-input" className="block text-[10px] text-[#6B9BFF]">
                Kỳ vọng kỳ (nhập ngược)
              </label>
              <div className="mt-0.5 flex items-baseline gap-1">
                <input
                  id="term-target-gpa-input"
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  value={calculations.termGpa10}
                  onChange={(e) => handleSemesterTargetInput(e.target.value)}
                  className="w-16 rounded border border-[#2F6BFF]/45 bg-[#0F1420] px-1.5 py-0.5 text-center font-mono text-base font-bold text-white focus:border-[#2F6BFF] focus:outline-none"
                />
                <span className="font-mono text-[11px] text-zinc-500">
                  ({calculations.termGpa4.toFixed(2)}/4)
                </span>
              </div>
            </div>
          </div>

          {termTargetUnachievable && (
            <div className="text-[10px] text-rose-400">
              Mục tiêu kỳ vượt trần điểm tối đa dựa trên điểm đã có.
            </div>
          )}
        </div>

        {/* Card B: Cumulative GPA */}
        <div className="space-y-1 rounded-lg border border-[#1D263B] bg-[#080B12] p-3.5">
          <span className="text-[11px] font-medium text-zinc-400">cGPA Tích lũy mới</span>
          <div className="flex items-baseline gap-2 pt-1">
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

        {/* Card C: Honors */}
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

        {/* Card D: Scholarship */}
        <div className="space-y-1 rounded-lg border border-[#1D263B] bg-[#080B12] p-3.5">
          <span className="text-[11px] font-medium text-zinc-400">Học bổng KKHT UIT</span>
          <div className="pt-0.5">
            {calculations.isScholarshipEligible ? (
              <div className="text-xs font-semibold text-emerald-400">Đủ tiêu chuẩn xét HB</div>
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

      {/* 3. Bidirectional Spreadsheet Table */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <span className="font-medium text-zinc-200">
              Bảng điểm kỳ này ({simulatedCourses.length} môn)
            </span>
            <span className="text-[11px] text-zinc-500">
              Ô trống tự tính điểm cần đạt theo Kỳ vọng
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsEditingAllWeights((prev) => !prev)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
              isEditingAllWeights
                ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                : "border-[#1D263B] bg-[#080B12] text-zinc-300 hover:border-[#2F6BFF]/40 hover:text-white"
            }`}
          >
            {isEditingAllWeights ? "Xong chỉnh trọng số" : "Chỉnh trọng số (%)"}
          </button>
        </div>

        <div className="overflow-x-auto rounded-lg border border-[#1D263B] bg-[#080B12]">
          <table className="w-full min-w-[700px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[#1D263B] bg-[#0F1420]/70 text-[11px] font-medium text-zinc-400">
                <th className="py-2.5 pl-3 pr-2">Môn học &amp; Trọng số</th>
                <th className="w-16 px-1.5 py-2.5 text-center">QT</th>
                <th className="w-16 px-1.5 py-2.5 text-center">TH</th>
                <th className="w-16 px-1.5 py-2.5 text-center">GK</th>
                <th className="w-16 px-1.5 py-2.5 text-center">CK</th>
                <th className="w-20 px-2 py-2.5 text-right">Hiện tại</th>
                <th className="w-24 pl-2 pr-3 py-2.5 text-right">Kỳ vọng</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#1D263B]/80">
              {simulatedCourses.map((course) => {
                const targetCalc = calculateCourseTarget(
                  course.scores,
                  course.weights,
                  course.expectedScore10
                );
                const currentAvgInfo = computeCourseCurrentAverage(course.scores, course.weights);
                const isWeightOpen = expandedWeightCode === course.courseCode;
                const showWeightEditor = isWeightOpen || isEditingAllWeights;
                const isComponentScoreLocked =
                  targetCalc.isValidWeightSum && targetCalc.remainingWeight === 0;
                const { gradeChar } = score10ToScale4(course.expectedScore10);

                return (
                  <React.Fragment key={course.courseCode}>
                    <tr className="transition-colors duration-100 hover:bg-[#151C2C]/60">
                      {/* Col 1: Course Info + Weight Badge */}
                      <td className="py-2.5 pl-3 pr-2 align-middle">
                        <div className="max-w-[260px] truncate font-medium text-zinc-100" title={course.courseName}>
                          {course.courseName}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                          <span className="text-zinc-400">
                            {course.courseCode} · {course.credits} TC
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              if (isEditingAllWeights) {
                                setIsEditingAllWeights(false);
                                setExpandedWeightCode(course.courseCode);
                              } else {
                                setExpandedWeightCode((curr) =>
                                  curr === course.courseCode ? null : course.courseCode
                                );
                              }
                            }}
                            title="Bấm để chỉnh trọng số QT / TH / GK / CK"
                            className={`rounded border px-1.5 py-0.5 transition-colors cursor-pointer ${
                              showWeightEditor
                                ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                                : "border-[#1D263B] bg-[#0F1420] text-zinc-400 hover:text-zinc-200"
                            }`}
                          >
                            {formatWeightBadge(course.weights)}
                          </button>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[9px] ${
                              course.weightSource === "syllabus"
                                ? "border-emerald-500/25 bg-emerald-950/40 text-emerald-400"
                                : course.weightSource === "manual"
                                ? "border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.12] text-[#6B9BFF]"
                                : "border-[#1D263B] bg-[#0F1420] text-zinc-500"
                            }`}
                          >
                            {course.weightSource === "syllabus"
                              ? "Đề cương UIT"
                              : course.weightSource === "manual"
                              ? "Tự chỉnh"
                              : "Mặc định"}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              if (isEditingAllWeights) {
                                setIsEditingAllWeights(false);
                                setExpandedWeightCode(course.courseCode);
                              } else {
                                setExpandedWeightCode((curr) =>
                                  curr === course.courseCode ? null : course.courseCode
                                );
                              }
                            }}
                            className="rounded border border-[#1D263B] bg-[#0F1420] px-1.5 py-0.5 text-[10px] text-zinc-300 transition-colors hover:border-[#2F6BFF]/40 hover:text-white cursor-pointer"
                          >
                            {isWeightOpen && !isEditingAllWeights ? "Thu gọn" : "Sửa %"}
                          </button>
                        </div>
                      </td>

                      {/* Cols 2-5: QT, TH, GK, CK */}
                      {COMPONENT_KEYS.map((key) => {
                        const weightVal = course.weights[key];
                        const scoreVal = course.scores[key];
                        const portalVal = course.portalScores[key];
                        const hasPortalVal = portalVal !== null && portalVal !== undefined;
                        const isDisabled = weightVal <= 0;

                        let hintText = "";
                        let hintTone = "text-zinc-500";
                        if (
                          !isDisabled &&
                          scoreVal === null &&
                          targetCalc.isValidWeightSum &&
                          targetCalc.requiredScore !== null
                        ) {
                          if (targetCalc.isAlreadyGuaranteed) {
                            hintText = "Đạt";
                            hintTone = "text-emerald-400/80";
                          } else if (!targetCalc.isAchievable) {
                            hintText = `>${targetCalc.requiredScore.toFixed(1)}`;
                            hintTone = "text-rose-400/90";
                          }
                        }

                      return (
                        <td key={key} className="px-1 py-2 text-center align-middle">
                          <div className="flex flex-col items-center gap-0.5">
                            {isDisabled ? (
                              <div
                                title={`${COMPONENT_LABELS[key]} không có trọng số (0%)`}
                                className="flex h-7 w-14 items-center justify-center rounded border border-[#1D263B]/50 bg-[#080B12] font-mono text-[11px] text-zinc-600 select-none"
                              >
                                —
                              </div>
                            ) : (
                              <input
                                type="number"
                                min={0}
                                max={10}
                                step={0.1}
                                aria-label={`${course.courseCode} ${COMPONENT_LABELS[key]}`}
                                placeholder={
                                  targetCalc.isValidWeightSum &&
                                  targetCalc.requiredScore !== null &&
                                  targetCalc.requiredScore > 0 &&
                                  targetCalc.requiredScore <= 10
                                    ? targetCalc.requiredScore.toFixed(1)
                                    : "—"
                                }
                                value={scoreVal === null ? "" : scoreVal}
                                onChange={(e) =>
                                  handleComponentScoreChange(
                                    course.courseCode,
                                    key,
                                    e.target.value
                                  )
                                }
                                className={`h-7 w-14 rounded border px-1 text-center font-mono text-xs tabular-nums focus:border-[#2F6BFF] focus:outline-none ${
                                  hasPortalVal && scoreVal === portalVal
                                    ? "border-[#2F6BFF]/40 bg-[#2F6BFF]/[0.12] font-semibold text-white"
                                    : scoreVal !== null
                                    ? "border-[#1D263B] bg-[#0F1420] font-semibold text-white"
                                    : "border-[#1D263B] bg-[#0F1420]/60 text-zinc-200 placeholder:text-[#6B9BFF]/65"
                                }`}
                              />
                            )}
                            <span
                              className={`font-mono text-[9px] tabular-nums ${
                                isDisabled ? "text-zinc-700" : hintText ? hintTone : "text-zinc-500"
                              }`}
                            >
                              {isDisabled ? "0%" : hintText ? `${weightVal}% · ${hintText}` : `${weightVal}%`}
                            </span>
                          </div>
                        </td>
                      );
                    })}

                    {/* Col 6: Current Weighted Average */}
                    <td className="px-2 py-2 text-right align-middle font-mono tabular-nums">
                      {currentAvgInfo.currentAvg !== null ? (
                        <div>
                          <div className="text-xs font-semibold text-zinc-200">
                            {currentAvgInfo.currentAvg.toFixed(2)}
                          </div>
                          <div className="text-[9px] text-zinc-500">
                            {currentAvgInfo.knownWeight}%
                          </div>
                        </div>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>

                    {/* Col 7: Expected Score (Editable -> Reverse Solves Row) */}
                    <td className="pl-2 pr-3 py-2 text-right align-middle">
                      <div className="inline-flex flex-col items-end gap-0.5">
                        <input
                          type="number"
                          min={0}
                          max={10}
                          step={0.1}
                          disabled={isComponentScoreLocked}
                          aria-label={`${course.courseCode} Kỳ vọng`}
                          value={course.expectedScore10}
                          onChange={(e) =>
                            handleExpectedScoreChange(
                              course.courseCode,
                              parseFloat(e.target.value) || 0
                            )
                          }
                          className={`h-7 w-14 rounded border px-1.5 text-center font-mono text-xs font-bold tabular-nums focus:border-[#2F6BFF] focus:outline-none ${
                            isComponentScoreLocked
                              ? "border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.1] text-[#6B9BFF]"
                              : !targetCalc.isAchievable
                              ? "border-rose-500/50 bg-rose-950/30 text-rose-300"
                              : "border-[#1D263B] bg-[#0F1420] text-white"
                          }`}
                        />
                        <span className="font-mono text-[9px] text-zinc-500">
                          {gradeChar} ·{" "}
                          {targetCalc.isValidWeightSum
                            ? `${targetCalc.minPossibleScore.toFixed(1)}–${targetCalc.maxPossibleScore.toFixed(1)}`
                            : "!%"}
                        </span>
                      </div>
                    </td>
                  </tr>

                  {/* Expandable Weight Config Sub-row */}
                  {showWeightEditor && (
                    <tr className="bg-[#0F1420]/90">
                      <td colSpan={7} className="px-3 py-2.5">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-zinc-500">Mẫu UIT:</span>
                              {UIT_WEIGHT_PRESETS.map((preset) => {
                                const isCurrent =
                                  formatWeightBadge(course.weights) ===
                                  formatWeightBadge(preset.weights);
                                return (
                                  <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() =>
                                      handleWeightsChange(course.courseCode, { ...preset.weights })
                                    }
                                    className={`rounded border px-2 py-0.5 font-mono transition-colors cursor-pointer ${
                                      isCurrent
                                        ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                                        : "border-[#1D263B] bg-[#080B12] text-zinc-400 hover:text-zinc-200"
                                    }`}
                                  >
                                    {preset.label}
                                  </button>
                                );
                              })}
                            </div>

                            <div className="flex items-center gap-2 font-mono">
                              <span
                                className={
                                  targetCalc.isValidWeightSum
                                    ? "text-zinc-400"
                                    : "font-semibold text-rose-400"
                                }
                              >
                                Tổng: {targetCalc.totalWeight}%
                              </span>
                              {course.weightSource === "manual" &&
                                syllabusWeightsMap[course.courseCode.trim().toUpperCase()] && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleRestoreOfficialSyllabusWeights(course.courseCode)
                                    }
                                    className="rounded border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.12] px-2 py-0.5 text-[#6B9BFF] hover:bg-[#2F6BFF]/[0.2] cursor-pointer"
                                  >
                                    Về đề cương UIT
                                  </button>
                                )}
                              <button
                                type="button"
                                onClick={() => handleResetCoursePortalScores(course.courseCode)}
                                className="rounded border border-[#1D263B] bg-[#080B12] px-2 py-0.5 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                              >
                                Khôi phục điểm Portal
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-4 gap-2">
                            {COMPONENT_KEYS.map((key) => (
                              <label
                                key={key}
                                className="flex items-center justify-between rounded border border-[#1D263B] bg-[#080B12] px-2 py-1 text-[11px]"
                              >
                                <span className="font-mono text-zinc-400">
                                  {COMPONENT_LABELS[key]} %
                                </span>
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  step={5}
                                  value={course.weights[key]}
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
                                  className="w-12 rounded border border-[#1D263B] bg-[#0F1420] px-1 py-0.5 text-center font-mono text-xs text-white focus:border-[#2F6BFF] focus:outline-none"
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
};
