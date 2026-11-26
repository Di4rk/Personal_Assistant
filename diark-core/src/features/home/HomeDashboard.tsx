import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calendar,
  Clock,
  ExternalLink,
  RefreshCw,
  Bell,
  BookOpen,
  AlertTriangle,
} from "lucide-react";
import {
  getPortalTimetable,
  getCalendarEvents,
  listGoogleCalendars,
  getExamSchedules,
  getMoodleTasks,
  getMoodleNotifications,
  getAcademicMacroMetricsSsot,
  getResolvedCurriculum,
  getPortalTuition,
  syncGoogleCalendars,
  openExternalUrl,
  type MoodleTask,
} from "../../lib/tauri-client";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { useSyncOrchestratorStore } from "../academic/stores/syncOrchestratorStore";
import type {
  AcademicExamRecord,
  AcademicMacroMetricSSOT,
} from "../academic/types";
import type {
  CalendarEvent,
  GoogleCalendarConfig,
  MoodleNotification,
  PortalTimetableSlot,
  PortalTuitionRecord,
} from "../../types/portal-extra";
import {
  addDays,
  formatTimeHm,
  formatUitPeriodRange,
  formatVietnameseDayHeader,
  formatVnd,
  getEventCoveredDatesVn,
  getVnMinutesOfDay,
  parseExamDateIso,
  parseTimeHmMinutes,
  toLocalDateIso,
  uitPeriodEndMinutes,
  uitPeriodStartMinutes,
} from "../../utils/scheduleTime";

interface TimelineRow {
  id: string;
  source: "uit" | "gcal" | "exam";
  title: string;
  timeRange: string;
  startMinutes: number;
  endMinutes: number;
  allDay: boolean;
  roomOrLocation: string;
  sourceLabel: string;
  dotColor: string;
  meta: string;
}

interface HomeDashboardProps {
  onNavigateTab: (tab: string) => void;
  onSyncPortal: () => void;
}

function buildDayTimeline(
  dateIso: string,
  timetable: PortalTimetableSlot[],
  calendarEvents: CalendarEvent[],
  calendarMap: Map<string, GoogleCalendarConfig>,
  exams: AcademicExamRecord[]
): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (const t of timetable) {
    if (t.ngay !== dateIso) continue;
    rows.push({
      id: `uit-${t.id}`,
      source: "uit",
      title: `${t.ten_mon_hoc} (${t.ma_lop})`,
      timeRange: formatUitPeriodRange(t.tiet_bat_dau, t.tiet_ket_thuc),
      startMinutes: uitPeriodStartMinutes(t.tiet_bat_dau),
      endMinutes: uitPeriodEndMinutes(t.tiet_ket_thuc),
      allDay: false,
      roomOrLocation: t.phong || "Chưa rõ phòng",
      sourceLabel: "TKB UIT",
      dotColor: "#10b981",
      meta: `Tiết ${t.tiet_bat_dau}–${t.tiet_ket_thuc}${t.ten_giang_vien ? ` · ${t.lecturer_title ? `${t.lecturer_title} ` : ""}${t.ten_giang_vien}` : ""}${t.trang_thai && t.trang_thai !== "normal" ? ` · ${t.trang_thai}` : ""}`,
    });
  }

  for (const ev of calendarEvents) {
    const coveredDates = getEventCoveredDatesVn(ev.start_ts, ev.end_ts, ev.all_day);
    if (!coveredDates.includes(dateIso)) continue;
    const cal = calendarMap.get(ev.calendar_id);
    const startMin = ev.all_day ? 0 : getVnMinutesOfDay(ev.start_ts);
    const endMin = ev.all_day ? 24 * 60 : getVnMinutesOfDay(ev.end_ts);
    rows.push({
      id: `gcal-${ev.calendar_id}-${ev.uid}-${dateIso}`,
      source: "gcal",
      title: ev.summary,
      timeRange: ev.all_day ? "Cả ngày" : `${formatTimeHm(ev.start_ts)}–${formatTimeHm(ev.end_ts)}`,
      startMinutes: startMin,
      endMinutes: endMin,
      allDay: ev.all_day,
      roomOrLocation: ev.location,
      sourceLabel: cal?.name ?? "Google Calendar",
      dotColor: cal?.color ?? "#38bdf8",
      meta: ev.description ? ev.description.split("\n")[0] : "",
    });
  }

  for (const ex of exams) {
    const exIso = parseExamDateIso(ex.date_str);
    if (exIso !== dateIso) continue;
    rows.push({
      id: `exam-${ex.id}`,
      source: "exam",
      title: `${ex.subject_code} — ${ex.subject_name}`,
      timeRange: `${ex.start_time}–${ex.end_time}`,
      startMinutes: parseTimeHmMinutes(ex.start_time),
      endMinutes: parseTimeHmMinutes(ex.end_time),
      allDay: false,
      roomOrLocation: ex.room || "Chưa có phòng",
      sourceLabel: ex.examination === "midterm" ? "Thi giữa kỳ" : "Thi cuối kỳ",
      dotColor: "#f43f5e",
      meta: `Ca ${ex.shift} · ${ex.section_class_code}${ex.seat_number ? ` · SBD ${ex.seat_number}` : ""}`,
    });
  }

  rows.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.startMinutes - b.startMinutes;
  });

  return rows;
}

type DeadlineUrgency = "critical" | "soon" | "normal";

function formatDueBadge(dueUnix: number, nowUnix: number): { text: string; level: DeadlineUrgency } {
  if (!dueUnix) return { text: "Chưa rõ hạn", level: "normal" };
  const diffSec = dueUnix - nowUnix;
  if (diffSec < 0) {
    const absHours = Math.max(1, Math.floor(Math.abs(diffSec) / 3600));
    return {
      text: absHours < 24 ? `Quá hạn ${absHours} tiếng` : `Quá hạn ${Math.floor(absHours / 24)} ngày`,
      level: "critical",
    };
  }
  const hours = Math.floor(diffSec / 3600);
  if (hours < 12) {
    return { text: `Còn ${Math.max(1, hours)} tiếng`, level: "critical" };
  }
  if (hours < 24) {
    return { text: `Còn ${hours} tiếng`, level: "soon" };
  }
  const days = Math.floor(hours / 24);
  if (days <= 2) {
    return { text: `Còn ${days} ngày`, level: "soon" };
  }
  return { text: `Còn ${days} ngày`, level: "normal" };
}

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  onNavigateTab,
  onSyncPortal,
}) => {
  const isPortalSyncing = useSyncOrchestratorStore((s) => s.serviceState.portal.isSyncing);
  const [now, setNow] = useState<Date>(() => new Date());
  const [timetable, setTimetable] = useState<PortalTimetableSlot[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<GoogleCalendarConfig[]>([]);
  const [exams, setExams] = useState<AcademicExamRecord[]>([]);
  const [moodleTasks, setMoodleTasks] = useState<MoodleTask[]>([]);
  const [moodleNotifications, setMoodleNotifications] = useState<MoodleNotification[]>([]);
  const [macroMetrics, setMacroMetrics] = useState<AcademicMacroMetricSSOT[]>([]);
  const [curriculumCredits, setCurriculumCredits] = useState<number>(126);
  const [tuitionRecords, setTuitionRecords] = useState<PortalTuitionRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSyncingCal, setIsSyncingCal] = useState<boolean>(false);
  const [dayOverride, setDayOverride] = useState<"auto" | "today" | "tomorrow">("auto");

  const todayIso = useMemo(() => toLocalDateIso(now), [now]);
  const tomorrowIso = useMemo(() => toLocalDateIso(addDays(now, 1)), [now]);

  const loadAll = useCallback(async () => {
    const base = new Date();
    const tIso = toLocalDateIso(base);
    const tmIso = toLocalDateIso(addDays(base, 1));
    const startTs = Math.floor(new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime() / 1000);
    const endTs = startTs + 86400 * 2 - 1;

    setIsLoading(true);
    try {
      const [tt, evs, cals, exs, tasks, notifs, macros, curr, tuition] = await Promise.allSettled([
        getPortalTimetable(tIso, tmIso),
        getCalendarEvents(startTs, endTs),
        listGoogleCalendars(),
        getExamSchedules(),
        getMoodleTasks(),
        getMoodleNotifications(),
        getAcademicMacroMetricsSsot(),
        getResolvedCurriculum(),
        getPortalTuition(),
      ]);

      if (tt.status === "fulfilled") setTimetable(tt.value);
      if (evs.status === "fulfilled") setCalendarEvents(evs.value);
      if (cals.status === "fulfilled") setCalendars(cals.value);
      if (exs.status === "fulfilled") setExams(exs.value);
      if (tasks.status === "fulfilled") setMoodleTasks(tasks.value);
      if (notifs.status === "fulfilled") setMoodleNotifications(notifs.value);
      if (macros.status === "fulfilled") setMacroMetrics(macros.value);
      if (curr.status === "fulfilled") setCurriculumCredits(curr.value.total_credits);
      if (tuition.status === "fulfilled") setTuitionRecords(tuition.value);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, [loadAll]);

  useTauriEvent("academic-data-synced", () => void loadAll());
  useTauriEvent("portal-extra-synced", () => void loadAll());
  useTauriEvent("calendar-events-synced", () => void loadAll());
  useTauriEvent("moodle-data-synced", () => void loadAll());
  useTauriEvent("exam-schedule-synced", () => void loadAll());

  const calendarMap = useMemo(() => {
    const map = new Map<string, GoogleCalendarConfig>();
    for (const c of calendars) map.set(c.id, c);
    return map;
  }, [calendars]);

  const todayRows = useMemo(
    () => buildDayTimeline(todayIso, timetable, calendarEvents, calendarMap, exams),
    [todayIso, timetable, calendarEvents, calendarMap, exams]
  );

  const tomorrowRows = useMemo(
    () => buildDayTimeline(tomorrowIso, timetable, calendarEvents, calendarMap, exams),
    [tomorrowIso, timetable, calendarEvents, calendarMap, exams]
  );

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const hasRemainingToday = useMemo(
    () => todayRows.some((r) => r.allDay || r.endMinutes > nowMinutes),
    [todayRows, nowMinutes]
  );

  const autoRolledToTomorrow = !hasRemainingToday;
  const effectiveDay: "today" | "tomorrow" =
    dayOverride === "auto" ? (autoRolledToTomorrow ? "tomorrow" : "today") : dayOverride;

  const activeRows = effectiveDay === "today" ? todayRows : tomorrowRows;
  const activeDateLabel =
    effectiveDay === "today"
      ? `Hôm nay · ${formatVietnameseDayHeader(now)}`
      : `Ngày mai · ${formatVietnameseDayHeader(addDays(now, 1))}`;

  const latestMacro = macroMetrics.length > 0 ? macroMetrics[macroMetrics.length - 1] : null;
  const totalDebt = useMemo(
    () => tuitionRecords.reduce((sum, r) => sum + (r.remaining > 0 ? r.remaining : 0), 0),
    [tuitionRecords]
  );

  const upcomingExams = useMemo(() => {
    const nowSec = Math.floor(now.getTime() / 1000);
    return exams
      .filter((e) => e.exam_timestamp >= nowSec - 3600)
      .sort((a, b) => a.exam_timestamp - b.exam_timestamp)
      .slice(0, 3);
  }, [exams, now]);

  const pendingDeadlines = useMemo(() => {
    const nowSec = Math.floor(now.getTime() / 1000);
    return moodleTasks
      .filter((t) => !t.is_submitted && t.due_date > nowSec - 86400 * 7)
      .sort((a, b) => a.due_date - b.due_date)
      .slice(0, 6);
  }, [moodleTasks, now]);

  const handleSyncCalendars = async () => {
    setIsSyncingCal(true);
    try {
      await syncGoogleCalendars();
      await loadAll();
    } catch (err) {
      console.error("[HomeDashboard] Sync GCal error:", err);
    } finally {
      setIsSyncingCal(false);
    }
  };

  const nowSec = Math.floor(now.getTime() / 1000);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {/* Top Status Strip — gọn, không vẽ KPI card to */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/50 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-4 divide-x divide-zinc-800 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="text-zinc-500">GPA tích lũy</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-zinc-100">
              {latestMacro ? latestMacro.cumulativeGpa.toFixed(2) : "—"}
            </span>
          </div>

          <div className="flex items-baseline gap-2 pl-4">
            <span className="text-zinc-500">Tín chỉ</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-zinc-100">
              {latestMacro ? `${latestMacro.cumulativeCredits}/${curriculumCredits}` : `0/${curriculumCredits}`}
            </span>
          </div>

          <div className="flex items-baseline gap-2 pl-4">
            <span className="text-zinc-500">ĐRL</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-emerald-400">
              {latestMacro ? latestMacro.drlScore : "—"}
            </span>
          </div>

          <button
            type="button"
            onClick={() => onNavigateTab("academic")}
            className="flex items-baseline gap-2 pl-4 text-left hover:text-zinc-100 cursor-pointer"
          >
            <span className="text-zinc-500">Học phí</span>
            {totalDebt > 0 ? (
              <span className="font-mono text-xs font-medium tabular-nums text-amber-400">
                Nợ {formatVnd(totalDebt)}
              </span>
            ) : (
              <span className="font-mono text-xs text-zinc-400">
                {tuitionRecords.length > 0 ? "Đã đóng đủ" : "Chưa đồng bộ"}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSyncPortal}
            disabled={isPortalSyncing}
            className="flex h-7 items-center gap-1.5 rounded-md border border-emerald-800/70 bg-emerald-950/60 px-2.5 text-xs font-medium text-emerald-200 transition-colors duration-150 hover:bg-emerald-900/60 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-3 w-3 ${isPortalSyncing ? "animate-spin" : ""}`} aria-hidden="true" />
            <span>{isPortalSyncing ? "Đang đồng bộ..." : "Đồng bộ Portal"}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleSyncCalendars()}
            disabled={isSyncingCal}
            className="flex h-7 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-300 transition-colors duration-150 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-3 w-3 ${isSyncingCal ? "animate-spin" : ""}`} aria-hidden="true" />
            <span>Đồng bộ lịch</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab("schedule")}
            className="flex h-7 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-medium text-zinc-300 transition-colors duration-150 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 active:scale-[0.98] cursor-pointer"
          >
            <Calendar className="h-3 w-3 text-zinc-400" aria-hidden="true" />
            <span>Lịch tuần</span>
          </button>
        </div>
      </div>

      {/* Main Workspace Split */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left 7 cols: Unified Daily Schedule (UIT TKB + Google Calendar) */}
        <section className="lg:col-span-7 rounded-lg border border-zinc-800/80 bg-zinc-900/40">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-zinc-100">{activeDateLabel}</h2>
                {dayOverride === "auto" && autoRolledToTomorrow && (
                  <span className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[11px] text-zinc-400">
                    Hết lịch hôm nay
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">
                Gộp Thời khóa biểu UIT và Google Calendar cá nhân
              </p>
            </div>

            <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setDayOverride("today")}
                className={`rounded px-2.5 py-1 font-medium transition-colors duration-150 cursor-pointer ${
                  effectiveDay === "today"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Hôm nay ({todayRows.length})
              </button>
              <button
                type="button"
                onClick={() => setDayOverride("tomorrow")}
                className={`rounded px-2.5 py-1 font-medium transition-colors duration-150 cursor-pointer ${
                  effectiveDay === "tomorrow"
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                Ngày mai ({tomorrowRows.length})
              </button>
            </div>
          </div>

          <div className="divide-y divide-zinc-800/70">
            {isLoading && activeRows.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-zinc-500">
                Đang tải lịch trình...
              </div>
            ) : activeRows.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-xs text-zinc-400">
                  Không có tiết học hoặc sự kiện nào trong {effectiveDay === "today" ? "hôm nay" : "ngày mai"}.
                </p>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={onSyncPortal}
                    disabled={isPortalSyncing}
                    className="rounded-md border border-emerald-800/70 bg-emerald-950/60 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-900/60 disabled:opacity-50 cursor-pointer"
                  >
                    {isPortalSyncing ? "Đang đồng bộ Portal..." : "Đồng bộ Portal UIT"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigateTab("schedule")}
                    className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 cursor-pointer"
                  >
                    Gắn Google Calendar
                  </button>
                </div>
              </div>
            ) : (
              activeRows.map((row) => {
                const isPast = effectiveDay === "today" && !row.allDay && row.endMinutes <= nowMinutes;
                return (
                  <div
                    key={row.id}
                    className={`flex items-start gap-3 px-4 py-3 transition-colors duration-100 hover:bg-zinc-900/70 ${
                      isPast ? "opacity-50" : ""
                    }`}
                  >
                    <div className="w-24 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-zinc-400">
                      {row.timeRange}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: row.dotColor }}
                          aria-hidden="true"
                        />
                        <span className="truncate text-xs font-medium text-zinc-100">
                          {row.title}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                            row.source === "uit"
                              ? "border border-emerald-900/60 bg-emerald-950/60 text-emerald-300"
                              : row.source === "exam"
                              ? "border border-rose-900/60 bg-rose-950/60 text-rose-300"
                              : "border border-zinc-800 bg-zinc-950 text-zinc-400"
                          }`}
                        >
                          {row.sourceLabel}
                        </span>
                        {row.roomOrLocation && (
                          <span
                            className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                              row.source === "uit"
                                ? "bg-zinc-800 text-zinc-100"
                                : row.source === "exam"
                                ? "bg-rose-950/80 text-rose-200"
                                : "bg-zinc-900 text-zinc-300 border border-zinc-800"
                            }`}
                          >
                            {row.roomOrLocation}
                          </span>
                        )}
                      </div>
                      {row.meta && (
                        <p className="mt-1 truncate text-[11px] text-zinc-500">{row.meta}</p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right 5 cols: Exams + Moodle Deadlines + Notifications */}
        <aside className="lg:col-span-5 space-y-4">
          {/* Upcoming Exams */}
          <section className="rounded-lg border border-zinc-800/80 bg-zinc-900/40">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-rose-400" aria-hidden="true" />
                <h2 className="text-xs font-semibold text-zinc-100">Lịch thi sắp tới</h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab("academic")}
                className="text-[11px] text-zinc-500 hover:text-zinc-200 cursor-pointer"
              >
                Chi tiết
              </button>
            </div>
            <div className="divide-y divide-zinc-800/70">
              {upcomingExams.length === 0 ? (
                <div className="px-4 py-4 text-xs text-zinc-500">
                  Chưa có ca thi sắp tới.
                </div>
              ) : (
                upcomingExams.map((ex) => {
                  const daysLeft = Math.ceil((ex.exam_timestamp - nowSec) / 86400);
                  return (
                    <div key={ex.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-zinc-100">
                          {ex.subject_code} · {ex.subject_name}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                          {ex.date_str} · {ex.start_time}–{ex.end_time} · Phòng {ex.room || "—"}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums ${
                          daysLeft <= 3
                            ? "bg-rose-950/70 text-rose-300 border border-rose-900/60"
                            : "bg-zinc-800 text-zinc-300"
                        }`}
                      >
                        {daysLeft <= 0 ? "Hôm nay" : `Còn ${daysLeft} ngày`}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Moodle Deadlines */}
          <section className="rounded-lg border border-zinc-800/80 bg-zinc-900/40">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <BookOpen className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                <h2 className="text-xs font-semibold text-zinc-100">Deadline Moodle</h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab("uit-courses")}
                className="text-[11px] text-zinc-500 hover:text-zinc-200 cursor-pointer"
              >
                Mở Courses
              </button>
            </div>
            <div className="divide-y divide-zinc-800/70">
              {pendingDeadlines.length === 0 ? (
                <div className="px-4 py-4 text-xs text-zinc-500">
                  Không có bài tập Moodle tồn đọng.
                </div>
              ) : (
                pendingDeadlines.map((t) => {
                  const badge = formatDueBadge(t.due_date, nowSec);
                  return (
                    <button
                      key={t.task_id}
                      type="button"
                      onClick={() => {
                        if (t.task_url) void openExternalUrl(t.task_url);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-zinc-900/70 cursor-pointer"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-200">{t.title}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                          {t.course_code || t.course_name || "Môn học"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums ${
                            badge.level === "critical"
                              ? "border border-rose-800/70 bg-rose-950/70 font-semibold text-rose-300"
                              : badge.level === "soon"
                              ? "border border-amber-900/60 bg-amber-950/60 text-amber-300"
                              : "bg-zinc-800 text-zinc-400"
                          }`}
                        >
                          {badge.text}
                        </span>
                        <ExternalLink className="h-3 w-3 text-zinc-600" aria-hidden="true" />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* Moodle Notifications / Tuition Alert */}
          {(totalDebt > 0 || moodleNotifications.length > 0) && (
            <section className="rounded-lg border border-zinc-800/80 bg-zinc-900/40">
              <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
                <Bell className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                <h2 className="text-xs font-semibold text-zinc-100">Cảnh báo & Thông báo</h2>
              </div>
              <div className="divide-y divide-zinc-800/70">
                {totalDebt > 0 && (
                  <button
                    type="button"
                    onClick={() => onNavigateTab("academic")}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-zinc-900/70 cursor-pointer"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden="true" />
                    <div className="min-w-0 flex-1 text-xs text-amber-200">
                      Còn học phí chưa đóng:{" "}
                      <span className="font-mono font-semibold tabular-nums">
                        {formatVnd(totalDebt)}
                      </span>
                    </div>
                  </button>
                )}
                {moodleNotifications.slice(0, 3).map((n) => (
                  <div key={n.id} className="px-4 py-2 text-xs text-zinc-400">
                    <div className="truncate font-medium text-zinc-300">
                      {n.shortened_subject || n.subject}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
};
