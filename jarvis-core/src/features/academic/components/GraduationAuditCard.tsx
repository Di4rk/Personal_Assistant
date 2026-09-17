import React, { useState, useEffect, useMemo } from "react";
import {
  GraduationCap,
  CheckCircle2,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import type { DegreeAuditReport, CurriculumIndexDto, BlockAuditResult } from "../types";
import {
  getDegreeAuditReport,
  getAvailableCurriculums,
  setStudentCurriculumSlug,
  fetchAndCacheCurriculum,
} from "../../../lib/tauri-client";

interface GraduationAuditCardProps {
  onRefreshTrigger?: () => void;
  className?: string;
}

export const GraduationAuditCard: React.FC<GraduationAuditCardProps> = ({
  onRefreshTrigger,
  className = "",
}) => {
  const [report, setReport] = useState<DegreeAuditReport | null>(null);
  const [curriculums, setCurriculums] = useState<CurriculumIndexDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [expandedBlock, setExpandedBlock] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Tải dữ liệu ban đầu
  const loadAuditData = async (slug?: string) => {
    try {
      setLoading(true);
      setErrorMessage(null);

      const [auditReport, catalog] = await Promise.all([
        getDegreeAuditReport(slug || null),
        getAvailableCurriculums().catch(() => []),
      ]);

      setReport(auditReport);
      setSelectedSlug(auditReport.slug);
      setCurriculums(catalog);
    } catch (err) {
      console.error("[GraduationAuditCard] Lỗi tải audit:", err);
      setErrorMessage(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAuditData();
  }, []);

  // Xử lý đổi CTĐT
  const handleSelectCurriculum = async (slug: string) => {
    if (!slug || slug === selectedSlug) return;
    try {
      setSyncing(true);
      setSelectedSlug(slug);
      await setStudentCurriculumSlug(slug);
      await loadAuditData(slug);
      if (onRefreshTrigger) onRefreshTrigger();
    } catch (err) {
      console.error("[GraduationAuditCard] Lỗi đổi CTĐT:", err);
      setErrorMessage(String(err));
    } finally {
      setSyncing(false);
    }
  };

  // Đồng bộ lại từ Portal UIT
  const handleManualSync = async () => {
    if (!selectedSlug) return;
    try {
      setSyncing(true);
      setErrorMessage(null);
      await fetchAndCacheCurriculum(selectedSlug);
      await loadAuditData(selectedSlug);
      if (onRefreshTrigger) onRefreshTrigger();
    } catch (err) {
      console.error("[GraduationAuditCard] Lỗi đồng bộ:", err);
      setErrorMessage(String(err));
    } finally {
      setSyncing(false);
    }
  };

  // Thống kê tiến độ các khối
  const completedBlocksCount = useMemo(() => {
    if (!report) return 0;
    return report.blockAudits.filter((b) => b.isFulfilled && b.compulsoryFulfilled).length;
  }, [report]);

  if (loading && !report) {
    return (
      <div className={`rounded-xl bg-zinc-900 border border-zinc-800 p-6 flex flex-col items-center justify-center min-h-[220px] ${className}`}>
        <RefreshCw className="h-6 w-6 animate-spin text-zinc-500 mb-2" />
        <p className="text-xs text-zinc-400 font-medium">Đang kiểm toán tiến độ tốt nghiệp...</p>
      </div>
    );
  }

  if (!report) {
    return (
      <div className={`rounded-xl bg-zinc-900 border border-zinc-800 p-6 ${className}`}>
        <div className="flex items-center gap-2 text-rose-400 text-sm font-medium mb-2">
          <AlertCircle className="h-4 w-4" />
          <span>Không thể tải báo cáo kiểm toán tốt nghiệp</span>
        </div>
        <p className="text-xs text-zinc-400 mb-4">{errorMessage || "Chưa có dữ liệu CTĐT hoặc bảng điểm."}</p>
        <button
          onClick={() => loadAuditData()}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 font-medium transition-colors"
        >
          Thử lại
        </button>
      </div>
    );
  }

  return (
    <div className={`rounded-xl bg-zinc-900 border border-zinc-800 p-5 shadow-sm space-y-5 ${className}`}>
      {/* 1. Header: Title, Major & Select CTĐT */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-lg bg-zinc-800/80 border border-zinc-700/50 text-zinc-300">
            <GraduationCap className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-zinc-100 text-base">Kiểm toán Tốt nghiệp</h3>
              {report.isGraduationReady ? (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950/60 text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="h-3 w-3" /> ĐỦ ĐIỀU KIỆN
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-950/50 text-amber-400 border border-amber-500/30">
                  <Clock className="h-3 w-3" /> ĐANG TÍCH LŨY ({report.completionPercent}%)
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">
              Chuẩn CTĐT: <span className="text-zinc-200 font-medium">{report.majorName}</span>
              {report.cohortYear ? ` — Khóa ${report.cohortYear}` : ""}
            </p>
          </div>
        </div>

        {/* Dropdown & Actions */}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {curriculums.length > 0 && (
            <div className="relative">
              <select
                aria-label="Chọn chương trình đào tạo chuẩn kiểm toán"
                value={selectedSlug}
                onChange={(e) => handleSelectCurriculum(e.target.value)}
                disabled={syncing}
                className="appearance-none bg-zinc-800/90 border border-zinc-700/60 rounded-lg px-3 py-1.5 pr-8 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 cursor-pointer disabled:opacity-50 max-w-[220px] truncate"
              >
                {curriculums.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.majorName} {c.cohortNum ? `(K${c.cohortNum} - ${c.cohortYear})` : `(${c.cohortYear})`}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-3.5 w-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          )}

          <button
            onClick={handleManualSync}
            disabled={syncing}
            title="Đồng bộ lại CTĐT từ Portal UIT"
            className="p-1.5 rounded-lg bg-zinc-800 border border-zinc-700/50 hover:bg-zinc-700/80 text-zinc-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin text-emerald-400" : ""}`} />
          </button>
        </div>
      </div>

      {/* 2. Main Progress Bar & Metrics */}
      <div className="space-y-2">
        <div className="flex justify-between items-baseline text-xs">
          <span className="text-zinc-400">Tiến độ tích lũy tín chỉ toàn khóa</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold text-zinc-100">
              {report.totalEarnedCredits.toFixed(1)}
            </span>
            <span className="text-zinc-400">/ {report.totalDegreeCredits.toFixed(1)} TC</span>
            <span className="text-xs font-semibold text-emerald-400 ml-1">
              ({report.completionPercent}%)
            </span>
          </div>
        </div>

        {/* Thanh tiến độ chính */}
        <div className="h-2.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-500 rounded-full ${
              report.isGraduationReady ? "bg-emerald-500" : "bg-emerald-500/80"
            }`}
            style={{ width: `${report.completionPercent}%` }}
          />
        </div>
      </div>

      {/* 3. 4 Non-Credit Prerequisites Badges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
        {/* GDQP */}
        <div
          className={`p-2.5 rounded-lg border flex items-center gap-2.5 ${
            report.nonCreditPrerequisites.hasGdqp
              ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
              : "bg-zinc-800/40 border-zinc-700/40 text-zinc-400"
          }`}
        >
          {report.nonCreditPrerequisites.hasGdqp ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 text-zinc-500 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider">GDQP (ME001)</div>
            <div className="text-[10px] truncate opacity-80">
              {report.nonCreditPrerequisites.hasGdqp ? "Đã hoàn thành" : "Chưa hoàn thành"}
            </div>
          </div>
        </div>

        {/* GDTC */}
        <div
          className={`p-2.5 rounded-lg border flex items-center gap-2.5 ${
            report.nonCreditPrerequisites.hasGdtc
              ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
              : "bg-zinc-800/40 border-zinc-700/40 text-zinc-400"
          }`}
        >
          {report.nonCreditPrerequisites.hasGdtc ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 text-zinc-500 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider">GDTC (2 HP)</div>
            <div className="text-[10px] truncate opacity-80">
              {report.nonCreditPrerequisites.hasGdtc ? "Đã hoàn thành" : "Chưa đủ 2 học phần"}
            </div>
          </div>
        </div>

        {/* Tiếng Anh */}
        <div
          className={`p-2.5 rounded-lg border flex items-center gap-2.5 ${
            report.nonCreditPrerequisites.hasEnglish
              ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
              : "bg-zinc-800/40 border-zinc-700/40 text-zinc-400"
          }`}
        >
          {report.nonCreditPrerequisites.hasEnglish ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 text-zinc-500 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider">Ngoại ngữ</div>
            <div className="text-[10px] truncate opacity-80">
              {report.nonCreditPrerequisites.hasEnglish ? "Đạt chuẩn ENG03" : "Cần ENG03/IELTS"}
            </div>
          </div>
        </div>

        {/* ĐRL */}
        <div
          className={`p-2.5 rounded-lg border flex items-center gap-2.5 ${
            report.nonCreditPrerequisites.hasDrl65
              ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
              : "bg-zinc-800/40 border-zinc-700/40 text-zinc-400"
          }`}
        >
          {report.nonCreditPrerequisites.hasDrl65 ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 text-zinc-500 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider">ĐRL (≥ 65)</div>
            <div className="text-[10px] truncate opacity-80">
              {report.nonCreditPrerequisites.hasDrl65 ? "Đạt mức sàn" : "Dưới 65 điểm"}
            </div>
          </div>
        </div>
      </div>

      {/* 4. Knowledge Blocks Accordion */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
            Chi tiết các khối kiến thức ({completedBlocksCount}/{report.blockAudits.length} khối hoàn thành)
          </span>
        </div>

        <div className="space-y-2">
          {report.blockAudits.map((block: BlockAuditResult) => {
            const isExpanded = expandedBlock === block.knowledgeBlock;
            const progress = Math.min(100, Math.round((block.completedCredits / block.requiredCredits) * 100));

            return (
              <div
                key={block.knowledgeBlock}
                className="rounded-lg border border-zinc-800/80 bg-zinc-800/20 overflow-hidden transition-colors"
              >
                {/* Block Summary Row */}
                <div
                  onClick={() => setExpandedBlock(isExpanded ? null : block.knowledgeBlock)}
                  className="p-3 flex items-center justify-between cursor-pointer hover:bg-zinc-800/40 select-none"
                >
                  <div className="space-y-1.5 flex-1 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-200">
                        {block.blockNameDisplay}
                      </span>
                      {block.isFulfilled && block.compulsoryFulfilled ? (
                        <span className="text-[10px] font-medium px-2 py-0.2 rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-500/20">
                          Đạt
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium px-2 py-0.2 rounded-full bg-zinc-800 text-zinc-400">
                          {progress}%
                        </span>
                      )}

                      {/* Hiển thị tín chỉ tràn nếu có */}
                      {block.overflowCredits > 0 && (
                        <span className="text-[10px] font-medium px-1.5 py-0.2 rounded text-zinc-400 bg-zinc-800/80">
                          +{block.overflowCredits} TC tràn tự do
                        </span>
                      )}
                    </div>

                    {/* Thanh tiến độ khối nhỏ */}
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            block.isFulfilled ? "bg-emerald-500" : "bg-zinc-400"
                          }`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="text-[11px] text-zinc-400 shrink-0 font-medium">
                        {block.completedCredits.toFixed(1)} / {block.requiredCredits.toFixed(1)} TC
                      </span>
                    </div>

                    {/* Cảnh báo môn bắt buộc bị thiếu */}
                    {!block.compulsoryFulfilled && block.missingCompulsoryCodes.length > 0 && (
                      <div className="text-[11px] text-amber-400/90 flex items-center gap-1 pt-0.5">
                        <AlertCircle className="h-3 w-3 shrink-0" />
                        <span>Chưa tích lũy: {block.missingCompulsoryCodes.join(", ")}</span>
                      </div>
                    )}
                  </div>

                  <div className="text-zinc-500 hover:text-zinc-300">
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>

                {/* Expanded Course List Table */}
                {isExpanded && (
                  <div className="border-t border-zinc-800/80 bg-zinc-900/60 p-3 text-xs">
                    {block.passedCourses.length === 0 ? (
                      <div className="text-zinc-500 text-center py-2 text-xs">
                        Chưa có môn nào được tích lũy trong khối này.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="border-b border-zinc-800 text-zinc-400 text-[11px]">
                              <th className="pb-1.5 font-medium">Mã MH</th>
                              <th className="pb-1.5 font-medium">Tên môn học</th>
                              <th className="pb-1.5 font-medium text-center">TC</th>
                              <th className="pb-1.5 font-medium text-center">Điểm 10</th>
                              <th className="pb-1.5 font-medium text-center">Điểm Chữ</th>
                              <th className="pb-1.5 font-medium">Học kỳ</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/40 text-zinc-300">
                            {block.passedCourses.map((c) => (
                              <tr key={c.courseCode} className="hover:bg-zinc-800/30">
                                <td className="py-1.5 font-mono text-[11px] text-zinc-200">
                                  {c.courseCode}
                                </td>
                                <td className="py-1.5 text-zinc-300">{c.courseName}</td>
                                <td className="py-1.5 text-center">{c.credits}</td>
                                <td className="py-1.5 text-center font-semibold text-zinc-100">
                                  {c.grade10 !== null ? c.grade10.toFixed(1) : "—"}
                                </td>
                                <td className="py-1.5 text-center font-semibold text-emerald-400">
                                  {c.gradeChar || "—"}
                                </td>
                                <td className="py-1.5 text-zinc-400 text-[11px]">
                                  {c.semesterId}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
