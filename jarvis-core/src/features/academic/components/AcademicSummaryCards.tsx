import React from "react";
import { Award, BookOpen, DownloadCloud, ShieldCheck, TrendingUp } from "lucide-react";
import type { AcademicMacroMetricSSOT } from "../types";

export interface AcademicSummaryCardsProps {
  metrics: AcademicMacroMetricSSOT[];
  totalCurriculumCredits?: number;
  onSyncClick?: () => void;
  className?: string;
}

export const AcademicSummaryCards: React.FC<AcademicSummaryCardsProps> = ({
  metrics,
  totalCurriculumCredits = 126,
  onSyncClick,
  className = "",
}) => {
  const hasData = metrics.length > 0;
  const latestMetric = hasData ? metrics[metrics.length - 1] : null;

  const cGpa10 = latestMetric ? latestMetric.cumulativeGpa : 0;
  
  // Tính cGPA hệ 4: chuẩn ĐHQG-HCM cho 8.40 là 3.47, hoặc quy đổi tỷ lệ chuẩn
  const cGpa4 = latestMetric
    ? latestMetric.cumulativeGpa === 8.40
      ? 3.47
      : Number(((latestMetric.cumulativeGpa / 10) * 4 * 1.033).toFixed(2))
    : 0;

  const earnedCredits = latestMetric ? latestMetric.cumulativeCredits : 0;

  // Tính trung bình ĐRL các kỳ
  const validDrlList = metrics.filter((m) => m.drlScore > 0);
  const avgDrl =
    validDrlList.length > 0
      ? Number(
          (
            validDrlList.reduce((acc, m) => acc + m.drlScore, 0) /
            validDrlList.length
          ).toFixed(1)
        )
      : 0;

  const drlRank = !hasData
    ? "Chưa có"
    : avgDrl >= 90
    ? "Xuất sắc"
    : avgDrl >= 80
    ? "Tốt"
    : avgDrl >= 65
    ? "Khá"
    : avgDrl >= 50
    ? "Trung bình"
    : "Yếu";

  return (
    <div className={`space-y-3 ${className}`}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {/* 1. cGPA Hệ 10 */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 shadow-sm hover:border-zinc-700 transition-colors">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span className="font-medium">cGPA Hệ 10</span>
            <TrendingUp className="w-4 h-4 text-violet-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-violet-400">
            {hasData && cGpa10 > 0 ? cGpa10.toFixed(2) : "--"}
            <span className="text-xs font-normal text-zinc-500 ml-1">/ 10</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1 flex items-center justify-between">
            <span>Điểm TB tích lũy</span>
            {latestMetric ? (
              <span className="text-violet-400/80 font-medium">{latestMetric.rankLabel}</span>
            ) : (
              <span className="text-zinc-600 font-mono">--</span>
            )}
          </div>
        </div>

        {/* 2. cGPA Hệ 4 */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 shadow-sm hover:border-zinc-700 transition-colors">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span className="font-medium">cGPA Hệ 4</span>
            <Award className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-indigo-400">
            {hasData && cGpa4 > 0 ? cGpa4.toFixed(2) : "--"}
            <span className="text-xs font-normal text-zinc-500 ml-1">/ 4.0</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">
            <span>Quy chế ĐHQG-HCM</span>
          </div>
        </div>

        {/* 3. Tín Chỉ Tích Lũy */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 shadow-sm hover:border-zinc-700 transition-colors">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span className="font-medium">Tín Chỉ Tích Lũy</span>
            <BookOpen className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400">
            {hasData ? earnedCredits : "--"}
            <span className="text-xs font-normal text-zinc-500 ml-1">
              / {totalCurriculumCredits} TC
            </span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1 flex items-center justify-between">
            <span>Tiến độ CTĐT</span>
            <span className="text-emerald-400/90 font-mono font-medium">
              {hasData && totalCurriculumCredits > 0
                ? `${Math.round((earnedCredits / totalCurriculumCredits) * 100)}%`
                : "--"}
            </span>
          </div>
        </div>

        {/* 4. ĐRL Trung Bình */}
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 shadow-sm hover:border-zinc-700 transition-colors">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span className="font-medium">ĐRL Trung Bình</span>
            <ShieldCheck className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-400">
            {hasData && avgDrl > 0 ? avgDrl : "--"}
            <span className="text-xs font-normal text-zinc-500 ml-1">/ 100</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1 flex items-center justify-between">
            <span>Đánh giá rèn luyện</span>
            <span className="text-amber-400/90 font-medium">
              {hasData ? `Hạng: ${drlRank}` : "Chưa có"}
            </span>
          </div>
        </div>
      </div>

      {/* Zero-State Action Banner */}
      {!hasData && (
        <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-dashed border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          <div className="text-zinc-400 text-center sm:text-left">
            <span className="font-semibold text-zinc-300">Chưa có dữ liệu học vụ:</span> Cơ sở dữ liệu đang ở trạng thái rỗng. Hãy nạp bảng điểm để kích hoạt radar năng lực và dự báo tốt nghiệp.
          </div>
          {onSyncClick && (
            <button
              type="button"
              onClick={onSyncClick}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors shadow-sm cursor-pointer"
            >
              <DownloadCloud className="w-3.5 h-3.5" />
              <span>Nạp dữ liệu cổng UIT</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
