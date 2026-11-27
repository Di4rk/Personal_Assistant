import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  UploadCloud,
} from "lucide-react";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  exportUitScheduleIcs,
  getCalendarEvents,
  getExamSchedules,
  getGoogleOAuthStatus,
  getPortalClassActivities,
  getPortalTimetable,
  listGoogleCalendars,
  pushUitScheduleToGoogle,
  syncGoogleCalendars,
  toggleGoogleCalendar,
} from "../../lib/tauri-client";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import type { AcademicExamRecord } from "../academic/types";
import type {
  CalendarEvent,
  GoogleCalendarConfig,
  GoogleOAuthStatus,
  PortalClassActivity,
  PortalTimetableSlot,
} from "../../types/portal-extra";
import {
  addDays,
  formatTimeHm,
  formatUitPeriodRange,
  formatVietnameseShortDate,
  formatVietnameseWeekRange,
  getEventCoveredDatesVn,
  getMondayOfWeek,
  getVnMinutesOfDay,
  parseExamDateIso,
  parseTimeHmMinutes,
  toLocalDateIso,
  uitPeriodStartMinutes,
} from "../../utils/scheduleTime";
import { MiniMonthCalendar } from "./components/MiniMonthCalendar";
import {
  ScheduleContextMenu,
  type ContextMenuItem,
} from "./components/ScheduleContextMenu";
import {
  getNextRoundedHourRange,
  ScheduleEventModal,
  UitClassPreviewModal,
  type ScheduleEventFormValues,
} from "./components/ScheduleEventModal";

const WEEKDAY_NAMES = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "CN"];

interface AgendaEntry {
  id: string;
  source: "uit" | "gcal" | "exam" | "activity";
  timeLabel: string;
  startMinutes: number;
  allDay: boolean;
  title: string;
  roomOrLocation: string;
  badgeLabel: string;
  showBadge: boolean;
  dotColor: string;
  subtext: string;
  rawDateIso: string;
  rawEvent?: CalendarEvent;
  rawTimetable?: PortalTimetableSlot;
  canEdit?: boolean;
}

type ModalState =
  | {
      mode: "create";
      defaultDateIso: string;
      prefill?: Partial<ScheduleEventFormValues>;
      nonce?: number;
    }
  | {
      mode: "edit";
      calendarId: string;
      uid: string;
      values: ScheduleEventFormValues;
    }
  | null;

type ContextMenuState =
  | {
      x: number;
      y: number;
      kind: "day";
      dateIso: string;
      fromMiniCalendar: boolean;
    }
  | {
      x: number;
      y: number;
      kind: "event";
      entry: AgendaEntry;
    }
  | null;

function parseLocalIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDayMonthShort(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}`;
}

export const ScheduleDashboard: React.FC = () => {
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => getMondayOfWeek(new Date()));
  const [miniMonth, setMiniMonth] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [monthCalendarEvents, setMonthCalendarEvents] = useState<CalendarEvent[]>([]);
  const [timetable, setTimetable] = useState<PortalTimetableSlot[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<GoogleCalendarConfig[]>([]);
  const [oauthStatus, setOauthStatus] = useState<GoogleOAuthStatus | null>(null);
  const [exams, setExams] = useState<AcademicExamRecord[]>([]);
  const [activities, setActivities] = useState<PortalClassActivity[]>([]);

  // Google OAuth push state
  const [isPushingUit, setIsPushingUit] = useState(false);

  // Unified Create / Edit Event Modal + UIT Quick View Modal
  const [modalState, setModalState] = useState<ModalState>(null);
  const [previewUitSlot, setPreviewUitSlot] = useState<PortalTimetableSlot | null>(null);
  const [isSavingEvent, setIsSavingEvent] = useState(false);
  const [isDeletingEvent, setIsDeletingEvent] = useState(false);

  // Toolbar utilities dropdown
  const [isUtilsOpen, setIsUtilsOpen] = useState(false);
  const utilsDropdownRef = useRef<HTMLDivElement | null>(null);

  const [isSyncing, setIsSyncing] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const silentSyncInFlightRef = useRef(false);
  const hasAutoSyncedMountRef = useRef(false);

  // Scroll, collapse & context-menu state
  const dayRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingScrollIsoRef = useRef<string | null>(null);
  const hasAutoScrolledTodayRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flashedDayIso, setFlashedDayIso] = useState<string | null>(null);
  const [expandedPastDays, setExpandedPastDays] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i)),
    [weekAnchor]
  );

  const weekStartIso = useMemo(() => toLocalDateIso(weekDays[0]), [weekDays]);
  const weekEndIso = useMemo(() => toLocalDateIso(weekDays[6]), [weekDays]);
  const todayIso = toLocalDateIso(new Date());

  const loadData = useCallback(async () => {
    const startTs = Math.floor(weekDays[0].getTime() / 1000);
    const endTs = startTs + 86400 * 7 - 1;
    const monthGridStart = getMondayOfWeek(
      new Date(miniMonth.getFullYear(), miniMonth.getMonth(), 1)
    );
    const monthStartTs = Math.floor(monthGridStart.getTime() / 1000);
    const monthEndTs = monthStartTs + 86400 * 42 - 1;

    const [tt, evs, monthEvs, cals, exs, acts, oauth] = await Promise.allSettled([
      getPortalTimetable(weekStartIso, weekEndIso),
      getCalendarEvents(startTs, endTs),
      getCalendarEvents(monthStartTs, monthEndTs),
      listGoogleCalendars(),
      getExamSchedules(),
      getPortalClassActivities(),
      getGoogleOAuthStatus(),
    ]);

    if (tt.status === "fulfilled") setTimetable(tt.value);
    if (evs.status === "fulfilled") setCalendarEvents(evs.value);
    if (monthEvs.status === "fulfilled") setMonthCalendarEvents(monthEvs.value);
    if (cals.status === "fulfilled") setCalendars(cals.value);
    if (exs.status === "fulfilled") setExams(exs.value);
    if (acts.status === "fulfilled") setActivities(acts.value);
    if (oauth.status === "fulfilled") setOauthStatus(oauth.value);
  }, [weekDays, weekStartIso, weekEndIso, miniMonth]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useTauriEvent("portal-extra-synced", () => void loadData());
  useTauriEvent("calendar-events-synced", () => void loadData());
  useTauriEvent("exam-schedule-synced", () => void loadData());

  const runSilentSync = useCallback(async () => {
    if (silentSyncInFlightRef.current) return;
    silentSyncInFlightRef.current = true;
    try {
      await syncGoogleCalendars();
      await loadData();
    } catch {
      // Bỏ qua lỗi mạng tạm thời khi đồng bộ nền
    } finally {
      silentSyncInFlightRef.current = false;
    }
  }, [loadData]);

  useEffect(() => {
    if (!oauthStatus?.connected) return;
    if (!hasAutoSyncedMountRef.current) {
      hasAutoSyncedMountRef.current = true;
      void runSilentSync();
    }
    const timer = window.setInterval(() => {
      void runSilentSync();
    }, 300_000);
    return () => window.clearInterval(timer);
  }, [oauthStatus?.connected, runSilentSync]);

  useEffect(() => {
    const onSettingsUpdated = () => {
      void loadData();
    };
    window.addEventListener("calendar-settings-updated", onSettingsUpdated);
    return () => window.removeEventListener("calendar-settings-updated", onSettingsUpdated);
  }, [loadData]);

  const oauthCalendars = useMemo(
    () => calendars.filter((c) => c.source === "oauth"),
    [calendars]
  );
  const icsCalendars = useMemo(
    () => calendars.filter((c) => c.source !== "oauth"),
    [calendars]
  );
  const writableOAuthCalendars = useMemo(
    () => oauthCalendars.filter((c) => c.can_write),
    [oauthCalendars]
  );

  // Close utilities dropdown on outside click or Escape
  useEffect(() => {
    if (!isUtilsOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (utilsDropdownRef.current && !utilsDropdownRef.current.contains(e.target as Node)) {
        setIsUtilsOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsUtilsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isUtilsOpen]);

  // Keyboard shortcut 'N' to open Create Event Modal when idle
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() !== "n") return;
      if (modalState || previewUitSlot || contextMenu) return;
      if (writableOAuthCalendars.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      setModalState({ mode: "create", defaultDateIso: todayIso });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalState, previewUitSlot, contextMenu, writableOAuthCalendars.length, todayIso]);

  // Initial scroll to Today on mount
  useEffect(() => {
    if (hasAutoScrolledTodayRef.current) return;
    const todayEl = dayRefs.current.get(todayIso);
    if (!todayEl) return;
    hasAutoScrolledTodayRef.current = true;
    requestAnimationFrame(() => {
      todayEl.scrollIntoView({ behavior: "auto", block: "nearest" });
    });
  }, [todayIso, weekStartIso]);

  // Scroll + flash when clicking a date in MiniMonthCalendar
  useEffect(() => {
    const targetIso = pendingScrollIsoRef.current;
    if (!targetIso) return;
    const el = dayRefs.current.get(targetIso);
    if (!el) return;
    pendingScrollIsoRef.current = null;
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setFlashedDayIso(targetIso);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashedDayIso((curr) => (curr === targetIso ? null : curr));
      }, 820);
    });
  }, [weekStartIso]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  const calendarMap = useMemo(() => {
    const map = new Map<string, GoogleCalendarConfig>();
    for (const c of calendars) map.set(c.id, c);
    return map;
  }, [calendars]);

  const examDateSet = useMemo(() => {
    const set = new Set<string>();
    for (const ex of exams) {
      const iso = parseExamDateIso(ex.date_str);
      if (iso) set.add(iso);
    }
    return set;
  }, [exams]);

  const gcalDateColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ev of monthCalendarEvents) {
      const cal = calendarMap.get(ev.calendar_id);
      const color = cal?.color ?? "#6B9BFF";
      for (const iso of getEventCoveredDatesVn(ev.start_ts, ev.end_ts, ev.all_day)) {
        if (!map.has(iso)) {
          map.set(iso, color);
        }
      }
    }
    return map;
  }, [monthCalendarEvents, calendarMap]);

  const handleSelectMiniDate = (date: Date) => {
    const iso = toLocalDateIso(date);
    if (iso < todayIso) {
      setExpandedPastDays((prev) => (prev[iso] ? prev : { ...prev, [iso]: true }));
    }
    pendingScrollIsoRef.current = iso;
    setWeekAnchor(getMondayOfWeek(date));
    setMiniMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    const existingEl = dayRefs.current.get(iso);
    if (existingEl && iso >= weekStartIso && iso <= weekEndIso) {
      pendingScrollIsoRef.current = null;
      existingEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setFlashedDayIso(iso);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashedDayIso((curr) => (curr === iso ? null : curr));
      }, 820);
    }
  };

  const handleJumpToday = () => {
    const now = new Date();
    const iso = toLocalDateIso(now);
    pendingScrollIsoRef.current = iso;
    setWeekAnchor(getMondayOfWeek(now));
    setMiniMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    const existingEl = dayRefs.current.get(iso);
    if (existingEl && iso >= weekStartIso && iso <= weekEndIso) {
      pendingScrollIsoRef.current = null;
      existingEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setFlashedDayIso(iso);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setFlashedDayIso((curr) => (curr === iso ? null : curr));
      }, 820);
    }
  };

  const entriesByDate = useMemo(() => {
    const grouped = new Map<string, AgendaEntry[]>();
    for (const d of weekDays) grouped.set(toLocalDateIso(d), []);

    for (const t of timetable) {
      const list = grouped.get(t.ngay);
      if (!list) continue;
      list.push({
        id: `uit-${t.id}`,
        source: "uit",
        timeLabel: formatUitPeriodRange(t.tiet_bat_dau, t.tiet_ket_thuc),
        startMinutes: uitPeriodStartMinutes(t.tiet_bat_dau),
        allDay: false,
        title: `${t.ten_mon_hoc} (${t.ma_lop})`,
        roomOrLocation: t.phong,
        badgeLabel: "UIT",
        showBadge: true,
        dotColor: "#2F6BFF",
        subtext: `Tiết ${t.tiet_bat_dau}–${t.tiet_ket_thuc} · ${t.hinh_thuc}`,
        rawDateIso: t.ngay,
        rawTimetable: t,
      });
    }

    const userEmailLower = (oauthStatus?.email ?? "").trim().toLowerCase();

    for (const ev of calendarEvents) {
      const cal = calendarMap.get(ev.calendar_id);
      const startMinutes = ev.all_day ? 0 : getVnMinutesOfDay(ev.start_ts);
      const timeLabel = ev.all_day
        ? "Cả ngày"
        : `${formatTimeHm(ev.start_ts)}–${formatTimeHm(ev.end_ts)}`;
      const canEdit = Boolean(cal && cal.source === "oauth" && cal.can_write);
      const calLabel = cal?.name ?? "Google";
      const isPrimaryEmailBadge =
        (userEmailLower !== "" &&
          (calLabel.toLowerCase() === userEmailLower ||
            cal?.google_calendar_id.toLowerCase() === userEmailLower)) ||
        (calLabel.includes("@") && calLabel.toLowerCase() === userEmailLower);

      for (const evDate of getEventCoveredDatesVn(ev.start_ts, ev.end_ts, ev.all_day)) {
        const list = grouped.get(evDate);
        if (!list) continue;
        list.push({
          id: `gcal-${ev.calendar_id}-${ev.uid}-${evDate}`,
          source: "gcal",
          timeLabel,
          startMinutes,
          allDay: ev.all_day,
          title: ev.summary,
          roomOrLocation: ev.location,
          badgeLabel: calLabel,
          showBadge: !isPrimaryEmailBadge,
          dotColor: cal?.color ?? "#6B9BFF",
          subtext: "",
          rawDateIso: evDate,
          rawEvent: ev,
          canEdit,
        });
      }
    }

    for (const ex of exams) {
      const exIso = parseExamDateIso(ex.date_str);
      if (!exIso) continue;
      const list = grouped.get(exIso);
      if (!list) continue;
      list.push({
        id: `exam-${ex.id}`,
        source: "exam",
        timeLabel: `${ex.start_time}–${ex.end_time}`,
        startMinutes: parseTimeHmMinutes(ex.start_time),
        allDay: false,
        title: `${ex.subject_code} — ${ex.subject_name}`,
        roomOrLocation: ex.room,
        badgeLabel: ex.examination === "midterm" ? "Thi GK" : "Thi CK",
        showBadge: true,
        dotColor: "#f87171",
        subtext: `Ca ${ex.shift} · ${ex.section_class_code}`,
        rawDateIso: exIso,
      });
    }

    for (const act of activities) {
      const actIso = parseExamDateIso(act.ngay) ?? act.ngay;
      const list = grouped.get(actIso);
      if (!list) continue;
      list.push({
        id: `act-${act.id}`,
        source: "activity",
        timeLabel:
          act.tiet_bat_dau > 0
            ? formatUitPeriodRange(act.tiet_bat_dau, act.tiet_ket_thuc)
            : "Sinh hoạt",
        startMinutes: act.tiet_bat_dau > 0 ? uitPeriodStartMinutes(act.tiet_bat_dau) : 0,
        allDay: act.tiet_bat_dau <= 0,
        title: act.noi_dung,
        roomOrLocation: act.dia_diem,
        badgeLabel: "Sinh hoạt",
        showBadge: true,
        dotColor: "#94a3b8",
        subtext: act.gv_chu_tri,
        rawDateIso: actIso,
      });
    }

    for (const list of grouped.values()) {
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.startMinutes - b.startMinutes;
      });
    }

    return grouped;
  }, [weekDays, timetable, calendarEvents, calendarMap, exams, activities, oauthStatus?.email]);

  const handleSyncAll = async () => {
    setIsSyncing(true);
    setFeedback(null);
    try {
      const res = await syncGoogleCalendars();
      await loadData();
      if (res.errors.length > 0) {
        setFeedback({ ok: false, text: `Lỗi: ${res.errors.join("; ")}` });
      } else {
        setFeedback({
          ok: true,
          text: `Đã đồng bộ ${res.total_events} sự kiện từ ${res.synced_calendars} lịch.`,
        });
      }
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePushUitToGoogle = async () => {
    setIsUtilsOpen(false);
    setIsPushingUit(true);
    setFeedback(null);
    try {
      const res = await pushUitScheduleToGoogle();
      await loadData();
      if (res.errors.length > 0) {
        setFeedback({
          ok: false,
          text: `Đã đẩy ${res.pushed_classes} buổi học và ${res.pushed_exams} ca thi, nhưng có lỗi: ${res.errors.join("; ")}`,
        });
      } else {
        setFeedback({
          ok: true,
          text: `Đã đẩy ${res.pushed_classes} buổi học và ${res.pushed_exams} ca thi lên lịch "${res.calendar_name}" trên Google Calendar.`,
        });
      }
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setIsPushingUit(false);
    }
  };

  const handleOpenEditModal = (entry: AgendaEntry) => {
    if (!entry.canEdit || !entry.rawEvent) return;
    const ev = entry.rawEvent;
    setModalState({
      mode: "edit",
      calendarId: ev.calendar_id,
      uid: ev.uid,
      values: {
        calendarId: ev.calendar_id,
        title: ev.summary,
        dateIso: entry.rawDateIso,
        allDay: ev.all_day,
        startTime: ev.all_day ? "09:00" : formatTimeHm(ev.start_ts),
        endTime: ev.all_day ? "10:30" : formatTimeHm(ev.end_ts),
        location: ev.location ?? "",
        description: ev.description ?? "",
      },
    });
  };

  const handleSubmitEventModal = async (values: ScheduleEventFormValues) => {
    if (!modalState) return;
    setIsSavingEvent(true);
    setFeedback(null);
    try {
      const created = await createGoogleCalendarEvent({
        calendar_id: values.calendarId,
        summary: values.title,
        date: values.dateIso,
        start_time: values.startTime,
        end_time: values.endTime,
        all_day: values.allDay,
        location: values.location,
        description: values.description,
      });

      if (modalState.mode === "edit") {
        await deleteGoogleCalendarEvent(modalState.calendarId, modalState.uid);
      }

      setModalState(null);
      await loadData();
      setFeedback({
        ok: true,
        text:
          modalState.mode === "edit"
            ? `Đã cập nhật "${created.summary}" trên Google Calendar.`
            : `Đã thêm "${created.summary}" lên Google Calendar.`,
      });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setIsSavingEvent(false);
    }
  };

  const handleDeleteFromModal = async () => {
    if (!modalState || modalState.mode !== "edit") return;
    setIsDeletingEvent(true);
    setFeedback(null);
    try {
      await deleteGoogleCalendarEvent(modalState.calendarId, modalState.uid);
      setModalState(null);
      await loadData();
      setFeedback({ ok: true, text: "Đã xóa sự kiện khỏi Google Calendar." });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setIsDeletingEvent(false);
    }
  };

  const handleMoveEventNextDay = async (entry: AgendaEntry) => {
    if (!entry.canEdit || !entry.rawEvent) return;
    const ev = entry.rawEvent;
    const nextDateIso = toLocalDateIso(addDays(parseLocalIsoDate(entry.rawDateIso), 1));
    setFeedback(null);
    try {
      await createGoogleCalendarEvent({
        calendar_id: ev.calendar_id,
        summary: ev.summary,
        date: nextDateIso,
        start_time: ev.all_day ? "09:00" : formatTimeHm(ev.start_ts),
        end_time: ev.all_day ? "10:30" : formatTimeHm(ev.end_ts),
        all_day: ev.all_day,
        location: ev.location ?? "",
        description: ev.description ?? "",
      });
      await deleteGoogleCalendarEvent(ev.calendar_id, ev.uid);
      await loadData();
      setFeedback({
        ok: true,
        text: `Đã dời "${ev.summary}" sang ngày ${formatDayMonthShort(nextDateIso)}.`,
      });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    }
  };

  const handleDuplicateEvent = (entry: AgendaEntry) => {
    if (!entry.canEdit || !entry.rawEvent) return;
    const ev = entry.rawEvent;
    setModalState({
      mode: "create",
      defaultDateIso: entry.rawDateIso,
      nonce: Date.now(),
      prefill: {
        calendarId: ev.calendar_id,
        title: ev.summary,
        dateIso: entry.rawDateIso,
        allDay: ev.all_day,
        startTime: ev.all_day ? "09:00" : formatTimeHm(ev.start_ts),
        endTime: ev.all_day ? "10:30" : formatTimeHm(ev.end_ts),
        location: ev.location ?? "",
        description: ev.description ?? "",
      },
    });
  };

  const handleQuickDeleteEvent = async (entry: AgendaEntry) => {
    if (!entry.canEdit || !entry.rawEvent) return;
    const ev = entry.rawEvent;
    setFeedback(null);
    try {
      await deleteGoogleCalendarEvent(ev.calendar_id, ev.uid);
      await loadData();
      setFeedback({ ok: true, text: `Đã xóa "${ev.summary}" khỏi Google Calendar.` });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    }
  };

  const handleDayContextMenu = (
    dateIso: string,
    fromMiniCalendar: boolean,
    e: React.MouseEvent<HTMLElement>
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      kind: "day",
      dateIso,
      fromMiniCalendar,
    });
  };

  const handleEventContextMenu = (
    entry: AgendaEntry,
    e: React.MouseEvent<HTMLDivElement>
  ) => {
    if (!entry.canEdit || !entry.rawEvent) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      kind: "event",
      entry,
    });
  };

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    if (contextMenu.kind === "day") {
      const items: ContextMenuItem[] = [];
      if (writableOAuthCalendars.length > 0) {
        items.push({
          id: "add-event-day",
          label: `+ Thêm sự kiện vào ${formatDayMonthShort(contextMenu.dateIso)}`,
          icon: <CalendarPlus className="h-3.5 w-3.5 text-[#6B9BFF]" aria-hidden="true" />,
          onSelect: () => {
            setModalState({
              mode: "create",
              defaultDateIso: contextMenu.dateIso,
              nonce: Date.now(),
            });
          },
        });
      }
      if (contextMenu.fromMiniCalendar) {
        items.push({
          id: "jump-day",
          label: "Nhảy tới ngày này",
          icon: <ArrowRight className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />,
          onSelect: () => {
            handleSelectMiniDate(parseLocalIsoDate(contextMenu.dateIso));
          },
        });
      }
      return items;
    }

    const { entry } = contextMenu;
    return [
      {
        id: "edit-event",
        label: "Chỉnh sửa",
        icon: <Pencil className="h-3.5 w-3.5 text-zinc-300" aria-hidden="true" />,
        onSelect: () => handleOpenEditModal(entry),
      },
      {
        id: "move-next-day",
        label: "Dời sang ngày mai (+1 ngày)",
        icon: <ArrowRight className="h-3.5 w-3.5 text-[#6B9BFF]" aria-hidden="true" />,
        onSelect: () => handleMoveEventNextDay(entry),
      },
      {
        id: "duplicate-event",
        label: "Nhân bản",
        icon: <Copy className="h-3.5 w-3.5 text-zinc-300" aria-hidden="true" />,
        onSelect: () => handleDuplicateEvent(entry),
      },
      {
        id: "delete-event",
        label: "Xóa sự kiện",
        confirmLabel: "Bấm lần nữa để xác nhận xóa",
        danger: true,
        icon: <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />,
        onSelect: () => handleQuickDeleteEvent(entry),
      },
    ];
  }, [contextMenu, writableOAuthCalendars.length]);

  const handleToggleCalendar = async (id: string, current: boolean) => {
    await toggleGoogleCalendar(id, !current);
    await loadData();
  };

  const handleExportIcs = async () => {
    setIsUtilsOpen(false);
    try {
      const icsContent = await exportUitScheduleIcs();
      const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `uit-schedule-${weekStartIso}.ics`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setFeedback({ ok: true, text: "Đã xuất file .ics (nhập vào Google Calendar được ngay)." });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    }
  };

  const createModalInitialValues: ScheduleEventFormValues | null = useMemo(() => {
    if (!modalState || modalState.mode !== "create") return null;
    const defaultRange = getNextRoundedHourRange();
    return {
      calendarId: writableOAuthCalendars[0]?.id ?? "",
      title: "",
      dateIso: modalState.defaultDateIso,
      allDay: false,
      startTime: defaultRange.startTime,
      endTime: defaultRange.endTime,
      location: "",
      description: "",
      ...modalState.prefill,
    };
  }, [modalState, writableOAuthCalendars]);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {/* Compact Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1D263B] bg-[#0F1420] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-[#1D263B] bg-[#080B12] p-0.5">
            <button
              type="button"
              onClick={() => {
                const next = addDays(weekAnchor, -7);
                setWeekAnchor(next);
                setMiniMonth(new Date(next.getFullYear(), next.getMonth(), 1));
              }}
              className="rounded p-1 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
              aria-label="Tuần trước"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleJumpToday}
              className="rounded px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
            >
              Tuần này
            </button>
            <button
              type="button"
              onClick={() => {
                const next = addDays(weekAnchor, 7);
                setWeekAnchor(next);
                setMiniMonth(new Date(next.getFullYear(), next.getMonth(), 1));
              }}
              className="rounded p-1 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-zinc-100 cursor-pointer"
              aria-label="Tuần sau"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <span className="font-mono text-xs text-zinc-300 tabular-nums">
            Tuần {formatVietnameseWeekRange(weekDays[0], weekDays[6])}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {writableOAuthCalendars.length > 0 && (
            <button
              type="button"
              onClick={() => setModalState({ mode: "create", defaultDateIso: todayIso })}
              title="Thêm sự kiện mới (N)"
              className="flex h-8 items-center gap-1.5 rounded-lg bg-[#2F6BFF] px-3 text-xs font-semibold text-white transition-colors duration-150 hover:bg-[#255CE6] active:scale-[0.98] cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Thêm sự kiện</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleSyncAll()}
            disabled={isSyncing}
            title="Đồng bộ lịch Google"
            aria-label="Đồng bộ lịch Google"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#1D263B] bg-[#080B12] text-[#6B9BFF] transition-colors duration-150 hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} aria-hidden="true" />
          </button>

          <div ref={utilsDropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setIsUtilsOpen((v) => !v)}
              aria-expanded={isUtilsOpen}
              aria-haspopup="menu"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[#1D263B] bg-[#080B12] px-3 text-xs font-medium text-zinc-300 transition-colors duration-150 hover:border-[#2F6BFF]/30 hover:bg-[#151C2C] hover:text-white cursor-pointer"
            >
              <span>Tiện ích</span>
              <ChevronDown
                className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-150 ${
                  isUtilsOpen ? "rotate-180" : ""
                }`}
                aria-hidden="true"
              />
            </button>

            {isUtilsOpen && (
              <div
                role="menu"
                className="uit-modal-in absolute right-0 top-10 z-30 w-56 rounded-xl border border-[#1D263B] bg-[#0F1420] py-1.5 shadow-2xl"
              >
                {oauthStatus?.connected && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isPushingUit}
                    onClick={() => void handlePushUitToGoogle()}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-[#151C2C] disabled:opacity-50 cursor-pointer"
                  >
                    <UploadCloud
                      className={`h-3.5 w-3.5 text-[#6B9BFF] ${isPushingUit ? "animate-pulse" : ""}`}
                      aria-hidden="true"
                    />
                    <span>{isPushingUit ? "Đang đẩy TKB..." : "Đẩy TKB UIT lên Google"}</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleExportIcs()}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-[#151C2C] cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                  <span>Xuất .ics UIT</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs ${
            feedback.ok
              ? "border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.12] text-[#8BB2FF]"
              : "border-red-500/30 bg-red-500/10 text-red-300"
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left 8 cols: 7-day Agenda */}
        <div className="lg:col-span-8 rounded-xl border border-[#1D263B] bg-[#0F1420] divide-y divide-[#1D263B]/75">
          {weekDays.map((day, idx) => {
            const iso = toLocalDateIso(day);
            const entries = entriesByDate.get(iso) ?? [];
            const isToday = iso === todayIso;
            const isPastDay = iso < todayIso;
            const isExpandedPast = Boolean(expandedPastDays[iso]);
            const isCollapsedPast = isPastDay && !isExpandedPast;
            const isFlashed = flashedDayIso === iso;

            return (
              <div
                key={iso}
                ref={(el) => {
                  if (el) dayRefs.current.set(iso, el);
                  else dayRefs.current.delete(iso);
                }}
                className={`px-4 py-3 transition-opacity duration-150 ${
                  isCollapsedPast
                    ? "opacity-60 hover:opacity-90"
                    : isPastDay
                    ? "opacity-80"
                    : ""
                }`}
              >
                <div
                  role={isPastDay ? "button" : undefined}
                  tabIndex={isPastDay ? 0 : undefined}
                  aria-expanded={isPastDay ? isExpandedPast : undefined}
                  onClick={
                    isPastDay
                      ? () =>
                          setExpandedPastDays((prev) => ({
                            ...prev,
                            [iso]: !prev[iso],
                          }))
                      : undefined
                  }
                  onKeyDown={
                    isPastDay
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setExpandedPastDays((prev) => ({
                              ...prev,
                              [iso]: !prev[iso],
                            }));
                          }
                        }
                      : undefined
                  }
                  onContextMenu={(e) => handleDayContextMenu(iso, false, e)}
                  className={`group/dayhead flex items-center justify-between rounded-md px-1.5 py-1 -mx-1.5 transition-colors duration-150 ${
                    isPastDay ? "cursor-pointer hover:bg-[#151C2C]/70" : ""
                  } ${isFlashed ? "uit-day-flash" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-semibold ${
                        isToday ? "text-[#6B9BFF]" : "text-zinc-200"
                      }`}
                    >
                      {WEEKDAY_NAMES[idx]}
                    </span>
                    <span className="font-mono text-xs text-zinc-500 tabular-nums">
                      {formatVietnameseShortDate(day)}
                    </span>
                    {isToday && (
                      <span className="rounded-full bg-[#2F6BFF] px-2 py-0.5 text-[10px] font-semibold text-white">
                        Hôm nay
                      </span>
                    )}
                    {isCollapsedPast && (
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-400">
                        <span>— {entries.length > 0 ? `${entries.length} mục` : "Trống"}</span>
                        <ChevronRight className="h-3 w-3 text-zinc-500" aria-hidden="true" />
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {writableOAuthCalendars.length > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setModalState({
                            mode: "create",
                            defaultDateIso: iso,
                            nonce: Date.now(),
                          });
                        }}
                        title={`Thêm sự kiện vào ${formatDayMonthShort(iso)}`}
                        aria-label={`Thêm sự kiện vào ${formatDayMonthShort(iso)}`}
                        className="flex h-5 w-5 items-center justify-center rounded border border-[#1D263B] bg-[#080B12] text-zinc-400 opacity-0 transition-opacity duration-150 group-hover/dayhead:opacity-100 focus-visible:opacity-100 hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] hover:text-[#6B9BFF] cursor-pointer"
                      >
                        <Plus className="h-3 w-3" aria-hidden="true" />
                      </button>
                    )}
                    {!isCollapsedPast && (
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-600 tabular-nums">
                        <span>{entries.length > 0 ? `${entries.length} mục` : "Trống"}</span>
                        {isPastDay && (
                          <ChevronDown className="h-3 w-3 text-zinc-500" aria-hidden="true" />
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {!isCollapsedPast && entries.length > 0 && (
                  <div className="mt-2 divide-y divide-[#1D263B]/60 border-t border-[#1D263B]/75">
                    {entries.map((item) => {
                      const isUitClass = item.source === "uit" && Boolean(item.rawTimetable);
                      const isEditableGcal = Boolean(item.canEdit && item.rawEvent);
                      const isClickable = isUitClass || isEditableGcal;

                      const handleRowClick = () => {
                        if (isUitClass && item.rawTimetable) {
                          setPreviewUitSlot(item.rawTimetable);
                          return;
                        }
                        if (isEditableGcal) {
                          handleOpenEditModal(item);
                        }
                      };

                      return (
                        <div
                          key={item.id}
                          role={isClickable ? "button" : undefined}
                          tabIndex={isClickable ? 0 : undefined}
                          onClick={isClickable ? handleRowClick : undefined}
                          onContextMenu={
                            isEditableGcal
                              ? (e) => handleEventContextMenu(item, e)
                              : undefined
                          }
                          onKeyDown={
                            isClickable
                              ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleRowClick();
                                  }
                                }
                              : undefined
                          }
                          className={`group flex items-center justify-between gap-3 rounded-md py-2 px-2 -mx-2 transition-colors duration-150 hover:bg-[#151C2C] ${
                            item.source === "uit"
                              ? "border-l-2 border-[#2F6BFF] pl-2.5"
                              : ""
                          } ${isClickable ? "cursor-pointer" : ""}`}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-zinc-400">
                              {item.timeLabel}
                            </span>
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: item.dotColor }}
                              aria-hidden="true"
                            />
                            <div className="min-w-0">
                              <div className="truncate text-xs font-medium text-zinc-100">
                                {item.title}
                              </div>
                              {item.subtext && (
                                <div className="truncate text-[11px] text-zinc-500">
                                  {item.subtext}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            {item.showBadge && (
                              <span
                                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                                  item.source === "uit"
                                    ? "border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.12] text-[#6B9BFF]"
                                    : item.source === "exam"
                                    ? "border-red-500/30 bg-red-500/15 text-red-300"
                                    : "border-[#1D263B] bg-[#080B12] text-zinc-400"
                                }`}
                              >
                                {item.badgeLabel}
                              </span>
                            )}
                            {item.roomOrLocation && (
                              <span
                                className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                                  item.source === "uit"
                                    ? "bg-[#2F6BFF]/[0.16] text-[#6B9BFF]"
                                    : item.source === "exam"
                                    ? "border border-red-500/30 bg-red-500/15 text-red-300"
                                    : "border border-[#1D263B] bg-[#080B12] text-zinc-300"
                                }`}
                              >
                                {item.roomOrLocation}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Right 4 cols: Sticky Mini Calendar + Google Account OAuth + Advanced ICS */}
        <aside className="lg:col-span-4 space-y-4 lg:sticky lg:top-4 lg:self-start">
          <MiniMonthCalendar
            selectedWeekStart={weekAnchor}
            viewMonth={miniMonth}
            onChangeMonth={setMiniMonth}
            onSelectDate={handleSelectMiniDate}
            onJumpToday={handleJumpToday}
            onDateContextMenu={(date, e) =>
              handleDayContextMenu(toLocalDateIso(date), true, e)
            }
            examDateSet={examDateSet}
            gcalDateColorMap={gcalDateColorMap}
          />

          {/* Compact Calendar Visibility Card (OAuth & ICS setup moved to Settings -> Kết nối & Đồng bộ) */}
          <div className="rounded-xl border border-[#1D263B] bg-[#0F1420] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-xs font-semibold text-zinc-100">Lịch hiển thị</h2>
                {oauthStatus?.connected && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                    title={oauthStatus.email ? `Đã kết nối: ${oauthStatus.email}` : "Đã kết nối Google Calendar"}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "services" } }))
                }
                title="Cài đặt kết nối & đồng bộ lịch"
                aria-label="Cài đặt kết nối & đồng bộ lịch"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-[#1D263B] bg-[#080B12] text-zinc-400 transition-colors hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] hover:text-[#6B9BFF] cursor-pointer"
              >
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            {calendars.length === 0 ? (
              <div className="space-y-2 pt-0.5">
                <p className="text-[11px] leading-relaxed text-zinc-400">
                  Chưa có lịch cá nhân nào được kết nối.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "services" } }))
                  }
                  className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-[#1D263B] bg-[#151C2C] px-3 text-xs font-medium text-zinc-200 transition-colors hover:border-[#2F6BFF]/50 hover:text-white cursor-pointer"
                >
                  <Settings className="h-3.5 w-3.5 text-[#6B9BFF]" aria-hidden="true" />
                  <span>Kết nối lịch trong Cài đặt</span>
                </button>
              </div>
            ) : (
              <div className="divide-y divide-[#1D263B]/70 border-t border-[#1D263B]/80">
                {[...oauthCalendars, ...icsCalendars].map((cal) => (
                  <label
                    key={cal.id}
                    className="flex items-center justify-between gap-2 py-2 cursor-pointer"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={cal.is_enabled}
                        onChange={() => void handleToggleCalendar(cal.id, cal.is_enabled)}
                        className="h-3.5 w-3.5 rounded border-[#1D263B] bg-[#080B12] accent-[#2F6BFF]"
                      />
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: cal.color }}
                      />
                      <span className="truncate text-xs font-medium text-zinc-200">
                        {cal.name}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                      {cal.source === "oauth"
                        ? cal.can_write
                          ? "2 chiều"
                          : "Chỉ đọc"
                        : ".ics"}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Unified Create / Edit Event Modal */}
      {modalState && writableOAuthCalendars.length > 0 && (
        <ScheduleEventModal
          key={
            modalState.mode === "create"
              ? `create-${modalState.defaultDateIso}-${modalState.nonce ?? 0}`
              : `edit-${modalState.calendarId}-${modalState.uid}`
          }
          mode={modalState.mode}
          writableCalendars={writableOAuthCalendars}
          initialValues={
            modalState.mode === "create"
              ? createModalInitialValues!
              : modalState.values
          }
          isSaving={isSavingEvent}
          isDeleting={isDeletingEvent}
          onClose={() => {
            if (!isSavingEvent && !isDeletingEvent) setModalState(null);
          }}
          onSubmit={handleSubmitEventModal}
          onDelete={modalState.mode === "edit" ? handleDeleteFromModal : undefined}
        />
      )}

      {/* Read-only UIT Timetable Quick Preview Modal */}
      {previewUitSlot && (
        <UitClassPreviewModal
          slot={previewUitSlot}
          onClose={() => setPreviewUitSlot(null)}
        />
      )}

      {/* Custom Context Menu */}
      {contextMenu && contextMenuItems.length > 0 && (
        <ScheduleContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          header={
            contextMenu.kind === "day"
              ? `Ngày ${formatDayMonthShort(contextMenu.dateIso)}`
              : contextMenu.entry.title
          }
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
