import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  Calendar,
  CheckCircle2,
  GraduationCap,
  Sliders,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";
import { evaluateUitWorkload } from "../utils/forecastEngine";
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
  className?: string;
}

type SimulatorScope = "semester" | "degree";
type SimulatorMode = "time" | "pace";

/**
 * Redesigned Graduation Forecast & GPA Simulator (UIT Workload & Scholarship Rules)
 *
 * Chế độ 1: Kịch bản kỳ này (Semester Target Simulator) - Tính toán bước nhảy cGPA và điều kiện HB.
 * Chế độ 2: Dự báo toàn khóa (Degree Pace Simulator) - Phân bổ lộ trình tốt nghiệp theo quy chế UIT.
 */
export const GpaSimulatorCard: React.FC<GpaSimulatorCardProps> = ({
  currentGpaCredits,
  currentEarnedCredits,
  currentTotalWeighted10,
  currentGpa10,
  completedTermsCount = 2,
  totalDegreeCredits = 126,
  activeCourses = [],
  activeSemesterId,
  className = "",
}) => {
  const [scope, setScope] = useState<SimulatorScope>("semester");
  const TOTAL_DEGREE_CREDITS = totalDegreeCredits;
  const remainingCredits = Math.max(0, TOTAL_DEGREE_CREDITS - currentEarnedCredits);

  // Chế độ mô phỏng
  const [mode, setMode] = useState<SimulatorMode>("time");
  const [targetGpa10, setTargetGpa10] = useState<number>(8.5); // Default: Giỏi (8.5)

  // State Chế độ A: Theo lộ trình thời gian (số kỳ còn lại)
  const completedTerms = Math.max(1, completedTermsCount);
  const [selectedTerms, setSelectedTerms] = useState<number>(5);

  // State Chế độ B: Theo tải trọng tín chỉ mỗi kỳ
  const [creditsPerTerm, setCreditsPerTerm] = useState<number>(21);

  // Tính số kỳ và số tín chỉ/kỳ hiệu dụng dựa theo mode đang chọn
  const { effectiveTerms, effectiveCreditsPerTerm } = useMemo(() => {
    if (remainingCredits <= 0) {
      return { effectiveTerms: 0, effectiveCreditsPerTerm: 0 };
    }

    if (mode === "time") {
      const terms = Math.max(1, selectedTerms);
      const pace = Math.ceil(remainingCredits / terms);
      return { effectiveTerms: terms, effectiveCreditsPerTerm: pace };
    } else {
      const pace = Math.max(1, creditsPerTerm);
      const terms = Math.ceil(remainingCredits / pace);
      return { effectiveTerms: terms, effectiveCreditsPerTerm: pace };
    }
  }, [mode, selectedTerms, creditsPerTerm, remainingCredits]);

  // Đánh giá tải trọng hiệu dụng theo quy chế UIT
  const effectiveWorkload = useMemo(
    () => evaluateUitWorkload(effectiveCreditsPerTerm),
    [effectiveCreditsPerTerm]
  );

  // Đánh giá tải trọng chế độ Pace
  const paceWorkload = useMemo(
    () => evaluateUitWorkload(creditsPerTerm),
    [creditsPerTerm]
  );

  // Dự báo năm tốt nghiệp (1 năm = 2 học kỳ chính)
  const estimatedGraduationYears = useMemo(() => {
    const totalTerms = completedTerms + effectiveTerms;
    return (totalTerms / 2).toFixed(1);
  }, [completedTerms, effectiveTerms]);

  // Tính cGPA trung bình cần đạt trên tổng số tín chỉ còn lại
  const targetTotalPoints = targetGpa10 * TOTAL_DEGREE_CREDITS;
  const requiredRemainingPoints = targetTotalPoints - currentTotalWeighted10;
  const requiredAverageGpa10 =
    remainingCredits > 0
      ? Number((requiredRemainingPoints / remainingCredits).toFixed(2))
      : 0;

  const isAchievable = requiredAverageGpa10 <= 10.0 && requiredAverageGpa10 >= 0;

  // Danh hiệu tốt nghiệp theo chuẩn ĐHQG-HCM
  const degreeRank = useMemo(() => {
    if (targetGpa10 >= 9.0)
      return { label: "Xuất sắc", color: "text-amber-400 border-amber-500/30 bg-amber-950/40" };
    if (targetGpa10 >= 8.0)
      return { label: "Giỏi", color: "text-violet-400 border-violet-500/30 bg-violet-950/40" };
    if (targetGpa10 >= 7.0)
      return { label: "Khá", color: "text-blue-400 border-blue-500/30 bg-blue-950/40" };
    return { label: "Trung bình", color: "text-zinc-400 border-zinc-700 bg-zinc-800" };
  }, [targetGpa10]);

  // 4 Card Preset (Lộ trình thời gian) tính động số TC/kỳ và badge theo quy chế UIT
  const timePresets = useMemo(() => {
    return [4, 5, 6, 7].map((terms) => {
      const pace = remainingCredits > 0 ? Math.ceil(remainingCredits / terms) : 0;
      const workload = evaluateUitWorkload(pace);
      return {
        terms,
        label: `${terms} kỳ nữa`,
        pace,
        workload,
      };
    });
  }, [remainingCredits]);

  return (
    <div
      className={`rounded-xl bg-zinc-900 border border-zinc-800 p-5 shadow-lg flex flex-col justify-between ${className}`}
    >
      {/* Top Scope Switcher */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex rounded-lg bg-zinc-950 p-0.5 border border-zinc-800">
          <button
            type="button"
            onClick={() => setScope("semester")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-all cursor-pointer ${
              scope === "semester"
                ? "bg-violet-600 text-white shadow-sm font-semibold"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Target className="w-3.5 h-3.5" />
            Chiến thuật kỳ này
          </button>
          <button
            type="button"
            onClick={() => setScope("degree")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-all cursor-pointer ${
              scope === "degree"
                ? "bg-violet-600 text-white shadow-sm font-semibold"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <GraduationCap className="w-3.5 h-3.5" />
            Dự báo toàn khóa
          </button>
        </div>

        {scope === "degree" ? (
          <div
            className={`px-2.5 py-1 rounded-full border text-xs font-semibold flex items-center gap-1.5 ${degreeRank.color}`}
          >
            <Award className="w-3.5 h-3.5" />
            Hạng: {degreeRank.label}
          </div>
        ) : (
          <div className="text-xs font-mono text-zinc-400">
            cGPA hiện tại:{" "}
            <span className="text-violet-400 font-bold">
              {currentGpa10 > 0 ? currentGpa10.toFixed(2) : "0.00"}
            </span>
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
          <div className="flex items-center gap-2.5 mb-3">
            <div className="p-2 rounded-lg bg-violet-950/60 border border-violet-800/50 text-violet-400">
              <GraduationCap className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                Dự Báo Tốt Nghiệp &amp; GPA Simulator
              </h3>
              <p className="text-xs text-zinc-500">
                Mô phỏng cGPA mục tiêu và phân bổ lộ trình tín chỉ UIT
              </p>
            </div>
          </div>

          {/* Progress Badge */}
          <div className="flex items-center justify-between bg-zinc-950/60 border border-zinc-800/80 rounded-lg px-3.5 py-2 mb-4">
            <span className="text-xs text-zinc-400 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
              Tiến độ tích lũy CTĐT:
            </span>
            <span className="font-mono text-xs font-semibold text-zinc-200">
              <span className="text-emerald-400 font-bold">{currentEarnedCredits}</span> /{" "}
              {TOTAL_DEGREE_CREDITS} TC{" "}
              <span className="text-zinc-500 font-normal">
                (Còn <span className="text-violet-400 font-bold">{remainingCredits}</span> TC)
              </span>
            </span>
          </div>

          {/* Slider Mục tiêu cGPA Tốt Nghiệp */}
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="gpa-slider"
                  className="text-xs font-medium text-zinc-300 flex items-center gap-1.5"
                >
                  <Sliders className="w-3.5 h-3.5 text-violet-400" />
                  Mục tiêu cGPA Tốt nghiệp:
                </label>
                <span className="font-mono text-lg font-bold text-violet-400">
                  {targetGpa10.toFixed(2)}
                  <span className="text-xs text-zinc-500 ml-1">/ 10.0</span>
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
                className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-violet-500 focus:outline-none"
              />

              <div className="flex justify-between text-[10px] text-zinc-500 font-mono mt-1 px-0.5">
                <span>7.00 (Khá)</span>
                <span>8.00 (Giỏi)</span>
                <span>8.50</span>
                <span>9.00 (Xuất sắc)</span>
                <span>9.50</span>
              </div>
            </div>

            {/* Mode Selector Tabs (Mutually Exclusive Dual-Controller) */}
            <div className="pt-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                  Phương thức mô phỏng:
                </span>
                <div className="flex rounded-lg bg-zinc-950 p-0.5 border border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setMode("time")}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                      mode === "time"
                        ? "bg-violet-600 text-white shadow-sm"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <Calendar className="w-3 h-3" />
                    Lộ trình thời gian
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("pace")}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                      mode === "pace"
                        ? "bg-violet-600 text-white shadow-sm"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <Zap className="w-3 h-3" />
                    Tải trọng tín chỉ
                  </button>
                </div>
              </div>

              {/* CHẾ ĐỘ A: THEO LỘ TRÌNH THỜI GIAN (DYNAMIC PRESETS) */}
              {mode === "time" ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {timePresets.map((preset) => {
                      const isSelected = selectedTerms === preset.terms;
                      return (
                        <button
                          key={preset.terms}
                          type="button"
                          onClick={() => setSelectedTerms(preset.terms)}
                          className={`py-2 px-2 rounded-lg text-xs font-medium border transition-all cursor-pointer text-center flex flex-col items-center justify-between min-h-[72px] ${
                            isSelected
                              ? "bg-violet-950/60 text-violet-300 border-violet-500 shadow-sm ring-1 ring-violet-500/40"
                              : "bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200"
                          }`}
                        >
                          <div className="font-bold text-sm text-zinc-100">{preset.label}</div>
                          <div className="text-[11px] font-mono text-zinc-400 mt-0.5">
                            ~{preset.pace} TC/kỳ
                          </div>
                          <div
                            className={`mt-1 px-1.5 py-0.5 rounded text-[9px] font-semibold border leading-tight truncate max-w-full ${preset.workload.badgeColor}`}
                          >
                            {preset.workload.label}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-zinc-500 italic text-right font-mono">
                    Cần hoàn thành trung bình ~{effectiveCreditsPerTerm} TC/kỳ
                  </p>
                </div>
              ) : (
                /* CHẾ ĐỘ B: THEO TẢI TRỌNG TÍN CHỈ (PACE-DRIVEN 10 - 32 TC) */
                <div
                  className={`space-y-2.5 rounded-lg bg-zinc-950/60 border p-3 transition-colors ${
                    paceWorkload.isInvalid
                      ? "border-rose-800/80 bg-rose-950/10"
                      : paceWorkload.tier === "below_floor"
                      ? "border-amber-800/80 bg-amber-950/10"
                      : "border-zinc-800"
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-400">Số tín chỉ dự kiến học mỗi kỳ:</span>
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${paceWorkload.badgeColor}`}
                      >
                        {paceWorkload.label}
                      </span>
                      <span className="font-mono font-bold text-zinc-100 text-sm">
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
                    className={`w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer focus:outline-none ${
                      paceWorkload.isInvalid
                        ? "accent-rose-500"
                        : paceWorkload.tier === "below_floor"
                        ? "accent-amber-500"
                        : paceWorkload.tier === "max_limit"
                        ? "accent-orange-500"
                        : paceWorkload.tier === "high_pace"
                        ? "accent-cyan-500"
                        : "accent-emerald-500"
                    }`}
                  />
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-amber-400/80">10 TC (&lt;14 Sàn HB)</span>
                    <span className="text-zinc-300 font-semibold">
                      {effectiveTerms} kỳ nữa • Tốt nghiệp ~{estimatedGraduationYears} năm
                    </span>
                    <span className="text-rose-400/80">32 TC (&gt;30 Trần UIT)</span>
                  </div>
                </div>
              )}
            </div>

            {/* Real-time Result Alert Card - Chuẩn hóa ngữ nghĩa toán học & Cố vấn đào tạo UIT */}
            {remainingCredits <= 0 ? (
              <div className="rounded-lg bg-emerald-950/30 border border-emerald-800/40 p-3.5 text-xs text-emerald-300">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="leading-relaxed">
                    Bạn đã hoàn thành đủ{" "}
                    <span className="font-mono font-bold text-zinc-100">{TOTAL_DEGREE_CREDITS}</span> tín
                    chỉ theo khung chương trình đào tạo với cGPA hiện tại là{" "}
                    <span className="font-mono font-bold text-emerald-400">
                      {currentGpa10.toFixed(2)}
                    </span>
                    . Đủ điều kiện tốt nghiệp loại{" "}
                    <span className="font-semibold text-emerald-200">{degreeRank.label}</span>!
                  </div>
                </div>
              </div>
            ) : !isAchievable ? (
              <div className="rounded-lg bg-rose-950/40 border border-rose-800/50 p-3.5 text-xs text-rose-300">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div className="leading-relaxed">
                    <p className="font-semibold text-rose-200">Mục tiêu cGPA bất khả thi!</p>
                    <p className="mt-0.5 text-rose-400/90">
                      Cần đạt cGPA trung bình{" "}
                      <span className="font-mono font-bold text-rose-300 text-sm">
                        {requiredAverageGpa10.toFixed(2)} / 10.0
                      </span>{" "}
                      ở các tín chỉ còn lại (vượt trần tối đa 10.0). Vui lòng hạ chỉ tiêu hoặc kéo dài
                      lộ trình.
                    </p>
                  </div>
                </div>
              </div>
            ) : effectiveWorkload.isInvalid ? (
              <div className="rounded-lg bg-rose-950/40 border border-rose-800/50 p-3.5 text-xs text-rose-300">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
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
                      Portal UIT sẽ từ chối đăng ký phương án này. Vui lòng kéo dài lộ trình thêm học
                      kỳ hoặc giảm số tín chỉ mỗi kỳ.
                    </p>
                  </div>
                </div>
              </div>
            ) : effectiveWorkload.tier === "below_floor" ? (
              <div className="rounded-lg bg-amber-950/40 border border-amber-800/50 p-3.5 text-xs text-amber-300">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="leading-relaxed">
                    Cần duy trì{" "}
                    <span className="font-semibold text-amber-200">cGPA trung bình tối thiểu</span>{" "}
                    <span className="font-mono font-bold text-amber-400 text-sm">
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
              </div>
            ) : (
              <div className="rounded-lg bg-emerald-950/30 border border-emerald-800/40 p-3.5 text-xs text-emerald-300">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="leading-relaxed">
                    Cần duy trì{" "}
                    <span className="font-semibold text-emerald-200">cGPA trung bình tối thiểu</span>{" "}
                    <span className="font-mono font-bold text-emerald-400 text-sm">
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
              </div>
            )}

            {/* Key Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
              <div className="rounded-lg bg-zinc-950/50 border border-zinc-800/80 p-2.5">
                <div className="text-[11px] text-zinc-500">cGPA hiện tại</div>
                <div className="text-base font-bold text-zinc-200 font-mono mt-0.5">
                  {currentGpa10 > 0 ? currentGpa10.toFixed(2) : "0.00"}
                </div>
              </div>

              <div className="rounded-lg bg-zinc-950/50 border border-zinc-800/80 p-2.5">
                <div className="text-[11px] text-zinc-500">Mục tiêu cGPA</div>
                <div className="text-base font-bold text-violet-400 font-mono mt-0.5">
                  {targetGpa10.toFixed(2)}
                </div>
              </div>

              <div className="rounded-lg bg-zinc-950/50 border border-zinc-800/80 p-2.5">
                <div className="text-[11px] text-zinc-500">cGPA cần đạt (còn lại)</div>
                <div
                  className={`text-base font-bold font-mono mt-0.5 ${
                    isAchievable ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {requiredAverageGpa10.toFixed(2)}
                </div>
              </div>

              <div className="rounded-lg bg-zinc-950/50 border border-zinc-800/80 p-2.5">
                <div className="text-[11px] text-zinc-500">Tải trọng dự kiến</div>
                <div
                  className={`text-base font-bold font-mono mt-0.5 ${
                    effectiveWorkload.isInvalid
                      ? "text-rose-400"
                      : effectiveWorkload.tier === "below_floor"
                      ? "text-amber-400"
                      : effectiveWorkload.tier === "max_limit"
                      ? "text-orange-400"
                      : effectiveWorkload.tier === "high_pace"
                      ? "text-cyan-400"
                      : "text-emerald-400"
                  }`}
                >
                  ~{effectiveCreditsPerTerm}{" "}
                  <span className="text-xs text-zinc-500 font-normal">TC/kỳ</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};


