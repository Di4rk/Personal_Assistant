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
    <div className={`rounded-xl border border-[#1D263B] bg-[#0F1420] p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Calendar className="h-4 w-4 text-zinc-400" />
          Danh Sách Học Kỳ
        </h3>
        <span className="font-mono text-xs text-zinc-500">
          {metrics.length} học kỳ
        </span>
      </div>

      {metrics.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-500">
          Chưa có dữ liệu học kỳ nào. Nhấn nút đồng bộ hoặc F5 để lấy dữ liệu.
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-2">
          {metrics.map((m) => {
            const isSelected = m.semesterId === selectedSemesterId;

            const parts = m.semesterId.split(".");
            const termNum = parts.length > 1 ? parts[1] : "1";
            let tabTitle =
              m.semesterLabel && m.semesterLabel.trim().length > 0
                ? m.semesterLabel
                : `Học kỳ ${termNum}/${m.yearName}`;

            tabTitle = tabTitle.replace(/Học kỳ\s+Học[_\s]kỳ/gi, "Học kỳ");
            tabTitle = tabTitle.replace(/Học_kỳ_/gi, "Học kỳ ");
            tabTitle = tabTitle.replace(/_/g, " ");

            return (
              <button
                key={m.semesterId}
                type="button"
                onClick={() => onSelectSemester(m.semesterId)}
                className={`flex-shrink-0 rounded-lg border p-3 text-left text-xs transition-colors cursor-pointer ${
                  isSelected
                    ? "border-[#2F6BFF]/55 bg-[#2F6BFF]/[0.08] text-white"
                    : "border-[#1D263B] bg-[#080B12] text-zinc-400 hover:border-[#2F6BFF]/35 hover:bg-[#151C2C] hover:text-zinc-200"
                }`}
              >
                <div className="flex items-center gap-2 truncate text-sm font-semibold">
                  <span>{tabTitle}</span>
                  {isSelected && (
                    <span className="h-1.5 w-1.5 rounded-full bg-[#2F6BFF]" />
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px] tabular-nums">
                  {m.termGpa > 0 ? (
                    <span className="text-[#71717A]">
                      GPA:{" "}
                      <span className="font-semibold text-[#F4F4F5]">
                        {m.termGpa.toFixed(2)}
                      </span>
                    </span>
                  ) : (
                    <span className="font-semibold text-[#6B9BFF]">Đang học</span>
                  )}
                  <span className="text-zinc-600">|</span>
                  <span className="font-semibold text-[#F4F4F5]">
                    {m.termCredits} <span className="font-normal text-[#71717A]">TC</span>
                  </span>
                  <span className="text-zinc-600">|</span>
                  {m.drlScore > 0 ? (
                    <span className="text-[#71717A]">
                      ĐRL:{" "}
                      <span className="font-semibold text-[#F4F4F5]">
                        {m.drlScore}
                      </span>
                    </span>
                  ) : (
                    <span className="text-zinc-500">Chưa có ĐRL</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
