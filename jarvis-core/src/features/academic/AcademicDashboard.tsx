import React, { useEffect, useMemo, useState } from "react";
import {
  Award,
  BookOpen,
  Calendar,
  CheckCircle2,
  GraduationCap,
  Layers,
  RefreshCw,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useAcademicRadar } from "./hooks/useAcademicRadar";
import { AcademicRadarChart } from "./components/AcademicRadarChart";
import { GpaSimulatorCard } from "./components/GpaSimulatorCard";
import { SyncPortalButton } from "./components/SyncPortalButton";
import { useAppVersion } from "@/shared/hooks/useAppVersion";
import {
  classifyCourseCategory,
  computeCategoryRadarData,
  type CategoryAxisData,
} from "./utils/forecastEngine";
import { getSemesterCourses } from "../../lib/tauri-client";
import type { AcademicCourseRecord } from "./types";

interface AcademicDashboardProps {
  className?: string;
}

export const AcademicDashboard: React.FC<AcademicDashboardProps> = ({
  className = "",
}) => {
  const appVersion = useAppVersion();
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

  // Cache tất cả môn học của toàn bộ học kỳ để vẽ Radar toàn khóa và tính cGPA
  const [allCourses, setAllCourses] = useState<AcademicCourseRecord[]>([]);
  const [isLoadingAllCourses, setIsLoadingAllCourses] = useState<boolean>(false);

  const [radarScope, setRadarScope] = useState<"all" | "semester">("all");

  // Khi overview load xong, tự động chọn học kỳ mới nhất nếu chưa có học kỳ nào được chọn
  useEffect(() => {
    if (overview.length > 0 && !selectedSemesterId) {
      // Ưu tiên chọn học kỳ đầu tiên trong danh sách (thường sắp xếp mới nhất)
      selectSemester(overview[0].id);
    }
  }, [overview, selectedSemesterId, selectSemester]);

  // Nạp toàn bộ môn học để tính toán cGPA tổng thể và phân loại Radar toàn diện
  useEffect(() => {
    if (overview.length === 0) {
      setAllCourses([]);
      return;
    }

    let isMounted = true;
    setIsLoadingAllCourses(true);

    Promise.all(overview.map((sem) => getSemesterCourses(sem.id)))
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
  }, [overview]);

  // Dữ liệu môn học dùng để tính toán Radar (Toàn khóa hoặc Học kỳ đang chọn)
  const radarCourses = useMemo(() => {
    return radarScope === "all" ? allCourses : courses;
  }, [radarScope, allCourses, courses]);

  // Tính 4 trục cho biểu đồ Radar
  const radarData: CategoryAxisData[] = useMemo(() => {
    return computeCategoryRadarData(radarCourses);
  }, [radarCourses]);

  // Tính toán cGPA tổng hợp toàn khóa từ allCourses
  const cumulativeStats = useMemo(() => {
    let currentTotalWeighted10 = 0;
    let currentTotalWeighted4 = 0;
    let currentGpaCredits = 0;
    let currentEarnedCredits = 0;
    let totalEnrolledCredits = 0;
    let failedCourseCount = 0;

    for (const c of allCourses) {
      totalEnrolledCredits += c.credits;
      if (c.isPassed) {
        currentEarnedCredits += c.credits;
      } else {
        failedCourseCount += 1;
      }

      if (c.isGpaCalculated && c.summaryScore10 !== null && c.summaryScore10 !== undefined) {
        currentTotalWeighted10 += c.summaryScore10 * c.credits;
        if (c.summaryScore4 !== null && c.summaryScore4 !== undefined) {
          currentTotalWeighted4 += c.summaryScore4 * c.credits;
        }
        currentGpaCredits += c.credits;
      }
    }

    const cGpa10 = currentGpaCredits > 0 ? currentTotalWeighted10 / currentGpaCredits : 0;
    const cGpa4 = currentGpaCredits > 0 ? currentTotalWeighted4 / currentGpaCredits : 0;

    // Tính DRL trung bình
    let sumDrl = 0;
    let drlCount = 0;
    for (const sem of overview) {
      if (sem.actualDrl > 0) {
        sumDrl += sem.actualDrl;
        drlCount += 1;
      }
    }
    const avgDrl = drlCount > 0 ? Math.round(sumDrl / drlCount) : 0;

    return {
      cGpa10: Number(cGpa10.toFixed(2)),
      cGpa4: Number(cGpa4.toFixed(2)),
      currentGpaCredits,
      currentEarnedCredits,
      totalEnrolledCredits,
      currentTotalWeighted10,
      failedCourseCount,
      avgDrl,
    };
  }, [allCourses, overview]);

  // Tìm học kỳ đang chọn
  const currentSemester = useMemo(() => {
    return overview.find((s) => s.id === selectedSemesterId) ?? null;
  }, [overview, selectedSemesterId]);

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
              <h2 className="text-lg font-bold text-zinc-100 flex items-center gap-2">
                UIT Academic Radar
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                  {appVersion}
                </span>
              </h2>
              <p className="text-xs text-zinc-500">
                Hệ thống theo dõi lộ trình học tập, phân tích năng lực và dự báo tốt nghiệp
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => refetchOverview()}
            disabled={isLoadingOverview}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors border border-zinc-700 focus:outline-none"
            title="Làm mới dữ liệu"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingOverview ? "animate-spin text-violet-400" : ""}`} />
            <span>Làm mới</span>
          </button>
          <SyncPortalButton onSyncSuccess={() => { void refetchOverview(); }} />
        </div>
      </div>

      {/* 2. Cumulative Summary Metric Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>cGPA Hệ 10</span>
            <TrendingUp className="w-4 h-4 text-violet-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-violet-400">
            {cumulativeStats.cGpa10 > 0 ? cumulativeStats.cGpa10.toFixed(2) : "—"}
            <span className="text-xs font-normal text-zinc-500 ml-1">/ 10</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">Điểm trung bình tích lũy</div>
        </div>

        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>cGPA Hệ 4</span>
            <Award className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-indigo-400">
            {cumulativeStats.cGpa4 > 0 ? cumulativeStats.cGpa4.toFixed(2) : "—"}
            <span className="text-xs font-normal text-zinc-500 ml-1">/ 4.0</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">Quy chế ĐHQG-HCM</div>
        </div>

        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>Tín Chỉ Tích Lũy</span>
            <BookOpen className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-400">
            {cumulativeStats.currentEarnedCredits}
            <span className="text-xs font-normal text-zinc-500 ml-1">
              / {cumulativeStats.totalEnrolledCredits} TC
            </span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">
            {cumulativeStats.failedCourseCount > 0 ? (
              <span className="text-rose-400 font-medium">
                {cumulativeStats.failedCourseCount} môn chưa đạt (nợ)
              </span>
            ) : (
              <span className="text-emerald-500/80">Không có nợ môn</span>
            )}
          </div>
        </div>

        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
            <span>ĐRL Trung Bình</span>
            <Award className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-amber-400">
            {cumulativeStats.avgDrl > 0 ? cumulativeStats.avgDrl : "—"}
            <span className="text-xs font-normal text-zinc-500 ml-1">/ 100</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">Điểm rèn luyện qua các kỳ</div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-rose-950/40 border border-rose-800/50 p-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      {/* 3. Main Split View: Left (Transcript) vs Right (Radar & Simulator) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* === LEFT COLUMN: Transcript & Semesters (7 cols on XL) === */}
        <div className="xl:col-span-7 space-y-4">
          {/* Semester Selector Tabs / Pill List */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-violet-400" />
                Danh Sách Học Kỳ
              </h3>
              <span className="text-xs text-zinc-500 font-mono">
                {overview.length} học kỳ
              </span>
            </div>

            {overview.length === 0 ? (
              <div className="text-center py-6 text-xs text-zinc-500">
                Chưa có dữ liệu học kỳ nào. Hãy nhấn &quot;Đồng bộ Portal&quot; để lấy dữ liệu từ cổng thông tin UIT.
              </div>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-zinc-800">
                {overview.map((sem) => {
                  const isSelected = sem.id === selectedSemesterId;
                  return (
                    <button
                      key={sem.id}
                      onClick={() => selectSemester(sem.id)}
                      className={`flex-shrink-0 text-left rounded-lg p-2.5 transition-all border text-xs ${
                        isSelected
                          ? "bg-violet-950/40 border-violet-500/50 text-zinc-100 shadow-md ring-1 ring-violet-500/30"
                          : "bg-zinc-950/60 border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      <div className="font-semibold truncate">
                        HK{sem.semesterTerm} ({sem.academicYear})
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[11px] font-mono">
                        <span className={sem.actualGpa10 && sem.actualGpa10 >= 8.0 ? "text-emerald-400 font-bold" : "text-violet-400"}>
                          GPA: {sem.actualGpa10 ? sem.actualGpa10.toFixed(2) : "—"}
                        </span>
                        <span className="text-zinc-600">|</span>
                        <span className="text-zinc-400">{sem.passedCredits} TC</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Selected Semester Course Table */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-zinc-200">
                  {currentSemester
                    ? `Bảng Điểm Chi Tiết: Học kỳ ${currentSemester.semesterTerm} (${currentSemester.academicYear})`
                    : "Chi Tiết Môn Học"}
                </h3>
                {currentSemester && (
                  <p className="text-xs text-zinc-500 mt-0.5">
                    GPA Hệ 10:{" "}
                    <span className="font-mono text-violet-400 font-bold">
                      {currentSemester.actualGpa10 ? currentSemester.actualGpa10.toFixed(2) : "—"}
                    </span>{" "}
                    • GPA Hệ 4:{" "}
                    <span className="font-mono text-indigo-400 font-bold">
                      {currentSemester.actualGpa4 ? currentSemester.actualGpa4.toFixed(2) : "—"}
                    </span>{" "}
                    • Tín chỉ:{" "}
                    <span className="font-mono text-emerald-400 font-bold">
                      {currentSemester.passedCredits} / {currentSemester.totalCredits} TC
                    </span>
                  </p>
                )}
              </div>
              <span className="text-xs font-mono text-zinc-500">
                {courses.length} môn
              </span>
            </div>

            {isLoadingCourses ? (
              <div className="py-12 flex flex-col items-center justify-center gap-2 text-xs text-zinc-500">
                <RefreshCw className="w-5 h-5 animate-spin text-violet-500" />
                <span>Đang tải bảng điểm môn học...</span>
              </div>
            ) : courses.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-500">
                Học kỳ này chưa có môn học nào hoặc chưa được chọn.
              </div>
            ) : (
              <div className="overflow-x-auto -mx-4 px-4">
                <table className="w-full text-left text-xs text-zinc-300">
                  <thead className="bg-zinc-950/60 text-zinc-400 uppercase tracking-wider text-[10px] font-semibold border-b border-zinc-800">
                    <tr>
                      <th className="py-2.5 px-3">Mã MH</th>
                      <th className="py-2.5 px-3">Tên Môn Học</th>
                      <th className="py-2.5 px-2 text-center">Khối</th>
                      <th className="py-2.5 px-2 text-center">TC</th>
                      <th className="py-2.5 px-2 text-center">GK</th>
                      <th className="py-2.5 px-2 text-center">CK</th>
                      <th className="py-2.5 px-2 text-center">TK 10</th>
                      <th className="py-2.5 px-2 text-center">Hệ 4</th>
                      <th className="py-2.5 px-2 text-center">Chữ</th>
                      <th className="py-2.5 px-3 text-center">Kết Quả</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60 font-sans">
                    {courses.map((course) => {
                      const category = classifyCourseCategory(course.courseCode);
                      return (
                        <tr
                          key={course.id}
                          className="hover:bg-zinc-800/40 transition-colors"
                        >
                          <td className="py-2 px-3 font-mono font-medium text-zinc-200 whitespace-nowrap">
                            {course.courseCode}
                          </td>
                          <td className="py-2 px-3 text-zinc-300 font-medium min-w-[160px]">
                            {course.courseName}
                          </td>
                          <td className="py-2 px-2 text-center whitespace-nowrap">
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                category === "foundational"
                                  ? "bg-blue-950/60 text-blue-400 border border-blue-800/40"
                                  : category === "specialized"
                                  ? "bg-violet-950/60 text-violet-400 border border-violet-800/40"
                                  : category === "auxiliary"
                                  ? "bg-zinc-800 text-zinc-400 border border-zinc-700"
                                  : "bg-emerald-950/60 text-emerald-400 border border-emerald-800/40"
                              }`}
                            >
                              {category === "foundational"
                                ? "CS ngành"
                                : category === "specialized"
                                ? "C.ngành"
                                : category === "auxiliary"
                                ? "Bổ trợ"
                                : "Đ.cương"}
                            </span>
                          </td>
                          <td className="py-2 px-2 text-center font-mono text-zinc-300">
                            {course.credits}
                          </td>
                          <td className="py-2 px-2 text-center font-mono text-zinc-400">
                            {course.midtermScore !== null && course.midtermScore !== undefined
                              ? course.midtermScore.toFixed(1)
                              : "—"}
                          </td>
                          <td className="py-2 px-2 text-center font-mono text-zinc-400">
                            {course.finalScore !== null && course.finalScore !== undefined
                              ? course.finalScore.toFixed(1)
                              : "—"}
                          </td>
                          <td className="py-2 px-2 text-center font-mono font-bold text-zinc-100">
                            {course.summaryScore10 !== null && course.summaryScore10 !== undefined
                              ? course.summaryScore10.toFixed(1)
                              : "—"}
                          </td>
                          <td className="py-2 px-2 text-center font-mono text-violet-400 font-medium">
                            {course.summaryScore4 !== null && course.summaryScore4 !== undefined
                              ? course.summaryScore4.toFixed(1)
                              : "—"}
                          </td>
                          <td className="py-2 px-2 text-center font-mono font-semibold text-zinc-300">
                            {course.gradeChar ?? "—"}
                          </td>
                          <td className="py-2 px-3 text-center whitespace-nowrap">
                            {course.isPassed ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-800/40">
                                <CheckCircle2 className="w-3 h-3" />
                                Đạt
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-400 bg-rose-950/40 px-2 py-0.5 rounded border border-rose-800/40">
                                <XCircle className="w-3 h-3" />
                                Nợ
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
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
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    radarScope === "all"
                      ? "bg-violet-600 text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Toàn khóa
                </button>
                <button
                  onClick={() => setRadarScope("semester")}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
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
          />
        </div>
      </div>
    </div>
  );
};
