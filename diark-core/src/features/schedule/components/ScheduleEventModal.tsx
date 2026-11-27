import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Trash2,
  X,
} from "lucide-react";
import { openExternalUrl } from "../../../lib/tauri-client";
import type {
  GoogleCalendarConfig,
  PortalTimetableSlot,
} from "../../../types/portal-extra";
import {
  addDays,
  formatUitPeriodRange,
  getMondayOfWeek,
  toLocalDateIso,
} from "../../../utils/scheduleTime";

export interface ScheduleEventFormValues {
  calendarId: string;
  title: string;
  dateIso: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  location: string;
  description: string;
}

interface ScheduleEventModalProps {
  mode: "create" | "edit";
  writableCalendars: GoogleCalendarConfig[];
  initialValues: ScheduleEventFormValues;
  isSaving: boolean;
  isDeleting: boolean;
  onClose: () => void;
  onSubmit: (values: ScheduleEventFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
}

const DURATION_OPTIONS = [
  { label: "30p", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "1.5h", minutes: 90 },
  { label: "2h", minutes: 120 },
] as const;

const SHORT_WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

const MIN_SLOT_MINUTES = 0;
const MAX_SLOT_MINUTES = 23 * 60 + 45;

const TIME_SLOTS: string[] = Array.from(
  { length: (MAX_SLOT_MINUTES - MIN_SLOT_MINUTES) / 15 + 1 },
  (_, idx) => minutesToHm(MIN_SLOT_MINUTES + idx * 15)
);

function hmToMinutes(hm: string): number | null {
  const m = hm.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToHm(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function getNextRoundedHourRange(now: Date = new Date()): {
  startTime: string;
  endTime: string;
} {
  const h = now.getHours();
  const nextHour = Math.min(23, h + 1);
  const startMin = nextHour * 60;
  const endMin = Math.min(MAX_SLOT_MINUTES, startMin + 60);
  return {
    startTime: minutesToHm(startMin),
    endTime: minutesToHm(endMin),
  };
}

function isoToVnDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function parseIsoToLocalMonth(iso: string): Date {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, 1);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function snapToQuarterHour(minutes: number): number {
  return Math.round(minutes / 15) * 15;
}

export const ScheduleEventModal: React.FC<ScheduleEventModalProps> = ({
  mode,
  writableCalendars,
  initialValues,
  isSaving,
  isDeleting,
  onClose,
  onSubmit,
  onDelete,
}) => {
  const [calendarId, setCalendarId] = useState(initialValues.calendarId);
  const [title, setTitle] = useState(initialValues.title);
  const [dateIso, setDateIso] = useState(initialValues.dateIso);
  const [dateViewMonth, setDateViewMonth] = useState<Date>(() =>
    parseIsoToLocalMonth(initialValues.dateIso)
  );
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);

  const [allDay, setAllDay] = useState(initialValues.allDay);
  const [startTime, setStartTime] = useState(initialValues.startTime);
  const [endTime, setEndTime] = useState(initialValues.endTime);
  const [openTimeDropdown, setOpenTimeDropdown] = useState<"start" | "end" | null>(null);

  const [location, setLocation] = useState(initialValues.location);
  const [description, setDescription] = useState(initialValues.description);
  const [formError, setFormError] = useState<string | null>(null);

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const datePickerRef = useRef<HTMLDivElement | null>(null);
  const startPickerRef = useRef<HTMLDivElement | null>(null);
  const endPickerRef = useRef<HTMLDivElement | null>(null);
  const startTriggerRef = useRef<HTMLButtonElement | null>(null);
  const endTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeSlotRef = useRef<HTMLButtonElement | null>(null);

  const startTimeRef = useRef(startTime);
  const endTimeRef = useRef(endTime);
  startTimeRef.current = startTime;
  endTimeRef.current = endTime;

  useEffect(() => {
    if (mode === "create") {
      requestAnimationFrame(() => titleInputRef.current?.focus());
    }
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (datePopoverOpen) {
        e.stopPropagation();
        setDatePopoverOpen(false);
        return;
      }
      if (openTimeDropdown !== null) {
        e.stopPropagation();
        setOpenTimeDropdown(null);
        return;
      }
      if (!isSaving && !isDeleting) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [datePopoverOpen, openTimeDropdown, onClose, isSaving, isDeleting]);

  // Close popovers on outside click
  useEffect(() => {
    if (!datePopoverOpen && openTimeDropdown === null) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (datePopoverOpen && datePickerRef.current && !datePickerRef.current.contains(target)) {
        setDatePopoverOpen(false);
      }
      if (
        openTimeDropdown === "start" &&
        startPickerRef.current &&
        !startPickerRef.current.contains(target)
      ) {
        setOpenTimeDropdown(null);
      }
      if (
        openTimeDropdown === "end" &&
        endPickerRef.current &&
        !endPickerRef.current.contains(target)
      ) {
        setOpenTimeDropdown(null);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [datePopoverOpen, openTimeDropdown]);

  // Auto-scroll opened time dropdown to currently selected slot
  useEffect(() => {
    if (!openTimeDropdown) return;
    requestAnimationFrame(() => {
      activeSlotRef.current?.scrollIntoView({ block: "center" });
    });
  }, [openTimeDropdown]);

  const applyStartTimeWithPreservedDuration = (nextStartMin: number) => {
    const clampedStart = Math.max(MIN_SLOT_MINUTES, Math.min(23 * 60 + 30, nextStartMin));
    const prevStart = hmToMinutes(startTimeRef.current) ?? 9 * 60;
    const prevEnd = hmToMinutes(endTimeRef.current) ?? prevStart + 60;
    const duration = Math.max(15, prevEnd - prevStart);
    const nextEnd = Math.min(MAX_SLOT_MINUTES, Math.max(clampedStart + 15, clampedStart + duration));

    setFormError(null);
    setStartTime(minutesToHm(clampedStart));
    setEndTime(minutesToHm(nextEnd));
  };

  const applyEndTime = (nextEndMin: number) => {
    const startMin = hmToMinutes(startTimeRef.current) ?? MIN_SLOT_MINUTES;
    const clampedEnd = Math.max(startMin + 15, Math.min(MAX_SLOT_MINUTES, nextEndMin));
    setFormError(null);
    setEndTime(minutesToHm(clampedEnd));
  };

  // Non-passive wheel handlers for 15-minute stepping over Start/End triggers
  useEffect(() => {
    if (allDay) return;
    const startEl = startTriggerRef.current;
    const endEl = endTriggerRef.current;

    const onWheelStart = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 15 : -15;
      const cur = snapToQuarterHour(hmToMinutes(startTimeRef.current) ?? 9 * 60);
      applyStartTimeWithPreservedDuration(cur + delta);
    };

    const onWheelEnd = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 15 : -15;
      const cur = snapToQuarterHour(hmToMinutes(endTimeRef.current) ?? 10 * 60);
      applyEndTime(cur + delta);
    };

    startEl?.addEventListener("wheel", onWheelStart, { passive: false });
    endEl?.addEventListener("wheel", onWheelEnd, { passive: false });
    return () => {
      startEl?.removeEventListener("wheel", onWheelStart);
      endEl?.removeEventListener("wheel", onWheelEnd);
    };
  }, [allDay]);

  const handleQuickDuration = (minutes: number) => {
    setFormError(null);
    const startMin = hmToMinutes(startTime) ?? 9 * 60;
    setEndTime(minutesToHm(Math.min(MAX_SLOT_MINUTES, startMin + minutes)));
  };

  const handleSelectQuickDate = (kind: "today" | "tomorrow" | "weekend") => {
    const now = new Date();
    let target = now;
    if (kind === "tomorrow") {
      target = addDays(now, 1);
    } else if (kind === "weekend") {
      const dow = now.getDay();
      const delta = dow === 6 ? 1 : dow === 0 ? 6 : 6 - dow;
      target = addDays(now, delta);
    }
    const iso = toLocalDateIso(target);
    setDateIso(iso);
    setDateViewMonth(new Date(target.getFullYear(), target.getMonth(), 1));
    setDatePopoverOpen(false);
    setFormError(null);
  };

  const pickerWeeks = useMemo(() => {
    const firstOfMonth = new Date(dateViewMonth.getFullYear(), dateViewMonth.getMonth(), 1);
    const gridStart = getMondayOfWeek(firstOfMonth);
    const rows: Date[][] = [];
    for (let w = 0; w < 6; w++) {
      const row: Date[] = [];
      for (let d = 0; d < 7; d++) {
        row.push(addDays(gridStart, w * 7 + d));
      }
      if (w === 5 && row[0].getMonth() !== dateViewMonth.getMonth()) break;
      rows.push(row);
    }
    return rows;
  }, [dateViewMonth]);

  const todayIso = toLocalDateIso(new Date());
  const startMinutes = hmToMinutes(startTime);
  const endMinutes = hmToMinutes(endTime);
  const currentDurationMinutes =
    startMinutes !== null && endMinutes !== null ? endMinutes - startMinutes : -1;

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("Vui lòng nhập tên sự kiện.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
      setFormError("Ngày không hợp lệ.");
      return;
    }
    if (!allDay) {
      if (startMinutes === null || endMinutes === null) {
        setFormError("Giờ không hợp lệ.");
        return;
      }
      if (endMinutes <= startMinutes) {
        setFormError("Giờ kết thúc phải sau giờ bắt đầu.");
        return;
      }
    }

    void onSubmit({
      calendarId,
      title: trimmedTitle,
      dateIso,
      allDay,
      startTime: startTime.trim(),
      endTime: endTime.trim(),
      location: location.trim(),
      description: description.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,7,15,0.7)] p-4"
      onClick={() => {
        if (!isSaving && !isDeleting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? "Thêm sự kiện" : "Chỉnh sửa sự kiện"}
        onClick={(e) => e.stopPropagation()}
        className="uit-modal-in w-full max-w-[460px] rounded-xl border border-[#1D263B] bg-[#0F1420] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#1D263B]/80 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-white">
            {mode === "create" ? "Thêm sự kiện mới" : "Chỉnh sửa sự kiện"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving || isDeleting}
            aria-label="Đóng"
            className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-white disabled:opacity-40 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleFormSubmit} className="space-y-3.5 px-5 py-4">
          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-zinc-400">
              Tên sự kiện
            </label>
            <input
              ref={titleInputRef}
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Họp nhóm đồ án, Đi khám răng..."
              className="w-full rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-[#2F6BFF]/60 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Custom Date Picker Popover */}
            <div ref={datePickerRef} className="relative space-y-1">
              <label className="block text-[11px] font-medium text-zinc-400">
                Ngày (DD/MM/YYYY)
              </label>
              <button
                type="button"
                onClick={() => {
                  setOpenTimeDropdown(null);
                  setDatePopoverOpen((prev) => !prev);
                }}
                aria-expanded={datePopoverOpen}
                className="flex w-full items-center justify-between rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-2 font-mono text-xs text-zinc-100 transition-colors hover:border-[#2F6BFF]/50 focus:border-[#2F6BFF]/60 focus:outline-none cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5 text-[#6B9BFF]" aria-hidden="true" />
                  <span>{isoToVnDate(dateIso)}</span>
                </span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-150 ${
                    datePopoverOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {datePopoverOpen && (
                <div className="uit-modal-in absolute left-0 top-full z-30 mt-1.5 w-[276px] rounded-xl border border-[#1D263B] bg-[#0F1420] p-3 shadow-2xl">
                  <div className="mb-2.5 grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleSelectQuickDate("today")}
                      className="rounded-md border border-[#1D263B] bg-[#080B12] px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] hover:text-[#6B9BFF] cursor-pointer"
                    >
                      Hôm nay
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectQuickDate("tomorrow")}
                      className="rounded-md border border-[#1D263B] bg-[#080B12] px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] hover:text-[#6B9BFF] cursor-pointer"
                    >
                      Ngày mai
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSelectQuickDate("weekend")}
                      className="rounded-md border border-[#1D263B] bg-[#080B12] px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] hover:text-[#6B9BFF] cursor-pointer"
                    >
                      Cuối tuần
                    </button>
                  </div>

                  <div className="mb-2 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() =>
                        setDateViewMonth(
                          new Date(dateViewMonth.getFullYear(), dateViewMonth.getMonth() - 1, 1)
                        )
                      }
                      aria-label="Tháng trước"
                      className="rounded p-1 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-white cursor-pointer"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="text-xs font-semibold text-zinc-100">
                      Tháng {String(dateViewMonth.getMonth() + 1).padStart(2, "0")}/
                      {dateViewMonth.getFullYear()}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDateViewMonth(
                          new Date(dateViewMonth.getFullYear(), dateViewMonth.getMonth() + 1, 1)
                        )
                      }
                      aria-label="Tháng sau"
                      className="rounded p-1 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-white cursor-pointer"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-7 pb-1 text-center text-[10px] font-medium text-zinc-500">
                    {SHORT_WEEKDAYS.map((wd) => (
                      <span key={wd} className="py-0.5">
                        {wd}
                      </span>
                    ))}
                  </div>

                  <div className="space-y-0.5">
                    {pickerWeeks.map((row, rIdx) => (
                      <div key={rIdx} className="grid grid-cols-7 gap-0.5">
                        {row.map((day) => {
                          const iso = toLocalDateIso(day);
                          const inMonth = day.getMonth() === dateViewMonth.getMonth();
                          const isSelected = iso === dateIso;
                          const isToday = iso === todayIso;

                          return (
                            <button
                              key={iso}
                              type="button"
                              onClick={() => {
                                setDateIso(iso);
                                setDateViewMonth(new Date(day.getFullYear(), day.getMonth(), 1));
                                setDatePopoverOpen(false);
                                setFormError(null);
                              }}
                              className={`flex h-7 items-center justify-center rounded font-mono text-[11px] tabular-nums transition-colors cursor-pointer ${
                                isSelected
                                  ? "bg-[#2F6BFF] font-semibold text-white"
                                  : isToday
                                  ? "ring-1 ring-[#2F6BFF]/70 bg-[#2F6BFF]/[0.14] font-semibold text-[#6B9BFF] hover:bg-[#2F6BFF]/[0.24]"
                                  : inMonth
                                  ? "text-zinc-200 hover:bg-[#151C2C]"
                                  : "text-zinc-600 hover:bg-[#151C2C]"
                              }`}
                            >
                              {day.getDate()}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="block text-[11px] font-medium text-zinc-400">
                Lịch Google
              </label>
              <select
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                disabled={mode === "edit"}
                className="w-full rounded-lg border border-[#1D263B] bg-[#080B12] px-2.5 py-2 text-xs text-zinc-100 focus:border-[#2F6BFF]/60 focus:outline-none disabled:opacity-60"
              >
                {writableCalendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-[#1D263B]/80 bg-[#080B12]/60 px-3 py-2">
            <span className="text-xs font-medium text-zinc-300">Sự kiện cả ngày</span>
            <button
              type="button"
              role="switch"
              aria-checked={allDay}
              onClick={() => {
                setOpenTimeDropdown(null);
                setAllDay((prev) => !prev);
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 cursor-pointer ${
                allDay ? "bg-[#2F6BFF]" : "bg-[#1D263B]"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-150 ${
                  allDay ? "translate-x-[18px]" : "translate-x-[3px]"
                }`}
              />
            </button>
          </div>

          {!allDay && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                {/* Start Time Selector (15-min dropdown + wheel) */}
                <div ref={startPickerRef} className="relative space-y-1">
                  <label className="block text-[11px] font-medium text-zinc-400">
                    Bắt đầu (24h · lăn chuột ±15p)
                  </label>
                  <button
                    ref={startTriggerRef}
                    type="button"
                    onClick={() => {
                      setDatePopoverOpen(false);
                      setOpenTimeDropdown((prev) => (prev === "start" ? null : "start"));
                    }}
                    aria-expanded={openTimeDropdown === "start"}
                    className="flex w-full items-center justify-between rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-1.5 font-mono text-xs text-zinc-100 transition-colors hover:border-[#2F6BFF]/50 focus:border-[#2F6BFF]/60 focus:outline-none cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <Clock className="h-3.5 w-3.5 text-[#6B9BFF]" aria-hidden="true" />
                      <span>{startTime}</span>
                    </span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-150 ${
                        openTimeDropdown === "start" ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {openTimeDropdown === "start" && (
                    <div
                      role="listbox"
                      aria-label="Chọn giờ bắt đầu"
                      className="uit-modal-in absolute left-0 top-full z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-xl border border-[#1D263B] bg-[#0F1420] py-1 shadow-2xl"
                    >
                      {TIME_SLOTS.filter((slot) => slot <= "23:30").map((slot) => {
                        const isActive = slot === startTime;
                        return (
                          <button
                            key={slot}
                            ref={isActive ? activeSlotRef : undefined}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            onClick={() => {
                              const mins = hmToMinutes(slot);
                              if (mins !== null) applyStartTimeWithPreservedDuration(mins);
                              setOpenTimeDropdown(null);
                            }}
                            className={`flex w-full items-center justify-between px-3 py-1.5 font-mono text-xs transition-colors cursor-pointer ${
                              isActive
                                ? "bg-[#2F6BFF]/[0.18] font-semibold text-[#6B9BFF]"
                                : "text-zinc-300 hover:bg-[#151C2C] hover:text-white"
                            }`}
                          >
                            <span>{slot}</span>
                            {isActive && <span className="h-1.5 w-1.5 rounded-full bg-[#2F6BFF]" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* End Time Selector (15-min dropdown + wheel) */}
                <div ref={endPickerRef} className="relative space-y-1">
                  <label className="block text-[11px] font-medium text-zinc-400">
                    Kết thúc (24h · lăn chuột ±15p)
                  </label>
                  <button
                    ref={endTriggerRef}
                    type="button"
                    onClick={() => {
                      setDatePopoverOpen(false);
                      setOpenTimeDropdown((prev) => (prev === "end" ? null : "end"));
                    }}
                    aria-expanded={openTimeDropdown === "end"}
                    className="flex w-full items-center justify-between rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-1.5 font-mono text-xs text-zinc-100 transition-colors hover:border-[#2F6BFF]/50 focus:border-[#2F6BFF]/60 focus:outline-none cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <Clock className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
                      <span>{endTime}</span>
                    </span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-zinc-500 transition-transform duration-150 ${
                        openTimeDropdown === "end" ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {openTimeDropdown === "end" && (
                    <div
                      role="listbox"
                      aria-label="Chọn giờ kết thúc"
                      className="uit-modal-in absolute left-0 top-full z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-xl border border-[#1D263B] bg-[#0F1420] py-1 shadow-2xl"
                    >
                      {TIME_SLOTS.filter((slot) => {
                        const sMin = hmToMinutes(slot) ?? 0;
                        return sMin > (startMinutes ?? MIN_SLOT_MINUTES);
                      }).map((slot) => {
                        const isActive = slot === endTime;
                        return (
                          <button
                            key={slot}
                            ref={isActive ? activeSlotRef : undefined}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            onClick={() => {
                              const mins = hmToMinutes(slot);
                              if (mins !== null) applyEndTime(mins);
                              setOpenTimeDropdown(null);
                            }}
                            className={`flex w-full items-center justify-between px-3 py-1.5 font-mono text-xs transition-colors cursor-pointer ${
                              isActive
                                ? "bg-[#2F6BFF]/[0.18] font-semibold text-[#6B9BFF]"
                                : "text-zinc-300 hover:bg-[#151C2C] hover:text-white"
                            }`}
                          >
                            <span>{slot}</span>
                            {isActive && <span className="h-1.5 w-1.5 rounded-full bg-[#2F6BFF]" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[11px] text-zinc-500">Thời lượng:</span>
                {DURATION_OPTIONS.map((opt) => {
                  const isActiveDuration = currentDurationMinutes === opt.minutes;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => handleQuickDuration(opt.minutes)}
                      className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer ${
                        isActiveDuration
                          ? "border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.18] font-medium text-[#6B9BFF]"
                          : "border-[#1D263B] bg-[#080B12] text-zinc-300 hover:border-[#2F6BFF]/40 hover:bg-[#151C2C] hover:text-[#6B9BFF]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-zinc-400">
              Địa điểm (không bắt buộc)
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Phòng họp, Thư viện UIT..."
              className="w-full rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-[#2F6BFF]/60 focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-zinc-400">
              Ghi chú (không bắt buộc)
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Chi tiết thêm..."
              className="w-full resize-none rounded-lg border border-[#1D263B] bg-[#080B12] px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-[#2F6BFF]/60 focus:outline-none"
            />
          </div>

          {formError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {formError}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-[#1D263B]/80 pt-3.5">
            <div>
              {mode === "edit" && onDelete && (
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={isDeleting || isSaving}
                  className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-40 cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{isDeleting ? "Đang xóa..." : "Xóa sự kiện"}</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isSaving || isDeleting}
                className="flex h-8 items-center rounded-lg border border-[#1D263B] bg-[#080B12] px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-[#151C2C] disabled:opacity-40 cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={isSaving || isDeleting || !title.trim()}
                className="flex h-8 items-center rounded-lg bg-[#2F6BFF] px-3.5 text-xs font-semibold text-white transition-colors hover:bg-[#255CE6] disabled:opacity-40 cursor-pointer"
              >
                {isSaving
                  ? "Đang lưu..."
                  : mode === "create"
                  ? "Lưu sự kiện"
                  : "Cập nhật"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

interface UitClassPreviewModalProps {
  slot: PortalTimetableSlot;
  onClose: () => void;
}

export const UitClassPreviewModal: React.FC<UitClassPreviewModalProps> = ({
  slot,
  onClose,
}) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const timeRange = formatUitPeriodRange(slot.tiet_bat_dau, slot.tiet_ket_thuc);
  const lecturerDisplay = slot.ten_giang_vien
    ? `${slot.lecturer_title ? `${slot.lecturer_title} ` : ""}${slot.ten_giang_vien}`
    : "Chưa cập nhật";
  const moodleUrl = `https://courses.uit.edu.vn/course/search.php?q=${encodeURIComponent(slot.ma_lop)}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,7,15,0.7)] p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={slot.ten_mon_hoc}
        onClick={(e) => e.stopPropagation()}
        className="uit-modal-in w-full max-w-[420px] rounded-xl border border-[#1D263B] bg-[#0F1420] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#1D263B]/80 px-5 py-3.5">
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6B9BFF]">
              Thời khóa biểu UIT
            </span>
            <h2 className="mt-0.5 text-sm font-semibold text-white">
              {slot.ten_mon_hoc}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2.5 px-5 py-4 text-xs">
          <div className="flex items-center justify-between py-1">
            <span className="text-zinc-400">Mã lớp</span>
            <span className="font-mono font-medium text-zinc-100">{slot.ma_lop}</span>
          </div>
          <div className="flex items-center justify-between border-t border-[#1D263B]/60 py-1 pt-2.5">
            <span className="text-zinc-400">Phòng học</span>
            <span className="rounded bg-[#2F6BFF]/[0.16] px-2 py-0.5 font-mono text-[11px] font-semibold text-[#6B9BFF]">
              {slot.phong || "Chưa rõ"}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-[#1D263B]/60 py-1 pt-2.5">
            <span className="text-zinc-400">Giờ học</span>
            <span className="font-mono text-zinc-200">
              {timeRange} · Tiết {slot.tiet_bat_dau}–{slot.tiet_ket_thuc}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-[#1D263B]/60 py-1 pt-2.5">
            <span className="text-zinc-400">Hình thức</span>
            <span className="text-zinc-200">{slot.hinh_thuc || "Chính quy"}</span>
          </div>
          <div className="flex items-center justify-between border-t border-[#1D263B]/60 py-1 pt-2.5">
            <span className="text-zinc-400">Giảng viên</span>
            <span className="max-w-[240px] truncate text-right text-zinc-200">
              {lecturerDisplay}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#1D263B]/80 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 items-center rounded-lg border border-[#1D263B] bg-[#080B12] px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-[#151C2C] cursor-pointer"
          >
            Đóng
          </button>
          <button
            type="button"
            onClick={() => void openExternalUrl(moodleUrl)}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-[#2F6BFF] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#255CE6] cursor-pointer"
          >
            <span>Mở Moodle môn học</span>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};
