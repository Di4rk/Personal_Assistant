import React, { useMemo, useState } from "react";
import {
  buildDynamicTermPresets,
  evaluateUitWorkload,
  getRecommendedTerms,
} from "../utils/forecastEngine";
import { SemesterGpaSimulator } from "./SemesterGpaSimulator";
import type { AcademicCourseRecord } from "../types";

interface GpaSimulatorCardProps {
  currentGpaCredits: number;
  currentEarnedCredits: number;
  currentTotalWeighted10: number;
  currentGpa10: number;
  completedTermsCount?: number;
  totalDegreeCredits?: number;
  activeCourses?: AcademicCourseRecord[];
  activeSemesterId?: string;
  semesters?: Array<{ id: string; label: string }>;
  onSelectSemester?: (semesterId: string) => void;
  className?: string;
}

type SimulatorScope = "semester" | "degree";
type SimulatorMode = "time" | "pace";

const EMPTY_ACTIVE_COURSES: NonNullable<GpaSimulatorCardProps["activeCourses"]> = [];

export const GpaSimulatorCard: React.FC<GpaSimulatorCardProps> = ({
  currentGpaCredits,
  currentEarnedCredits,
  currentTotalWeighted10,
  currentGpa10,
  completedTermsCount = 2,
  totalDegreeCredits = 126,
  activeCourses = EMPTY_ACTIVE_COURSES,
  activeSemesterId,
  semesters,
  onSelectSemester,
  className = "",
}) => {
  const [scope, setScope] = useState<SimulatorScope>("semester");
  const TOTAL_DEGREE_CREDITS = totalDegreeCredits;
  const remainingCredits = Math.max(0, TOTAL_DEGREE_CREDITS - currentEarnedCredits);

  const [mode, setMode] = useState<SimulatorMode>("time");
  const [targetGpa10, setTargetGpa10] = useState<number>(8.5);

  const completedTerms = Math.max(0, completedTermsCount);
  const recommendedTerms = useMemo(
    () => getRecommendedTerms(remainingCredits, completedTerms),
    [remainingCredits, completedTerms]
  );
  const [customTerms, setCustomTerms] = useState<number | null>(null);
  const selectedTerms = customTerms ?? recommendedTerms;
  const updateSelectedTerms = (next: number) => {
    if (!Number.isFinite(next)) return;
    setCustomTerms(Math.max(1, Math.min(16, Math.round(next))));
  };
  const [creditsPerTerm, setCreditsPerTerm] = useState<number>(21);

  const { effectiveTerms, effectiveCreditsPerTerm } = useMemo(() => {
    if (remainingCredits <= 0) {
      return { effectiveTerms: 0, effectiveCreditsPerTerm: 0 };
    }

    if (mode === "time") {
      const terms = Math.max(1, selectedTerms);
      const pace = Math.ceil(remainingCredits / terms);
      return { effectiveTerms: terms, effectiveCreditsPerTerm: pace };
    }
    const pace = Math.max(1, creditsPerTerm);
    const terms = Math.ceil(remainingCredits / pace);
    return { effectiveTerms: terms, effectiveCreditsPerTerm: pace };
  }, [mode, selectedTerms, creditsPerTerm, remainingCredits]);

  const effectiveWorkload = useMemo(
    () => evaluateUitWorkload(effectiveCreditsPerTerm),
    [effectiveCreditsPerTerm]
  );

  const paceWorkload = useMemo(
    () => evaluateUitWorkload(creditsPerTerm),
    [creditsPerTerm]
  );

  const estimatedGraduationYears = useMemo(() => {
    const totalTerms = completedTerms + effectiveTerms;
    return (totalTerms / 2).toFixed(1);
  }, [completedTerms, effectiveTerms]);

  const finalGpaCreditsAtGraduation = currentGpaCredits + remainingCredits;
  const targetTotalPoints = targetGpa10 * finalGpaCreditsAtGraduation;
  const requiredRemainingPoints = targetTotalPoints - currentTotalWeighted10;
  const requiredAverageGpa10 =
    remainingCredits > 0
      ? Number((requiredRemainingPoints / remainingCredits).toFixed(2))
      : 0;

  const isAchievable = requiredAverageGpa10 <= 10.0 && requiredAverageGpa10 >= 0;

  const degreeRank = useMemo(() => {
    if (targetGpa10 >= 9.0) {
      return { label: "Xuất sắc", color: "text-amber-400 border-amber-500/30 bg-amber-950/40" };
    }
    if (targetGpa10 >= 8.0) {
      return {
        label: "Giỏi",
        color: "text-emerald-400 border-emerald-500/30 bg-emerald-950/40",
      };
    }
    if (targetGpa10 >= 7.0) {
      return {
        label: "Khá",
        color: "text-[#6B9BFF] border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.16]",
      };
    }
    return { label: "Trung bình", color: "text-zinc-400 border-[#1D263B] bg-[#080B12]" };
  }, [targetGpa10]);

  const timePresets = useMemo(
    () => buildDynamicTermPresets(remainingCredits, completedTerms),
    [remainingCredits, completedTerms]
  );

  return (
    <div
      className={`flex flex-col justify-between rounded-xl border border-[#1D263B] bg-[#0F1420] p-5 shadow-sm ${className}`}
    >
      {/* Top Scope Switcher */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#1D263B] pb-3">
        <div className="flex rounded-lg border border-[#1D263B] bg-[#080B12] p-0.5">
          <button
            type="button"
            onClick={() => setScope("semester")}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors cursor-pointer ${
              scope === "semester"
                ? "bg-[#2F6BFF] font-semibold text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Chiến thuật kỳ này
          </button>
          <button
            type="button"
            onClick={() => setScope("degree")}
            className={`rounded-md px-3 py-1.5 text-xs transition-colors cursor-pointer ${
              scope === "degree"
                ? "bg-[#2F6BFF] font-semibold text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Dự báo toàn khóa
          </button>
        </div>

        {scope === "degree" ? (
          <div
            className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${degreeRank.color}`}
          >
            Hạng: {degreeRank.label}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {semesters && semesters.length > 1 && onSelectSemester && (
              <select
                aria-label="Chọn học kỳ mô phỏng"
                value={activeSemesterId ?? semesters[0].id}
                onChange={(e) => onSelectSemester(e.target.value)}
                className="cursor-pointer rounded-md border border-[#1D263B] bg-[#080B12] px-2.5 py-1 text-xs font-medium text-zinc-200 focus:border-[#2F6BFF] focus:outline-none"
              >
                {semesters.map((sem) => (
                  <option key={sem.id} value={sem.id}>
                    {sem.label}
                  </option>
                ))}
              </select>
            )}
            <div className="font-mono text-xs text-zinc-400">
              cGPA hiện tại:{" "}
              <span className="font-bold text-[#6B9BFF]">
                {currentGpa10 > 0 ? currentGpa10.toFixed(2) : "0.00"}
              </span>
            </div>
          </div>
        )}
      </div>

      {scope === "semester" ? (
        <SemesterGpaSimulator
          currentGpaCredits={currentGpaCredits}
          currentTotalWeighted10={currentTotalWeighted10}
          currentGpa10={currentGpa10}
          activeSemesterId={activeSemesterId}
          activeCourses={activeCourses}
          className="border-0 bg-transparent p-0 shadow-none"
        />
      ) : (
        <>
          {/* Header card */}
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-zinc-100">
              Dự Báo Tốt Nghiệp &amp; GPA Simulator
            </h3>
            <p className="text-xs text-zinc-500">
              Mô phỏng cGPA mục tiêu và phân bổ lộ trình tín chỉ UIT
            </p>
          </div>

          {/* Progress Badge */}
          <div className="mb-4 flex items-center justify-between rounded-lg border border-[#1D263B] bg-[#080B12] px-3.5 py-2">
            <span className="text-xs text-zinc-400">Tiến độ tích lũy CTĐT:</span>
            <span className="font-mono text-xs font-semibold text-zinc-200">
              <span className="font-bold text-emerald-400">{currentEarnedCredits}</span> /{" "}
              {TOTAL_DEGREE_CREDITS} TC{" "}
              <span className="font-normal text-zinc-500">
                (Còn <span className="font-bold text-[#6B9BFF]">{remainingCredits}</span> TC)
              </span>
            </span>
          </div>

          {/* Slider Mục tiêu cGPA Tốt Nghiệp */}
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="gpa-slider" className="text-xs font-medium text-zinc-300">
                  Mục tiêu cGPA Tốt nghiệp:
                </label>
                <span className="font-mono text-lg font-bold text-[#6B9BFF] tabular-nums">
                  {targetGpa10.toFixed(2)}
                  <span className="ml-1 text-xs text-zinc-500">/ 10.0</span>
                </span>
              </div>

              <input
                id="gpa-slider"
                type="range"
                min={7.0}
                max={9.5}
                step={0.05}
                value={targetGpa10}
                onChange={(e) => setTargetGpa10(parseFloat(e.target.value))}
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[#1D263B] accent-[#2F6BFF] focus:outline-none"
              />

              <div className="mt-1 flex justify-between px-0.5 font-mono text-[10px] text-zinc-500">
                <span>7.00 (Khá)</span>
                <span>8.00 (Giỏi)</span>
                <span>8.50</span>
                <span>9.00 (Xuất sắc)</span>
                <span>9.50</span>
              </div>
            </div>

            {/* Mode Selector Tabs */}
            <div className="pt-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-zinc-300">Phương thức mô phỏng:</span>
                <div className="flex rounded-lg border border-[#1D263B] bg-[#080B12] p-0.5">
                  <button
                    type="button"
                    onClick={() => setMode("time")}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                      mode === "time"
                        ? "bg-[#2F6BFF] text-white"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Lộ trình thời gian
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("pace")}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                      mode === "pace"
                        ? "bg-[#2F6BFF] text-white"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Tải trọng tín chỉ
                  </button>
                </div>
              </div>

              {mode === "time" ? (
                remainingCredits > 0 ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {timePresets.map((preset) => {
                        const isSelected = selectedTerms === preset.terms;
                        return (
                          <button
                            key={preset.terms}
                            type="button"
                            onClick={() => updateSelectedTerms(preset.terms)}
                            className={`flex min-h-[74px] cursor-pointer flex-col items-center justify-between rounded-lg border px-2 py-2 text-center text-xs font-medium transition-colors ${
                              isSelected
                                ? "border-[#2F6BFF] bg-[#2F6BFF]/[0.16] text-[#6B9BFF] ring-1 ring-[#2F6BFF]/30"
                                : "border-[#1D263B] bg-[#080B12] text-zinc-400 hover:border-[#2F6BFF]/35 hover:bg-[#151C2C] hover:text-zinc-200"
                            }`}
                          >
                            <div className="text-sm font-bold text-zinc-100">{preset.label}</div>
                            <div className="mt-0.5 font-mono text-[11px] text-zinc-400">
                              ~{preset.pace} TC/kỳ • ~{preset.estimatedYears} năm
                            </div>
                            <div
                              className={`mt-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-tight whitespace-nowrap ${preset.workload.badgeColor}`}
                            >
                              {preset.workload.label}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-400">Số kỳ tùy chỉnh:</span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={selectedTerms <= 1}
                            onClick={() => updateSelectedTerms(selectedTerms - 1)}
                            aria-label="Giảm số kỳ"
                            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-[#1D263B] bg-[#0F1420] font-mono text-xs text-zinc-300 transition-colors hover:border-[#2F6BFF]/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            -
                          </button>
                          <input
                            type="number"
                            min={1}
                            max={16}
                            value={selectedTerms}
                            onChange={(e) => {
                              const parsed = parseInt(e.target.value, 10);
                              if (!Number.isNaN(parsed)) {
                                updateSelectedTerms(parsed);
                              }
                            }}
                            aria-label="Số kỳ tùy chỉnh"
                            className="h-6 w-12 rounded border border-[#1D263B] bg-[#0F1420] text-center font-mono text-xs font-semibold text-zinc-100 focus:border-[#2F6BFF] focus:outline-none"
                          />
                          <button
                            type="button"
                            disabled={selectedTerms >= 16}
                            onClick={() => updateSelectedTerms(selectedTerms + 1)}
                            aria-label="Tăng số kỳ"
                            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-[#1D263B] bg-[#0F1420] font-mono text-xs text-zinc-300 transition-colors hover:border-[#2F6BFF]/50 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            +
                          </button>
                        </div>
                        <span className="text-zinc-400">kỳ</span>
                      </div>
                      <span className="font-mono text-[11px] text-zinc-400">
                        ~{effectiveCreditsPerTerm} TC/kỳ • Tổng {completedTerms + effectiveTerms} kỳ (~
                        {estimatedGraduationYears} năm)
                      </span>
                    </div>
                  </div>
                ) : null
              ) : (
                <div
                  className={`space-y-2.5 rounded-lg border bg-[#080B12] p-3 transition-colors ${
                    paceWorkload.isInvalid
                      ? "border-rose-800/80"
                      : paceWorkload.tier === "below_floor"
                      ? "border-amber-800/80"
                      : "border-[#1D263B]"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">Số tín chỉ dự kiến học mỗi kỳ:</span>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${paceWorkload.badgeColor}`}
                      >
                        {paceWorkload.label}
                      </span>
                      <span className="font-mono text-sm font-bold text-zinc-100">
                        {creditsPerTerm} TC/kỳ
                      </span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={32}
                    step={1}
                    value={creditsPerTerm}
                    onChange={(e) => setCreditsPerTerm(parseInt(e.target.value, 10))}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-[#1D263B] accent-[#2F6BFF] focus:outline-none"
                  />
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="text-amber-400/80">10 TC (&lt;14 Sàn HB)</span>
                    <span className="font-semibold text-zinc-300">
                      {effectiveTerms} kỳ nữa • Tốt nghiệp ~{estimatedGraduationYears} năm
                    </span>
                    <span className="text-rose-400/80">32 TC (&gt;30 Trần UIT)</span>
                  </div>
                </div>
              )}
            </div>

            {/* Real-time Result Alert Card */}
            {remainingCredits <= 0 ? (
              <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/30 p-3.5 text-xs text-emerald-300">
                <div className="leading-relaxed">
                  Bạn đã hoàn thành đủ{" "}
                  <span className="font-mono font-bold text-zinc-100">{TOTAL_DEGREE_CREDITS}</span>{" "}
                  tín chỉ theo khung chương trình đào tạo với cGPA hiện tại là{" "}
                  <span className="font-mono font-bold text-emerald-400">
                    {currentGpa10.toFixed(2)}
                  </span>
                  . Đủ điều kiện tốt nghiệp loại{" "}
                  <span className="font-semibold text-emerald-200">{degreeRank.label}</span>!
                </div>
              </div>
            ) : !isAchievable ? (
              <div className="rounded-lg border border-rose-800/50 bg-rose-950/40 p-3.5 text-xs text-rose-300">
                <div className="leading-relaxed">
                  <p className="font-semibold text-rose-200">Mục tiêu cGPA bất khả thi!</p>
                  <p className="mt-0.5 text-rose-400/90">
                    Cần đạt cGPA trung bình{" "}
                    <span className="font-mono text-sm font-bold text-rose-300">
                      {requiredAverageGpa10.toFixed(2)} / 10.0
                    </span>{" "}
                    ở các tín chỉ còn lại (vượt trần tối đa 10.0). Vui lòng hạ chỉ tiêu hoặc kéo dài
                    lộ trình.
                  </p>
                </div>
              </div>
            ) : effectiveWorkload.isInvalid ? (
              <div className="rounded-lg border border-rose-800/50 bg-rose-950/40 p-3.5 text-xs text-rose-300">
                <div className="leading-relaxed">
                  <p className="font-semibold text-rose-200">
                    Vi phạm quy chế đào tạo UIT (Vượt trần 30 TC)!
                  </p>
                  <p className="mt-0.5 text-rose-300/90">
                    Với mức tải{" "}
                    <span className="font-mono font-bold text-rose-200">
                      ~{effectiveCreditsPerTerm} TC/kỳ
                    </span>
                    , bạn đang vượt quá giới hạn tối đa 30 tín chỉ trong một học kỳ chính. Hệ thống
                    Portal UIT sẽ từ chối đăng ký phương án này.
                  </p>
                </div>
              </div>
            ) : effectiveWorkload.tier === "below_floor" ? (
              <div className="rounded-lg border border-amber-800/50 bg-amber-950/40 p-3.5 text-xs text-amber-300">
                <div className="leading-relaxed">
                  Cần duy trì{" "}
                  <span className="font-semibold text-amber-200">cGPA trung bình tối thiểu</span>{" "}
                  <span className="font-mono text-sm font-bold text-amber-400">
                    {requiredAverageGpa10.toFixed(2)}
                  </span>{" "}
                  trên{" "}
                  <span className="font-mono font-bold text-zinc-100">
                    {remainingCredits} tín chỉ còn lại
                  </span>
                  . <span className="font-bold text-amber-200">Lưu ý:</span> Với mức tải{" "}
                  <span className="font-mono font-bold text-amber-400">
                    ~{effectiveCreditsPerTerm} TC/kỳ
                  </span>
                  , bạn{" "}
                  <span className="font-bold text-amber-200 underline decoration-amber-500/50">
                    sẽ không đủ điều kiện xét Học bổng KKHT
                  </span>{" "}
                  theo quy chế đào tạo UIT.
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/30 p-3.5 text-xs text-emerald-300">
                <div className="leading-relaxed">
                  Cần duy trì{" "}
                  <span className="font-semibold text-emerald-200">cGPA trung bình tối thiểu</span>{" "}
                  <span className="font-mono text-sm font-bold text-emerald-400">
                    {requiredAverageGpa10.toFixed(2)}
                  </span>{" "}
                  trên tổng số{" "}
                  <span className="font-mono font-bold text-zinc-100">
                    {remainingCredits} tín chỉ còn lại
                  </span>{" "}
                  (trung bình{" "}
                  <span className="font-mono font-bold text-emerald-300">
                    {effectiveCreditsPerTerm} TC/kỳ
                  </span>{" "}
                  trong{" "}
                  <span className="font-mono font-bold text-zinc-100">
                    {effectiveTerms} học kỳ tới
                  </span>
                  ) để tốt nghiệp loại{" "}
                  <span className="font-semibold text-emerald-200">{degreeRank.label}</span>. Mức
                  tải này{" "}
                  <span className="font-bold text-emerald-200">
                    đủ điều kiện tối thiểu để xét Học bổng KKHT
                  </span>
                  .
                </div>
              </div>
            )}

            {/* Key Metrics 2x2 Grid */}
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <div className="rounded-lg border border-[#1D263B] bg-[#080B12] p-3">
                <div className="text-[11px] text-zinc-500">cGPA hiện tại</div>
                <div className="mt-0.5 font-mono text-base font-bold text-zinc-200">
                  {currentGpa10 > 0 ? currentGpa10.toFixed(2) : "0.00"}
                </div>
              </div>

              <div className="rounded-lg border border-[#1D263B] bg-[#080B12] p-3">
                <div className="text-[11px] text-zinc-500">Mục tiêu cGPA</div>
                <div className="mt-0.5 font-mono text-base font-bold text-[#6B9BFF]">
                  {targetGpa10.toFixed(2)}
                </div>
              </div>

              <div className="rounded-lg border border-[#1D263B] bg-[#080B12] p-3">
                <div className="text-[11px] text-zinc-500">cGPA cần đạt (còn lại)</div>
                <div
                  className={`mt-0.5 font-mono text-base font-bold ${
                    isAchievable ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {requiredAverageGpa10.toFixed(2)}
                </div>
              </div>

              <div className="rounded-lg border border-[#1D263B] bg-[#080B12] p-3">
                <div className="text-[11px] text-zinc-500">Tải trọng dự kiến</div>
                <div
                  className={`mt-0.5 font-mono text-base font-bold ${
                    effectiveWorkload.isInvalid
                      ? "text-rose-400"
                      : effectiveWorkload.tier === "below_floor"
                      ? "text-amber-400"
                      : effectiveWorkload.tier === "max_limit"
                      ? "text-amber-400"
                      : effectiveWorkload.tier === "high_pace"
                      ? "text-[#6B9BFF]"
                      : "text-emerald-400"
                  }`}
                >
                  ~{effectiveCreditsPerTerm}{" "}
                  <span className="text-xs font-normal text-zinc-500">TC/kỳ</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
