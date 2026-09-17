import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Terminal,
  Award,
  CheckCircle2,
  Clock,
  RefreshCw,
  ExternalLink,
  Filter,
  Sparkles,
  AlertTriangle,
  Code2,
  FolderCode,
  ListFilter,
  AlertCircle,
  WifiOff,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getWecodeSubmissions,
  getWecodeAssignments,
  getWecodeProblems,
  getStudentProfile,
} from "../../lib/tauri-client";
import { WecodeSubmissionsList } from "./components/WecodeSubmissionsList";
import { WecodeAssignmentList } from "./components/WecodeAssignmentList";
import { WecodeProblemList } from "./components/WecodeProblemList";
import { SyncWecodeModal } from "./components/SyncWecodeModal";
import { aggregateWecodeHierarchy } from "./utils/wecodeHierarchy";
import { useSyncLifecycle } from "./hooks/useSyncLifecycle";
import type {
  WecodeSubmission,
  WecodeAssignmentMeta,
  WecodeProblemRecord,
} from "../../types/wecode";

export const WecodeDashboard: React.FC = () => {
  const [submissions, setSubmissions] = useState<WecodeSubmission[]>([]);
  const [storedAssignments, setStoredAssignments] = useState<WecodeAssignmentMeta[]>([]);
  const [storedProblems, setStoredProblems] = useState<WecodeProblemRecord[]>([]);
  const [studentClass, setStudentClass] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState<boolean>(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [partialErrors, setPartialErrors] = useState<string[]>([]);

  // Navigation & Filtering States
  const [selectedCourse, setSelectedCourse] = useState<string | null>(null); // null = Tất cả môn
  const [selectedClass, setSelectedClass] = useState<string | null>(null); // null = Tất cả lớp trong môn
  const [statusFilter, setStatusFilter] = useState<"all" | "urgent" | "completed" | "closed">("all");
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<number | null>(null); // null = Danh sách assignments
  const [activeTab, setActiveTab] = useState<"assignments" | "raw_submissions">("assignments");

  const fetchSubmissions = useCallback(async () => {
    setIsLoading(true);
    try {
      const [subData, assignData, probData, profile] = await Promise.all([
        getWecodeSubmissions(),
        getWecodeAssignments().catch(() => []),
        getWecodeProblems().catch(() => []),
        getStudentProfile().catch(() => null),
      ]);
      setSubmissions(subData);
      setStoredAssignments(assignData);
      setStoredProblems(probData);
      if (profile?.student_class) {
        setStudentClass(profile.student_class);
      }
    } catch (err) {
      console.error("[WecodeDashboard] Lỗi tải dữ liệu wecode:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSubmissions();
  }, [fetchSubmissions]);

  useEffect(() => {
    let unlistenSync: UnlistenFn | undefined;
    let unlistenFail: UnlistenFn | undefined;
    let unlistenPartial: UnlistenFn | undefined;

    const setupListeners = async () => {
      unlistenSync = await listen("wecode-submissions-synced", () => {
        setSyncError(null);
        void fetchSubmissions();
      });

      unlistenFail = await listen<string>("wecode-sync-failed", (event) => {
        setSyncError(event.payload);
      });

      unlistenPartial = await listen<string[]>("wecode-sync-partial-errors", (event) => {
        setPartialErrors(event.payload);
      });
    };

    void setupListeners();

    return () => {
      if (unlistenSync) unlistenSync();
      if (unlistenFail) unlistenFail();
      if (unlistenPartial) unlistenPartial();
    };
  }, [fetchSubmissions]);

  const handleTriggerSync = () => {
    setIsSyncModalOpen(true);
  };

  // Tổng hợp dữ liệu phân cấp: Courses -> Assignments -> Problems -> Submissions
  const hierarchy = useMemo(() => {
    return aggregateWecodeHierarchy(submissions, storedAssignments, storedProblems, studentClass);
  }, [submissions, storedAssignments, storedProblems, studentClass]);

  // Hook tự động đồng bộ Dual-Tier & quản lý vòng đời
  const {
    serviceState,
    activeService,
    isOffline,
    requestSync,
    openInteractiveLogin,
  } = useSyncLifecycle({
    assignments: hierarchy.assignments,
    onDataRefresh: fetchSubmissions,
  });

  const [refreshCooldown, setRefreshCooldown] = useState<number>(0);

  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const timer = setTimeout(() => setRefreshCooldown((prev) => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [refreshCooldown]);

  const handleManualRefresh = async () => {
    if (refreshCooldown > 0 || activeService) return;
    setRefreshCooldown(15);
    await requestSync("wecode", { bypassTtl: true, bypassCircuitBreaker: true });
    await fetchSubmissions();
  };

  const formatLastSynced = (epochSec: number) => {
    if (!epochSec || epochSec <= 0) return "Chưa đồng bộ";
    const diffSec = Math.floor(Date.now() / 1000) - epochSec;
    if (diffSec < 60) return "Vừa xong";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
    const date = new Date(epochSec * 1000);
    return date.toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Thống kê đếm trạng thái cho Status Filter Tabs
  const statusCounts = useMemo(() => {
    let urgent = 0;
    let completed = 0;
    let closed = 0;
    for (const a of hierarchy.assignments) {
      const isCompleted = a.totalProblems > 0 && a.solvedProblems >= a.totalProblems;
      // QUY TẮC SỐNG CÒN: Unlimited (1999) TUYỆT ĐỐI KHÔNG tính vào Cần làm gấp
      if (
        !isCompleted &&
        (a.deadlineStatus === "urgent" || a.deadlineStatus === "critical")
      ) {
        urgent++;
      }
      if (isCompleted) {
        completed++;
      }
      if (a.deadlineStatus === "closed") {
        closed++;
      }
    }
    return {
      all: hierarchy.assignments.length,
      urgent,
      completed,
      closed,
    };
  }, [hierarchy.assignments]);

  // Danh sách các lớp học có trong môn học đang chọn
  const availableClasses = useMemo(() => {
    if (!selectedCourse) return [];
    const targetAssignments = hierarchy.assignments.filter(
      (a) => a.courseCode === selectedCourse
    );
    const set = new Set<string>();
    targetAssignments.forEach((a) => a.classes.forEach((c) => set.add(c)));
    return Array.from(set).sort();
  }, [hierarchy.assignments, selectedCourse]);

  // Lọc assignments theo môn học, lớp học & trạng thái hạn chót
  const filteredAssignments = useMemo(() => {
    return hierarchy.assignments.filter((assign) => {
      // 1. Lọc theo Môn
      if (selectedCourse && assign.courseCode !== selectedCourse) {
        return false;
      }
      // 2. Lọc theo Lớp
      if (selectedClass && !assign.classes.includes(selectedClass)) {
        return false;
      }
      // 3. Lọc theo Trạng thái Deadline (Zero-Garbage Hard Rule)
      const isCompleted = assign.totalProblems > 0 && assign.solvedProblems >= assign.totalProblems;
      if (statusFilter === "urgent") {
        return (
          !isCompleted &&
          (assign.deadlineStatus === "urgent" || assign.deadlineStatus === "critical")
        );
      }
      if (statusFilter === "completed") {
        return isCompleted;
      }
      if (statusFilter === "closed") {
        return assign.deadlineStatus === "closed";
      }
      return true;
    });
  }, [hierarchy.assignments, selectedCourse, selectedClass, statusFilter]);

  // Assignment đang được chọn để xem danh sách Problem
  const activeAssignment = useMemo(() => {
    if (selectedAssignmentId === null) return null;
    return hierarchy.assignments.find((a) => a.id === selectedAssignmentId) || null;
  }, [hierarchy.assignments, selectedAssignmentId]);

  // Thống kê tổng quan toàn hệ thống
  const stats = useMemo(() => {
    const total = submissions.length;
    const acList = submissions.filter(
      (s) => s.score === 100 || s.verdict.toUpperCase().includes("CORRECT")
    );
    const totalAc = acList.length;
    const uniqueProblemsAc = new Set(acList.map((s) => s.problem_id)).size;
    const totalXp = uniqueProblemsAc * 15;
    const acRate = total > 0 ? Math.round((totalAc / total) * 100) : 0;

    return {
      total,
      totalAc,
      uniqueProblemsAc,
      totalXp,
      acRate,
    };
  }, [submissions]);

  return (
    <div className="space-y-4 font-mono">
      {/* Top Banner & Main Metrics */}
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-emerald-950/60 border border-emerald-800/50 text-emerald-400">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold text-zinc-100">
                  UIT Wecode Tracker
                </h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-emerald-400 border border-zinc-700">
                  v2.1 • Competitive
                </span>
                {studentClass && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-800/60">
                    Lớp: {studentClass}
                  </span>
                )}
                {/* Live Sync Status Indicator */}
                {isOffline ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700 flex items-center gap-1">
                    <WifiOff className="w-3 h-3" /> Offline
                  </span>
                ) : activeService === "wecode" ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-950/80 text-indigo-300 border border-indigo-800/60 flex items-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin" /> Đang quét Wecode...
                  </span>
                ) : serviceState.wecode.authStatus === "expired" ? (
                  <button
                    onClick={() => openInteractiveLogin("wecode")}
                    className="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-950/80 text-rose-300 border border-rose-800/60 hover:bg-rose-900 flex items-center gap-1 cursor-pointer transition-colors"
                  >
                    <AlertCircle className="w-3 h-3" /> Phiên hết hạn - Đăng nhập lại
                  </button>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-900 text-zinc-400 border border-zinc-800 flex items-center gap-1">
                    <Clock className="w-3 h-3 text-zinc-500" /> Đồng bộ: {formatLastSynced(serviceState.wecode.lastSyncedAt)}
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                Thu thập và định lượng thành tích thực hành lập trình tại wecode.uit.edu.vn
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleManualRefresh()}
              disabled={isLoading || activeService === "wecode" || refreshCooldown > 0}
              className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs flex items-center gap-1.5 transition-colors border border-zinc-700 disabled:opacity-50 cursor-pointer"
              title={refreshCooldown > 0 ? `Vui lòng chờ ${refreshCooldown}s` : "Ép làm mới & quét dữ liệu Wecode"}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${activeService === "wecode" || isLoading ? "animate-spin" : ""}`} />
              <span>{refreshCooldown > 0 ? `Chờ ${refreshCooldown}s` : "Làm mới"}</span>
            </button>

            <button
              onClick={handleTriggerSync}
              className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-2 shadow-sm transition-all cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Đồng bộ Wecode</span>
            </button>
          </div>
        </div>

        {/* Sync Failure Banner */}
        {syncError && (
          <div className="mt-4 p-3 rounded-lg bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Lỗi đồng bộ Wecode:</div>
              <div className="text-rose-400 mt-0.5">{syncError}</div>
            </div>
          </div>
        )}

        {/* Partial Parse Errors Banner */}
        {partialErrors.length > 0 && (
          <div className="mt-4 p-3 rounded-lg bg-amber-950/60 border border-amber-800/60 text-amber-300 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Bỏ qua {partialErrors.length} bài nộp lỗi định dạng thời gian:
              </div>
              <ul className="list-disc list-inside text-amber-400/80 mt-1 space-y-0.5 text-[11px]">
                {partialErrors.slice(0, 3).map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Gamified Metrics Cards */}
        <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          {/* Card 1: Unique Problems AC Hero Metric (Đồng bộ số liệu chuẩn năng lực) */}
          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Bài tập đã giải (AC)</span>
            </div>
            <div className="text-2xl font-bold text-white tracking-tight">
              {stats.uniqueProblemsAc}
            </div>
            <span className="text-[11px] text-zinc-500 block truncate" title={`${stats.totalAc} lượt AC trên ${hierarchy.assignments.length} assignments`}>
              {stats.totalAc} lượt AC • Tỷ lệ AC: {stats.acRate}%
            </span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Award className="w-4 h-4 text-cyan-400" />
              <span>Wecode XP</span>
            </div>
            <div className="text-2xl font-bold text-cyan-400 tracking-tight flex items-center gap-1.5">
              +{stats.totalXp}
              <Sparkles className="w-4 h-4 text-cyan-400" />
            </div>
            <span className="text-[11px] text-zinc-500">
              15 XP / bài AC đầu tiên
            </span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Code2 className="w-4 h-4 text-amber-400" />
              <span>Tổng bài nộp</span>
            </div>
            <div className="text-2xl font-bold text-amber-400 tracking-tight">
              {stats.total}
            </div>
            <span className="text-[11px] text-zinc-500">
              {hierarchy.assignments.length} assignments • Lưu trữ SQLite
            </span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Clock className="w-4 h-4 text-indigo-400" />
              <span>Đồng bộ tự động</span>
            </div>
            <div className="text-2xl font-bold text-indigo-300 tracking-tight">
              {activeService === "wecode"
                ? "Đang quét..."
                : isOffline
                ? "Offline"
                : serviceState.wecode.authStatus === "expired"
                ? "Hết hạn"
                : "Dual-Tier"}
            </div>
            <span className="text-[11px] text-zinc-500 block truncate" title={`Lần cuối: ${formatLastSynced(serviceState.wecode.lastSyncedAt)} • 120s Watchdog`}>
              {serviceState.wecode.lastSyncedAt > 0
                ? `Lần cuối: ${formatLastSynced(serviceState.wecode.lastSyncedAt)}`
                : "1-Click In-App SSO Harvester"}
            </span>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {activeAssignment ? (
        /* VIEW 1: Assignment Problem Drilldown */
        <WecodeProblemList
          assignment={activeAssignment}
          onBack={() => setSelectedAssignmentId(null)}
        />
      ) : (
        /* VIEW 2: Course / Class / Deadline Filter Bar & Assignments Grid */
        <div className="space-y-4">
          {/* COURSE FILTER BAR */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-zinc-800/80">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                <Filter className="w-3.5 h-3.5 text-emerald-400" />
                <span>Lọc theo Môn học (Course):</span>
              </div>
              <span className="text-[11px] text-zinc-500">
                Hiển thị số lượng Assignment của từng môn
              </span>
            </div>

            {/* Course Chips */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => {
                  setSelectedCourse(null);
                  setSelectedClass(null);
                }}
                className={`px-3 py-1.5 rounded-lg border text-xs transition-all cursor-pointer flex items-center gap-1.5 ${
                  selectedCourse === null
                    ? "bg-emerald-950 text-emerald-300 border-emerald-700 font-bold shadow-sm"
                    : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
                }`}
              >
                <span>Tất cả môn</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-zinc-800 text-zinc-300">
                  {hierarchy.assignments.length}
                </span>
              </button>

              {hierarchy.courses.map((course) => {
                const isSelected = selectedCourse === course.courseCode;
                return (
                  <button
                    key={course.courseCode}
                    onClick={() => {
                      setSelectedCourse(isSelected ? null : course.courseCode);
                      setSelectedClass(null);
                    }}
                    className={`px-3 py-1.5 rounded-lg border text-xs transition-all cursor-pointer flex items-center gap-1.5 ${
                      isSelected
                        ? "bg-emerald-950 text-emerald-300 border-emerald-700 font-bold shadow-sm"
                        : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
                    }`}
                  >
                    <span>{course.courseCode}</span>
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                        isSelected
                          ? "bg-emerald-900/80 text-emerald-200"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {course.totalAssignments} bài tập
                    </span>
                  </button>
                );
              })}
            </div>

            {/* SUB-FILTER: Specific Classes if Course Selected */}
            {selectedCourse && availableClasses.length > 0 && (
              <div className="pt-2 border-t border-zinc-800/60 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[11px] text-zinc-500">Lớp thuộc {selectedCourse}:</span>
                <button
                  onClick={() => setSelectedClass(null)}
                  className={`px-2.5 py-1 rounded text-[11px] border transition-colors cursor-pointer ${
                    selectedClass === null
                      ? "bg-zinc-800 border-zinc-600 text-white font-semibold"
                      : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Tất cả lớp
                </button>
                {availableClasses.map((cls) => (
                  <button
                    key={cls}
                    onClick={() => setSelectedClass(selectedClass === cls ? null : cls)}
                    className={`px-2.5 py-1 rounded text-[11px] border transition-colors cursor-pointer ${
                      selectedClass === cls
                        ? "bg-emerald-950 border-emerald-700 text-emerald-300 font-semibold"
                        : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {cls}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* VIEW SWITCHER TABS & CONTENT */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-zinc-800 pb-2 gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveTab("assignments")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
                    activeTab === "assignments"
                      ? "bg-zinc-800 text-emerald-400 border border-zinc-700"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  }`}
                >
                  <FolderCode className="w-3.5 h-3.5" />
                  <span>Danh mục Bài tập ({filteredAssignments.length})</span>
                </button>

                <button
                  onClick={() => setActiveTab("raw_submissions")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors cursor-pointer ${
                    activeTab === "raw_submissions"
                      ? "bg-zinc-800 text-emerald-400 border border-zinc-700"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  }`}
                >
                  <ListFilter className="w-3.5 h-3.5" />
                  <span>Lịch sử nộp bài (Log: {submissions.length})</span>
                </button>
              </div>

              {/* Status Filter Tabs (Chỉ hiển thị khi ở tab Danh mục Bài tập) */}
              {activeTab === "assignments" && (
                <div className="flex items-center gap-1.5 bg-zinc-900 p-1 rounded-lg border border-zinc-800 self-start sm:self-auto">
                  <button
                    onClick={() => setStatusFilter("all")}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      statusFilter === "all"
                        ? "bg-zinc-800 text-zinc-100 font-semibold"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Tất cả ({statusCounts.all})
                  </button>
                  <button
                    onClick={() => setStatusFilter("urgent")}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                      statusFilter === "urgent"
                        ? "bg-amber-950/90 text-amber-300 font-semibold border border-amber-800/60"
                        : "text-zinc-400 hover:text-amber-300"
                    }`}
                    title="Chưa đạt 100% và sắp hết hạn (loại trừ bài vô thời hạn)"
                  >
                    <span>⚡ Gấp ({statusCounts.urgent})</span>
                  </button>
                  <button
                    onClick={() => setStatusFilter("completed")}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                      statusFilter === "completed"
                        ? "bg-emerald-950/90 text-emerald-300 font-semibold border border-emerald-800/60"
                        : "text-zinc-400 hover:text-emerald-300"
                    }`}
                  >
                    <span>✅ Xong ({statusCounts.completed})</span>
                  </button>
                  <button
                    onClick={() => setStatusFilter("closed")}
                    className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      statusFilter === "closed"
                        ? "bg-zinc-800 text-zinc-300 font-semibold border border-zinc-700"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Đã đóng ({statusCounts.closed})
                  </button>
                </div>
              )}
            </div>

            {activeTab === "assignments" ? (
              <WecodeAssignmentList
                assignments={filteredAssignments}
                statusFilter={statusFilter}
                onSelectAssignment={(id) => setSelectedAssignmentId(id)}
              />
            ) : (
              <WecodeSubmissionsList
                submissions={submissions}
                isLoading={isLoading}
              />
            )}
          </div>
        </div>
      )}

      {/* Sync Modal */}
      <SyncWecodeModal
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        onSyncSuccess={() => void fetchSubmissions()}
      />
    </div>
  );
};

export default WecodeDashboard;
