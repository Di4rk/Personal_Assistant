import React from "react";
import { Calendar } from "lucide-react";
import type { AcademicMacroMetricSSOT } from "../types";

export interface SemesterTabsProps {
  metrics: AcademicMacroMetricSSOT[];
  selectedSemesterId: string | null;
  onSelectSemester: (semesterId: string) => void;
  className?: string;
}

export const SemesterTabs: React.FC<SemesterTabsProps> = ({
  metrics,
  selectedSemesterId,
  onSelectSemester,
  className = "",
}) => {
  return (
    <div className={`rounded-xl bg-zinc-900 border border-zinc-800 p-4 ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-emerald-400" />
          Danh Sách Học Kỳ
        </h3>
        <span className="text-xs text-zinc-500 font-mono">
          {metrics.length} học kỳ
        </span>
      </div>

      {metrics.length === 0 ? (
        <div className="text-center py-6 text-xs text-zinc-500">
          Chưa có dữ liệu học kỳ nào. Hãy nhấn &quot;Nạp dữ liệu cổng UIT&quot; để lấy dữ liệu.
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-zinc-800">
          {metrics.map((m) => {
            const isSelected = m.semesterId === selectedSemesterId;
            
            // Format label: ưu tiên semester_label từ DB hoặc tạo fallback "HK{num} ({year})"
            const parts = m.semesterId.split(".");
            const termNum = parts.length > 1 ? parts[1] : "1";
            let tabTitle = m.semesterLabel && m.semesterLabel.trim().length > 0
              ? m.semesterLabel
              : `Học kỳ ${termNum}/${m.yearName}`;

            // Chuẩn hóa xóa bỏ lặp từ hoặc ký tự gạch dưới
            tabTitle = tabTitle.replace(/Học kỳ\s+Học[_\s]kỳ/gi, "Học kỳ");
            tabTitle = tabTitle.replace(/Học_kỳ_/gi, "Học kỳ ");
            tabTitle = tabTitle.replace(/_/g, " ");

            return (
              <button
                key={m.semesterId}
                type="button"
                onClick={() => onSelectSemester(m.semesterId)}
                className={`flex-shrink-0 text-left rounded-lg p-3 transition-all border text-xs cursor-pointer ${
                  isSelected
                    ? "bg-emerald-950/25 border-emerald-500/40 text-zinc-100 ring-1 ring-emerald-500/20"
                    : "bg-zinc-950/60 border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <div className="font-semibold text-sm truncate flex items-center gap-2">
                  <span>{tabTitle}</span>
                  {isSelected && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-[11px] font-mono tabular-nums">
                  {m.termGpa > 0 ? (
                    <span
                      className={
                        m.termGpa >= 8.0
                          ? "text-emerald-400 font-bold"
                          : "text-zinc-200 font-semibold"
                      }
                    >
                      GPA: {m.termGpa.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-amber-400 font-semibold">Đang học</span>
                  )}
                  <span className="text-zinc-600">|</span>
                  <span className="text-zinc-300">{m.termCredits} TC</span>
                  <span className="text-zinc-600">|</span>
                  <span className={m.drlScore > 0 ? "text-amber-400/90" : "text-zinc-500"}>
                    {m.drlScore > 0 ? `ĐRL: ${m.drlScore}` : "Chưa có ĐRL"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
