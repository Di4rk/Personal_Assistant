import React, { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, getMondayOfWeek, toLocalDateIso } from "../../../utils/scheduleTime";

interface MiniMonthCalendarProps {
  selectedWeekStart: Date;
  viewMonth: Date;
  onChangeMonth: (next: Date) => void;
  onSelectDate: (date: Date) => void;
  onJumpToday: () => void;
  examDateSet: Set<string>;
  gcalDateColorMap: Map<string, string>;
}

const SHORT_WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

export const MiniMonthCalendar: React.FC<MiniMonthCalendarProps> = ({
  selectedWeekStart,
  viewMonth,
  onChangeMonth,
  onSelectDate,
  onJumpToday,
  examDateSet,
  gcalDateColorMap,
}) => {
  const todayIso = toLocalDateIso(new Date());
  const selectedWeekStartIso = toLocalDateIso(selectedWeekStart);
  const selectedWeekEndIso = toLocalDateIso(addDays(selectedWeekStart, 6));

  const weeks = useMemo(() => {
    const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const gridStart = getMondayOfWeek(firstOfMonth);
    const rows: Date[][] = [];
    for (let w = 0; w < 6; w++) {
      const row: Date[] = [];
      for (let d = 0; d < 7; d++) {
        row.push(addDays(gridStart, w * 7 + d));
      }
      // Bỏ hàng thứ 6 nếu cả 7 ngày đều thuộc tháng sau
      if (w === 5 && row[0].getMonth() !== viewMonth.getMonth()) {
        break;
      }
      rows.push(row);
    }
    return rows;
  }, [viewMonth]);

  const monthTitle = `Tháng ${String(viewMonth.getMonth() + 1).padStart(2, "0")}/${viewMonth.getFullYear()}`;

  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 p-3.5">
      <div className="flex items-center justify-between gap-2 pb-2.5">
        <span className="text-xs font-semibold text-zinc-100">{monthTitle}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onJumpToday}
            className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
          >
            Hôm nay
          </button>
          <button
            type="button"
            onClick={() =>
              onChangeMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))
            }
            aria-label="Tháng trước"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() =>
              onChangeMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))
            }
            aria-label="Tháng sau"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 text-center text-[10px] font-medium text-zinc-500 pb-1">
        {SHORT_WEEKDAYS.map((wd) => (
          <span key={wd} className="py-1">
            {wd}
          </span>
        ))}
      </div>

      <div className="space-y-0.5">
        {weeks.map((row, rIdx) => {
          const rowStartIso = toLocalDateIso(row[0]);
          const rowEndIso = toLocalDateIso(row[6]);
          const isSelectedWeek =
            rowStartIso <= selectedWeekEndIso && rowEndIso >= selectedWeekStartIso;

          return (
            <div
              key={rIdx}
              className={`grid grid-cols-7 rounded-md ${
                isSelectedWeek ? "bg-zinc-800/55" : ""
              }`}
            >
              {row.map((day) => {
                const iso = toLocalDateIso(day);
                const inMonth = day.getMonth() === viewMonth.getMonth();
                const isToday = iso === todayIso;
                const hasExam = examDateSet.has(iso);
                const gcalColor = gcalDateColorMap.get(iso);

                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => onSelectDate(day)}
                    className={`flex flex-col items-center justify-center rounded py-1 text-[11px] font-mono tabular-nums transition-colors duration-100 cursor-pointer hover:bg-zinc-800 ${
                      isToday
                        ? "ring-1 ring-emerald-500/80 bg-emerald-950/60 font-semibold text-emerald-300"
                        : inMonth
                        ? "text-zinc-200"
                        : "text-zinc-600"
                    }`}
                  >
                    <span>{day.getDate()}</span>
                    <span className="mt-0.5 flex h-1.5 items-center gap-0.5">
                      {hasExam && (
                        <span
                          className="h-1 w-1 rounded-full bg-rose-400"
                          title="Có lịch thi"
                        />
                      )}
                      {gcalColor && (
                        <span
                          className="h-1 w-1 rounded-full"
                          style={{ backgroundColor: gcalColor }}
                          title="Có sự kiện cá nhân"
                        />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-center gap-3 border-t border-zinc-800/70 pt-2 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />
          Lịch thi
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
          Lịch cá nhân
        </span>
      </div>
    </div>
  );
};
