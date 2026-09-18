import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  GraduationCap,
  Layers,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useSyncOrchestratorStore } from "./stores/syncOrchestratorStore";
import { useAcademicRadar } from "./hooks/useAcademicRadar";
import { AcademicRadarChart } from "./components/AcademicRadarChart";
import { GpaSimulatorCard } from "./components/GpaSimulatorCard";
import { SyncPortalModal } from "./components/SyncPortalModal";
import { ArchiveRitualModal } from "./components/ArchiveRitualModal";
import { AcademicSummaryCards } from "./components/AcademicSummaryCards";
import { SemesterTabs } from "./components/SemesterTabs";
import { AcademicCourseTable } from "./components/AcademicCourseTable";
import { StudentIdentityChip } from "./components/StudentIdentityChip";
import { GraduationAuditCard } from "./components/GraduationAuditCard";
import { ExamRadarCard } from "./components/ExamRadarCard";
import {
  computeCategoryRadarData,
  type CategoryAxisData,
} from "./utils/forecastEngine";
import {
  getSemesterCourses,
  getAcademicMacroMetricsSsot,
  getResolvedCurriculum,
} from "../../lib/tauri-client";
import { listen } from "@tauri-apps/api/event";
import type { AcademicCourseRecord, AcademicMacroMetricSSOT } from "./types";

interface AcademicDashboardProps {
  className?: string;
}

export const AcademicDashboard: React.FC<AcademicDashboardProps> = ({
  className = "",
}) => {
  const {
    overview,
    selectedSemesterId,
    courses,
    isLoadingOverview,
    isLoadingCourses,
    error,
    selectSemester,
    refetchOverview,
  } = useAcademicRadar();

  // Danh sách macro metrics chuẩn SSOT từ SQLite (academic_macro_metrics)
  const [macroMetrics, setMacroMetrics] = useState<AcademicMacroMetricSSOT[]>([]);
  const [isLoadingMacro, setIsLoadingMacro] = useState<boolean>(false);

  // Cache tất cả môn học của toàn bộ học kỳ để vẽ Radar toàn khóa và tính cGPA
  const [allCourses, setAllCourses] = useState<AcademicCourseRecord[]>([]);
  const [isLoadingAllCourses, setIsLoadingAllCourses] = useState<boolean>(false);

  const [radarScope, setRadarScope] = useState<"all" | "semester">("all");

  const [curriculumCredits, setCurriculumCredits] = useState<number>(126);
  const [isSyncPortalModalOpen, setIsSyncPortalModalOpen] = useState<boolean>(false);
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState<boolean>(false);

  const loadMacroMetrics = useCallback(async () => {
    try {
      setIsLoadingMacro(true);
      const [data, curr] = await Promise.allSettled([
        getAcademicMacroMetricsSsot(),
        getResolvedCurriculum(),
      ]);
      if (data.status === "fulfilled") {
        setMacroMetrics(data.value);
      }
      if (curr.status === "fulfilled") {
        setCurriculumCredits(curr.value.total_credits);
      }
    } catch (err) {
      console.error("Không thể nạp academic_macro_metrics SSOT:", err);
    } finally {
      setIsLoadingMacro(false);
    }
  }, []);

  useEffect(() => {
    void loadMacroMetrics();
  }, [loadMacroMetrics]);

  // Khi macroMetrics load xong, tự động chọn học kỳ mới nhất (phần tử cuối mảng) nếu chưa chọn
  useEffect(() => {
    if (macroMetrics.length > 0 && !selectedSemesterId) {
      selectSemester(macroMetrics[macroMetrics.length - 1].semesterId);
    } else if (overview.length > 0 && !selectedSemesterId) {
      selectSemester(overview[0].id);
    }
  }, [macroMetrics, overview, selectedSemesterId, selectSemester]);

  // Nạp toàn bộ môn học để tính toán cGPA tổng thể và phân loại Radar toàn diện
  useEffect(() => {
    const semesterIds =
      macroMetrics.length > 0
        ? macroMetrics.map((m) => m.semesterId)
        : overview.map((sem) => sem.id);

    if (semesterIds.length === 0) {
      setAllCourses([]);
      return;
    }

    let isMounted = true;
    setIsLoadingAllCourses(true);

    Promise.all(semesterIds.map((id) => getSemesterCourses(id)))
      .then((courseBatches) => {
        if (!isMounted) return;
        const flattened = courseBatches.flat();
        setAllCourses(flattened);
      })
      .catch((err: unknown) => {
        console.error("Không thể nạp toàn bộ môn học:", err);
      })
      .finally(() => {
        if (isMounted) {
          setIsLoadingAllCourses(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [macroMetrics, overview]);

  // Dữ liệu môn học dùng để tính toán Radar (Toàn khóa hoặc Học kỳ đang chọn)
  const radarCourses = useMemo(() => {
    return radarScope === "all" ? allCourses : courses;
  }, [radarScope, allCourses, courses]);

  // Tính 4 trục cho biểu đồ Radar
  const radarData: CategoryAxisData[] = useMemo(() => {
    return computeCategoryRadarData(radarCourses);
  }, [radarCourses]);

  // Thống kê hỗ trợ cho GpaSimulatorCard
  const cumulativeStats = useMemo(() => {
    let currentTotalWeighted10 = 0;
    let currentGpaCredits = 0;
    let currentEarnedCredits = 0;

    for (const c of allCourses) {
      if (c.isPassed) {
        currentEarnedCredits += c.credits;
      }
      if (c.isGpaCalculated && c.summaryScore10 !== null && c.summaryScore10 !== undefined) {
        currentTotalWeighted10 += c.summaryScore10 * c.credits;
        currentGpaCredits += c.credits;
      }
    }

    const latest = macroMetrics.length > 0 ? macroMetrics[macroMetrics.length - 1] : null;
    const cGpa10 = latest ? latest.cumulativeGpa : currentGpaCredits > 0 ? currentTotalWeighted10 / currentGpaCredits : 0;

    return {
      cGpa10: Number(cGpa10.toFixed(2)),
      currentGpaCredits: latest ? latest.cumulativeCredits : currentGpaCredits,
      currentEarnedCredits: latest ? latest.cumulativeCredits : currentEarnedCredits,
      currentTotalWeighted10,
    };
  }, [allCourses, macroMetrics]);

  // Học kỳ macro tương ứng với tab đang chọn
  const currentMacro = useMemo(() => {
    return macroMetrics.find((m) => m.semesterId === selectedSemesterId) ?? null;
  }, [macroMetrics, selectedSemesterId]);

  const currentSemester = useMemo(() => {
    return overview.find((s) => s.id === selectedSemesterId) ?? null;
  }, [overview, selectedSemesterId]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([refetchOverview(), loadMacroMetrics()]);
  }, [refetchOverview, loadMacroMetrics]);

  const isPortalSyncing = useSyncOrchestratorStore((s) => s.serviceState.portal.isSyncing);
  const portalAuthStatus = useSyncOrchestratorStore((s) => s.serviceState.portal.authStatus);
  const requestSync = useSyncOrchestratorStore((s) => s.requestSync);

  const [scrapeFeedback, setScrapeFeedback] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const handleRefreshClick = useCallback(async () => {
    setScrapeFeedback(null);
    // 1. Nạp lại DB local ngay lập tức
    void handleRefresh();

    // 2. Kích hoạt cạo dữ liệu ngầm từ Cổng UIT
    try {
      const ok = await requestSync("portal", {
        bypassTtl: true,
        bypassCircuitBreaker: true,
      });
      if (ok) {
        setScrapeFeedback({
          type: "info",
          text: "Đang cạo dữ liệu từ Cổng UIT ngầm...",
        });
      }
    } catch (err) {
      console.error("Lỗi cạo dữ liệu Cổng UIT:", err);
      setScrapeFeedback({
        type: "error",
        text: "Không thể kết nối tới trình cạo dữ liệu.",
      });
    }
  }, [handleRefresh, requestSync]);

  // Lắng nghe event thất bại từ SSO sync window
  useEffect(() => {
    const unlisten = listen<string>("portal-sync-failed", (event) => {
      const reason = event.payload;
      if (reason.includes("session_expired")) {
        setScrapeFeedback({
          type: "error",
          text: "Phiên đăng nhập đã hết hạn. Vui lòng bấm 'Đồng bộ Cổng UIT' để đăng nhập lại.",
        });
      } else {
        setScrapeFeedback({
          type: "error",
          text: `Đồng bộ thất bại: ${reason}`,
        });
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Tự động làm mới khi backend hoàn tất nạp dữ liệu từ portal SSO
  useEffect(() => {
    const unlisten = listen("academic-data-synced", () => {
      void handleRefresh();
      setScrapeFeedback({
        type: "success",
        text: "Đã cạo & đồng bộ dữ liệu mới nhất từ Cổng UIT!",
      });
      const timer = setTimeout(() => {
        setScrapeFeedback(null);
      }, 4000);
      return () => clearTimeout(timer);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleRefresh]);

  // Nhắc nhở nếu phiên đăng nhập hết hạn
  useEffect(() => {
    if (portalAuthStatus === "expired") {
      setScrapeFeedback({
        type: "error",
        text: "Phiên đăng nhập đã hết hạn. Vui lòng bấm 'Đồng bộ Cổng UIT' để đăng nhập lại.",
      });
    }
  }, [portalAuthStatus]);

  const handleSyncPortal = useCallback(() => {
    setIsSyncPortalModalOpen(true);
  }, []);

  const isRefreshing = isLoadingOverview || isLoadingMacro;

  return (
    <div className={`space-y-6 ${className}`}>
      {/* 1. Header Bar: Tiêu đề, Thống kê tổng hợp & Nút Đồng Bộ Portal */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-violet-950/60 border border-violet-800/50 text-violet-400">
              <GraduationCap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-zinc-100">
                UIT Academic Radar
              </h2>
              <p className="text-xs text-zinc-500">
                Hệ thống theo dõi lộ trình học tập, phân tích năng lực và dự báo tốt nghiệp
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          {isPortalSyncing && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-950/50 border border-violet-800/40 text-xs text-violet-300 animate-pulse">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-violet-400" />
              <span>Đang cạo dữ liệu Cổng UIT ngầm...</span>
            </div>
          )}
          {scrapeFeedback && !isPortalSyncing && (
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border ${
                scrapeFeedback.type === "success"
                  ? "bg-emerald-950/50 border-emerald-800/40 text-emerald-300"
                  : scrapeFeedback.type === "error"
                  ? "bg-rose-950/50 border-rose-800/40 text-rose-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-300"
              }`}
            >
              {scrapeFeedback.type === "success" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              {scrapeFeedback.type === "error" && <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
              <span>{scrapeFeedback.text}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={() => { void handleRefreshClick(); }}
              disabled={isPortalSyncing || isRefreshing}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors border focus:outline-none cursor-pointer ${
                isPortalSyncing
                  ? "bg-violet-950/60 border-violet-600/50 text-violet-300"
                  : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border-zinc-700"
              }`}
              title={isPortalSyncing ? "Đang cạo bảng điểm & DRL từ Cổng UIT ngầm..." : "Làm mới & cạo dữ liệu từ Cổng UIT"}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isPortalSyncing || isRefreshing ? "animate-spin text-violet-400" : ""}`} />
              <span>{isPortalSyncing ? "Đang cạo..." : "Làm mới"}</span>
            </button>
            <button
              type="button"
              onClick={() => setIsSyncPortalModalOpen(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-xs font-semibold shadow-sm transition-all cursor-pointer"
            >
              <span className="text-white">⚡</span>
              <span>Đồng bộ Cổng UIT</span>
            </button>
          </div>
        </div>
      </div>

      {/* 1.1 Student Identity Chip (Hồ Sơ Chính Thức UIT) */}
      <div>
        <StudentIdentityChip />
      </div>

      {/* 2. Cumulative Summary Cards (SSOT: cGPA 10, cGPA 4, Cumulative Credits, Average DRL) */}
      <AcademicSummaryCards
        metrics={macroMetrics}
        totalCurriculumCredits={curriculumCredits}
        onSyncClick={handleSyncPortal}
      />

      {/* 2.0 Exam Radar & Shift Countdown (v0.7.0) */}
      <ExamRadarCard />

      {/* 2.1 Degree Audit & Curriculum Progress Engine */}
      <GraduationAuditCard onRefreshTrigger={() => { void handleRefresh(); }} />

      {error && (
        <div className="rounded-lg bg-rose-950/40 border border-rose-800/50 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* 3. Main Split View: Left (Transcript) vs Right (Radar & Simulator) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* === LEFT COLUMN: Transcript & Semesters (7 cols on XL) === */}
        <div className="xl:col-span-7 space-y-4">
          {/* Dynamic Semester Selector Tabs */}
          <SemesterTabs
            metrics={macroMetrics}
            selectedSemesterId={selectedSemesterId}
            onSelectSemester={(id) => selectSemester(id)}
          />

          {/* Selected Semester Course Table */}
          <AcademicCourseTable
            courses={courses}
            isLoading={isLoadingCourses}
            currentMacro={currentMacro}
            currentSemester={currentSemester}
            onArchiveClick={() => setIsArchiveModalOpen(true)}
          />
        </div>

        {/* === RIGHT COLUMN: Radar Chart & Graduation Simulator (5 cols on XL) === */}
        <div className="xl:col-span-5 space-y-6">
          {/* Radar Chart Card */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5 shadow-lg">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-violet-950/60 border border-violet-800/50 text-violet-400">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">
                    Academic Radar Chart
                  </h3>
                  <p className="text-[11px] text-zinc-500">
                    Phân bố năng lực 4 khối kiến thức chuẩn UIT
                  </p>
                </div>
              </div>

              {/* Scope Switcher: Toàn khóa vs Học kỳ */}
              <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-0.5 text-xs">
                <button
                  onClick={() => setRadarScope("all")}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    radarScope === "all"
                      ? "bg-violet-600 text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Toàn khóa
                </button>
                <button
                  onClick={() => setRadarScope("semester")}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                    radarScope === "semester"
                      ? "bg-violet-600 text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Kỳ này
                </button>
              </div>
            </div>

            {/* Render Pure SVG Radar */}
            <div className="py-2 flex items-center justify-center min-h-[300px]">
              {(radarScope === "all" ? isLoadingAllCourses : isLoadingCourses) ? (
                <div className="flex flex-col items-center justify-center gap-2 text-xs text-zinc-500">
                  <RefreshCw className="w-5 h-5 animate-spin text-violet-500" />
                  <span>Đang tải dữ liệu biểu đồ...</span>
                </div>
              ) : (
                <AcademicRadarChart data={radarData} size={300} />
              )}
            </div>

            {/* Radar Legend & Category Mini Breakdown */}
            <div className="mt-4 pt-3 border-t border-zinc-800/80 grid grid-cols-2 gap-2 text-xs">
              {radarData.map((item) => (
                <div
                  key={item.category}
                  className="flex items-center justify-between rounded bg-zinc-950/40 px-2.5 py-1.5 border border-zinc-800/60"
                >
                  <span className="text-zinc-400 truncate mr-2">{item.shortLabel}:</span>
                  <span className="font-mono font-semibold text-zinc-200">
                    {item.averageScore10 > 0 ? `${item.averageScore10.toFixed(2)}/10` : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Graduation Target Simulator Card */}
          <GpaSimulatorCard
            currentGpaCredits={cumulativeStats.currentGpaCredits}
            currentEarnedCredits={cumulativeStats.currentEarnedCredits}
            currentTotalWeighted10={cumulativeStats.currentTotalWeighted10}
            currentGpa10={cumulativeStats.cGpa10}
            completedTermsCount={macroMetrics.length > 0 ? macroMetrics.length : overview.length}
            totalDegreeCredits={curriculumCredits}
            activeCourses={courses}
            activeSemesterId={selectedSemesterId || undefined}
          />
        </div>
      </div>

      <SyncPortalModal
        isOpen={isSyncPortalModalOpen}
        onClose={() => setIsSyncPortalModalOpen(false)}
        onSyncSuccess={() => { void handleRefresh(); }}
      />

      {selectedSemesterId && (
        <ArchiveRitualModal
          isOpen={isArchiveModalOpen}
          onClose={() => setIsArchiveModalOpen(false)}
          semesterId={selectedSemesterId}
          courses={courses}
          onArchiveSuccess={() => {
            void handleRefresh();
          }}
        />
      )}
    </div>
  );
};
