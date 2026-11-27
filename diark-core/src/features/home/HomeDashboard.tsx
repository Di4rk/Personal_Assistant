import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  RefreshCw,
  ChevronRight,
} from "lucide-react";
import uitLogoMono from "../../assets/uit-logo-mono.png";
import { getTimeBucket, pickRandomGreeting } from "./greetings";
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
  getStudentProfile,
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

function formatHmClock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const hh = Math.floor(clamped / 60)
    .toString()
    .padStart(2, "0");
  const mm = (clamped % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatRemainingVietnamese(minutesLeft: number): string {
  const mins = Math.max(1, Math.round(minutesLeft));
  if (mins < 60) return `Còn ${mins}p`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `Còn ${h}g ${m}p` : `Còn ${h}g`;
}

interface HomeDashboardProps {
  onNavigateTab: (
    tab: string,
    subTab?: "transcript" | "overview" | "finance" | "classes"
  ) => void;
  onSyncPortal: () => void;
  isCoursesPluginEnabled?: boolean;
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
      dotColor: "#2F6BFF",
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
      dotColor: cal?.color ?? "#94a3b8",
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

let hasCompletedHomeBootMotion = false;

function useCountUp(target: number, shouldAnimate: boolean, durationMs = 420): number {
  const [displayValue, setDisplayValue] = useState<number>(() =>
    shouldAnimate ? 0 : target
  );

  useEffect(() => {
    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!shouldAnimate || target <= 0 || reducedMotion) {
      setDisplayValue(target);
      return;
    }

    let rafId = 0;
    const start = performance.now();
    const tick = (nowTs: number) => {
      const elapsed = nowTs - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayValue(target * eased);
      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        setDisplayValue(target);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [target, shouldAnimate, durationMs]);

  return shouldAnimate ? displayValue : target;
}

function handleKpiMouseMove(e: React.MouseEvent<HTMLElement>): void {
  const rect = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - rect.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - rect.top}px`);
}

export const HomeDashboard: React.FC<HomeDashboardProps> = ({
  onNavigateTab,
  onSyncPortal,
  isCoursesPluginEnabled = true,
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
  const [studentName, setStudentName] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [dayOverride, setDayOverride] = useState<"auto" | "today" | "tomorrow">("auto");
  const [greetingSeed] = useState<number>(() => Math.random());
  const [animateBoot] = useState<boolean>(() => !hasCompletedHomeBootMotion);
  const [creditShimmerKey, setCreditShimmerKey] = useState<number>(0);
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);
  const rowElementMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const gapDividerRef = useRef<HTMLDivElement | null>(null);
  const todayBtnRef = useRef<HTMLButtonElement | null>(null);
  const tomorrowBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevSyncingRef = useRef<boolean>(isPortalSyncing);
  const [togglePill, setTogglePill] = useState<{ x: number; w: number; ready: boolean }>({
    x: 0,
    w: 0,
    ready: false,
  });

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
      const [tt, evs, cals, exs, tasks, notifs, macros, curr, tuition, profile] = await Promise.allSettled([
        getPortalTimetable(tIso, tmIso),
        getCalendarEvents(startTs, endTs),
        listGoogleCalendars(),
        getExamSchedules(),
        getMoodleTasks(),
        getMoodleNotifications(),
        getAcademicMacroMetricsSsot(),
        getResolvedCurriculum(),
        getPortalTuition(),
        getStudentProfile(),
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
      if (profile.status === "fulfilled" && profile.value?.full_name) {
        setStudentName(profile.value.full_name.trim());
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, [loadAll]);

  useEffect(() => {
    if (calendars.length === 0) return;
    const STORAGE_KEY = "diark_last_gcal_autosync";
    const COOLDOWN_MS = 300_000;
    try {
      const lastTs = Number(window.sessionStorage.getItem(STORAGE_KEY) || "0");
      if (Date.now() - lastTs < COOLDOWN_MS) return;
      window.sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // ignore storage errors
    }
    let cancelled = false;
    void syncGoogleCalendars()
      .then(() => {
        if (!cancelled) void loadAll();
      })
      .catch(() => {
        /* silent background sync */
      });
    return () => {
      cancelled = true;
    };
  }, [calendars.length, loadAll]);

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

  const allDayRows = useMemo(() => activeRows.filter((r) => r.allDay), [activeRows]);
  const timedRows = useMemo(() => activeRows.filter((r) => !r.allDay), [activeRows]);

  const { stripStartMin, stripEndMin, stripTickHours } = useMemo(() => {
    let minHour = 6;
    let maxHour = 22;
    for (const r of timedRows) {
      minHour = Math.min(minHour, Math.floor(r.startMinutes / 60));
      maxHour = Math.max(maxHour, Math.ceil(r.endMinutes / 60));
    }
    const sHour = Math.max(0, minHour);
    const eHour = Math.min(24, Math.max(sHour + 4, maxHour));
    const span = eHour - sHour;
    const step = span <= 8 ? 2 : span <= 16 ? 4 : 6;
    const ticks: number[] = [];
    for (let h = sHour; h <= eHour; h += step) {
      ticks.push(h);
    }
    if (ticks[ticks.length - 1] !== eHour) {
      if (eHour - ticks[ticks.length - 1] < 2 && ticks.length > 1) {
        ticks[ticks.length - 1] = eHour;
      } else {
        ticks.push(eHour);
      }
    }
    return {
      stripStartMin: sHour * 60,
      stripEndMin: eHour * 60,
      stripTickHours: ticks,
    };
  }, [timedRows]);

  const activeTimedRow = useMemo(() => {
    if (effectiveDay !== "today") return null;
    return timedRows.find((r) => r.startMinutes <= nowMinutes && r.endMinutes > nowMinutes) ?? null;
  }, [effectiveDay, timedRows, nowMinutes]);

  const gapInsertIndex = useMemo(() => {
    if (effectiveDay !== "today" || activeTimedRow !== null || timedRows.length === 0) {
      return -1;
    }
    const nextIdx = timedRows.findIndex((r) => r.startMinutes > nowMinutes);
    return nextIdx === -1 ? timedRows.length : nextIdx;
  }, [effectiveDay, activeTimedRow, timedRows, nowMinutes]);

  const scrollToRow = useCallback((rowId: string) => {
    setHighlightedRowId(rowId);
    rowElementMapRef.current.get(rowId)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, []);

  const scrollToCurrentMoment = useCallback(() => {
    if (activeTimedRow) {
      scrollToRow(activeTimedRow.id);
      return;
    }
    gapDividerRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [activeTimedRow, scrollToRow]);

  const latestMacro = useMemo(() => {
    for (let i = macroMetrics.length - 1; i >= 0; i -= 1) {
      if (macroMetrics[i].termGpa > 0) return macroMetrics[i];
    }
    return macroMetrics.length > 0 ? macroMetrics[macroMetrics.length - 1] : null;
  }, [macroMetrics]);

  const totalDebt = useMemo(
    () => tuitionRecords.reduce((sum, r) => sum + (r.remaining > 0 ? r.remaining : 0), 0),
    [tuitionRecords]
  );

  const creditPct = useMemo(() => {
    if (!latestMacro || curriculumCredits <= 0) return 0;
    return Math.min(100, Math.round((latestMacro.cumulativeCredits / curriculumCredits) * 100));
  }, [latestMacro, curriculumCredits]);

  const gpaRankLabel = useMemo(() => {
    const gpa = latestMacro?.cumulativeGpa ?? 0;
    if (gpa >= 9.0) return "Xuất sắc";
    if (gpa >= 8.0) return "Giỏi";
    if (gpa >= 7.0) return "Khá";
    if (gpa >= 5.0) return "Trung bình";
    return "Chưa có";
  }, [latestMacro]);

  const drlRankLabel = useMemo(() => {
    const drl = latestMacro?.drlScore ?? 0;
    if (drl >= 90) return "Xuất sắc";
    if (drl >= 80) return "Tốt";
    if (drl >= 65) return "Khá";
    if (drl > 0) return "Trung bình";
    return "Chưa có";
  }, [latestMacro]);

  const gpaSeries = useMemo(
    () => macroMetrics.filter((m) => m.termGpa > 0).map((m) => m.termGpa),
    [macroMetrics]
  );

  const drlSeries = useMemo(
    () => macroMetrics.filter((m) => m.drlScore > 0).map((m) => m.drlScore),
    [macroMetrics]
  );

  useEffect(() => {
    if (!isLoading && animateBoot) {
      hasCompletedHomeBootMotion = true;
    }
  }, [isLoading, animateBoot]);

  useEffect(() => {
    if (prevSyncingRef.current && !isPortalSyncing) {
      setCreditShimmerKey((k) => k + 1);
    }
    prevSyncingRef.current = isPortalSyncing;
  }, [isPortalSyncing]);

  useLayoutEffect(() => {
    const targetEl = effectiveDay === "today" ? todayBtnRef.current : tomorrowBtnRef.current;
    if (!targetEl) return;
    setTogglePill({
      x: targetEl.offsetLeft,
      w: targetEl.offsetWidth,
      ready: true,
    });
  }, [effectiveDay, todayRows.length, tomorrowRows.length]);

  const animatedGpa = useCountUp(latestMacro?.cumulativeGpa ?? 0, animateBoot && !isLoading, 420);
  const animatedCredits = useCountUp(latestMacro?.cumulativeCredits ?? 0, animateBoot && !isLoading, 420);
  const animatedDrl = useCountUp(latestMacro?.drlScore ?? 0, animateBoot && !isLoading, 420);

  const greetingBucket = getTimeBucket(now.getHours());
  const greetingText = useMemo(() => {
    const representativeHour: Record<typeof greetingBucket, number> = {
      early_morning: 6,
      morning: 9,
      noon: 12,
      afternoon: 15,
      evening: 19,
      late_night: 23,
    };
    return pickRandomGreeting(representativeHour[greetingBucket], studentName, greetingSeed);
  }, [greetingBucket, studentName, greetingSeed]);

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

  const criticalDeadlineCount = useMemo(() => {
    const nowSec = Math.floor(now.getTime() / 1000);
    return pendingDeadlines.filter((t) => formatDueBadge(t.due_date, nowSec).level === "critical")
      .length;
  }, [pendingDeadlines, now]);

  const nowSec = Math.floor(now.getTime() / 1000);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* Ambient UIT Blue Obsidian Hero Banner */}
      <div
        onMouseMove={handleKpiMouseMove}
        className="group relative overflow-hidden rounded-2xl border border-[#1D263B] bg-[#0F1420]/90 px-5 py-4 backdrop-blur-[2px]"
      >
        <span
          aria-hidden="true"
          className="kpi-spotlight-border pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        />
        <span
          aria-hidden="true"
          className="uit-hero-beam pointer-events-none absolute top-0 left-0 h-px w-1/2 bg-gradient-to-r from-transparent via-[#6B9BFF]/80 to-transparent"
        />
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 18% 12%, rgba(47,107,255,0.10) 0%, rgba(15,20,32,0) 52%)",
          }}
          aria-hidden="true"
        />
        <div
          aria-hidden="true"
          className="uit-hero-mist-1 pointer-events-none absolute -right-[4%] -top-16 h-[220%] w-[52%]"
          style={{
            background:
              "radial-gradient(ellipse 68% 62% at 62% 48%, rgba(47,107,255,0.16) 0%, rgba(107,155,255,0.075) 42%, rgba(15,20,32,0) 74%)",
          }}
        />
        <div
          aria-hidden="true"
          className="uit-hero-mist-2 pointer-events-none absolute right-[8%] -bottom-14 h-[200%] w-[44%]"
          style={{
            background:
              "radial-gradient(ellipse 64% 58% at 48% 55%, rgba(107,155,255,0.12) 0%, rgba(47,107,255,0.05) 45%, rgba(15,20,32,0) 72%)",
          }}
        />
        <div
          aria-hidden="true"
          className="uit-hero-logo-glow pointer-events-none absolute -right-8 top-1/2 h-56 w-56 -translate-y-1/2 select-none opacity-45"
          style={{
            background:
              "linear-gradient(145deg, rgba(139,178,255,0.95) 0%, rgba(47,107,255,0.72) 52%, rgba(22,62,158,0.16) 100%)",
            WebkitMaskImage: `url(${uitLogoMono})`,
            maskImage: `url(${uitLogoMono})`,
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
          }}
        />

        <div className="relative z-10 space-y-1 pr-36 sm:pr-44">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[#6B9BFF]">
              Tổng quan học tập
            </span>
            {isPortalSyncing && (
              <span className="text-[11px] text-zinc-400">· Đang đồng bộ...</span>
            )}
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-white">{greetingText}</h2>
          <p className="text-xs text-zinc-400">
            Hôm nay có{" "}
            <span className="font-medium text-[#6B9BFF]">{todayRows.length} lịch</span>
            {" · "}
            <span className={criticalDeadlineCount > 0 ? "font-medium text-red-400" : "text-zinc-300"}>
              {criticalDeadlineCount} deadline gấp
            </span>
            {" · "}
            <span className={upcomingExams.length > 0 ? "font-medium text-[#6B9BFF]" : "text-zinc-300"}>
              {upcomingExams.length} ca thi sắp tới
            </span>
          </p>
        </div>
      </div>

      {/* Minimalist Obsidian + Navy + UIT Blue KPI Row */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {/* Card 1: GPA tích lũy */}
        <div
          onMouseMove={handleKpiMouseMove}
          style={animateBoot ? { animationDelay: "0ms" } : undefined}
          className={`group relative overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420]/90 p-4 backdrop-blur-[2px] transition-colors ${
            animateBoot ? "uit-stagger-in" : ""
          }`}
        >
          <span
            aria-hidden="true"
            className="kpi-spotlight-sheen pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <span
            aria-hidden="true"
            className="kpi-spotlight-border pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <div className="relative z-10">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-300">GPA tích lũy</span>
              <span className="inline-flex items-center rounded-full border border-[#1D263B] bg-[#151C2C] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                {gpaRankLabel}
              </span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold tracking-tight text-white tabular-nums">
                  {latestMacro && latestMacro.cumulativeGpa > 0
                    ? animatedGpa.toFixed(2)
                    : "—"}
                </span>
                <span className="text-xs text-zinc-500">/ 10.0</span>
              </div>
              <MiniSparkline values={gpaSeries} stroke="#2F6BFF" gradientId="gpaSpark" minBound={5} maxBound={10} />
            </div>
          </div>
        </div>

        {/* Card 2: Tiến độ tín chỉ */}
        <div
          onMouseMove={handleKpiMouseMove}
          style={animateBoot ? { animationDelay: "50ms" } : undefined}
          className={`group relative overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420]/90 p-4 backdrop-blur-[2px] transition-colors ${
            animateBoot ? "uit-stagger-in" : ""
          }`}
        >
          <span
            aria-hidden="true"
            className="kpi-spotlight-sheen pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <span
            aria-hidden="true"
            className="kpi-spotlight-border pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <div className="relative z-10">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-300">Tiến độ tín chỉ</span>
              <span className="inline-flex items-center rounded-full border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] px-2 py-0.5 font-mono text-[11px] font-medium text-[#6B9BFF] tabular-nums">
                {creditPct}%
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tracking-tight text-white tabular-nums">
                {latestMacro ? Math.round(animatedCredits) : 0}
              </span>
              <span className="text-xs text-zinc-500 tabular-nums">/ {curriculumCredits} TC</span>
            </div>
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1D263B]">
              <div
                className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-[#2F6BFF] to-[#6B9BFF] transition-colors duration-300"
                style={{ width: `${creditPct}%` }}
              >
                {creditPct > 0 && (
                  <span
                    key={creditShimmerKey}
                    aria-hidden="true"
                    className="uit-shimmer-once pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-transparent via-white/45 to-transparent"
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Card 3: Điểm rèn luyện */}
        <div
          onMouseMove={handleKpiMouseMove}
          style={animateBoot ? { animationDelay: "100ms" } : undefined}
          className={`group relative overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420]/90 p-4 backdrop-blur-[2px] transition-colors ${
            animateBoot ? "uit-stagger-in" : ""
          }`}
        >
          <span
            aria-hidden="true"
            className="kpi-spotlight-sheen pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <span
            aria-hidden="true"
            className="kpi-spotlight-border pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <div className="relative z-10">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-300">Điểm rèn luyện</span>
              <span className="inline-flex items-center rounded-full border border-[#1D263B] bg-[#151C2C] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                {drlRankLabel}
              </span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold tracking-tight text-white tabular-nums">
                  {latestMacro && latestMacro.drlScore > 0 ? Math.round(animatedDrl) : "—"}
                </span>
                <span className="text-xs text-zinc-500">học kỳ gần nhất</span>
              </div>
              <MiniSparkline values={drlSeries} stroke="#6B9BFF" gradientId="drlSpark" minBound={50} maxBound={100} />
            </div>
          </div>
        </div>

        {/* Card 4: Học phí (Red only when debt > 0, Skeleton shimmer while syncing) */}
        <button
          type="button"
          onClick={() => onNavigateTab("academic", "finance")}
          onMouseMove={handleKpiMouseMove}
          style={animateBoot ? { animationDelay: "150ms" } : undefined}
          className={`group relative overflow-hidden rounded-xl border p-4 text-left backdrop-blur-[2px] transition-colors cursor-pointer ${
            animateBoot ? "uit-stagger-in" : ""
          } ${
            totalDebt > 0
              ? "border-red-500/30 bg-red-500/[0.05] hover:border-red-400/45"
              : "border-[#1D263B] bg-[#0F1420]/90"
          }`}
        >
          <span
            aria-hidden="true"
            className="kpi-spotlight-sheen pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <span
            aria-hidden="true"
            className="kpi-spotlight-border pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          />
          <div className="relative z-10">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-300">Học phí</span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  isPortalSyncing
                    ? "border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-[#6B9BFF]"
                    : totalDebt > 0
                    ? "border-red-500/30 bg-red-500/15 text-red-300"
                    : "border-[#1D263B] bg-[#151C2C] text-zinc-300"
                }`}
              >
                {isPortalSyncing && (
                  <RefreshCw className="h-3 w-3 animate-spin text-[#6B9BFF]" aria-hidden="true" />
                )}
                <span>
                  {isPortalSyncing
                    ? "Đang đồng bộ"
                    : totalDebt > 0
                    ? "Còn nợ"
                    : tuitionRecords.length > 0
                    ? "Đã đóng đủ"
                    : "Chưa đồng bộ"}
                </span>
              </span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-2">
              {isPortalSyncing ? (
                <div className="relative h-7 w-28 overflow-hidden rounded-md bg-[#151C2C]">
                  <span
                    aria-hidden="true"
                    className="uit-shimmer-loop absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-[#2F6BFF]/25 to-transparent"
                  />
                </div>
              ) : (
                <span className="truncate text-2xl font-semibold tracking-tight text-white tabular-nums">
                  {totalDebt > 0
                    ? formatVnd(totalDebt)
                    : tuitionRecords.length > 0
                    ? "0 ₫"
                    : "—"}
                </span>
              )}
              <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-300" />
            </div>
          </div>
        </button>
      </div>

      {/* Main Workspace Split */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left 7 cols: Unified Daily Schedule (UIT TKB + Google Calendar) */}
        <section className="lg:col-span-7 rounded-xl border border-[#1D263B] bg-[#0F1420]/90 backdrop-blur-[2px]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1D263B]/75 px-4 py-3.5">
            <div className="border-l-2 border-[#2F6BFF] pl-2.5">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-white">{activeDateLabel}</h2>
                {dayOverride === "auto" && autoRolledToTomorrow && (
                  <span className="rounded-full border border-[#1D263B] bg-[#151C2C] px-2 py-0.5 text-[10px] text-zinc-300">
                    Hết lịch hôm nay
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">
                Thời khóa biểu UIT &amp; Google Calendar cá nhân
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {effectiveDay === "today" && timedRows.length > 0 && (
                <button
                  type="button"
                  onClick={scrollToCurrentMoment}
                  className="rounded-full border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] px-2.5 py-1 font-mono text-[11px] tabular-nums text-[#6B9BFF] transition-colors hover:bg-[#2F6BFF]/[0.24] cursor-pointer"
                >
                  Hiện tại · {formatHmClock(nowMinutes)}
                </button>
              )}
              <div className="relative flex items-center rounded-full border border-[#1D263B] bg-[#080B12] p-0.5 text-xs">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-full bg-white transition-[transform,width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
                  style={{
                    transform: `translateX(${togglePill.x}px)`,
                    width: `${togglePill.w}px`,
                    opacity: togglePill.ready ? 1 : 0,
                  }}
                />
                <button
                  ref={todayBtnRef}
                  type="button"
                  onClick={() => {
                    setHighlightedRowId(null);
                    setDayOverride("today");
                  }}
                  className={`relative z-10 rounded-full px-3 py-1 transition-colors duration-150 cursor-pointer ${
                    effectiveDay === "today"
                      ? `${!togglePill.ready ? "bg-white " : ""}font-semibold text-[#080B12]`
                      : "font-medium text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Hôm nay ({todayRows.length})
                </button>
                <button
                  ref={tomorrowBtnRef}
                  type="button"
                  onClick={() => {
                    setHighlightedRowId(null);
                    setDayOverride("tomorrow");
                  }}
                  className={`relative z-10 rounded-full px-3 py-1 transition-colors duration-150 cursor-pointer ${
                    effectiveDay === "tomorrow"
                      ? `${!togglePill.ready ? "bg-white " : ""}font-semibold text-[#080B12]`
                      : "font-medium text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Ngày mai ({tomorrowRows.length})
                </button>
              </div>
            </div>
          </div>

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
                  className="rounded-lg bg-[#2F6BFF] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#255CE6] disabled:opacity-50 cursor-pointer"
                >
                  {isPortalSyncing ? "Đang đồng bộ Portal..." : "Đồng bộ Portal UIT"}
                </button>
                <button
                  type="button"
                  onClick={() => onNavigateTab("schedule")}
                  className="rounded-lg border border-[#1D263B] bg-[#151C2C] px-3 py-1.5 text-xs text-zinc-200 hover:border-[#2F6BFF]/30 cursor-pointer"
                >
                  Gắn Google Calendar
                </button>
              </div>
            </div>
          ) : (
            <div>
              {allDayRows.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-b border-[#1D263B]/75 bg-[#080B12]/40 px-4 py-2">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    Cả ngày
                  </span>
                  {allDayRows.map((row) => (
                    <span
                      key={row.id}
                      title={`${row.title}${row.roomOrLocation ? ` · ${row.roomOrLocation}` : ""}`}
                      className={`inline-flex items-center gap-1.5 rounded-md border-l-2 px-2 py-0.5 text-[11px] font-medium ${
                        row.source === "uit"
                          ? "border-[#2F6BFF] bg-[#2F6BFF]/[0.14] text-[#8BB2FF]"
                          : row.source === "exam"
                          ? "border-red-400 bg-red-500/10 text-red-200"
                          : "border-zinc-400 bg-[#151C2C] text-zinc-200"
                      }`}
                    >
                      <span className="max-w-[220px] truncate">{row.title}</span>
                      {row.roomOrLocation && (
                        <span className="font-mono text-[10px] text-zinc-400">{row.roomOrLocation}</span>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {timedRows.length > 0 && (
                <>
                  {/* Horizontal Day Overview Strip */}
                  <div className="border-b border-[#1D263B]/75 bg-[#080B12]/35 px-4 py-3">
                    <div className="relative h-7 rounded-lg border border-[#1D263B] bg-[#080B12]">
                      {stripTickHours.slice(1, -1).map((tickHour) => {
                        const pct = ((tickHour * 60 - stripStartMin) / (stripEndMin - stripStartMin)) * 100;
                        return (
                          <span
                            key={tickHour}
                            className="pointer-events-none absolute inset-y-0 w-px bg-[#1D263B]/60"
                            style={{ left: `${pct}%` }}
                            aria-hidden="true"
                          />
                        );
                      })}

                      {timedRows.map((row) => {
                        const totalSpan = Math.max(1, stripEndMin - stripStartMin);
                        const clampedStart = Math.max(stripStartMin, Math.min(stripEndMin, row.startMinutes));
                        const clampedEnd = Math.max(clampedStart, Math.min(stripEndMin, row.endMinutes));
                        const leftPct = ((clampedStart - stripStartMin) / totalSpan) * 100;
                        const rawWidthPct = ((clampedEnd - clampedStart) / totalSpan) * 100;
                        const widthPct = Math.min(100 - leftPct, Math.max(1.8, rawWidthPct));

                        const isPast = effectiveDay === "today" && row.endMinutes <= nowMinutes;
                        const isCurrent =
                          effectiveDay === "today" &&
                          row.startMinutes <= nowMinutes &&
                          row.endMinutes > nowMinutes;
                        const isHighlighted = highlightedRowId === row.id;

                        const segColor =
                          row.source === "uit"
                            ? isCurrent || isHighlighted
                              ? "bg-[#2F6BFF] ring-1 ring-[#6B9BFF]"
                              : "bg-[#2F6BFF]/55 hover:bg-[#2F6BFF]/85"
                            : row.source === "exam"
                            ? isCurrent || isHighlighted
                              ? "bg-red-400/85 ring-1 ring-red-300"
                              : "bg-red-500/50 hover:bg-red-400/75"
                            : isCurrent || isHighlighted
                            ? "bg-zinc-300/75 ring-1 ring-zinc-200"
                            : "bg-zinc-500/40 hover:bg-zinc-400/65";

                        return (
                          <button
                            key={`strip-${row.id}`}
                            type="button"
                            title={`${row.title} (${row.timeRange})${row.roomOrLocation ? ` · ${row.roomOrLocation}` : ""}`}
                            onMouseEnter={() => setHighlightedRowId(row.id)}
                            onMouseLeave={() => setHighlightedRowId(null)}
                            onClick={() => scrollToRow(row.id)}
                            style={{
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                            }}
                            className={`absolute top-1.5 bottom-1.5 rounded-sm transition-colors duration-150 cursor-pointer ${segColor} ${
                              isPast && !isHighlighted ? "opacity-40" : ""
                            }`}
                          />
                        );
                      })}

                      {effectiveDay === "today" &&
                        nowMinutes >= stripStartMin &&
                        nowMinutes <= stripEndMin && (
                          <div
                            className="pointer-events-none absolute -top-1 -bottom-1 z-10 w-[2px] -translate-x-1/2"
                            style={{
                              left: `${((nowMinutes - stripStartMin) / (stripEndMin - stripStartMin)) * 100}%`,
                            }}
                            aria-hidden="true"
                          >
                            <span className="uit-glow-breathe absolute -inset-x-1.5 inset-y-0 rounded-full bg-[#2F6BFF]/35 blur-[3px]" />
                            <span className="relative block h-full w-full bg-[#2F6BFF] shadow-[0_0_10px_rgba(47,107,255,0.85)]" />
                            <span className="absolute -top-0.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-[#6B9BFF]" />
                          </div>
                        )}
                    </div>

                    <div className="relative mt-1.5 h-3.5 font-mono text-[10px] tabular-nums text-zinc-500">
                      {stripTickHours.map((tickHour, idx) => {
                        const pct = ((tickHour * 60 - stripStartMin) / (stripEndMin - stripStartMin)) * 100;
                        const alignClass =
                          idx === 0
                            ? "translate-x-0"
                            : idx === stripTickHours.length - 1
                            ? "-translate-x-full"
                            : "-translate-x-1/2";
                        return (
                          <span
                            key={tickHour}
                            className={`absolute top-0 ${alignClass}`}
                            style={{ left: `${pct}%` }}
                          >
                            {`${tickHour.toString().padStart(2, "0")}:00`}
                          </span>
                        );
                      })}
                    </div>
                  </div>

                  {/* Compact Vertical Node Timeline */}
                  <div className="px-4 py-3">
                    {timedRows.map((row, idx) => {
                      const isPast = effectiveDay === "today" && row.endMinutes <= nowMinutes;
                      const isCurrent =
                        effectiveDay === "today" &&
                        row.startMinutes <= nowMinutes &&
                        row.endMinutes > nowMinutes;
                      const isHighlighted = highlightedRowId === row.id;
                      const isFirst = idx === 0 && gapInsertIndex !== 0;
                      const isLast = idx === timedRows.length - 1 && gapInsertIndex !== timedRows.length;

                      const startHm = formatHmClock(row.startMinutes);
                      const endHm = formatHmClock(row.endMinutes);

                      const cardTone =
                        row.source === "uit"
                          ? isCurrent
                            ? "border-[#2F6BFF]/45 bg-[#2F6BFF]/[0.11] ring-1 ring-[#2F6BFF]/35"
                            : isHighlighted
                            ? "border-[#2F6BFF]/40 bg-[#151C2C] ring-1 ring-[#2F6BFF]/30"
                            : "border-[#1D263B] bg-[#080B12]/40 hover:border-[#2F6BFF]/30 hover:bg-[#151C2C]"
                          : row.source === "exam"
                          ? isCurrent
                            ? "border-red-500/40 bg-red-500/[0.09] ring-1 ring-red-400/35"
                            : isHighlighted
                            ? "border-red-400/50 bg-red-500/[0.09] ring-1 ring-red-400/30"
                            : "border-[#1D263B] bg-[#080B12]/40 hover:border-red-400/35 hover:bg-[#151C2C]"
                          : isCurrent
                          ? "border-[#2F6BFF]/35 bg-[#151C2C] ring-1 ring-[#2F6BFF]/25"
                          : isHighlighted
                          ? "border-[#2F6BFF]/30 bg-[#151C2C] ring-1 ring-[#2F6BFF]/20"
                          : "border-[#1D263B] bg-[#080B12]/40 hover:border-[#1D263B] hover:bg-[#151C2C]";

                      const roomTone =
                        row.source === "uit"
                          ? "border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-[#6B9BFF]"
                          : row.source === "exam"
                          ? "border border-red-500/25 bg-red-500/15 text-red-200"
                          : "border border-[#1D263B] bg-[#151C2C] text-zinc-300";

                      const sourceTagTone =
                        row.source === "uit"
                          ? "text-[#6B9BFF]"
                          : row.source === "exam"
                          ? "text-red-300/90"
                          : "text-zinc-400";

                      const duration = Math.max(1, row.endMinutes - row.startMinutes);
                      const elapsed = Math.max(0, Math.min(duration, nowMinutes - row.startMinutes));
                      const progressPct = Math.round((elapsed / duration) * 100);
                      const minutesLeft = Math.max(1, row.endMinutes - nowMinutes);

                      return (
                        <React.Fragment key={row.id}>
                          {gapInsertIndex === idx && (
                            <div
                              ref={gapDividerRef}
                              className="flex items-center gap-3 py-2"
                            >
                              <div className="w-12 shrink-0 text-right">
                                <span className="inline-block rounded bg-[#2F6BFF] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-white shadow-[0_0_8px_rgba(47,107,255,0.5)]">
                                  {formatHmClock(nowMinutes)}
                                </span>
                              </div>
                              <div className="relative flex w-4 shrink-0 justify-center">
                                <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                                  <span
                                    aria-hidden="true"
                                    className="uit-radar-ring absolute inset-0 rounded-full bg-[#2F6BFF]"
                                  />
                                  <span className="relative h-2 w-2 rounded-full bg-[#2F6BFF] shadow-[0_0_10px_rgba(47,107,255,0.85)]" />
                                </span>
                              </div>
                              <div className="flex flex-1 items-center gap-2">
                                <div className="h-[1.5px] flex-1 bg-[#2F6BFF]/80" />
                                <span className="text-[10px] font-medium text-[#6B9BFF]">
                                  Hiện tại
                                </span>
                              </div>
                            </div>
                          )}

                          <div
                            ref={(el) => {
                              if (el) {
                                rowElementMapRef.current.set(row.id, el);
                              } else {
                                rowElementMapRef.current.delete(row.id);
                              }
                            }}
                            onMouseEnter={() => setHighlightedRowId(row.id)}
                            onMouseLeave={() => setHighlightedRowId(null)}
                            className={`flex items-stretch gap-3 ${isLast ? "" : "pb-2.5"}`}
                          >
                            {/* Time column */}
                            <div className="w-12 shrink-0 pt-2 text-right font-mono tabular-nums">
                              <div
                                className={`text-[11px] leading-none ${
                                  isCurrent
                                    ? "font-semibold text-[#6B9BFF]"
                                    : isPast
                                    ? "text-zinc-500"
                                    : "text-zinc-200"
                                }`}
                              >
                                {startHm}
                              </div>
                              <div className="mt-1 text-[10px] leading-none text-zinc-500">
                                {endHm}
                              </div>
                            </div>

                            {/* Spine + Node dot */}
                            <div className="relative flex w-4 shrink-0 justify-center">
                              {!(isFirst && isLast) && (
                                <span
                                  className={`absolute w-px bg-[#1D263B] ${
                                    isFirst
                                      ? "top-3.5 bottom-0"
                                      : isLast
                                      ? "top-0 h-3.5"
                                      : "inset-y-0"
                                  }`}
                                  aria-hidden="true"
                                />
                              )}
                              {isCurrent ? (
                                <span
                                  className="relative z-10 mt-2.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center"
                                  aria-hidden="true"
                                >
                                  <span className="uit-radar-ring absolute inset-0 rounded-full bg-[#2F6BFF]" />
                                  <span className="relative h-2.5 w-2.5 rounded-full bg-[#2F6BFF] shadow-[0_0_10px_rgba(47,107,255,0.85)]" />
                                </span>
                              ) : (
                                <span
                                  className={`relative z-10 mt-2.5 shrink-0 rounded-full ${
                                    isPast
                                      ? "h-2 w-2 bg-zinc-600"
                                      : row.source === "uit"
                                      ? "h-2 w-2 border-2 border-[#2F6BFF] bg-[#0F1420]"
                                      : row.source === "exam"
                                      ? "h-2 w-2 border-2 border-red-400 bg-[#0F1420]"
                                      : "h-2 w-2 border-2 border-zinc-400 bg-[#0F1420]"
                                  }`}
                                  aria-hidden="true"
                                />
                              )}
                            </div>

                            {/* Compact content card */}
                            <div
                              className={`min-w-0 flex-1 rounded-lg border px-3 py-2 transition-colors duration-150 ${cardTone} ${
                                isPast && !isHighlighted ? "opacity-50" : ""
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className="truncate text-xs font-medium text-zinc-100">
                                  {row.title}
                                </span>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  {row.roomOrLocation && (
                                    <span
                                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${roomTone}`}
                                    >
                                      {row.roomOrLocation}
                                    </span>
                                  )}
                                  <span className={`text-[10px] font-medium ${sourceTagTone}`}>
                                    {row.sourceLabel}
                                  </span>
                                </div>
                              </div>

                              {row.meta && (
                                <p className="mt-1 truncate text-[11px] text-zinc-400">
                                  {row.meta}
                                </p>
                              )}

                              {isCurrent && (
                                <div className="mt-2 space-y-1">
                                  <div className="h-1 w-full overflow-hidden rounded-full bg-[#1D263B]">
                                    <div
                                      className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-[#2F6BFF] to-[#6B9BFF] transition-colors duration-300"
                                      style={{ width: `${progressPct}%` }}
                                    >
                                      <span
                                        aria-hidden="true"
                                        className="uit-shimmer-loop pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent"
                                      />
                                    </div>
                                  </div>
                                  <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-[#6B9BFF]">
                                    <span>Đang diễn ra · {progressPct}%</span>
                                    <span>{formatRemainingVietnamese(minutesLeft)}</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </React.Fragment>
                      );
                    })}

                    {gapInsertIndex === timedRows.length && (
                      <div
                        ref={gapDividerRef}
                        className="flex items-center gap-3 pt-2"
                      >
                        <div className="w-12 shrink-0 text-right">
                          <span className="inline-block rounded bg-[#2F6BFF] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-white shadow-[0_0_8px_rgba(47,107,255,0.5)]">
                            {formatHmClock(nowMinutes)}
                          </span>
                        </div>
                        <div className="relative flex w-4 shrink-0 justify-center">
                          <span className="relative flex h-2.5 w-2.5 items-center justify-center">
                            <span
                              aria-hidden="true"
                              className="uit-radar-ring absolute inset-0 rounded-full bg-[#2F6BFF]"
                            />
                            <span className="relative h-2 w-2 rounded-full bg-[#2F6BFF] shadow-[0_0_10px_rgba(47,107,255,0.85)]" />
                          </span>
                        </div>
                        <div className="flex flex-1 items-center gap-2">
                          <div className="h-[1.5px] flex-1 bg-[#2F6BFF]/80" />
                          <span className="text-[10px] font-medium text-[#6B9BFF]">
                            Hiện tại
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {/* Right 5 cols: Exams + Moodle Deadlines + Notifications */}
        <aside className="lg:col-span-5 space-y-4">
          {/* Upcoming Exams */}
          <section className="rounded-xl border border-[#1D263B] bg-[#0F1420]/90 backdrop-blur-[2px]">
            <div className="flex items-center justify-between border-b border-[#1D263B]/75 px-4 py-3">
              <h2
                className={`border-l-2 pl-2 text-xs font-semibold text-white ${
                  upcomingExams.some((ex) => Math.ceil((ex.exam_timestamp - nowSec) / 86400) <= 3)
                    ? "border-red-400"
                    : "border-[#2F6BFF]"
                }`}
              >
                Lịch thi sắp tới
              </h2>
              <button
                type="button"
                onClick={() => onNavigateTab("academic", "classes")}
                className="text-[11px] text-zinc-400 hover:text-white cursor-pointer"
              >
                Chi tiết
              </button>
            </div>
            <div className="divide-y divide-[#1D263B]/75">
              {upcomingExams.length === 0 ? (
                <div className="px-4 py-4 text-xs text-zinc-500">
                  Chưa có ca thi sắp tới.
                </div>
              ) : (
                upcomingExams.map((ex) => {
                  const daysLeft = Math.ceil((ex.exam_timestamp - nowSec) / 86400);
                  const studyUrl = ex.subject_code.toUpperCase().startsWith("NT")
                    ? "https://svuit.org/mmtt/"
                    : "https://www.bhtcnpm.com/";
                  return (
                    <div key={ex.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-100">
                          {ex.subject_code} · {ex.subject_name}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                          {ex.date_str} · {ex.start_time}–{ex.end_time} · Phòng {ex.room || "—"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openExternalUrl(studyUrl)}
                          title={`Mở tài liệu ôn thi (${studyUrl})`}
                          className="rounded-md border border-[#1D263B] bg-[#151C2C] px-1.5 py-0.5 text-[10px] font-medium text-zinc-300 transition-colors hover:border-[#2F6BFF]/30 hover:text-[#6B9BFF] cursor-pointer"
                        >
                          Tài liệu
                        </button>
                        <span
                          className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums ${
                            daysLeft <= 3
                              ? "border border-red-500/30 bg-red-500/15 text-red-300"
                              : "border border-[#1D263B] bg-[#151C2C] text-zinc-300"
                          }`}
                        >
                          {daysLeft <= 0 ? "Hôm nay" : `Còn ${daysLeft} ngày`}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Moodle Deadlines */}
          <section className="rounded-xl border border-[#1D263B] bg-[#0F1420]/90 backdrop-blur-[2px]">
            <div className="flex items-center justify-between border-b border-[#1D263B]/75 px-4 py-3">
              <h2
                className={`border-l-2 pl-2 text-xs font-semibold text-white ${
                  criticalDeadlineCount > 0 ? "border-red-400" : "border-[#2F6BFF]"
                }`}
              >
                Deadline Moodle
              </h2>
              <button
                type="button"
                disabled={!isCoursesPluginEnabled}
                onClick={() => {
                  if (isCoursesPluginEnabled) {
                    onNavigateTab("uit-courses");
                  }
                }}
                title={
                  isCoursesPluginEnabled
                    ? "Mở Moodle Courses"
                    : "Plugin Moodle Courses đang tắt trong Cài đặt"
                }
                className={
                  isCoursesPluginEnabled
                    ? "text-[11px] text-zinc-400 hover:text-white cursor-pointer"
                    : "text-[11px] text-zinc-600 opacity-50 cursor-not-allowed select-none"
                }
              >
                Mở Courses
              </button>
            </div>
            <div className="divide-y divide-[#1D263B]/75">
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
                      className="group flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-100 hover:bg-[#151C2C] cursor-pointer"
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          badge.level === "critical"
                            ? "bg-red-400"
                            : badge.level === "soon"
                            ? "bg-[#2F6BFF]"
                            : "bg-zinc-500"
                        }`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-zinc-200">{t.title}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                          {t.course_code || t.course_name || "Môn học"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span
                          className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums ${
                            badge.level === "critical"
                              ? "border border-red-500/30 bg-red-500/15 font-semibold text-red-300"
                              : badge.level === "soon"
                              ? "border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-[#6B9BFF]"
                              : "border border-[#1D263B] bg-[#151C2C] text-zinc-300"
                          }`}
                        >
                          {badge.text}
                        </span>
                        <ExternalLink
                          className="h-3 w-3 text-zinc-600 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#6B9BFF]"
                          aria-hidden="true"
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* Moodle Notifications / Tuition Alert */}
          {(totalDebt > 0 || moodleNotifications.length > 0) && (
            <section className="rounded-xl border border-[#1D263B] bg-[#0F1420]/90 backdrop-blur-[2px]">
              <div className="border-b border-[#1D263B]/75 px-4 py-3">
                <h2
                  className={`border-l-2 pl-2 text-xs font-semibold text-white ${
                    totalDebt > 0 ? "border-red-400" : "border-zinc-500"
                  }`}
                >
                  Cảnh báo &amp; Thông báo
                </h2>
              </div>
              <div className="divide-y divide-[#1D263B]/75">
                {totalDebt > 0 && (
                  <button
                    type="button"
                    onClick={() => onNavigateTab("academic", "finance")}
                    className="flex w-full items-center gap-2.5 border-l-2 border-red-400 bg-red-500/[0.06] px-4 py-2.5 text-left hover:bg-red-500/[0.1] cursor-pointer"
                  >
                    <div className="min-w-0 flex-1 text-xs text-red-200">
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

interface MiniSparklineProps {
  values: number[];
  stroke: string;
  gradientId: string;
  minBound?: number;
  maxBound?: number;
}

const MiniSparkline: React.FC<MiniSparklineProps> = ({
  values,
  stroke,
  gradientId,
  minBound = 0,
  maxBound = 10,
}) => {
  const width = 68;
  const height = 26;
  if (values.length === 0) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <line x1="2" y1="20" x2={width - 2} y2="20" stroke={stroke} strokeOpacity="0.25" strokeWidth="1.5" strokeDasharray="3 3" />
      </svg>
    );
  }

  const normalized = values.length === 1 ? [values[0], values[0]] : values;
  const minV = Math.min(minBound, ...normalized);
  const maxV = Math.max(maxBound, ...normalized);
  const span = Math.max(0.5, maxV - minV);

  const coords = normalized.map((v, idx) => {
    const x = (idx / (normalized.length - 1)) * (width - 8) + 4;
    const y = height - 4 - ((v - minV) / span) * (height - 8);
    return { x, y };
  });

  const linePoints = coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPoints = `4,${height} ${linePoints} ${coords[coords.length - 1].x.toFixed(1)},${height}`;
  const last = coords[coords.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradientId})`} />
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={linePoints}
      />
      <circle cx={last.x} cy={last.y} r="2.5" fill={stroke} />
    </svg>
  );
};
