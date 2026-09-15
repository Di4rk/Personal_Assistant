import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  Calendar,
  CheckCircle2,
  GraduationCap,
  Sliders,
  Sparkles,
  Zap,
} from "lucide-react";

interface GpaSimulatorCardProps {
  currentGpaCredits: number;
  currentEarnedCredits: number;
  currentTotalWeighted10: number;
  currentGpa10: number;
  completedTermsCount?: number;
  totalDegreeCredits?: number;
  className?: string;
}

type SimulatorMode = "time" | "pace";

/**
 * Redesigned Graduation Forecast & GPA Simulator (Dual-Mode SSOT Architecture)
 *
 * Chế độ A (Time-driven): Chọn số kỳ tốt nghiệp mục tiêu -> Tự suy ra số tín chỉ/kỳ.
 * Chế độ B (Pace-driven): Chọn số tín chỉ/kỳ -> Tự suy ra số kỳ và highlight badge tương ứng.
 * Chuẩn hóa ngữ nghĩa: Tính toán theo cGPA trung bình của các tín chỉ còn lại, loại bỏ khái niệm "điểm/môn".
 */
export const GpaSimulatorCard: React.FC<GpaSimulatorCardProps> = ({
  currentEarnedCredits,
  currentTotalWeighted10,
  currentGpa10,
  completedTermsCount = 2,
  totalDegreeCredits = 126,
  className = "",
}) => {
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

  // Danh sách các mốc lộ trình thời gian có thể chọn
  const timePresets = [
    { terms: 4, label: "4 kỳ nữa", note: "3.0 năm (Siêu tốc)" },
    { terms: 5, label: "5 kỳ nữa", note: "3.5 năm (Vượt tiến độ)" },
    { terms: 6, label: "6 kỳ nữa", note: "4.0 năm (Chuẩn CTĐT)" },
    { terms: 7, label: "7 kỳ nữa", note: "4.5 năm (Thong thả)" },
  ];

  return (
    <div
      className={`rounded-xl bg-zinc-900 border border-zinc-800 p-5 shadow-lg flex flex-col justify-between ${className}`}
    >
      {/* Header card */}
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
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

        <div
          className={`px-2.5 py-1 rounded-full border text-xs font-semibold flex items-center gap-1.5 ${degreeRank.color}`}
        >
          <Award className="w-3.5 h-3.5" />
          Hạng: {degreeRank.label}
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

          {/* CHẾ ĐỘ A: THEO LỘ TRÌNH THỜI GIAN */}
          {mode === "time" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {timePresets.map((preset) => (
                  <button
                    key={preset.terms}
                    type="button"
                    onClick={() => setSelectedTerms(preset.terms)}
                    className={`py-2 px-2 rounded-lg text-xs font-medium border transition-all cursor-pointer text-center ${
                      selectedTerms === preset.terms
                        ? "bg-violet-950/60 text-violet-300 border-violet-500 shadow-sm ring-1 ring-violet-500/40"
                        : "bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200"
                    }`}
                  >
                    <div className="font-bold text-sm">{preset.label}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">{preset.note}</div>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-zinc-500 italic text-right font-mono">
                Cần hoàn thành trung bình ~{effectiveCreditsPerTerm} TC/kỳ
              </p>
            </div>
          ) : (
            /* CHẾ ĐỘ B: THEO TẢI TRỌNG TÍN CHỈ */
            <div className="space-y-2.5 rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">Số tín chỉ dự kiến học mỗi kỳ:</span>
                <span className="font-mono font-bold text-emerald-400 text-sm">
                  {creditsPerTerm} TC/kỳ
                </span>
              </div>
              <input
                type="range"
                min={12}
                max={26}
                step={1}
                value={creditsPerTerm}
                onChange={(e) => setCreditsPerTerm(parseInt(e.target.value, 10))}
                className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500 focus:outline-none"
              />
              <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono">
                <span>12 TC (Nhẹ nhàng)</span>
                <span className="text-emerald-400 font-semibold">
                  {effectiveTerms} kỳ nữa • Tốt nghiệp ~{estimatedGraduationYears} năm
                </span>
                <span>26 TC (Tối đa)</span>
              </div>
            </div>
          )}
        </div>

        {/* Real-time Result Alert Card - Chuẩn hóa ngữ nghĩa toán học */}
        {isAchievable ? (
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
                  {remainingCredits}
                </span>{" "}
                tín chỉ còn lại (trung bình{" "}
                <span className="font-mono font-bold text-emerald-300">
                  {effectiveCreditsPerTerm} TC/kỳ
                </span>{" "}
                trong{" "}
                <span className="font-mono font-bold text-zinc-100">
                  {effectiveTerms} học kỳ tới
                </span>
                ) để tốt nghiệp loại{" "}
                <span className="font-semibold text-emerald-200">{degreeRank.label}</span>.
              </div>
            </div>
          </div>
        ) : (
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
                  ở các tín chỉ còn lại (vượt trần tối đa 10.0). Vui lòng hạ chỉ tiêu hoặc kéo dài lộ trình.
                </p>
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
            <div className="text-base font-bold text-cyan-400 font-mono mt-0.5">
              ~{effectiveCreditsPerTerm} <span className="text-xs text-zinc-500 font-normal">TC/kỳ</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

