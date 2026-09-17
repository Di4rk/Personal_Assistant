import React, { useState, useMemo } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Cpu,
  FileCode2,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Check,
  Star,
  ExternalLink,
} from "lucide-react";
import { openExternalUrl } from "../../../lib/tauri-client";
import type { WecodeAssignmentGroup, WecodeSubmission } from "../../../types/wecode";
import { formatVerdictLabel } from "../utils/wecodeHierarchy";

interface WecodeProblemListProps {
  assignment: WecodeAssignmentGroup;
  onBack: () => void;
}

export const WecodeProblemList: React.FC<WecodeProblemListProps> = ({
  assignment,
  onBack,
}) => {
  // State quản lý việc mở rộng xem log chi tiết của từng problem
  const [expandedProblemIds, setExpandedProblemIds] = useState<Set<number>>(new Set());
  // Sub-filter: Tất cả | Chưa AC | Đã AC
  const [problemFilter, setProblemFilter] = useState<"all" | "unsolved" | "solved">("all");

  const toggleExpand = (problemId: number) => {
    setExpandedProblemIds((prev) => {
      const next = new Set(prev);
      if (next.has(problemId)) {
        next.delete(problemId);
      } else {
        next.add(problemId);
      }
      return next;
    });
  };

  const expandAll = () => {
    setExpandedProblemIds(new Set(assignment.problems.map((p) => p.problem_id)));
  };

  const collapseAll = () => {
    setExpandedProblemIds(new Set());
  };

  const handleOpenProblemUrl = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch (err) {
      console.error("[WecodeProblemList] Không thể mở URL ngoài trình duyệt:", url, err);
    }
  };

  const assignmentUrl = useMemo(() => {
    const base = assignment.base_url?.trim().replace(/\/+$/, "") || "https://khmt.uit.edu.vn/wecode25/it00x";
    return `${base}/assignment/${assignment.id}/0`;
  }, [assignment.base_url, assignment.id]);

  const getProblemUrl = (prob: { problem_id: number; problem_url?: string }): string => {
    const raw = prob.problem_url?.trim();
    if (raw && (raw.startsWith("http://") || raw.startsWith("https://"))) {
      return raw;
    }
    const base = assignment.base_url?.trim().replace(/\/+$/, "") || "https://khmt.uit.edu.vn/wecode25/it00x";
    if (raw && raw.startsWith("/")) {
      return `${base}${raw}`;
    }
    return `${base}/assignment/${assignment.id}/${prob.problem_id}`;
  };

  const solvedCount = useMemo(() => {
    return assignment.problems.filter((p) => p.isSolved).length;
  }, [assignment.problems]);

  const unsolvedCount = assignment.problems.length - solvedCount;

  const filteredProblems = useMemo(() => {
    return assignment.problems.filter((prob) => {
      if (problemFilter === "unsolved") return !prob.isSolved;
      if (problemFilter === "solved") return prob.isSolved;
      return true;
    });
  }, [assignment.problems, problemFilter]);

  const renderVerdictBadge = (sub?: WecodeSubmission, isBest: boolean = false, isSolved?: boolean) => {
    const { text, colorClass } = formatVerdictLabel(sub, isSolved);

    let icon = <AlertTriangle className="w-3 h-3 shrink-0" />;
    if (isSolved || text.startsWith("AC")) {
      icon = <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-400" />;
    } else if (text === "Chưa nộp") {
      icon = <Clock className="w-3 h-3 shrink-0 text-zinc-500" />;
    } else if (text.startsWith("Quá giờ") || text.includes("TIME LIMIT")) {
      icon = <Clock className="w-3 h-3 shrink-0 text-amber-400" />;
    } else if (text.startsWith("Lỗi biên dịch")) {
      icon = <FileCode2 className="w-3 h-3 shrink-0 text-red-400" />;
    } else if (sub && sub.score > 0) {
      icon = <Sparkles className="w-3 h-3 shrink-0 text-amber-400" />;
    }

    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono font-semibold border ${colorClass}`}
        title={sub ? `${sub.verdict} (Score: ${sub.score})` : text}
      >
        {icon}
        <span className="truncate max-w-[150px]">{text}</span>
        {isBest && (
          <span
            className="ml-1 text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30"
            title="Bài nộp tốt nhất của problem"
          >
            ⭐ Top
          </span>
        )}
      </span>
    );
  };

  const acRate =
    assignment.totalProblems > 0
      ? Math.round((assignment.solvedProblems / assignment.totalProblems) * 100)
      : 0;

  return (
    <div className="space-y-4 font-mono">
      {/* Top Header & Navigation */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer group"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
            <span>Quay lại danh sách Bài tập</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={expandedProblemIds.size === filteredProblems.length ? collapseAll : expandAll}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] flex items-center gap-1.5 transition-colors border border-zinc-700 cursor-pointer"
            >
              {expandedProblemIds.size === filteredProblems.length ? (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  <span>Thu gọn tất cả log</span>
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  <span>Mở rộng tất cả log</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold text-zinc-100">
              {assignment.name}
            </h3>
            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-emerald-400 border border-zinc-700">
              ID #{assignment.id}
            </span>
            <button
              type="button"
              onClick={() => void handleOpenProblemUrl(assignmentUrl)}
              className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 hover:bg-emerald-950 text-zinc-300 hover:text-emerald-300 border border-zinc-700 hover:border-emerald-700/60 transition-colors cursor-pointer inline-flex items-center gap-1"
              title={`Mở bài tập #${assignment.id} trên Wecode`}
            >
              <ExternalLink className="w-2.5 h-2.5" />
              <span>Mở bài tập trên web</span>
            </button>
            <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${assignment.deadlineBadgeColor}`}>
              {assignment.deadlineLabel}
            </span>
          </div>

          {/* Class Badges */}
          {assignment.classes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-[11px] text-zinc-500">Lớp:</span>
              {assignment.primaryClass && (
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800/50">
                  {assignment.primaryClass}
                </span>
              )}
              {assignment.additionalClasses.map((cls, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800/80 text-zinc-300 border border-zinc-700/60"
                >
                  {cls}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Overview Stats Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs border-t border-zinc-800">
          <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80">
            <span className="text-zinc-500 text-[11px] block">Tiến độ AC</span>
            <div className="text-lg font-bold text-emerald-400 mt-0.5">
              {assignment.solvedProblems} / {assignment.totalProblems}{" "}
              <span className="text-xs text-zinc-500 font-normal">({acRate}%)</span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80">
            <span className="text-zinc-500 text-[11px] block">Tổng điểm đạt được</span>
            <div className="text-lg font-bold text-amber-400 mt-0.5">
              {assignment.earnedScore}{" "}
              <span className="text-xs text-zinc-500 font-normal">
                / {assignment.totalProblems * 100}đ
              </span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80">
            <span className="text-zinc-500 text-[11px] block">Tổng lượt nộp</span>
            <div className="text-lg font-bold text-zinc-200 mt-0.5">
              {assignment.totalSubmissions}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80">
            <span className="text-zinc-500 text-[11px] block">Môn học</span>
            <div className="text-lg font-bold text-cyan-400 mt-0.5">
              {assignment.courseCode}
            </div>
          </div>
        </div>
      </div>

      {/* Problem Cards Table */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
        {/* Header with Sub-Filter Toggle */}
        <div className="p-3.5 bg-zinc-900/60 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-200">
              Danh sách bài tập (Problems)
            </span>
            <span className="text-[10px] text-zinc-500">
              • Kết quả tốt nhất
            </span>
          </div>

          {/* Sub-Filter Controls */}
          <div className="flex items-center gap-1.5 bg-zinc-900 p-1 rounded-lg border border-zinc-800 self-start sm:self-auto">
            <button
              onClick={() => setProblemFilter("all")}
              className={`px-2.5 py-1 rounded text-[11px] transition-colors cursor-pointer ${
                problemFilter === "all"
                  ? "bg-zinc-800 text-white font-semibold"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Tất cả ({assignment.problems.length})
            </button>
            <button
              onClick={() => setProblemFilter("unsolved")}
              className={`px-2.5 py-1 rounded text-[11px] transition-colors cursor-pointer ${
                problemFilter === "unsolved"
                  ? "bg-rose-950/80 text-rose-300 font-semibold border border-rose-800/60"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Chưa AC ({unsolvedCount})
            </button>
            <button
              onClick={() => setProblemFilter("solved")}
              className={`px-2.5 py-1 rounded text-[11px] transition-colors cursor-pointer ${
                problemFilter === "solved"
                  ? "bg-emerald-950/80 text-emerald-300 font-semibold border border-emerald-800/60"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Đã AC ({solvedCount})
            </button>
          </div>
        </div>

        {filteredProblems.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500">
            Không có bài tập nào phù hợp với bộ lọc ({problemFilter === "unsolved" ? "Chưa AC" : problemFilter === "solved" ? "Đã AC" : "Tất cả"}).
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/70">
            {filteredProblems.map((prob, idx) => {
              const isExpanded = expandedProblemIds.has(prob.problem_id);
              const best = prob.bestSubmission;
              const isAc = prob.isSolved;
              const displayOrder = prob.order && prob.order > 0 ? prob.order : idx + 1;
              const probUrl = getProblemUrl(prob);

              return (
                <div
                  key={prob.problem_id}
                  className={`transition-colors ${
                    isExpanded ? "bg-zinc-900/40" : "hover:bg-zinc-900/20"
                  }`}
                >
                  {/* Problem Summary Row */}
                  <div
                    onClick={() => toggleExpand(prob.problem_id)}
                    className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 cursor-pointer select-none"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold ${
                          isAc
                            ? "bg-emerald-950 text-emerald-400 border border-emerald-800/80"
                            : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                        }`}
                      >
                        {displayOrder}
                      </div>

                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-zinc-100 truncate">
                            {prob.problem_name}
                          </span>
                          <span className="text-[10px] text-zinc-500 font-mono">
                            #ID {prob.problem_id}
                          </span>

                          {/* External Deep-Link Button */}
                          {probUrl && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleOpenProblemUrl(probUrl);
                              }}
                              className="p-1 px-1.5 rounded bg-zinc-800/80 hover:bg-emerald-950/80 text-zinc-400 hover:text-emerald-300 border border-zinc-700/60 hover:border-emerald-700/50 transition-colors cursor-pointer inline-flex items-center gap-1 text-[10px]"
                              title={`Mở bài tập #${prob.problem_id} trực tiếp trên Wecode`}
                            >
                              <ExternalLink className="w-3 h-3" />
                              <span className="hidden sm:inline">Mở đề</span>
                            </button>
                          )}
                        </div>

                        {/* Performance Details of Best Submission */}
                        {best ? (
                          <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3 text-zinc-500" />
                              {best.execution_time.toFixed(2)}s
                            </span>
                            <span className="flex items-center gap-1">
                              <Cpu className="w-3 h-3 text-zinc-500" />
                              {best.memory_kib} KiB
                            </span>
                            <span className="flex items-center gap-1">
                              <FileCode2 className="w-3 h-3 text-zinc-500" />
                              {best.language}
                            </span>
                          </div>
                        ) : (
                          <div className="text-[11px] text-zinc-500">
                            Điểm tối đa: {prob.maxScore || 100}đ • Chưa có lượt nộp bài
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Right side: Best Verdict & Actions */}
                    <div className="flex items-center justify-between md:justify-end gap-3 self-end md:self-center shrink-0">
                      <div className="text-right space-y-1">
                        <div>{renderVerdictBadge(best, false, prob.isSolved)}</div>
                        <div className="text-[11px] text-zinc-400">
                          Điểm cao nhất:{" "}
                          <span
                            className={`font-bold ${
                              isAc
                                ? "text-emerald-400"
                                : prob.bestScore > 0
                                ? "text-amber-400"
                                : "text-zinc-500"
                            }`}
                          >
                            {prob.bestScore}đ
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        className="px-2.5 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 text-[11px] flex items-center gap-1 border border-zinc-700/80"
                      >
                        <span>{prob.totalAttempts} lần nộp</span>
                        {isExpanded ? (
                          <ChevronUp className="w-3.5 h-3.5 text-zinc-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Expandable Submission History Log */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 bg-black/40 border-t border-zinc-800/60">
                      {prob.submissions.length === 0 ? (
                        <div className="p-4 text-center text-xs text-zinc-500 font-mono bg-zinc-950 rounded-lg border border-zinc-800/80">
                          Chưa có lượt nộp bài nào cho bài toán này.
                        </div>
                      ) : (
                        <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800/80 space-y-2.5">
                          <div className="flex items-center justify-between text-xs text-zinc-400 pb-1 border-b border-zinc-800/80">
                            <span className="font-semibold text-zinc-300 flex items-center gap-1.5">
                              <span>📜 Lịch sử nộp bài (Log chi tiết):</span>
                              <span className="text-[10px] text-zinc-500 font-normal">
                                ({prob.submissions.length} lần thử)
                              </span>
                            </span>
                            <span className="text-[10px] text-zinc-500">
                              Sắp xếp mới nhất trước
                            </span>
                          </div>

                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-[11px] border-collapse">
                              <thead>
                                <tr className="border-b border-zinc-800/60 text-zinc-500 text-[10px]">
                                  <th className="py-2 px-2.5">Submit ID</th>
                                  <th className="py-2 px-2.5">Thời gian</th>
                                  <th className="py-2 px-2.5">Kết quả</th>
                                  <th className="py-2 px-2.5 text-right">Điểm</th>
                                  <th className="py-2 px-2.5 text-right">Thời gian</th>
                                  <th className="py-2 px-2.5 text-right">Bộ nhớ</th>
                                  <th className="py-2 px-2.5">Ngôn ngữ</th>
                                  <th className="py-2 px-2.5 text-center">Đánh dấu</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-zinc-800/40 text-zinc-300">
                                {prob.submissions.map((subAttempt) => {
                                  const isBestAttempt =
                                    best && subAttempt.submission_id === best.submission_id;

                                  return (
                                    <tr
                                      key={subAttempt.submission_id}
                                      className={`hover:bg-zinc-900/60 transition-colors ${
                                        isBestAttempt ? "bg-emerald-950/20" : ""
                                      }`}
                                    >
                                      <td className="py-2 px-2.5 font-mono text-zinc-400">
                                        #{subAttempt.submission_id}
                                      </td>
                                      <td className="py-2 px-2.5 whitespace-nowrap text-zinc-400">
                                        {subAttempt.submit_time_str}
                                      </td>
                                      <td className="py-2 px-2.5">
                                        {renderVerdictBadge(subAttempt, false)}
                                      </td>
                                      <td className="py-2 px-2.5 text-right font-bold font-mono">
                                        <span
                                          className={
                                            subAttempt.score === 100
                                              ? "text-emerald-400"
                                              : subAttempt.score > 0
                                              ? "text-amber-300"
                                              : "text-rose-400"
                                          }
                                        >
                                          {subAttempt.score}
                                        </span>
                                      </td>
                                      <td className="py-2 px-2.5 text-right font-mono text-zinc-400">
                                        {subAttempt.execution_time.toFixed(2)}s
                                      </td>
                                      <td className="py-2 px-2.5 text-right font-mono text-zinc-400">
                                        {subAttempt.memory_kib} KiB
                                      </td>
                                      <td className="py-2 px-2.5 font-mono text-zinc-400">
                                        {subAttempt.language}
                                      </td>
                                      <td className="py-2 px-2.5 text-center">
                                        <div className="flex items-center justify-center gap-1">
                                          {isBestAttempt && (
                                            <span
                                              title="Lần nộp đạt kết quả tốt nhất"
                                              className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-semibold flex items-center gap-0.5"
                                            >
                                              <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                                              Best
                                            </span>
                                          )}
                                          {subAttempt.is_final && (
                                            <span
                                              title="Bài nộp chính thức"
                                              className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] font-semibold flex items-center gap-0.5"
                                            >
                                              <Check className="w-2.5 h-2.5 text-emerald-400" />
                                              Final
                                            </span>
                                          )}
                                          {!isBestAttempt && !subAttempt.is_final && (
                                            <span className="text-zinc-600 text-[10px]">
                                              —
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
