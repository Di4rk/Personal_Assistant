import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  GraduationCap,
  Sliders,
  Sparkles,
} from "lucide-react";

interface GpaSimulatorCardProps {
  currentGpaCredits: number;
  currentEarnedCredits: number;
  currentTotalWeighted10: number;
  currentGpa10: number;
  completedTermsCount?: number;
  className?: string;
}

/**
 * Redesigned Graduation Forecast & GPA Simulator (Sprint v1.0 Production Repair)
 *
 * Tính toán động lộ trình tốt nghiệp dựa trên 126 TC chuẩn CTĐT UIT.
 * Hỗ trợ chọn nhanh số kỳ tốt nghiệp (3.5 năm / 4 năm / 4.5 năm) hoặc tự nhập số tín chỉ/kỳ.
 */
export const GpaSimulatorCard: React.FC<GpaSimulatorCardProps> = ({
  currentEarnedCredits,
  currentTotalWeighted10,
  currentGpa10,
  completedTermsCount = 2,
  className = "",
}) => {
  const TOTAL_DEGREE_CREDITS = 126; // Chuẩn CTĐT UIT
  const remainingCredits = Math.max(0, TOTAL_DEGREE_CREDITS - currentEarnedCredits);

  const [targetGpa10, setTargetGpa10] = useState<number>(8.5); // Default: Giỏi (8.5)
  const [creditsPerTermInput, setCreditsPerTermInput] = useState<number>(21);

  // Tính số kỳ động tương ứng với lộ trình 3.5 năm (7 kỳ), 4 năm (8 kỳ), 4.5 năm (9 kỳ)
  const completedTerms = Math.max(1, completedTermsCount);
  const earlyTerms = Math.max(1, 7 - completedTerms);
  const standardTerms = Math.max(1, 8 - completedTerms);
  const extendedTerms = Math.max(1, 9 - completedTerms);

  // Số kỳ tính toán từ số TC dự kiến mỗi kỳ
  const effectiveCreditsPerTerm = Math.max(1, creditsPerTermInput);
  const calculatedTerms = Math.ceil(remainingCredits / effectiveCreditsPerTerm);

  // Tính điểm trung bình mỗi kỳ còn lại cần đạt
  const targetTotalPoints = targetGpa10 * TOTAL_DEGREE_CREDITS;
  const requiredRemainingPoints = targetTotalPoints - currentTotalWeighted10;
  const requiredAverageGpa10 =
    remainingCredits > 0
      ? Number((requiredRemainingPoints / remainingCredits).toFixed(2))
      : 0;

  const isAchievable = requiredAverageGpa10 <= 10.0 && requiredAverageGpa10 >= 0;

  // Xác định chuẩn danh hiệu tốt nghiệp theo quy chế ĐHQG-HCM
  const degreeRank = useMemo(() => {
    if (targetGpa10 >= 9.0)
      return { label: "Xuất sắc", color: "text-amber-400 border-amber-500/30 bg-amber-950/40" };
    if (targetGpa10 >= 8.0)
      return { label: "Giỏi", color: "text-violet-400 border-violet-500/30 bg-violet-950/40" };
    if (targetGpa10 >= 7.0)
      return { label: "Khá", color: "text-blue-400 border-blue-500/30 bg-blue-950/40" };
    return { label: "Trung bình", color: "text-zinc-400 border-zinc-700 bg-zinc-800" };
  }, [targetGpa10]);

  const handleSelectPill = (termsCount: number) => {
    if (remainingCredits <= 0) return;
    const tcNeeded = Math.ceil(remainingCredits / termsCount);
    setCreditsPerTermInput(tcNeeded);
  };

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
              Mô phỏng lộ trình cGPA và phân bổ chỉ tiêu học kỳ UIT
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

      {/* Main Slider & Target Section */}
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

        {/* Dynamic Remaining Terms Pills */}
        <div>
          <div className="text-xs font-medium text-zinc-400 mb-2 flex items-center justify-between">
            <span>Lộ trình tốt nghiệp dự kiến:</span>
            <span className="text-[11px] text-zinc-500 font-mono">
              Đã học: {completedTerms} kỳ
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => handleSelectPill(earlyTerms)}
              className={`py-1.5 px-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer text-center ${
                calculatedTerms === earlyTerms
                  ? "bg-violet-600/20 text-violet-300 border-violet-500/50 shadow-sm"
                  : "bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <div className="font-bold">{earlyTerms} kỳ nữa</div>
              <div className="text-[10px] text-zinc-500 font-normal">Vượt (3.5 năm)</div>
            </button>

            <button
              type="button"
              onClick={() => handleSelectPill(standardTerms)}
              className={`py-1.5 px-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer text-center ${
                calculatedTerms === standardTerms
                  ? "bg-emerald-600/20 text-emerald-300 border-emerald-500/50 shadow-sm"
                  : "bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <div className="font-bold">{standardTerms} kỳ nữa</div>
              <div className="text-[10px] text-zinc-500 font-normal">Chuẩn (4 năm)</div>
            </button>

            <button
              type="button"
              onClick={() => handleSelectPill(extendedTerms)}
              className={`py-1.5 px-2 rounded-lg text-xs font-medium border transition-colors cursor-pointer text-center ${
                calculatedTerms === extendedTerms
                  ? "bg-amber-600/20 text-amber-300 border-amber-500/50 shadow-sm"
                  : "bg-zinc-950/60 text-zinc-400 border-zinc-800 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <div className="font-bold">{extendedTerms} kỳ nữa</div>
              <div className="text-[10px] text-zinc-500 font-normal">Kéo dài (4.5 năm)</div>
            </button>
          </div>
        </div>

        {/* Real-time Badge / Alert */}
        {isAchievable ? (
          <div className="rounded-lg bg-emerald-950/30 border border-emerald-800/40 p-3.5 text-xs text-emerald-300">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                Cần duy trì tối thiểu{" "}
                <span className="font-mono font-bold text-emerald-400 text-sm">
                  {requiredAverageGpa10.toFixed(2)}
                </span>{" "}
                điểm/môn trong{" "}
                <span className="font-mono font-bold text-emerald-400 text-sm">
                  {calculatedTerms}
                </span>{" "}
                học kỳ tới để tốt nghiệp loại{" "}
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
                  Cần đạt trung bình{" "}
                  <span className="font-mono font-bold text-rose-300 text-sm">
                    {requiredAverageGpa10.toFixed(2)} / 10.0
                  </span>{" "}
                  ở các tín chỉ còn lại (vượt trần điểm tối đa 10.0). Hãy hạ bớt chỉ tiêu.
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
            <div className="text-[11px] text-zinc-500">TC đã tích lũy</div>
            <div className="text-base font-bold text-emerald-400 font-mono mt-0.5">
              {currentEarnedCredits} <span className="text-[10px] text-zinc-500 font-normal">TC</span>
            </div>
          </div>

          <div className="rounded-lg bg-zinc-950/50 border border-zinc-800/80 p-2.5">
            <div className="text-[11px] text-zinc-500">TC còn lại</div>
            <div className="text-base font-bold text-violet-400 font-mono mt-0.5">
              {remainingCredits} <span className="text-[10px] text-zinc-500 font-normal">TC</span>
            </div>
          </div>

          <div className="rounded-lg bg-zinc-950/50 border border-zinc-800/80 p-2.5">
            <div className="text-[11px] text-zinc-500">Số kỳ suy ra</div>
            <div className="text-base font-bold text-zinc-200 font-mono mt-0.5">
              {calculatedTerms} <span className="text-[10px] text-zinc-500 font-normal">kỳ</span>
            </div>
          </div>
        </div>
      </div>

      {/* Custom Credits Per Term Input */}
      <div className="mt-4 pt-3 border-t border-zinc-800/80 flex items-center justify-between gap-3 text-xs text-zinc-400">
        <label htmlFor="custom-tc-input" className="flex items-center gap-1.5 cursor-pointer">
          <span>Số tín chỉ dự kiến học mỗi kỳ:</span>
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="custom-tc-input"
            type="number"
            min={10}
            max={35}
            value={creditsPerTermInput}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              setCreditsPerTermInput(isNaN(val) ? 20 : val);
            }}
            className="w-16 bg-zinc-950 border border-zinc-700 text-zinc-200 rounded px-2 py-1 font-mono text-xs text-center focus:outline-none focus:border-violet-500"
          />
          <span className="text-zinc-500 text-[11px]">TC/kỳ</span>
        </div>
      </div>
    </div>
  );
};
