import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  GraduationCap,
  Sliders,
  TrendingUp,
} from "lucide-react";
import {
  calculateGraduationForecast,
  type ForecastParams,
} from "../utils/forecastEngine";

interface GpaSimulatorCardProps {
  currentGpaCredits: number;
  currentEarnedCredits: number;
  currentTotalWeighted10: number;
  currentGpa10: number;
  className?: string;
}

/**
 * Academic Target Simulator Card (Sprint v0.3.2)
 *
 * Cho phép sinh viên kéo slider điều chỉnh cGPA mục tiêu khi tốt nghiệp,
 * tự động tính điểm trung bình tối thiểu cần đạt mỗi kỳ còn lại.
 */
export const GpaSimulatorCard: React.FC<GpaSimulatorCardProps> = ({
  currentGpaCredits,
  currentEarnedCredits,
  currentTotalWeighted10,
  currentGpa10,
  className = "",
}) => {
  const [targetGpa10, setTargetGpa10] = useState<number>(8.5); // Default: Giỏi (8.5)
  const [totalDegreeCredits, setTotalDegreeCredits] = useState<number>(130); // Chuẩn UIT kỹ sư/cử nhân
  const [creditsPerTerm, setCreditsPerTerm] = useState<number>(20);

  // Tính toán kết quả dự báo
  const forecastParams: ForecastParams = useMemo(() => ({
    currentEarnedCredits,
    currentGpaCredits,
    currentTotalWeighted10,
    targetGpa10,
    totalDegreeCredits,
    estimatedCreditsPerTerm: creditsPerTerm,
  }), [
    currentEarnedCredits,
    currentGpaCredits,
    currentTotalWeighted10,
    targetGpa10,
    totalDegreeCredits,
    creditsPerTerm,
  ]);

  const forecast = useMemo(() => {
    return calculateGraduationForecast(forecastParams);
  }, [forecastParams]);

  // Xác định chuẩn danh hiệu tốt nghiệp theo quy chế ĐHQG-HCM
  const degreeRank = useMemo(() => {
    if (targetGpa10 >= 9.0) return { label: "Xuất sắc", color: "text-amber-400 border-amber-500/30 bg-amber-950/40" };
    if (targetGpa10 >= 8.0) return { label: "Giỏi", color: "text-violet-400 border-violet-500/30 bg-violet-950/40" };
    if (targetGpa10 >= 7.0) return { label: "Khá", color: "text-blue-400 border-blue-500/30 bg-blue-950/40" };
    return { label: "Trung bình", color: "text-zinc-400 border-zinc-700 bg-zinc-800" };
  }, [targetGpa10]);

  return (
    <div className={`rounded-xl bg-zinc-900 border border-zinc-800 p-5 shadow-lg flex flex-col justify-between ${className}`}>
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
            <p className="text-xs text-zinc-500">Mô phỏng lộ trình cGPA và chỉ tiêu học kỳ</p>
          </div>
        </div>

        <div className={`px-2.5 py-1 rounded-full border text-xs font-semibold flex items-center gap-1.5 ${degreeRank.color}`}>
          <Award className="w-3.5 h-3.5" />
          Hạng: {degreeRank.label}
        </div>
      </div>

      {/* Main Slider & Target Section */}
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="gpa-slider" className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
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

        {/* Real-time Badge / Alert */}
        {forecast.isAchievable ? (
          <div className="rounded-lg bg-emerald-950/30 border border-emerald-800/40 p-3.5 text-xs text-emerald-300">
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                Cần duy trì tối thiểu{" "}
                <span className="font-mono font-bold text-emerald-400 text-sm">
                  {forecast.requiredAverageGpa10.toFixed(2)}
                </span>{" "}
                điểm/môn trong{" "}
                <span className="font-mono font-bold text-emerald-400 text-sm">
                  {forecast.termsRemaining}
                </span>{" "}
                học kỳ tới để đạt chuẩn{" "}
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
                    {forecast.requiredAverageGpa10.toFixed(2)} / 10.0
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
              {forecast.remainingCredits} <span className="text-[10px] text-zinc-500 font-normal">TC</span>
            </div>
          </div>

          <div className="rounded-lg bg-zinc-950/50 border border-zinc-800/80 p-2.5">
            <div className="text-[11px] text-zinc-500">Học kỳ dự kiến</div>
            <div className="text-base font-bold text-zinc-200 font-mono mt-0.5">
              {forecast.termsRemaining} <span className="text-[10px] text-zinc-500 font-normal">kỳ</span>
            </div>
          </div>
        </div>
      </div>

      {/* Advanced Settings Accordion / Toggle */}
      <div className="mt-4 pt-3 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
        <div className="flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 text-zinc-500" />
          <span>Chuẩn tốt nghiệp:</span>
          <select
            value={totalDegreeCredits}
            onChange={(e) => setTotalDegreeCredits(parseInt(e.target.value, 10))}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 rounded px-2 py-0.5 font-mono text-xs focus:outline-none focus:border-violet-500"
          >
            <option value={120}>120 TC (Cử nhân)</option>
            <option value={130}>130 TC (Kỹ sư UIT)</option>
            <option value={135}>135 TC (Chất lượng cao)</option>
            <option value={140}>140 TC (Song ngành)</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span>Dự kiến/kỳ:</span>
          <select
            value={creditsPerTerm}
            onChange={(e) => setCreditsPerTerm(parseInt(e.target.value, 10))}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 rounded px-2 py-0.5 font-mono text-xs focus:outline-none focus:border-violet-500"
          >
            <option value={15}>15 TC</option>
            <option value={18}>18 TC</option>
            <option value={20}>20 TC</option>
            <option value={22}>22 TC</option>
          </select>
        </div>
      </div>
    </div>
  );
};
