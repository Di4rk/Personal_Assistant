import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
  Check,
  X,
} from "lucide-react";
import type { DegreeAuditReport, CurriculumIndexDto, BlockAuditResult } from "../types";
import { listen } from "@tauri-apps/api/event";
import {
  getDegreeAuditReport,
  getAvailableCurriculums,
  setStudentCurriculumSlug,
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

  // Mặc định mở sẵn trong sub-tab Tổng quan & CTĐT để sinh viên thấy ngay tiến độ
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("academic_audit_collapsed");
      return stored === null ? false : stored === "true";
    } catch {
      return false;
    }
  });

  // Trạng thái mở Popover chọn CTĐT và ô tìm kiếm
  const [isSelectorOpen, setIsSelectorOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const selectorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem("academic_audit_collapsed", String(isCollapsed));
    } catch (e) {
      console.warn("[GraduationAuditCard] Không thể lưu collapse state:", e);
    }
  }, [isCollapsed]);

  const toggleCollapse = () => {
    setIsCollapsed((prev) => !prev);
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

  useEffect(() => {
    const unlisten = listen("academic-data-synced", () => {
      void loadAuditData();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
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
      <div className={`flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-[#1D263B] bg-[#0F1420] p-6 ${className}`}>
        <RefreshCw className="mb-2 h-6 w-6 animate-spin text-[#6B9BFF]" />
        <p className="text-xs font-medium text-zinc-400">Đang kiểm toán tiến độ tốt nghiệp...</p>
      </div>
    );
  }

  if (!report) {
    return (
      <div className={`rounded-xl border border-[#1D263B] bg-[#0F1420] p-6 ${className}`}>
        <div className="mb-2 text-sm font-medium text-rose-400">
          Không thể tải báo cáo kiểm toán tốt nghiệp
        </div>
        <p className="mb-4 text-xs text-zinc-400">{errorMessage || "Chưa có dữ liệu CTĐT hoặc bảng điểm."}</p>
        <button
          onClick={() => loadAuditData()}
          className="rounded-lg border border-[#1D263B] bg-[#151C2C] px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-[#2F6BFF]/50 cursor-pointer"
        >
          Thử lại
        </button>
      </div>
    );
  }

  return (
    <div className={`space-y-5 rounded-xl border border-[#1D263B] bg-[#0F1420] p-5 shadow-sm ${className}`}>
      {/* 1. Header: Title, Major & Select CTĐT */}
      <div className="flex flex-col justify-between gap-4 border-b border-[#1D263B] pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-zinc-100">Kiểm toán Tốt nghiệp</h3>
            {report.isGraduationReady ? (
              <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-950/60 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
                ĐỦ ĐIỀU KIỆN
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-950/50 px-2.5 py-0.5 text-xs font-semibold text-amber-400">
                ĐANG TÍCH LŨY ({report.completionPercent}%)
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-zinc-400">
            Chuẩn CTĐT: <span className="font-medium text-zinc-200">{report.majorName}</span>
            {report.cohortYear ? ` — Khóa ${report.cohortYear}` : ""}
          </p>
        </div>

        {/* Custom Dropdown Combobox Popover & Actions */}
        <div className="flex flex-wrap items-center gap-1.5 self-start sm:self-auto">
          {curriculums.length > 0 && (
            <div className="relative" ref={selectorRef}>
              <button
                type="button"
                onClick={() => setIsSelectorOpen(!isSelectorOpen)}
                disabled={syncing}
                className="flex max-w-[230px] items-center gap-1.5 rounded-lg border border-[#1D263B] bg-[#080B12] px-2.5 py-1.5 text-xs text-zinc-200 transition-colors hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] focus:border-[#2F6BFF]/60 focus:outline-none disabled:opacity-50 cursor-pointer"
                title="Bấm để chọn CTĐT khác"
              >
                <span className="truncate text-left font-medium">
                  {selectedMajorParsed.cleanName}
                </span>
                {selectedMajorParsed.isTalent && (
                  <span className="shrink-0 rounded border border-amber-600/30 bg-amber-950/60 px-1 py-0.2 text-[9px] text-amber-300">
                    TN
                  </span>
                )}
                {selectedMajorParsed.isAdvanced && (
                  <span className="shrink-0 rounded border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.16] px-1 py-0.2 text-[9px] text-[#6B9BFF]">
                    TT
                  </span>
                )}
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${
                    isSelectorOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {/* Floating Popover Panel */}
              {isSelectorOpen && (
                <div className="uit-modal-in absolute right-0 top-full z-50 mt-1.5 w-80 overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420] shadow-2xl sm:w-96">
                  {/* Popover Header & Search */}
                  <div className="space-y-2 border-b border-[#1D263B] bg-[#080B12] p-2.5">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        aria-label="Tìm kiếm chương trình đào tạo"
                        placeholder="Tìm kiếm CTĐT (VD: Máy tính, Phần mềm...)"
                        className="w-full rounded-lg border border-line bg-surface py-1.5 pl-8 pr-7 text-xs text-zinc-200 placeholder:text-zinc-500 focus:border-uit/60 focus:outline-none"
                        autoFocus
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          aria-label="Xóa từ khóa tìm kiếm"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200 cursor-pointer"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    {/* Quick Cohort Filter Toggle */}
                    <div className="flex items-center justify-between px-0.5 text-[11px]">
                      <span className="text-zinc-500">Khóa tuyển sinh:</span>
                      <div className="flex items-center gap-1 rounded-md border border-[#1D263B] bg-[#0F1420] p-0.5">
                        <button
                          type="button"
                          onClick={() => setShowAllCohorts(false)}
                          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                            !showAllCohorts
                              ? "border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                              : "text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          Khóa {studentCohortYear}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowAllCohorts(true)}
                          className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                            showAllCohorts
                              ? "border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                              : "text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          Tất cả khóa
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* List of CTĐT */}
                  <div className="max-h-64 space-y-1 overflow-y-auto p-1.5">
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
                            className={`flex w-full items-start justify-between gap-2 rounded-lg border p-2 text-left text-xs transition-colors cursor-pointer ${
                              isSelected
                                ? "border-[#2F6BFF]/40 bg-[#2F6BFF]/[0.16] text-white"
                                : "border-transparent text-zinc-300 hover:bg-[#151C2C]"
                            }`}
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-semibold text-zinc-100">
                                  {details.cleanName}
                                </span>
                                {details.isTalent && (
                                  <span className="rounded border border-amber-600/30 bg-amber-950/70 px-1.5 py-0.2 text-[9px] font-medium text-amber-300">
                                    Tài năng
                                  </span>
                                )}
                                {details.isAdvanced && (
                                  <span className="rounded border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.16] px-1.5 py-0.2 text-[9px] font-medium text-[#6B9BFF]">
                                    Tiên tiến
                                  </span>
                                )}
                                {details.isClc && (
                                  <span className="rounded border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.16] px-1.5 py-0.2 text-[9px] font-medium text-[#6B9BFF]">
                                    CLC
                                  </span>
                                )}
                                {details.isVnJp && (
                                  <span className="rounded border border-rose-600/30 bg-rose-950/70 px-1.5 py-0.2 text-[9px] font-medium text-rose-300">
                                    Việt - Nhật
                                  </span>
                                )}
                                {details.isLienThong && (
                                  <span className="rounded border border-[#1D263B] bg-[#151C2C] px-1.5 py-0.2 text-[9px] font-medium text-zinc-400">
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
                              <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#6B9BFF]" />
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

          {/* Toggle Collapse/Expand Button */}
          <button
            type="button"
            onClick={toggleCollapse}
            title={isCollapsed ? "Mở rộng chi tiết kiểm toán tốt nghiệp" : "Thu gọn kiểm toán tốt nghiệp"}
            className="flex items-center gap-1 rounded-lg border border-[#1D263B] bg-[#080B12] px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] cursor-pointer"
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
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-zinc-400">Tiến độ tích lũy tín chỉ toàn khóa</span>
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-base font-bold text-zinc-100 tabular-nums">
              {report.totalEarnedCredits.toFixed(1)}
            </span>
            <span className="font-mono text-zinc-400 tabular-nums">/ {report.totalDegreeCredits.toFixed(1)} TC</span>
            <span
              className={`ml-1 font-mono text-xs font-semibold tabular-nums ${
                report.isGraduationReady ? "text-emerald-400" : "text-[#6B9BFF]"
              }`}
            >
              ({report.completionPercent}%)
            </span>
          </div>
        </div>

        {/* Thanh tiến độ chính */}
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#1D263B]">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              report.isGraduationReady ? "bg-emerald-500" : "bg-[#2F6BFF]"
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
          className={`flex items-center gap-2.5 rounded-lg border p-2.5 ${
            report.nonCreditPrerequisites.hasGdqp
              ? "border-emerald-500/30 bg-emerald-950/25 text-emerald-300"
              : "border-[#1D263B] bg-[#080B12] text-zinc-400"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              report.nonCreditPrerequisites.hasGdqp ? "bg-emerald-400" : "bg-zinc-600"
            }`}
          />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider">GDQP (ME001)</div>
            <div className="text-[10px] truncate opacity-80">
              {report.nonCreditPrerequisites.hasGdqp ? "Đã hoàn thành" : "Chưa hoàn thành"}
            </div>
          </div>
        </div>

        {/* GDTC */}
        <div
          className={`flex items-center gap-2.5 rounded-lg border p-2.5 ${
            report.nonCreditPrerequisites.hasGdtc
              ? "border-emerald-500/30 bg-emerald-950/25 text-emerald-300"
              : "border-[#1D263B] bg-[#080B12] text-zinc-400"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              report.nonCreditPrerequisites.hasGdtc ? "bg-emerald-400" : "bg-zinc-600"
            }`}
          />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider">GDTC (2 HP)</div>
            <div className="text-[10px] truncate opacity-80">
              {report.nonCreditPrerequisites.hasGdtc ? "Đã hoàn thành" : "Chưa đủ 2 học phần"}
            </div>
          </div>
        </div>

        {/* Tiếng Anh */}
        <div
          className={`flex items-center gap-2.5 rounded-lg border p-2.5 ${
            report.nonCreditPrerequisites.hasEnglish
              ? "border-emerald-500/30 bg-emerald-950/25 text-emerald-300"
              : "border-[#1D263B] bg-[#080B12] text-zinc-400"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              report.nonCreditPrerequisites.hasEnglish ? "bg-emerald-400" : "bg-zinc-600"
            }`}
          />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider">Ngoại ngữ</div>
            <div className="text-[10px] truncate opacity-80">
              {report.nonCreditPrerequisites.hasEnglish ? "Đạt chuẩn ENG03" : "Cần ENG03/IELTS"}
            </div>
          </div>
        </div>

        {/* ĐRL */}
        <div
          className={`flex items-center gap-2.5 rounded-lg border p-2.5 ${
            report.nonCreditPrerequisites.hasDrl65
              ? "border-emerald-500/30 bg-emerald-950/25 text-emerald-300"
              : "border-[#1D263B] bg-[#080B12] text-zinc-400"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              report.nonCreditPrerequisites.hasDrl65 ? "bg-emerald-400" : "bg-zinc-600"
            }`}
          />
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
                className="overflow-hidden rounded-lg border border-[#1D263B] bg-[#080B12] transition-colors"
              >
                {/* Block Summary Row */}
                <div
                  onClick={() => setExpandedBlock(isExpanded ? null : block.knowledgeBlock)}
                  className="flex cursor-pointer items-center justify-between p-3 transition-colors select-none hover:bg-[#151C2C]"
                >
                  <div className="space-y-1.5 flex-1 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-200">
                        {block.blockNameDisplay}
                      </span>
                      {block.isFulfilled && block.compulsoryFulfilled ? (
                        <span className="rounded-full border border-emerald-500/25 bg-emerald-950/60 px-2 py-0.2 text-[10px] font-medium text-emerald-400">
                          Đạt
                        </span>
                      ) : (
                        <span className="rounded-full border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.16] px-2 py-0.2 font-mono text-[10px] font-medium text-[#6B9BFF]">
                          {progress}%
                        </span>
                      )}

                      {/* Hiển thị tín chỉ tràn nếu có */}
                      {block.overflowCredits > 0 && (
                        <span className="rounded border border-[#1D263B] bg-[#151C2C] px-1.5 py-0.2 text-[10px] font-medium text-zinc-400">
                          +{block.overflowCredits} TC tràn tự do
                        </span>
                      )}
                    </div>

                    {/* Thanh tiến độ khối nhỏ */}
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1D263B]">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            block.isFulfilled ? "bg-emerald-500" : "bg-[#2F6BFF]"
                          }`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="shrink-0 font-mono text-[11px] font-medium text-zinc-400 tabular-nums">
                        {block.completedCredits.toFixed(1)} / {block.requiredCredits.toFixed(1)} TC
                      </span>
                    </div>

                    {/* Cảnh báo môn bắt buộc bị thiếu */}
                    {!block.compulsoryFulfilled && block.missingCompulsoryCodes.length > 0 && (
                      <div className="pt-0.5 text-[11px] text-amber-400/90">
                        Chưa tích lũy: {block.missingCompulsoryCodes.join(", ")}
                      </div>
                    )}
                  </div>

                  <div className="text-zinc-500 hover:text-zinc-300">
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>

                {/* Expanded Course List & Remaining Electives */}
                {isExpanded && (
                  <div className="space-y-3 border-t border-[#1D263B] bg-[#0F1420] p-3.5">
                    {/* Compact Grid 2 cột: Môn bắt buộc chưa tích lũy (Đang học / Chưa học) */}
                    {block.missingCompulsoryCourses && block.missingCompulsoryCourses.length > 0 && (
                      <div>
                        <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-zinc-400">
                          <span>Môn bắt buộc chưa tích lũy ({block.missingCompulsoryCourses.length} môn):</span>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {block.missingCompulsoryCourses.map((c) => (
                            <div
                              key={c.courseCode}
                              className="flex items-center justify-between rounded-lg border border-[#1D263B] bg-[#080B12] p-2 text-xs transition-colors hover:bg-[#151C2C]"
                            >
                              <div className="flex min-w-0 items-center gap-2 pr-2">
                                <span
                                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                                    c.isInProgress
                                      ? "border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.14] text-[#6B9BFF]"
                                      : "border-[#1D263B] bg-[#151C2C] text-zinc-300"
                                  }`}
                                >
                                  {c.courseCode}
                                </span>
                                <div className="min-w-0">
                                  <div
                                    className="truncate text-[12px] font-medium text-zinc-200"
                                    title={c.courseName}
                                  >
                                    {c.courseName || c.courseCode}
                                  </div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                                    <span className="font-medium text-zinc-400">{c.credits} TC</span>
                                    {!c.isInProgress && c.semesterId && c.semesterId !== "Chưa học" && (
                                      <>
                                        <span>•</span>
                                        <span>Gợi ý {c.semesterId}</span>
                                      </>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <span
                                className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                                  c.isInProgress
                                    ? "border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.14] text-[#6B9BFF]"
                                    : "border-[#1D263B] bg-[#151C2C] text-zinc-400"
                                }`}
                              >
                                {c.isInProgress ? "Đang học" : "Chưa học"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

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
                              className="flex items-center justify-between rounded-lg border border-[#1D263B] bg-[#080B12] p-2 text-xs transition-colors hover:bg-[#151C2C]"
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
                                  <span className="rounded border border-[#1D263B] bg-[#151C2C] px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-300">
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
                    {block.remainingElectives && block.remainingElectives.length > 0 && (() => {
                      const defaultOpen =
                        block.passedCourses.length === 0 &&
                        (!block.missingCompulsoryCourses || block.missingCompulsoryCourses.length === 0);
                      const isElectivesOpen = openElectiveBlocks[block.knowledgeBlock] ?? defaultOpen;
                      const isGradBlock = block.blockNameDisplay === "Tốt nghiệp";
                      return (
                      <div className="border-t border-[#1D263B] pt-2">
                        <button
                          type="button"
                          onClick={() => toggleElectives(block.knowledgeBlock)}
                          className="flex w-full items-center justify-between rounded px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-zinc-200 cursor-pointer"
                        >
                          <span className="font-medium">
                            {isGradBlock
                              ? `Lựa chọn tốt nghiệp & môn chuyên đề (${block.remainingElectives.length} học phần)`
                              : `Môn tự chọn chưa học (${block.remainingElectives.length} môn)`}
                          </span>
                          {isElectivesOpen ? (
                            <ChevronUp className="h-3.5 w-3.5 text-zinc-400" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
                          )}
                        </button>

                        {isElectivesOpen && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 mt-2 pt-1">
                            {block.remainingElectives.map((e) => (
                              <div
                                key={e.courseCode}
                                className="flex items-center justify-between rounded-md border border-[#1D263B] bg-[#080B12] p-2 text-[11px] transition-colors hover:border-[#2F6BFF]/35"
                              >
                                <div className="flex items-center gap-1.5 min-w-0 pr-1">
                                  <span className="font-mono text-[10px] text-zinc-400 font-semibold shrink-0">
                                    {e.courseCode}
                                  </span>
                                  <span className="text-zinc-300 truncate" title={e.courseName}>
                                    {e.courseName}
                                  </span>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5 ml-1">
                                  {e.isInProgress && (
                                    <span className="rounded border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.14] px-1 py-0.2 text-[9px] font-medium text-[#6B9BFF]">
                                      Đang học
                                    </span>
                                  )}
                                  <span className="text-[10px] text-zinc-500 font-medium">
                                    {e.credits} TC
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Đề xuất học phần kỳ tới theo CTĐT & tiên quyết */}
        {report.recommendedNextCourses && report.recommendedNextCourses.length > 0 && (
          <div className="space-y-2 rounded-lg border border-[#1D263B] bg-[#080B12] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-zinc-200">
                Đề xuất học phần kỳ tới
              </div>
              <span className="text-[11px] text-zinc-500">
                Theo đúng CTĐT &amp; điều kiện tiên quyết ({report.recommendedNextCourses.length} môn ưu tiên)
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {report.recommendedNextCourses.map((rec) => (
                <div
                  key={rec.courseCode}
                  className="flex items-start justify-between gap-2 rounded-lg border border-[#1D263B] bg-[#0F1420] p-2.5 text-xs transition-colors hover:bg-[#151C2C]"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.14] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#6B9BFF]">
                        {rec.courseCode}
                      </span>
                      <span
                        className="truncate font-medium text-zinc-100"
                        title={rec.courseName}
                      >
                        {rec.courseName}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
                      <span className="font-mono text-zinc-300">{rec.credits} TC</span>
                      <span>·</span>
                      <span>{rec.reason}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-[10px]">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-medium ${
                        rec.isOpen
                          ? "border-[#1D263B] bg-[#080B12] text-zinc-300"
                          : "border-[#1D263B] bg-[#080B12] text-zinc-500"
                      }`}
                    >
                      {rec.isOpen ? "Đang mở lớp" : "Chưa mở"}
                    </span>
                    {rec.prerequisitesMet ? (
                      <span className="text-emerald-400/80 font-medium">Đủ tiên quyết</span>
                    ) : (
                      <span
                        className="text-amber-400/90 font-medium"
                        title={`Cần học trước: ${rec.missingPrerequisites.join(", ")}`}
                      >
                        Cần: {rec.missingPrerequisites.join(", ")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Môn tự do ngoài CTĐT nếu có */}
        {report.unmatchedPassedCourses && report.unmatchedPassedCourses.length > 0 && (
          <div className="space-y-2 rounded-lg border border-[#1D263B] bg-[#080B12] p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-300">
                Môn đã tích lũy ngoài khung CTĐT ({report.unmatchedPassedCourses.length} môn)
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {report.unmatchedPassedCourses.map((c) => (
                <div
                  key={c.courseCode}
                  className="flex items-center justify-between rounded-lg border border-[#1D263B] bg-[#0F1420] p-2 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0 pr-2">
                    <span className="shrink-0 rounded border border-[#1D263B] bg-[#151C2C] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-400">
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
