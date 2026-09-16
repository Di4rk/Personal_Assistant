import React from "react";
import { CheckCircle2, Clock, Cpu, FileCode2, ShieldAlert, Check } from "lucide-react";
import type { WecodeSubmission } from "../../../types/wecode";

interface WecodeSubmissionsListProps {
  submissions: WecodeSubmission[];
  isLoading?: boolean;
}

export const WecodeSubmissionsList: React.FC<WecodeSubmissionsListProps> = ({
  submissions,
  isLoading = false,
}) => {
  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6 text-center text-xs font-mono text-zinc-400">
        Đang tải lịch sử nộp bài Wecode...
      </div>
    );
  }

  if (submissions.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-6 text-center text-xs font-mono text-zinc-500">
        Chưa có dữ liệu bài nộp nào từ Wecode. Hãy bấm "Đồng bộ Wecode" để cập nhật.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden font-mono">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-400">
              <th className="py-2.5 px-3 font-semibold">ID</th>
              <th className="py-2.5 px-3 font-semibold">Bài tập</th>
              <th className="py-2.5 px-3 font-semibold">Thời gian</th>
              <th className="py-2.5 px-3 font-semibold">Kết quả</th>
              <th className="py-2.5 px-3 font-semibold text-right">Điểm</th>
              <th className="py-2.5 px-3 font-semibold text-right">Hiệu năng</th>
              <th className="py-2.5 px-3 font-semibold">Ngôn ngữ</th>
              <th className="py-2.5 px-3 font-semibold text-center">Chính thức</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
            {submissions.map((sub) => {
              const isAccepted = sub.score === 100 || sub.verdict === "CORRECT ANSWER";

              return (
                <tr
                  key={sub.submission_id}
                  className="hover:bg-zinc-900/40 transition-colors"
                >
                  <td className="py-2.5 px-3 text-zinc-500 text-[11px]">
                    #{sub.submission_id}
                  </td>
                  <td className="py-2.5 px-3 font-medium text-zinc-200">
                    <div className="flex flex-col">
                      <span>{sub.problem_name || `Problem #${sub.problem_id}`}</span>
                      <span className="text-[10px] text-zinc-500">
                        {sub.assignment_name ? `${sub.assignment_name} • ` : `Assign #${sub.assignment_id} • `}Prob #{sub.problem_id}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-zinc-400 text-[11px] whitespace-nowrap">
                    {sub.submit_time_str}
                  </td>
                  <td className="py-2.5 px-3">
                    {isAccepted ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
                        <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        {sub.verdict || "CORRECT"}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-rose-950/80 text-rose-400 border border-rose-800/60">
                        <ShieldAlert className="w-3 h-3 text-rose-400" />
                        {sub.verdict || "WRONG"}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <span
                      className={`text-sm font-bold ${
                        sub.score === 100 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {sub.score}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right text-[11px] text-zinc-400 whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <span className="inline-flex items-center gap-0.5">
                        <Clock className="w-3 h-3 text-zinc-500" />
                        {sub.execution_time.toFixed(2)}s
                      </span>
                      <span className="inline-flex items-center gap-0.5">
                        <Cpu className="w-3 h-3 text-zinc-500" />
                        {sub.memory_kib} KiB
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-[11px] text-zinc-300">
                    <span className="inline-flex items-center gap-1">
                      <FileCode2 className="w-3 h-3 text-zinc-500" />
                      {sub.language}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {sub.is_final ? (
                      <span
                        title="Bài nộp chính thức"
                        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-700/60"
                      >
                        <Check className="w-3 h-3" />
                      </span>
                    ) : (
                      <span className="text-zinc-600 text-[10px]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
