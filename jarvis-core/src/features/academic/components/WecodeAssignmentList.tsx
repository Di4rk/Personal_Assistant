import React from "react";
import {
  FolderCode,
  CheckCircle2,
  ChevronRight,
  Clock,
} from "lucide-react";
import type { WecodeAssignmentGroup } from "../../../types/wecode";

interface WecodeAssignmentListProps {
  assignments: WecodeAssignmentGroup[];
  onSelectAssignment: (assignmentId: number) => void;
}

export const WecodeAssignmentList: React.FC<WecodeAssignmentListProps> = ({
  assignments,
  onSelectAssignment,
}) => {
  if (assignments.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-8 text-center text-xs font-mono text-zinc-500 space-y-2">
        <FolderCode className="w-8 h-8 text-zinc-600 mx-auto" />
        <p>Không tìm thấy bài tập nào cho tiêu chí lọc hiện tại.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 font-mono">
      {assignments.map((assign) => {
        const isCompleted =
          assign.totalProblems > 0 && assign.solvedProblems >= assign.totalProblems;
        const acPercent =
          assign.totalProblems > 0
            ? Math.round((assign.solvedProblems / assign.totalProblems) * 100)
            : 0;

        return (
          <div
            key={assign.id}
            onClick={() => onSelectAssignment(assign.id)}
            className="group relative rounded-xl border border-zinc-800 bg-zinc-900/70 hover:bg-zinc-900 hover:border-emerald-700/60 p-4 transition-all duration-200 cursor-pointer shadow-sm hover:shadow-md flex flex-col justify-between"
          >
            {/* Top row: Title & Assignment ID & Deadline Badge */}
            <div className="space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div
                    className={`p-2 rounded-lg shrink-0 ${
                      isCompleted
                        ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/60"
                        : "bg-zinc-800/80 text-zinc-400 border border-zinc-700/80"
                    }`}
                  >
                    <FolderCode className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors line-clamp-2">
                      {assign.name}
                    </h4>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-zinc-500 block">
                        #{assign.id}
                      </span>
                      {/* Deadline Status Badge */}
                      <span
                        className={`px-2 py-0.2 rounded text-[10px] font-semibold border ${assign.deadlineBadgeColor}`}
                        title={assign.finish_time ? `Hạn nộp: ${assign.finish_time}` : undefined}
                      >
                        {assign.deadlineLabel}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="p-1 rounded text-zinc-500 group-hover:text-emerald-400 group-hover:translate-x-0.5 transition-all shrink-0">
                  <ChevronRight className="w-4 h-4" />
                </div>
              </div>

              {/* Compact Class Chips: Course Chip + Primary Class + Tooltip badge */}
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {assign.courseCode && assign.courseCode !== "OTHER" && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700">
                    {assign.courseCode}
                  </span>
                )}
                {assign.primaryClass && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800/50">
                    {assign.primaryClass}
                  </span>
                )}
                {assign.additionalClasses.length > 0 && (
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-800/60 text-zinc-400 border border-zinc-700/50 cursor-help"
                    title={`Các lớp cùng đề: ${assign.additionalClasses.join(", ")}`}
                  >
                    +{assign.additionalClasses.length} lớp khác
                  </span>
                )}
              </div>
            </div>

            {/* Bottom Row: Metrics & Progress Bar */}
            <div className="mt-4 pt-3 border-t border-zinc-800/80 space-y-2">
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 text-zinc-400">
                  <CheckCircle2
                    className={`w-3.5 h-3.5 ${
                      isCompleted ? "text-emerald-400" : "text-zinc-500"
                    }`}
                  />
                  <span>
                    AC:{" "}
                    <b className={isCompleted ? "text-emerald-400" : "text-zinc-200"}>
                      {assign.solvedProblems}
                    </b>
                    /{assign.totalProblems} bài
                  </span>
                </div>

                <div className="flex items-center gap-2 text-zinc-500">
                  <span>{assign.totalSubmissions} lượt nộp</span>
                  <span>•</span>
                  <span className="text-amber-400 font-semibold">
                    {assign.earnedScore}đ
                  </span>
                </div>
              </div>

              {/* Mini Progress Bar */}
              <div className="w-full bg-zinc-800/80 h-1.5 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    isCompleted
                      ? "bg-emerald-400"
                      : acPercent > 0
                      ? "bg-emerald-500/80"
                      : "bg-zinc-700"
                  }`}
                  style={{ width: `${acPercent}%` }}
                />
              </div>

              {/* Sub-label for deadline datetime if present */}
              {assign.finish_time && assign.deadlineStatus !== "unlimited" && (
                <div className="flex items-center gap-1 text-[10px] text-zinc-500 pt-0.5">
                  <Clock className="w-3 h-3 text-zinc-600" />
                  <span className="truncate">Hạn: {assign.finish_time}</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
