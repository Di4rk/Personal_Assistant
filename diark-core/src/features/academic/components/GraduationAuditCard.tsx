import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  GraduationCap,
  CheckCircle2,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  BookOpen,
  Search,
  Check,
  X,
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

function parseMajorDetails(rawName: string) {
  const cleanName = rawName
    .replace(/^Cử nhân ngành\s+/i, "")
    .replace(/^Kỹ sư ngành\s+/i, "")
    .replace(/^Chương trình tiên tiến ngành\s+/i, "")
    .replace(/^Cử nhân tài năng ngành\s+/i, "")
    .replace(/\s*\(Khoá\s+.*?\)/gi, "")
    .replace(/\s*\(K\d+.*?\)/gi, "")
    .trim();

  const isTalent = rawName.toLowerCase().includes("tài năng");
  const isAdvanced = rawName.toLowerCase().includes("tiên tiến");
  const isClc = rawName.toLowerCase().includes("chất lượng cao");
  const isVnJp = rawName.toLowerCase().includes("việt nhật") || rawName.toLowerCase().includes("việt - nhật");
  const isLienThong = rawName.toLowerCase().includes("liên thông");

  return {
    cleanName: cleanName || rawName,
    isTalent,
    isAdvanced,
    isClc,
    isVnJp,
    isLienThong,
  };
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
  const [openElectiveBlocks, setOpenElectiveBlocks] = useState<Record<string, boolean>>({});
  const [showAllCohorts, setShowAllCohorts] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Trạng thái thu gọn card (lưu vào localStorage)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("academic_audit_collapsed") === "true";
    } catch {
      return false;
    }
  });

  // Trạng thái mở Popover chọn CTĐT và ô tìm kiếm
  const [isSelectorOpen, setIsSelectorOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const selectorRef = useRef<HTMLDivElement>(null);

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("academic_audit_collapsed", String(next));
      } catch (e) {
        console.warn("Lỗi lưu localStorage:", e);
      }
      return next;
    });
  };

  // Đóng popover khi click ra ngoài
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setIsSelectorOpen(false);
      }
    };
    if (isSelectorOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isSelectorOpen]);

  const toggleElectives = (blockKey: string) => {
    setOpenElectiveBlocks((prev) => ({
      ...prev,
      [blockKey]: !prev[blockKey],
    }));
  };

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

  // Lọc CTĐT theo cohort năm của SV và từ khóa tìm kiếm
  const studentCohortYear = report?.cohortYear || 2025;
  const filteredCurriculums = useMemo(() => {
    let list = curriculums;
    if (!showAllCohorts) {
      list = list.filter((c) => c.cohortYear === studentCohortYear);
      if (selectedSlug && !list.some((c) => c.slug === selectedSlug)) {
        const current = curriculums.find((c) => c.slug === selectedSlug);
        if (current) list = [current, ...list];
      }
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((c) =>
        c.majorName.toLowerCase().includes(q) ||
        String(c.cohortYear).includes(q) ||
        c.slug.toLowerCase().includes(q)
      );
    }
    return list.length > 0 ? list : curriculums;
  }, [curriculums, showAllCohorts, studentCohortYear, selectedSlug, searchQuery]);

  const selectedCurriculum = useMemo(() => {
    return curriculums.find((c) => c.slug === selectedSlug) || null;
  }, [curriculums, selectedSlug]);

  const selectedMajorParsed = useMemo(() => {
    if (!selectedCurriculum) {
      return parseMajorDetails(report?.majorName || "Chọn CTĐT...");
    }
    return parseMajorDetails(selectedCurriculum.majorName);
  }, [selectedCurriculum, report]);

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

        {/* Custom Dropdown Combobox Popover & Actions */}
        <div className="flex items-center gap-1.5 self-start sm:self-auto flex-wrap">
          {curriculums.length > 0 && (
            <div className="relative" ref={selectorRef}>
              <button
                type="button"
                onClick={() => setIsSelectorOpen(!isSelectorOpen)}
                disabled={syncing}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-800 border border-zinc-700/60 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 cursor-pointer disabled:opacity-50 max-w-[230px] transition-colors"
                title="Bấm để chọn CTĐT khác"
              >
                <BookOpen className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span className="truncate font-medium text-left">
                  {selectedMajorParsed.cleanName}
                </span>
                {selectedMajorParsed.isTalent && (
                  <span className="px-1 py-0.2 text-[9px] rounded bg-amber-950/60 text-amber-300 border border-amber-600/30 shrink-0">
                    TN
                  </span>
                )}
                {selectedMajorParsed.isAdvanced && (
                  <span className="px-1 py-0.2 text-[9px] rounded bg-sky-950/60 text-sky-300 border border-sky-600/30 shrink-0">
                    TT
                  </span>
                )}
                <ChevronDown
                  className={`h-3.5 w-3.5 text-zinc-400 shrink-0 transition-transform ${
                    isSelectorOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {/* Floating Popover Panel */}
              {isSelectorOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-50 w-80 sm:w-96 rounded-xl bg-zinc-900 border border-zinc-700/80 shadow-2xl overflow-hidden">
                  {/* Popover Header & Search */}
                  <div className="p-2.5 border-b border-zinc-800 space-y-2 bg-zinc-950/70">
                    <div className="relative">
                      <Search className="h-3.5 w-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Tìm kiếm CTĐT (VD: Máy tính, Phần mềm...)"
                        className="w-full pl-8 pr-7 py-1.5 bg-zinc-900 border border-zinc-700/60 rounded-lg text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/70"
                        autoFocus
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    {/* Quick Cohort Filter Toggle */}
                    <div className="flex items-center justify-between text-[11px] px-0.5">
                      <span className="text-zinc-500">Khóa tuyển sinh:</span>
                      <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
                        <button
                          type="button"
                          onClick={() => setShowAllCohorts(false)}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                            !showAllCohorts
                              ? "bg-emerald-950/80 text-emerald-300 border border-emerald-500/30"
                              : "text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          Khóa {studentCohortYear}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowAllCohorts(true)}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                            showAllCohorts
                              ? "bg-zinc-700 text-zinc-100"
                              : "text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          Tất cả khóa
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* List of CTĐT */}
                  <div className="max-h-64 overflow-y-auto p-1.5 space-y-1 scrollbar-thin scrollbar-thumb-zinc-700">
                    {filteredCurriculums.length === 0 ? (
                      <div className="py-6 text-center text-xs text-zinc-500">
                        Không tìm thấy chương trình đào tạo phù hợp
                      </div>
                    ) : (
                      filteredCurriculums.map((c) => {
                        const isSelected = c.slug === selectedSlug;
                        const details = parseMajorDetails(c.majorName);

                        return (
                          <button
                            key={c.slug}
                            type="button"
                            onClick={() => {
                              void handleSelectCurriculum(c.slug);
                              setIsSelectorOpen(false);
                            }}
                            className={`w-full text-left p-2 rounded-lg text-xs transition-colors flex items-start justify-between gap-2 cursor-pointer ${
                              isSelected
                                ? "bg-emerald-950/40 border border-emerald-500/40 text-emerald-200"
                                : "hover:bg-zinc-800/80 text-zinc-300 border border-transparent"
                            }`}
                          >
                            <div className="min-w-0 space-y-1 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-semibold text-zinc-100">
                                  {details.cleanName}
                                </span>
                                {details.isTalent && (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-amber-950/70 text-amber-300 border border-amber-600/30">
                                    Tài năng
                                  </span>
                                )}
                                {details.isAdvanced && (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-sky-950/70 text-sky-300 border border-sky-600/30">
                                    Tiên tiến
                                  </span>
                                )}
                                {details.isClc && (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-indigo-950/70 text-indigo-300 border border-indigo-600/30">
                                    CLC
                                  </span>
                                )}
                                {details.isVnJp && (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-rose-950/70 text-rose-300 border border-rose-600/30">
                                    Việt - Nhật
                                  </span>
                                )}
                                {details.isLienThong && (
                                  <span className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                                    Liên thông
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 text-[10px] text-zinc-400">
                                <span>Khóa {c.cohortYear}</span>
                                {c.cohortNum && <span>• K{c.cohortNum}</span>}
                                {c.totalCredits && <span>• {c.totalCredits} TC</span>}
                              </div>
                            </div>
                            {isSelected && (
                              <Check className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Sync Button */}
          <button
            onClick={handleManualSync}
            disabled={syncing}
            title="Đồng bộ lại chuẩn CTĐT từ Portal UIT"
            className="p-1.5 rounded-lg bg-zinc-800 border border-zinc-700/50 hover:bg-zinc-700/80 text-zinc-300 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin text-emerald-400" : ""}`} />
          </button>

          {/* Toggle Collapse/Expand Button */}
          <button
            type="button"
            onClick={toggleCollapse}
            title={isCollapsed ? "Mở rộng chi tiết kiểm toán tốt nghiệp" : "Thu gọn kiểm toán tốt nghiệp"}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/60 text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
          >
            {isCollapsed ? (
              <>
                <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                <span>Mở rộng</span>
              </>
            ) : (
              <>
                <ChevronUp className="h-3.5 w-3.5 text-zinc-400" />
                <span>Thu gọn</span>
              </>
            )}
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

      {/* 3 & 4. Details Sections (Collapsible) */}
      {!isCollapsed && (
        <>
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

                {/* Expanded Course List & Remaining Electives */}
                {isExpanded && (
                  <div className="border-t border-zinc-800/80 bg-zinc-900/60 p-3.5 space-y-3">
                    {/* Compact Grid 2 cột: Môn đã hoàn thành */}
                    {block.passedCourses.length === 0 ? (
                      <div className="text-zinc-500 text-center py-2.5 text-xs italic">
                        Chưa có môn nào được tích lũy trong khối này.
                      </div>
                    ) : (
                      <div>
                        <div className="text-[11px] font-medium text-zinc-400 mb-2 flex items-center justify-between">
                          <span>Môn đã tích lũy ({block.passedCourses.length} môn):</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {block.passedCourses.map((c) => (
                            <div
                              key={c.courseCode}
                              className="flex items-center justify-between p-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-800/80 border border-zinc-800 text-xs transition-colors"
                            >
                              <div className="flex items-center gap-2 min-w-0 pr-2">
                                <span className="font-mono text-[11px] font-semibold text-emerald-400 bg-emerald-950/50 px-1.5 py-0.5 rounded border border-emerald-500/20 shrink-0">
                                  {c.courseCode}
                                </span>
                                <div className="min-w-0">
                                  <div
                                    className="text-zinc-200 font-medium truncate text-[12px]"
                                    title={c.courseName}
                                  >
                                    {c.courseName}
                                  </div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                                    <span className="text-zinc-300 font-medium">{c.credits} TC</span>
                                    <span>•</span>
                                    <span>{c.semesterId}</span>
                                    {c.isCompulsory && (
                                      <>
                                        <span>•</span>
                                        <span className="text-amber-400/90 font-medium">Bắt buộc</span>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0 text-right">
                                {c.grade10 !== null && (
                                  <span className="text-xs font-semibold text-zinc-100 font-mono">
                                    {c.grade10.toFixed(1)}
                                  </span>
                                )}
                                {c.gradeChar ? (
                                  <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-zinc-700/60 text-emerald-300 font-mono border border-zinc-600/40">
                                    {c.gradeChar}
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-zinc-500">Đạt</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Môn tự chọn chưa học - Collapsible View */}
                    {block.remainingElectives && block.remainingElectives.length > 0 && (
                      <div className="pt-2 border-t border-zinc-800/70">
                        <button
                          type="button"
                          onClick={() => toggleElectives(block.knowledgeBlock)}
                          className="flex items-center justify-between w-full py-1.5 px-2 rounded hover:bg-zinc-800/40 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                        >
                          <div className="flex items-center gap-1.5">
                            <BookOpen className="h-3.5 w-3.5 text-zinc-400" />
                            <span className="font-medium">
                              Môn tự chọn chưa học ({block.remainingElectives.length} môn)
                            </span>
                          </div>
                          {openElectiveBlocks[block.knowledgeBlock] ? (
                            <ChevronUp className="h-3.5 w-3.5 text-zinc-400" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                          )}
                        </button>

                        {openElectiveBlocks[block.knowledgeBlock] && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 mt-2 pt-1">
                            {block.remainingElectives.map((e) => (
                              <div
                                key={e.courseCode}
                                className="flex items-center justify-between p-2 rounded-md bg-zinc-900/50 border border-zinc-800/60 text-[11px] hover:border-zinc-700/70 transition-colors"
                              >
                                <div className="flex items-center gap-1.5 min-w-0 pr-1">
                                  <span className="font-mono text-[10px] text-zinc-400 font-semibold shrink-0">
                                    {e.courseCode}
                                  </span>
                                  <span className="text-zinc-300 truncate" title={e.courseName}>
                                    {e.courseName}
                                  </span>
                                </div>
                                <span className="text-[10px] text-zinc-500 shrink-0 font-medium ml-1">
                                  {e.credits} TC
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Môn tự do ngoài CTĐT nếu có */}
        {report.unmatchedPassedCourses && report.unmatchedPassedCourses.length > 0 && (
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-800/20 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-300">
                Môn đã tích lũy ngoài khung CTĐT ({report.unmatchedPassedCourses.length} môn)
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {report.unmatchedPassedCourses.map((c) => (
                <div
                  key={c.courseCode}
                  className="flex items-center justify-between p-2 rounded-lg bg-zinc-800/50 border border-zinc-800 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0 pr-2">
                    <span className="font-mono text-[11px] font-semibold text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">
                      {c.courseCode}
                    </span>
                    <div className="min-w-0">
                      <div className="text-zinc-300 font-medium truncate text-[12px]">{c.courseName}</div>
                      <div className="text-[10px] text-zinc-500">{c.credits} TC • {c.semesterId}</div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {c.grade10 !== null && (
                      <span className="text-xs font-mono font-semibold text-zinc-200">
                        {c.grade10.toFixed(1)}
                      </span>
                    )}
                    {c.gradeChar && (
                      <span className="ml-1.5 text-[11px] font-mono font-bold text-zinc-400">
                        {c.gradeChar}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
        </>
      )}
    </div>
  );
};
