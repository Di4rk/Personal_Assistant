export const UIT_PERIOD_START: Record<number, { h: number; m: number; label: string }> = {
  1: { h: 7, m: 30, label: "07:30" },
  2: { h: 8, m: 15, label: "08:15" },
  3: { h: 9, m: 0, label: "09:00" },
  4: { h: 10, m: 0, label: "10:00" },
  5: { h: 10, m: 45, label: "10:45" },
  6: { h: 13, m: 0, label: "13:00" },
  7: { h: 13, m: 45, label: "13:45" },
  8: { h: 14, m: 30, label: "14:30" },
  9: { h: 15, m: 30, label: "15:30" },
  10: { h: 16, m: 15, label: "16:15" },
  11: { h: 17, m: 45, label: "17:45" },
  12: { h: 18, m: 30, label: "18:30" },
  13: { h: 19, m: 15, label: "19:15" },
};

export const UIT_PERIOD_END: Record<number, { h: number; m: number; label: string }> = {
  1: { h: 8, m: 15, label: "08:15" },
  2: { h: 9, m: 0, label: "09:00" },
  3: { h: 9, m: 45, label: "09:45" },
  4: { h: 10, m: 45, label: "10:45" },
  5: { h: 11, m: 30, label: "11:30" },
  6: { h: 13, m: 45, label: "13:45" },
  7: { h: 14, m: 30, label: "14:30" },
  8: { h: 15, m: 15, label: "15:15" },
  9: { h: 16, m: 15, label: "16:15" },
  10: { h: 17, m: 0, label: "17:00" },
  11: { h: 18, m: 30, label: "18:30" },
  12: { h: 19, m: 15, label: "19:15" },
  13: { h: 20, m: 0, label: "20:00" },
};

export function formatUitPeriodRange(tietStart: number, tietEnd: number): string {
  const s = UIT_PERIOD_START[tietStart]?.label ?? "07:30";
  const e = UIT_PERIOD_END[tietEnd]?.label ?? "09:00";
  return `${s}–${e}`;
}

export function uitPeriodStartMinutes(tietStart: number): number {
  const entry = UIT_PERIOD_START[tietStart];
  return entry ? entry.h * 60 + entry.m : 7 * 60 + 30;
}

export function uitPeriodEndMinutes(tietEnd: number): number {
  const entry = UIT_PERIOD_END[tietEnd];
  return entry ? entry.h * 60 + entry.m : 9 * 60;
}

export function toLocalDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function getMondayOfWeek(date: Date): Date {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

const VND_FORMATTER = new Intl.NumberFormat("vi-VN");
const VN_TIME_HM_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const VN_DATE_ISO_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function formatVnd(amount: number): string {
  return VND_FORMATTER.format(amount) + " đ";
}

export function parseExamDateIso(dateStr: string): string | null {
  const clean = dateStr.trim();
  const ddmmyyyy = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  }
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return clean;
  }
  return null;
}

export function formatTimeHm(unixSeconds: number): string {
  return VN_TIME_HM_FORMATTER.format(new Date(unixSeconds * 1000));
}

export function toVnDateIso(unixSeconds: number): string {
  return VN_DATE_ISO_FORMATTER.format(new Date(unixSeconds * 1000));
}

export function getVnMinutesOfDay(unixSeconds: number): number {
  const parts = VN_TIME_HM_FORMATTER.formatToParts(new Date(unixSeconds * 1000));
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + m;
}

export function getEventCoveredDatesVn(
  startTs: number,
  endTs: number,
  allDay: boolean
): string[] {
  const startIso = toVnDateIso(startTs);
  const effectiveEndTs = endTs > startTs ? endTs - 1 : startTs;
  const endIso = toVnDateIso(effectiveEndTs);

  if (startIso === endIso) {
    return [startIso];
  }

  const dates: string[] = [];
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const cursor = new Date(Date.UTC(sy, sm - 1, sd));
  const limit = new Date(Date.UTC(ey, em - 1, ed));

  let steps = 0;
  const maxSpan = allDay ? 60 : 30;
  while (cursor.getTime() <= limit.getTime() && steps < maxSpan) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    steps += 1;
  }

  return dates;
}

export function parseTimeHmMinutes(hhmm: string): number {
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

const VI_WEEKDAYS = [
  "Chủ nhật",
  "Thứ 2",
  "Thứ 3",
  "Thứ 4",
  "Thứ 5",
  "Thứ 6",
  "Thứ 7",
];

export function formatVietnameseShortDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}`;
}

export function formatVietnameseDayHeader(date: Date): string {
  const weekday = VI_WEEKDAYS[date.getDay()] ?? "";
  return `${weekday}, ${formatVietnameseShortDate(date)}`;
}

export function formatVietnameseWeekRange(start: Date, end: Date): string {
  return `${formatVietnameseShortDate(start)} – ${formatVietnameseShortDate(end)}/${end.getFullYear()}`;
}

