import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import {
  addGoogleCalendar,
  connectGoogleCalendarOAuth,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  disconnectGoogleCalendarOAuth,
  exportUitScheduleIcs,
  getCalendarEvents,
  getExamSchedules,
  getGoogleOAuthStatus,
  getPortalClassActivities,
  getPortalTimetable,
  listGoogleCalendars,
  openExternalUrl,
  pushUitScheduleToGoogle,
  removeGoogleCalendar,
  saveGoogleOAuthClientConfig,
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

const CALENDAR_PALETTE = [
  "#10b981",
  "#38bdf8",
  "#f59e0b",
  "#f43f5e",
  "#a1a1aa",
];

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
  dotColor: string;
  subtext: string;
  calendarId?: string;
  eventUid?: string;
  canDelete?: boolean;
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

  // Google OAuth state
  const [isConnectingOAuth, setIsConnectingOAuth] = useState(false);
  const [isPushingUit, setIsPushingUit] = useState(false);
  const [showOAuthSetup, setShowOAuthSetup] = useState(false);
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [isSavingOAuthConfig, setIsSavingOAuthConfig] = useState(false);

  // Create Event Modal / Drawer state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [eventCalendarId, setEventCalendarId] = useState("");
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState(() => toLocalDateIso(new Date()));
  const [eventAllDay, setEventAllDay] = useState(false);
  const [eventStartTime, setEventStartTime] = useState("09:00");
  const [eventEndTime, setEventEndTime] = useState("10:30");
  const [eventLocation, setEventLocation] = useState("");
  const [eventDescription, setEventDescription] = useState("");
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);
  const [deletingEventKey, setDeletingEventKey] = useState<string | null>(null);

  // Advanced ICS fallback state
  const [showIcsAdvanced, setShowIcsAdvanced] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newColor, setNewColor] = useState(CALENDAR_PALETTE[1]);
  const [isAdding, setIsAdding] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i)),
    [weekAnchor]
  );

  const weekStartIso = useMemo(() => toLocalDateIso(weekDays[0]), [weekDays]);
  const weekEndIso = useMemo(() => toLocalDateIso(weekDays[6]), [weekDays]);

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

  useEffect(() => {
    if (writableOAuthCalendars.length > 0 && !writableOAuthCalendars.some((c) => c.id === eventCalendarId)) {
      setEventCalendarId(writableOAuthCalendars[0].id);
    }
  }, [writableOAuthCalendars, eventCalendarId]);

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
      const color = cal?.color ?? "#38bdf8";
      for (const iso of getEventCoveredDatesVn(ev.start_ts, ev.end_ts, ev.all_day)) {
        if (!map.has(iso)) {
          map.set(iso, color);
        }
      }
    }
    return map;
  }, [monthCalendarEvents, calendarMap]);

  const handleSelectMiniDate = (date: Date) => {
    setWeekAnchor(getMondayOfWeek(date));
    setMiniMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  };

  const handleJumpToday = () => {
    const now = new Date();
    setWeekAnchor(getMondayOfWeek(now));
    setMiniMonth(new Date(now.getFullYear(), now.getMonth(), 1));
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
        badgeLabel: "TKB UIT",
        dotColor: "#10b981",
        subtext: `Tiết ${t.tiet_bat_dau}–${t.tiet_ket_thuc} · ${t.hinh_thuc}`,
      });
    }

    for (const ev of calendarEvents) {
      const cal = calendarMap.get(ev.calendar_id);
      const startMinutes = ev.all_day ? 0 : getVnMinutesOfDay(ev.start_ts);
      const timeLabel = ev.all_day
        ? "Cả ngày"
        : `${formatTimeHm(ev.start_ts)}–${formatTimeHm(ev.end_ts)}`;
      const canDelete = Boolean(cal && cal.source === "oauth" && cal.can_write);

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
          badgeLabel: cal?.name ?? "Google",
          dotColor: cal?.color ?? "#38bdf8",
          subtext: "",
          calendarId: ev.calendar_id,
          eventUid: ev.uid,
          canDelete,
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
        dotColor: "#f43f5e",
        subtext: `Ca ${ex.shift} · ${ex.section_class_code}`,
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
        badgeLabel: "Sinh hoạt lớp",
        dotColor: "#f59e0b",
        subtext: act.gv_chu_tri,
      });
    }

    for (const list of grouped.values()) {
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.startMinutes - b.startMinutes;
      });
    }

    return grouped;
  }, [weekDays, timetable, calendarEvents, calendarMap, exams, activities]);

  const handleConnectGoogleOAuth = async () => {
    setIsConnectingOAuth(true);
    setFeedback(null);
    try {
      const res = await connectGoogleCalendarOAuth();
      await loadData();
      if (res.errors.length > 0) {
        setFeedback({
          ok: false,
          text: `Đã kết nối Google nhưng có lỗi tải lịch: ${res.errors.join("; ")}`,
        });
      } else {
        setFeedback({
          ok: true,
          text: `Đã kết nối Google và kéo về ${res.total_events} sự kiện từ ${res.synced_calendars} lịch.`,
        });
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("OAuth Client ID")) {
        setShowOAuthSetup(true);
      }
      setFeedback({ ok: false, text: msg });
    } finally {
      setIsConnectingOAuth(false);
    }
  };

  const handleDisconnectGoogleOAuth = async () => {
    setFeedback(null);
    try {
      await disconnectGoogleCalendarOAuth();
      await loadData();
      setFeedback({ ok: true, text: "Đã ngắt kết nối tài khoản Google Calendar." });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    }
  };

  const handleSaveOAuthConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oauthClientId.trim()) return;
    setIsSavingOAuthConfig(true);
    setFeedback(null);
    try {
      await saveGoogleOAuthClientConfig(oauthClientId.trim(), oauthClientSecret.trim());
      setOauthClientSecret("");
      setShowOAuthSetup(false);
      await loadData();
      setFeedback({
        ok: true,
        text: "Đã lưu cấu hình OAuth Client. Giờ bạn có thể bấm Đăng nhập bằng Google.",
      });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setIsSavingOAuthConfig(false);
    }
  };

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

  const handleCreateEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!eventCalendarId || !eventTitle.trim() || !eventDate) return;
    setIsCreatingEvent(true);
    setFeedback(null);
    try {
      const created = await createGoogleCalendarEvent({
        calendar_id: eventCalendarId,
        summary: eventTitle.trim(),
        date: eventDate,
        start_time: eventStartTime,
        end_time: eventEndTime,
        all_day: eventAllDay,
        location: eventLocation.trim(),
        description: eventDescription.trim(),
      });
      setEventTitle("");
      setEventLocation("");
      setEventDescription("");
      setIsCreateOpen(false);
      await loadData();
      setFeedback({
        ok: true,
        text: `Đã thêm "${created.summary}" lên Google Calendar.`,
      });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setIsCreatingEvent(false);
    }
  };

  const handleDeleteEvent = async (calendarId: string, uid: string) => {
    const key = `${calendarId}:${uid}`;
    setDeletingEventKey(key);
    setFeedback(null);
    try {
      await deleteGoogleCalendarEvent(calendarId, uid);
      await loadData();
      setFeedback({ ok: true, text: "Đã xóa sự kiện khỏi Google Calendar." });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setDeletingEventKey(null);
    }
  };

  const handleAddCalendar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newUrl.trim()) return;
    setIsAdding(true);
    setFeedback(null);
    try {
      await addGoogleCalendar(newName.trim(), newUrl.trim(), newColor);
      setNewName("");
      setNewUrl("");
      const res = await syncGoogleCalendars();
      await loadData();
      setFeedback({
        ok: res.errors.length === 0,
        text:
          res.errors.length > 0
            ? res.errors.join("; ")
            : `Đã thêm và tải ${res.total_events} sự kiện.`,
      });
    } catch (err) {
      setFeedback({ ok: false, text: String(err) });
    } finally {
      setIsAdding(false);
    }
  };

  const handleToggleCalendar = async (id: string, current: boolean) => {
    await toggleGoogleCalendar(id, !current);
    await loadData();
  };

  const handleDeleteCalendar = async (id: string) => {
    await removeGoogleCalendar(id);
    await loadData();
  };

  const handleExportIcs = async () => {
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

  const todayIso = toLocalDateIso(new Date());

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/50 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
            <button
              type="button"
              onClick={() => {
                const next = addDays(weekAnchor, -7);
                setWeekAnchor(next);
                setMiniMonth(new Date(next.getFullYear(), next.getMonth(), 1));
              }}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
              aria-label="Tuần trước"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleJumpToday}
              className="rounded px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
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
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
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
              onClick={() => setIsCreateOpen((prev) => !prev)}
              className="flex h-8 items-center gap-1.5 rounded-md bg-zinc-100 px-3 text-xs font-medium text-zinc-950 transition-colors duration-150 hover:bg-zinc-200 active:scale-[0.98] cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Thêm sự kiện</span>
            </button>
          )}
          {oauthStatus?.connected && (
            <button
              type="button"
              onClick={() => void handlePushUitToGoogle()}
              disabled={isPushingUit}
              className="flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 transition-colors duration-150 hover:border-zinc-600 hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
            >
              <UploadCloud
                className={`h-3.5 w-3.5 text-emerald-400 ${isPushingUit ? "animate-pulse" : ""}`}
                aria-hidden="true"
              />
              <span>{isPushingUit ? "Đang đẩy TKB..." : "Đẩy TKB UIT lên Google"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleExportIcs()}
            className="flex h-8 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 transition-colors duration-150 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 active:scale-[0.98] cursor-pointer"
          >
            <Download className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
            <span>Xuất .ics UIT</span>
          </button>
          <button
            type="button"
            onClick={() => void handleSyncAll()}
            disabled={isSyncing}
            className="flex h-8 items-center gap-1.5 rounded-md border border-emerald-800/70 bg-emerald-950/60 px-3 text-xs font-medium text-emerald-200 transition-colors duration-150 hover:bg-emerald-900/60 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} aria-hidden="true" />
            <span>Đồng bộ</span>
          </button>
        </div>
      </div>

      {/* Inline Quick Create Google Calendar Event Panel */}
      {isCreateOpen && writableOAuthCalendars.length > 0 && (
        <form
          onSubmit={(e) => void handleCreateEvent(e)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-zinc-100">
              Tạo sự kiện mới (tự đồng bộ lên Google Calendar)
            </h2>
            <button
              type="button"
              onClick={() => setIsCreateOpen(false)}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
              aria-label="Đóng biểu mẫu"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-12">
            <input
              type="text"
              value={eventTitle}
              onChange={(e) => setEventTitle(e.target.value)}
              placeholder="Tên sự kiện (vd: Họp nhóm đồ án, Đi khám răng)"
              required
              className="sm:col-span-5 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            <select
              value={eventCalendarId}
              onChange={(e) => setEventCalendarId(e.target.value)}
              className="sm:col-span-4 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            >
              {writableOAuthCalendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              required
              className="sm:col-span-3 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={eventAllDay}
                onChange={(e) => setEventAllDay(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-950 accent-emerald-500"
              />
              <span>Cả ngày</span>
            </label>
            {!eventAllDay && (
              <div className="flex items-center gap-1.5">
                <input
                  type="time"
                  value={eventStartTime}
                  onChange={(e) => setEventStartTime(e.target.value)}
                  className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
                />
                <span className="text-xs text-zinc-500">đến</span>
                <input
                  type="time"
                  value={eventEndTime}
                  onChange={(e) => setEventEndTime(e.target.value)}
                  className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
                />
              </div>
            )}
            <input
              type="text"
              value={eventLocation}
              onChange={(e) => setEventLocation(e.target.value)}
              placeholder="Địa điểm (không bắt buộc)"
              className="min-w-[180px] flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={isCreatingEvent || !eventTitle.trim()}
              className="flex h-7 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{isCreatingEvent ? "Đang lưu..." : "Lưu lên Google"}</span>
            </button>
          </div>
        </form>
      )}

      {feedback && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            feedback.ok
              ? "border-emerald-900/60 bg-emerald-950/40 text-emerald-300"
              : "border-rose-900/60 bg-rose-950/40 text-rose-300"
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left 8 cols: 7-day Agenda */}
        <div className="lg:col-span-8 rounded-lg border border-zinc-800/80 bg-zinc-900/40 divide-y divide-zinc-800/80">
          {weekDays.map((day, idx) => {
            const iso = toLocalDateIso(day);
            const entries = entriesByDate.get(iso) ?? [];
            const isToday = iso === todayIso;
            return (
              <div key={iso} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-semibold ${
                        isToday ? "text-emerald-400" : "text-zinc-200"
                      }`}
                    >
                      {WEEKDAY_NAMES[idx]}
                    </span>
                    <span className="font-mono text-xs text-zinc-500 tabular-nums">
                      {formatVietnameseShortDate(day)}
                    </span>
                    {isToday && (
                      <span className="rounded border border-emerald-900/70 bg-emerald-950/60 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
                        Hôm nay
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[11px] text-zinc-600 tabular-nums">
                    {entries.length > 0 ? `${entries.length} mục` : "Trống"}
                  </span>
                </div>

                {entries.length > 0 && (
                  <div className="mt-2 divide-y divide-zinc-800/50 border-t border-zinc-800/60">
                    {entries.map((item) => {
                      const delKey =
                        item.calendarId && item.eventUid
                          ? `${item.calendarId}:${item.eventUid}`
                          : "";
                      return (
                        <div
                          key={item.id}
                          className="group flex items-center justify-between gap-3 py-2"
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
                            <span className="rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                              {item.badgeLabel}
                            </span>
                            {item.roomOrLocation && (
                              <span
                                className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${
                                  item.source === "uit"
                                    ? "bg-zinc-800 text-zinc-100"
                                    : item.source === "exam"
                                    ? "bg-rose-950 text-rose-200"
                                    : "bg-zinc-900 text-zinc-300 border border-zinc-800"
                                }`}
                              >
                                {item.roomOrLocation}
                              </span>
                            )}
                            {item.canDelete && item.calendarId && item.eventUid && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleDeleteEvent(item.calendarId!, item.eventUid!)
                                }
                                disabled={deletingEventKey === delKey}
                                title="Xóa khỏi Google Calendar"
                                aria-label={`Xóa ${item.title}`}
                                className="rounded p-1 text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-800 hover:text-rose-400 disabled:opacity-50 cursor-pointer"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
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

        {/* Right 4 cols: Mini Calendar + Google Account OAuth + Advanced ICS */}
        <aside className="lg:col-span-4 space-y-4">
          <MiniMonthCalendar
            selectedWeekStart={weekAnchor}
            viewMonth={miniMonth}
            onChangeMonth={setMiniMonth}
            onSelectDate={handleSelectMiniDate}
            onJumpToday={handleJumpToday}
            examDateSet={examDateSet}
            gcalDateColorMap={gcalDateColorMap}
          />

          {/* Primary Google Calendar OAuth Card */}
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold text-zinc-100">
                Google Calendar (2 chiều)
              </h2>
              {oauthStatus?.connected && (
                <button
                  type="button"
                  onClick={() => void handleDisconnectGoogleOAuth()}
                  className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:border-zinc-700 hover:text-rose-300 cursor-pointer"
                >
                  <LogOut className="h-3 w-3" aria-hidden="true" />
                  <span>Ngắt kết nối</span>
                </button>
              )}
            </div>

            {!oauthStatus?.connected ? (
              <div className="space-y-3">
                <p className="text-[11px] leading-relaxed text-zinc-400">
                  Đăng nhập bằng tài khoản Google để tự động lấy toàn bộ lịch, tạo sự kiện mới và đồng bộ TKB UIT lên điện thoại.
                </p>

                <button
                  type="button"
                  onClick={() => void handleConnectGoogleOAuth()}
                  disabled={isConnectingOAuth}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.99] disabled:opacity-50 cursor-pointer"
                >
                  <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>
                    {isConnectingOAuth
                      ? "Đang chờ xác nhận trên trình duyệt..."
                      : "Đăng nhập bằng Google"}
                  </span>
                </button>

                {oauthStatus && !oauthStatus.is_embedded_config && (
                  <div className="border-t border-zinc-800/80 pt-2.5">
                    <button
                      type="button"
                      onClick={() => setShowOAuthSetup((v) => !v)}
                      className="flex w-full items-center justify-between text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                    >
                      <span className="flex items-center gap-1.5">
                        <Settings2 className="h-3 w-3" aria-hidden="true" />
                        <span>
                          {oauthStatus.is_configured
                            ? "Đổi OAuth Client ID (bản dev)"
                            : "Cấu hình OAuth (dành cho bản dev)"}
                        </span>
                      </span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${
                          showOAuthSetup ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {showOAuthSetup && (
                      <form
                        onSubmit={(e) => void handleSaveOAuthConfig(e)}
                        className="mt-2.5 space-y-2"
                      >
                        <p className="text-[11px] text-zinc-500">
                          Dán Desktop OAuth Client ID & Secret từ Google Cloud Console (khi đóng gói bản phát hành qua env, mục này sẽ tự ẩn).
                        </p>
                        <input
                          type="text"
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          placeholder="Google OAuth Client ID"
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                        />
                        <input
                          type="password"
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          placeholder="Client Secret (tùy chọn)"
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={isSavingOAuthConfig || !oauthClientId.trim()}
                          className="h-7 w-full rounded-md bg-zinc-100 text-xs font-medium text-zinc-950 hover:bg-zinc-200 disabled:opacity-40 cursor-pointer"
                        >
                          {isSavingOAuthConfig ? "Đang lưu..." : "Lưu cấu hình OAuth"}
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2 rounded-md border border-emerald-900/60 bg-emerald-950/30 px-2.5 py-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                  <span className="truncate font-mono text-[11px] text-emerald-200">
                    {oauthStatus.email || "Đã đăng nhập Google"}
                  </span>
                </div>

                {oauthCalendars.length > 0 && (
                  <div className="divide-y divide-zinc-800/70 border-t border-zinc-800">
                    {oauthCalendars.map((cal) => (
                      <label
                        key={cal.id}
                        className="flex items-center justify-between gap-2 py-2 cursor-pointer"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <input
                            type="checkbox"
                            checked={cal.is_enabled}
                            onChange={() =>
                              void handleToggleCalendar(cal.id, cal.is_enabled)
                            }
                            className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-950 accent-emerald-500"
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
                          {cal.can_write ? "2 chiều" : "Chỉ đọc"}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Secondary Collapsible ICS Feed Manager */}
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-4">
            <button
              type="button"
              onClick={() => setShowIcsAdvanced((v) => !v)}
              className="flex w-full items-center justify-between gap-2 text-left cursor-pointer"
            >
              <span className="text-xs font-semibold text-zinc-300">
                Nâng cao: Thêm lịch bằng link .ics ({icsCalendars.length})
              </span>
              <ChevronDown
                className={`h-4 w-4 text-zinc-500 transition-transform ${
                  showIcsAdvanced ? "rotate-180" : ""
                }`}
              />
            </button>

            {showIcsAdvanced && (
              <div className="mt-3 space-y-3 border-t border-zinc-800/70 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-zinc-400">
                    Nguồn iCalendar công khai / bí mật
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void openExternalUrl(
                        "https://calendar.google.com/calendar/r/settings"
                      )
                    }
                    className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] font-medium text-emerald-400 hover:border-zinc-700 hover:bg-zinc-800 cursor-pointer"
                  >
                    <span>Mở Google Calendar</span>
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>

                <ol className="space-y-1 text-[11px] text-zinc-400 list-decimal list-inside">
                  <li>Mở cài đặt Google Calendar trên trình duyệt.</li>
                  <li>Chọn lịch ở cột trái, kéo xuống mục Tích hợp lịch.</li>
                  <li>Sao chép Địa chỉ bí mật iCal và dán vào ô bên dưới.</li>
                </ol>

                <form
                  onSubmit={(e) => void handleAddCalendar(e)}
                  className="space-y-2.5"
                >
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Tên lịch (vd: Cá nhân, CLB)"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                  />
                  <input
                    type="url"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="https://calendar.google.com/calendar/ical/..."
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                  />
                  <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1.5">
                      {CALENDAR_PALETTE.map((hex) => (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => setNewColor(hex)}
                          aria-label={`Chọn màu ${hex}`}
                          className={`h-4 w-4 rounded-full cursor-pointer transition-transform duration-100 ${
                            newColor === hex
                              ? "ring-2 ring-zinc-200 ring-offset-2 ring-offset-zinc-900"
                              : ""
                          }`}
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </div>
                    <button
                      type="submit"
                      disabled={isAdding || !newName.trim() || !newUrl.trim()}
                      className="flex h-7 items-center gap-1 rounded-md bg-zinc-100 px-2.5 text-xs font-medium text-zinc-950 transition-colors duration-150 hover:bg-zinc-200 disabled:opacity-40 cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Thêm lịch</span>
                    </button>
                  </div>
                </form>

                <div className="divide-y divide-zinc-800/70 border-t border-zinc-800">
                  {icsCalendars.length === 0 ? (
                    <div className="py-3 text-center text-xs text-zinc-500">
                      Chưa gắn lịch .ics nào.
                    </div>
                  ) : (
                    icsCalendars.map((cal) => (
                      <div
                        key={cal.id}
                        className="flex items-center justify-between gap-2 py-2.5"
                      >
                        <label className="flex min-w-0 flex-1 items-center gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cal.is_enabled}
                            onChange={() =>
                              void handleToggleCalendar(cal.id, cal.is_enabled)
                            }
                            className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-950 accent-emerald-500"
                          />
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: cal.color }}
                          />
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-zinc-200">
                              {cal.name}
                            </div>
                            <div className="font-mono text-[10px] text-zinc-500">
                              {cal.last_synced_at > 0
                                ? `Cập nhật ${formatTimeHm(cal.last_synced_at)}`
                                : "Chưa đồng bộ"}
                            </div>
                          </div>
                        </label>
                        <button
                          type="button"
                          onClick={() => void handleDeleteCalendar(cal.id)}
                          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-rose-400 cursor-pointer"
                          aria-label={`Xóa lịch ${cal.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
