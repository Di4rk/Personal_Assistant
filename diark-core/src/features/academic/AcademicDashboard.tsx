import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
} from "lucide-react";
import { useSyncOrchestratorStore } from "./stores/syncOrchestratorStore";
import { useAcademicRadar } from "./hooks/useAcademicRadar";
import { AcademicRadarChart } from "./components/AcademicRadarChart";
import { GpaSimulatorCard } from "./components/GpaSimulatorCard";
import { SyncPortalModal } from "./components/SyncPortalModal";
import { ArchiveRitualModal } from "./components/ArchiveRitualModal";
import { SemesterTabs } from "./components/SemesterTabs";
import { AcademicCourseTable } from "./components/AcademicCourseTable";
import { GraduationAuditCard } from "./components/GraduationAuditCard";
import { ExamRadarCard } from "./components/ExamRadarCard";
import {
  computeCategoryRadarData,
  deduplicateCoursesByHighestScore,
  type CategoryAxisData,
} from "./utils/forecastEngine";
import {
  getSemesterCourses,
  getAcademicMacroMetricsSsot,
  getResolvedCurriculum,
  getPortalTuition,
  getPortalCertificates,
  getPortalRegisteredClasses,
  getPortalClassActivities,
  getStudentProfile,
  type StudentProfilePayload,
} from "../../lib/tauri-client";
import { listen } from "@tauri-apps/api/event";
import { usePrivacyStore } from "../../stores/usePrivacyStore";
import {
  formatVietnameseName,
  maskClassName,
  maskFullName,
  maskStudentId,
} from "../../utils/masking";
import type { AcademicCourseRecord, AcademicMacroMetricSSOT } from "./types";
import type {
  PortalCertificate,
  PortalClassActivity,
  PortalRegisteredClass,
  PortalTuitionRecord,
} from "../../types/portal-extra";
import { formatUitPeriodRange, formatVnd } from "../../utils/scheduleTime";

type AcademicSubTab = "transcript" | "overview" | "finance" | "classes";

interface ClassSlot {
  thu: number;
  tietBatDau: number;
  tietKetThuc: number;
  room: string;
}

interface AcademicDashboardProps {
  className?: string;
}

const SUB_TABS: Array<{ id: AcademicSubTab; label: string }> = [
  { id: "transcript", label: "Bảng điểm chi tiết" },
  { id: "overview", label: "Tổng quan & CTĐT" },
  { id: "finance", label: "Học phí & Chứng chỉ" },
  { id: "classes", label: "Lớp học phần & Thi" },
];

export const AcademicDashboard: React.FC<AcademicDashboardProps> = ({
  className = "",
}) => {
  const {
    overview,
    selectedSemesterId,
    courses,
    isLoadingCourses,
    error,
    selectSemester,
    refetchOverview,
  } = useAcademicRadar();

  const isDemoMode = usePrivacyStore((s) => s.isDemoMode);
  const toggleDemoMode = usePrivacyStore((s) => s.toggleDemoMode);

  const [activeSubTab, setActiveSubTab] = useState<AcademicSubTab>("transcript");
  const [macroMetrics, setMacroMetrics] = useState<AcademicMacroMetricSSOT[]>([]);
  const [studentProfile, setStudentProfile] = useState<StudentProfilePayload | null>(null);
  const [allCourses, setAllCourses] = useState<AcademicCourseRecord[]>([]);
  const [isLoadingAllCourses, setIsLoadingAllCourses] = useState<boolean>(false);
  const [radarScope, setRadarScope] = useState<"all" | "semester">("all");
  const [curriculumCredits, setCurriculumCredits] = useState<number>(126);

  const [tuitionRecords, setTuitionRecords] = useState<PortalTuitionRecord[]>([]);
  const [certificates, setCertificates] = useState<PortalCertificate[]>([]);
  const [registeredClasses, setRegisteredClasses] = useState<PortalRegisteredClass[]>([]);
  const [classActivities, setClassActivities] = useState<PortalClassActivity[]>([]);

  const [isSyncPortalModalOpen, setIsSyncPortalModalOpen] = useState<boolean>(false);
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState<boolean>(false);

  const loadMacroMetrics = useCallback(async () => {
    try {
      const [data, curr, tuition, certs, classes, acts, prof] = await Promise.allSettled([
        getAcademicMacroMetricsSsot(),
        getResolvedCurriculum(),
        getPortalTuition(),
        getPortalCertificates(),
        getPortalRegisteredClasses(),
        getPortalClassActivities(),
        getStudentProfile(),
      ]);
      if (data.status === "fulfilled") setMacroMetrics(data.value);
      if (curr.status === "fulfilled") setCurriculumCredits(curr.value.total_credits);
      if (tuition.status === "fulfilled") setTuitionRecords(tuition.value);
      if (certs.status === "fulfilled") setCertificates(certs.value);
      if (classes.status === "fulfilled") setRegisteredClasses(classes.value);
      if (acts.status === "fulfilled") setClassActivities(acts.value);
      if (prof.status === "fulfilled" && prof.value) setStudentProfile(prof.value);
    } catch (err) {
      console.error("Không thể nạp academic_macro_metrics SSOT:", err);
    }
  }, []);

  useEffect(() => {
    void loadMacroMetrics();
  }, [loadMacroMetrics]);

  useEffect(() => {
    const unlistenProf = listen<StudentProfilePayload>("student-profile-synced", (event) => {
      if (event.payload) setStudentProfile(event.payload);
    });
    const unlistenExtra = listen("portal-extra-synced", () => {
      void loadMacroMetrics();
    });
    return () => {
      void unlistenProf.then((fn) => fn());
      void unlistenExtra.then((fn) => fn());
    };
  }, [loadMacroMetrics]);

  useEffect(() => {
    if (macroMetrics.length > 0 && !selectedSemesterId) {
      selectSemester(macroMetrics[macroMetrics.length - 1].semesterId);
    } else if (overview.length > 0 && !selectedSemesterId) {
      selectSemester(overview[0].id);
    }
  }, [macroMetrics, overview, selectedSemesterId, selectSemester]);

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
        setAllCourses(courseBatches.flat());
      })
      .catch((err: unknown) => {
        console.error("Không thể nạp toàn bộ môn học:", err);
      })
      .finally(() => {
        if (isMounted) setIsLoadingAllCourses(false);
      });

    return () => {
      isMounted = false;
    };
  }, [macroMetrics, overview]);

  const radarCourses = useMemo(() => {
    return radarScope === "all" ? allCourses : courses;
  }, [radarScope, allCourses, courses]);

  const radarData: CategoryAxisData[] = useMemo(() => {
    return computeCategoryRadarData(radarCourses);
  }, [radarCourses]);

  const cumulativeStats = useMemo(() => {
    const uniqueCourses = deduplicateCoursesByHighestScore(allCourses);
    let currentTotalWeighted10 = 0;
    let currentGpaCredits = 0;
    let currentEarnedCredits = 0;

    for (const c of uniqueCourses) {
      if (c.isPassed) currentEarnedCredits += c.credits;
      if (
        c.isGpaCalculated &&
        c.credits > 0 &&
        c.summaryScore10 !== null &&
        c.summaryScore10 !== undefined
      ) {
        currentTotalWeighted10 += c.summaryScore10 * c.credits;
        currentGpaCredits += c.credits;
      }
    }

    let latest: AcademicMacroMetricSSOT | null = null;
    for (let i = macroMetrics.length - 1; i >= 0; i -= 1) {
      if (macroMetrics[i].termGpa > 0) {
        latest = macroMetrics[i];
        break;
      }
    }
    if (!latest && macroMetrics.length > 0) {
      latest = macroMetrics[macroMetrics.length - 1];
    }

    const cGpa10 =
      latest && latest.cumulativeGpa > 0
        ? latest.cumulativeGpa
        : currentGpaCredits > 0
        ? currentTotalWeighted10 / currentGpaCredits
        : 0;

    return {
      cGpa10: Number(cGpa10.toFixed(2)),
      currentGpaCredits:
        currentGpaCredits > 0 ? currentGpaCredits : latest ? latest.cumulativeCredits : 0,
      currentEarnedCredits: Math.max(
        currentEarnedCredits,
        latest ? latest.cumulativeCredits : 0
      ),
      currentTotalWeighted10,
    };
  }, [allCourses, macroMetrics]);

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

  const [scrapeFeedback, setScrapeFeedback] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  useEffect(() => {
    const unlisten = listen<string>("portal-sync-failed", (event) => {
      const reason = event.payload;
      setScrapeFeedback({
        type: "error",
        text: reason.includes("session_expired")
          ? "Phiên đăng nhập đã hết hạn. Vui lòng bấm 'Đồng bộ Portal' để đăng nhập lại."
          : `Đồng bộ thất bại: ${reason}`,
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = listen("academic-data-synced", () => {
      void handleRefresh();
      setScrapeFeedback({
        type: "success",
        text: "Đã cập nhật dữ liệu mới nhất từ Portal UIT.",
      });
      timer = setTimeout(() => setScrapeFeedback(null), 4000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      void unlisten.then((fn) => fn());
    };
  }, [handleRefresh]);

  useEffect(() => {
    if (portalAuthStatus === "expired") {
      setScrapeFeedback({
        type: "error",
        text: "Phiên đăng nhập đã hết hạn. Bấm 'Đồng bộ Portal' để đăng nhập lại.",
      });
    }
  }, [portalAuthStatus]);

  const latestMacro = useMemo(() => {
    for (let i = macroMetrics.length - 1; i >= 0; i -= 1) {
      if (macroMetrics[i].termGpa > 0) {
        return macroMetrics[i];
      }
    }
    return macroMetrics.length > 0 ? macroMetrics[macroMetrics.length - 1] : null;
  }, [macroMetrics]);

  const averageDrl = useMemo(() => {
    const completed = macroMetrics.filter((m) => m.termGpa > 0 && m.drlScore > 0);
    const valid = completed.length > 0 ? completed : macroMetrics.filter((m) => m.drlScore > 0);
    if (valid.length === 0) return null;
    const sum = valid.reduce((acc, m) => acc + m.drlScore, 0);
    return Number((sum / valid.length).toFixed(1));
  }, [macroMetrics]);

  const tabListRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Partial<Record<AcademicSubTab, HTMLButtonElement | null>>>({});
  const [tabIndicator, setTabIndicator] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    ready: boolean;
  }>({ left: 0, top: 0, width: 0, height: 0, ready: false });

  const updateTabIndicator = useCallback(() => {
    const activeBtn = tabButtonRefs.current[activeSubTab];
    if (!activeBtn) return;
    setTabIndicator({
      left: activeBtn.offsetLeft,
      top: activeBtn.offsetTop,
      width: activeBtn.offsetWidth,
      height: activeBtn.offsetHeight,
      ready: true,
    });
  }, [activeSubTab]);

  useLayoutEffect(() => {
    updateTabIndicator();
  }, [updateTabIndicator]);

  useEffect(() => {
    window.addEventListener("resize", updateTabIndicator);
    return () => window.removeEventListener("resize", updateTabIndicator);
  }, [updateTabIndicator]);

  const totalTuitionDebt = useMemo(
    () => tuitionRecords.reduce((acc, r) => acc + (r.remaining > 0 ? r.remaining : 0), 0),
    [tuitionRecords]
  );

  const rawFullName = studentProfile?.full_name
    ? formatVietnameseName(studentProfile.full_name)
    : "Sức khỏe học vụ UIT";
  const displayName =
    studentProfile?.full_name && isDemoMode ? maskFullName(rawFullName) : rawFullName;
  const displayId = studentProfile?.student_id
    ? isDemoMode
      ? maskStudentId(studentProfile.student_id)
      : studentProfile.student_id
    : null;
  const displayClass = studentProfile?.student_class
    ? isDemoMode
      ? maskClassName(studentProfile.student_class)
      : studentProfile.student_class
    : null;

  const termBadge =
    registeredClasses.length > 0 && registeredClasses[0].hoc_ky > 0
      ? `Đang học · HK${registeredClasses[0].hoc_ky}`
      : "Đang học";

  return (
    <div className={`mx-auto max-w-7xl space-y-4 ${className}`}>
      {/* Single Merged Compact Academic Header */}
      <div className="flex flex-col gap-3 rounded-xl border border-[#1D263B] bg-[#0F1420] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: Student Identity + Meta */}
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold tracking-tight text-white">
              {displayName}
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#1D263B] bg-[#080B12] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {termBadge}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-[#71717A]">
            {displayId && <span className="text-zinc-300">MSSV: {displayId}</span>}
            {displayClass && (
              <>
                <span className="text-zinc-600">·</span>
                <span>Lớp: {displayClass}</span>
              </>
            )}
            {studentProfile?.cohort && (
              <>
                <span className="text-zinc-600">·</span>
                <span>{studentProfile.cohort}</span>
              </>
            )}
            <span className="text-zinc-600 hidden sm:inline">·</span>
            <span className="font-sans text-[#71717A]">
              GPA{" "}
              <strong className="font-mono font-semibold tabular-nums text-[#F4F4F5]">
                {latestMacro ? latestMacro.cumulativeGpa.toFixed(2) : "—"}
              </strong>
              {" · "}
              <strong className="font-mono font-semibold tabular-nums text-[#F4F4F5]">
                {latestMacro ? `${latestMacro.cumulativeCredits}/${curriculumCredits}` : `0/${curriculumCredits}`}
              </strong>{" "}
              TC
              {" · "}
              ĐRL{" "}
              <strong
                title="Điểm rèn luyện trung bình các học kỳ đã có điểm"
                className="font-mono font-semibold tabular-nums text-[#F4F4F5]"
              >
                {averageDrl !== null ? averageDrl : "—"}
              </strong>
              {" · "}
              Học phí{" "}
              <strong
                className={`font-mono font-semibold tabular-nums ${
                  totalTuitionDebt > 0 ? "text-amber-400" : "text-[#F4F4F5]"
                }`}
              >
                {tuitionRecords.length === 0
                  ? "—"
                  : totalTuitionDebt > 0
                  ? `Nợ ${formatVnd(totalTuitionDebt)}`
                  : "Đã đóng"}
              </strong>
            </span>
          </div>
        </div>

        {/* Right: Feedback pill + Eye toggle + Compact Icon Sync */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {scrapeFeedback && !isPortalSyncing && (
            <div
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${
                scrapeFeedback.type === "success"
                  ? "border-emerald-500/30 bg-emerald-950/40 text-emerald-300"
                  : scrapeFeedback.type === "error"
                  ? "border-rose-500/30 bg-rose-950/40 text-rose-300"
                  : "border-[#1D263B] bg-[#080B12] text-zinc-300"
              }`}
            >
              {scrapeFeedback.type === "success" && (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
              )}
              {scrapeFeedback.type === "error" && (
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden="true" />
              )}
              <span>{scrapeFeedback.text}</span>
            </div>
          )}

          <button
            type="button"
            onClick={toggleDemoMode}
            title={
              isDemoMode
                ? "Chế độ riêng tư: Đang bật (Click để hiện thông tin)"
                : "Chế độ riêng tư: Đang tắt (Click để ẩn thông tin)"
            }
            aria-label="Ẩn/hiện thông tin cá nhân"
            className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
              isDemoMode
                ? "border-[#2F6BFF]/45 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                : "border-[#1D263B] bg-[#080B12] text-zinc-400 hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] hover:text-zinc-200"
            }`}
          >
            {isDemoMode ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Sub-Tab Bar with Sliding Active Indicator */}
      <div
        ref={tabListRef}
        role="tablist"
        aria-label="Phân mục Học vụ"
        className="relative flex flex-wrap items-center gap-1.5 border-b border-[#1D263B] pb-2"
      >
        {tabIndicator.ready && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 rounded-lg border border-[#2F6BFF]/55 bg-[#2F6BFF]/[0.14] transition-[transform,width] duration-[180ms] ease-out motion-reduce:transition-none"
            style={{
              width: `${tabIndicator.width}px`,
              height: `${tabIndicator.height}px`,
              transform: `translate3d(${tabIndicator.left}px, ${tabIndicator.top}px, 0)`,
            }}
          />
        )}
        {SUB_TABS.map((tab) => {
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabButtonRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveSubTab(tab.id)}
              className={`relative z-10 rounded-lg border border-transparent px-3 py-1.5 text-xs transition-colors duration-150 cursor-pointer ${
                isActive
                  ? "font-semibold text-[#6B9BFF]"
                  : "font-medium text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div
          className="rounded-lg border border-rose-500/30 bg-rose-950/40 p-3 text-xs text-rose-300"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* SUB-TAB 1: Bảng điểm chi tiết */}
      {activeSubTab === "transcript" && (
        <div className="space-y-4">
          <div className="space-y-3">
            <SemesterTabs
              metrics={macroMetrics}
              selectedSemesterId={selectedSemesterId}
              onSelectSemester={(id) => selectSemester(id)}
            />
            <AcademicCourseTable
              courses={courses}
              isLoading={isLoadingCourses}
              currentMacro={currentMacro}
              currentSemester={currentSemester}
              semesterKey={selectedSemesterId ?? "none"}
              onArchiveClick={() => setIsArchiveModalOpen(true)}
            />
          </div>
        </div>
      )}

      {/* SUB-TAB 2: Tổng quan & CTĐT */}
      {activeSubTab === "overview" && (
        <div className="space-y-4">
          <GraduationAuditCard
            onRefreshTrigger={() => {
              void handleRefresh();
            }}
          />
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
            {/* Sticky Left Radar Column */}
            <div className="rounded-xl border border-[#1D263B] bg-[#0F1420] p-4 xl:sticky xl:top-4 xl:col-span-5 xl:self-start">
              <div className="mb-3 flex items-center justify-between border-b border-[#1D263B] pb-3">
                <div>
                  <h3 className="text-xs font-semibold text-zinc-100">Phân bố khối kiến thức</h3>
                  <p className="text-[11px] text-zinc-500">4 nhóm chuẩn CTĐT UIT</p>
                </div>
                <div className="flex items-center rounded-md border border-[#1D263B] bg-[#080B12] p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setRadarScope("all")}
                    className={`rounded px-2 py-1 text-xs transition-colors cursor-pointer ${
                      radarScope === "all"
                        ? "bg-[#2F6BFF]/[0.16] font-medium text-[#6B9BFF]"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    Toàn khóa
                  </button>
                  <button
                    type="button"
                    onClick={() => setRadarScope("semester")}
                    className={`rounded px-2 py-1 text-xs transition-colors cursor-pointer ${
                      radarScope === "semester"
                        ? "bg-[#2F6BFF]/[0.16] font-medium text-[#6B9BFF]"
                        : "text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    Kỳ này
                  </button>
                </div>
              </div>
              <div className="flex min-h-[280px] items-center justify-center">
                {(radarScope === "all" ? isLoadingAllCourses : isLoadingCourses) ? (
                  <span className="text-xs text-zinc-500">Đang tải...</span>
                ) : (
                  <AcademicRadarChart data={radarData} size={280} />
                )}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#1D263B] pt-3 text-xs">
                {radarData.map((item) => (
                  <div
                    key={item.category}
                    className="flex items-center justify-between rounded-lg border border-[#1D263B] bg-[#080B12] px-2.5 py-1.5"
                  >
                    <span className="truncate text-zinc-400">{item.shortLabel}</span>
                    <span className="font-mono font-semibold tabular-nums text-zinc-200">
                      {item.averageScore10 > 0 ? item.averageScore10.toFixed(2) : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="xl:col-span-7">
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
        </div>
      )}

      {/* SUB-TAB 3: Học phí & Chứng chỉ */}
      {activeSubTab === "finance" && (
        <div className="space-y-4">
          <section className="overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420]">
            <div className="border-b border-[#1D263B] px-4 py-3">
              <h3 className="text-xs font-semibold text-zinc-100">Học phí theo học kỳ</h3>
            </div>
            {tuitionRecords.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-zinc-400">
                Chưa có dữ liệu học phí. Nhấn F5 hoặc nút đồng bộ ở góc dưới trái để cập nhật.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[#1D263B] bg-[#080B12] text-zinc-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Học kỳ</th>
                      <th className="px-4 py-2 text-right font-medium">Phải đóng</th>
                      <th className="px-4 py-2 text-right font-medium">Đã đóng</th>
                      <th className="px-4 py-2 text-right font-medium">Còn nợ</th>
                      <th className="px-4 py-2 font-medium">Trạng thái</th>
                      <th className="px-4 py-2 font-medium">Hạn / Ngày đóng</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D263B]/60">
                    {tuitionRecords.map((rec) => (
                      <tr key={rec.id} className="transition-colors hover:bg-[#151C2C]">
                        <td className="px-4 py-2.5 font-medium text-zinc-200">{rec.period}</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-zinc-300">
                          {formatVnd(rec.must_be_paid)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-zinc-300">
                          {formatVnd(rec.paid)}
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-mono font-semibold tabular-nums ${
                            rec.remaining > 0 ? "text-amber-400" : "text-[#F4F4F5]"
                          }`}
                        >
                          {formatVnd(rec.remaining)}
                        </td>
                        <td className="px-4 py-2.5 text-zinc-300">
                          {rec.payment_status_label || rec.payment_status}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-500">
                          {rec.paid_time_formatted || rec.period_1_due_date || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420]">
              <div className="border-b border-[#1D263B] px-4 py-3">
                <h3 className="text-xs font-semibold text-zinc-100">Chứng chỉ &amp; Chuẩn đầu ra</h3>
              </div>
              {certificates.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-zinc-500">
                  Chưa ghi nhận chứng chỉ nào trên Portal.
                </div>
              ) : (
                <div className="divide-y divide-[#1D263B]/60">
                  {certificates.map((c) => (
                    <div key={c.id} className="flex items-center justify-between px-4 py-2.5 text-xs">
                      <div>
                        <div className="font-medium text-zinc-200">
                          {c.cert_type} {c.capdo ? `(${c.capdo})` : ""}
                        </div>
                        <div className="font-mono text-[11px] text-zinc-500">
                          {c.ngaythi || c.create_date || "—"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {c.tongdiem > 0 && (
                          <span className="font-mono font-semibold tabular-nums text-zinc-100">
                            {c.tongdiem}
                          </span>
                        )}
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                            c.output_standard
                              ? "border border-emerald-500/30 bg-emerald-950/60 text-emerald-300"
                              : "border border-[#1D263B] bg-[#080B12] text-zinc-400"
                          }`}
                        >
                          {c.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420]">
              <div className="border-b border-[#1D263B] px-4 py-3">
                <h3 className="text-xs font-semibold text-zinc-100">Lịch sinh hoạt lớp</h3>
              </div>
              {classActivities.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-zinc-500">
                  Không có lịch sinh hoạt lớp sắp tới.
                </div>
              ) : (
                <div className="divide-y divide-[#1D263B]/60">
                  {classActivities.map((act) => (
                    <div key={act.id} className="px-4 py-2.5 text-xs">
                      <div className="font-medium text-zinc-200">{act.noi_dung}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                        {act.ngay} · Phòng {act.dia_diem || "—"}{" "}
                        {act.gv_chu_tri ? `· ${act.gv_chu_tri}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* SUB-TAB 4: Lớp học phần & Thi */}
      {activeSubTab === "classes" && (
        <div className="space-y-4">
          <section className="overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420]">
            <div className="border-b border-[#1D263B] px-4 py-3">
              <h3 className="text-xs font-semibold text-zinc-100">
                Lớp học phần đã đăng ký ({registeredClasses.length})
              </h3>
            </div>
            {registeredClasses.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-zinc-500">
                Chưa có danh sách lớp đăng ký. Nhấn F5 hoặc nút đồng bộ để cập nhật.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[#1D263B] bg-[#080B12] text-zinc-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Mã lớp</th>
                      <th className="px-4 py-2 font-medium">Môn học</th>
                      <th className="px-4 py-2 text-center font-medium">TC</th>
                      <th className="px-4 py-2 font-medium">Giảng viên</th>
                      <th className="px-4 py-2 font-medium">Lịch &amp; Phòng</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1D263B]/60">
                    {registeredClasses.map((cls) => {
                      let slots: ClassSlot[] = [];
                      try {
                        const parsed: unknown = JSON.parse(cls.slots_json);
                        if (Array.isArray(parsed)) slots = parsed as ClassSlot[];
                      } catch {
                        slots = [];
                      }
                      return (
                        <tr key={cls.id} className="transition-colors hover:bg-[#151C2C]">
                          <td className="px-4 py-2.5 font-mono font-medium text-[#6B9BFF]">
                            {cls.code}
                          </td>
                          <td className="px-4 py-2.5 text-zinc-200">{cls.subject_name}</td>
                          <td className="px-4 py-2.5 text-center font-mono tabular-nums text-zinc-400">
                            {cls.credit}
                          </td>
                          <td className="px-4 py-2.5 text-zinc-400">{cls.lecturer || "—"}</td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-zinc-300">
                            {slots.length === 0
                              ? "—"
                              : slots
                                  .map(
                                    (s) =>
                                      `T${s.thu} (${formatUitPeriodRange(s.tietBatDau, s.tietKetThuc)}) · ${s.room}`
                                  )
                                  .join(", ")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <ExamRadarCard />
        </div>
      )}

      <SyncPortalModal
        isOpen={isSyncPortalModalOpen}
        onClose={() => setIsSyncPortalModalOpen(false)}
        onSyncSuccess={() => {
          void handleRefresh();
        }}
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
