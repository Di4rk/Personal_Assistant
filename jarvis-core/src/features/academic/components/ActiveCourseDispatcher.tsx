/**
 * ActiveCourseDispatcher — Sprint v0.3.3
 *
 * Zero Decision Fatigue card: 1 môn học active, 1 deadline gần nhất,
 * 1 nút bấm. Không có nested cards, không có animation bounce.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │ [Mã môn] Tên đầy đủ          Target: 8.5    │
 *   │─────────────────────────────────────────────│
 *   │ GPA Simulator: Midterm x.x → Final cần y.y  │
 *   │─────────────────────────────────────────────│
 *   │ ⏰ Next Deadline   [3d 14h] ĐĂNG KÝ ĐỀ TÀI │
 *   │─────────────────────────────────────────────│
 *   │              ⚡ Open in VS Code              │
 *   └─────────────────────────────────────────────│
 */

import React, { useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock, ExternalLink, FolderOpen, Target, Zap } from "lucide-react";

// ============================================================
//  TYPES
// ============================================================

export interface ScrapedDeadline {
  id: string;
  course_code: string;
  title: string;
  due_timestamp: number; // Unix seconds
  due_date_raw: string;
  source_url: string;
}

export interface ActiveCourseDispatcherProps {
  /** Mã môn học: e.g. "SS009" */
  courseCode: string;
  /** Tên đầy đủ: e.g. "Kỹ năng mềm" */
  courseTitle: string;
  /** Điểm GPA mục tiêu */
  targetScore?: number;
  /** Điểm giữa kỳ (thang 10) */
  midtermScore?: number;
  /** Tỷ lệ điểm giữa kỳ (0-1), default 0.3 */
  midtermWeight?: number;
  /** Đường dẫn workspace folder */
  workspacePath?: string;
  /** Danh sách deadline (lấy từ DB, đã sort theo due_timestamp asc) */
  deadlines?: ScrapedDeadline[];
  className?: string;
}

// ============================================================
//  TIME HELPERS
// ============================================================

interface TimeLeft {
  total_seconds: number;
  days: number;
  hours: number;
  minutes: number;
  is_overdue: boolean;
}

function computeTimeLeft(dueTimestampSec: number): TimeLeft {
  const now = Math.floor(Date.now() / 1000);
  const diff = dueTimestampSec - now;
  if (diff <= 0) {
    return { total_seconds: diff, days: 0, hours: 0, minutes: 0, is_overdue: true };
  }
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  return { total_seconds: diff, days, hours, minutes, is_overdue: false };
}

function formatTimeLeft(tl: TimeLeft): string {
  if (tl.is_overdue) return "Đã hết hạn";
  if (tl.days > 0) return `${tl.days}d ${tl.hours}h`;
  if (tl.hours > 0) return `${tl.hours}h ${tl.minutes}m`;
  return `${tl.minutes}m`;
}

/** Badge urgency: đỏ < 24h, hổ phách ≤ 3 ngày, xanh lá > 3 ngày */
function urgencyClass(tl: TimeLeft): string {
  if (tl.is_overdue || tl.total_seconds < 86400) {
    return "bg-red-500/20 text-red-400 border-red-500/30";
  }
  if (tl.days <= 3) {
    return "bg-amber-500/20 text-amber-400 border-amber-500/30";
  }
  return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
}

// ============================================================
//  GPA SIMULATOR (inline — pure calculation)
// ============================================================

/**
 * Tính điểm cuối kỳ tối thiểu cần đạt để đạt target GPA.
 * Formula: target = midterm * midtermWeight + final * finalWeight
 * → final = (target - midterm * midtermWeight) / finalWeight
 */
function calcRequiredFinal(
  midterm: number,
  midtermWeight: number,
  target: number
): number | null {
  const finalWeight = 1 - midtermWeight;
  if (finalWeight <= 0) return null;
  const required = (target - midterm * midtermWeight) / finalWeight;
  return Math.max(0, Math.min(10, required));
}

// ============================================================
//  COMPONENT
// ============================================================

export const ActiveCourseDispatcher: React.FC<ActiveCourseDispatcherProps> = ({
  courseCode,
  courseTitle,
  targetScore = 8.5,
  midtermScore,
  midtermWeight = 0.3,
  workspacePath,
  deadlines = [],
  className = "",
}) => {
  // Lấy deadline gần nhất chưa quá hạn
  const nextDeadline = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return (
      deadlines
        .filter((d) => d.due_timestamp > now)
        .sort((a, b) => a.due_timestamp - b.due_timestamp)[0] ?? null
    );
  }, [deadlines]);

  const timeLeft = useMemo(
    () => (nextDeadline ? computeTimeLeft(nextDeadline.due_timestamp) : null),
    [nextDeadline]
  );

  // GPA simulator
  const requiredFinal = useMemo(() => {
    if (midtermScore === undefined || midtermScore === null) return null;
    return calcRequiredFinal(midtermScore, midtermWeight, targetScore);
  }, [midtermScore, midtermWeight, targetScore]);

  const finalGrade = useMemo((): string => {
    if (requiredFinal === null) return "–";
    if (requiredFinal >= 9.0) return "≥ 9.0 (Xuất sắc)";
    if (requiredFinal >= 8.0) return `${requiredFinal.toFixed(1)} (Giỏi)`;
    if (requiredFinal >= 6.5) return `${requiredFinal.toFixed(1)} (Khá)`;
    return `${requiredFinal.toFixed(1)}`;
  }, [requiredFinal]);

  const finalBadgeClass = useMemo(() => {
    if (requiredFinal === null) return "";
    if (requiredFinal >= 9.0) return "text-purple-400";
    if (requiredFinal >= 8.0) return "text-emerald-400";
    if (requiredFinal >= 6.5) return "text-blue-400";
    return "text-amber-400";
  }, [requiredFinal]);

  // Handlers
  const handleOpenVSCode = useCallback(async () => {
    if (!workspacePath) return;
    try {
      await invoke<void>("check_and_launch_vscode", {
        workspacePath,
      });
    } catch (e) {
      console.error("[ActiveCourseDispatcher] VS Code launch error:", e);
    }
  }, [workspacePath]);

  const handleOpenDeadlineLink = useCallback(() => {
    if (!nextDeadline?.source_url) return;
    window.open(nextDeadline.source_url, "_blank", "noopener,noreferrer");
  }, [nextDeadline]);

  return (
    <div
      className={[
        "rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm",
        "divide-y divide-white/8 overflow-hidden",
        className,
      ].join(" ")}
    >
      {/* ── HEADER: Course identity ── */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-xs font-bold tracking-wider text-slate-400 shrink-0">
            {courseCode}
          </span>
          <span
            className="truncate text-sm font-semibold text-slate-100"
            title={courseTitle}
          >
            {courseTitle}
          </span>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5">
          <Target className="h-3 w-3 text-blue-400" />
          <span className="text-xs font-semibold text-blue-300">
            Target: {targetScore.toFixed(1)}
          </span>
        </div>
      </div>

      {/* ── GPA TARGET SIMULATOR ── */}
      {midtermScore !== undefined && midtermScore !== null && (
        <div className="px-4 py-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-500">
            GPA Simulator
          </p>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm text-slate-400">
              Giữa kỳ:{" "}
              <span className="font-semibold text-slate-200">
                {midtermScore.toFixed(1)}
              </span>
            </span>
            <span className="text-slate-600">→</span>
            <span className="text-sm text-slate-400">
              Cuối kỳ cần:{" "}
              <span className={`font-bold text-base ${finalBadgeClass}`}>
                {finalGrade}
              </span>
            </span>
          </div>
          {requiredFinal !== null && requiredFinal >= 9.8 && (
            <p className="mt-1 text-xs text-amber-400/80">
              ⚠ Cần điểm gần tuyệt đối — xem xét lại target hoặc nộp muộn bù điểm
            </p>
          )}
        </div>
      )}

      {/* ── NEXT DEADLINE ── */}
      <div className="px-4 py-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          Next Critical Deadline
        </p>
        {nextDeadline && timeLeft ? (
          <div className="flex items-start justify-between gap-2">
            <button
              type="button"
              onClick={handleOpenDeadlineLink}
              className="group flex min-w-0 flex-1 items-start gap-2 text-left"
              title="Mở trong Moodle"
            >
              <span className="mt-0.5 shrink-0 text-slate-500 transition-colors group-hover:text-slate-300">
                <ExternalLink className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-200 group-hover:text-white transition-colors">
                  {nextDeadline.title}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {nextDeadline.due_date_raw}
                </p>
              </div>
            </button>
            <span
              className={[
                "shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-bold tabular-nums",
                urgencyClass(timeLeft),
              ].join(" ")}
            >
              {formatTimeLeft(timeLeft)}
            </span>
          </div>
        ) : (
          <p className="text-sm text-slate-500 italic">
            {deadlines.length === 0
              ? "Chưa có deadline nào được sync"
              : "Tất cả deadline đã qua hạn"}
          </p>
        )}
      </div>

      {/* ── CTA: Open VS Code ── */}
      <div className="px-4 py-3">
        <button
          type="button"
          id={`vscode-launch-${courseCode}`}
          onClick={handleOpenVSCode}
          disabled={!workspacePath}
          className={[
            "flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5",
            "text-sm font-semibold transition-all duration-150",
            workspacePath
              ? [
                  "bg-violet-600 text-white",
                  "hover:bg-violet-500 active:scale-95",
                  "shadow-lg shadow-violet-500/20",
                ].join(" ")
              : "cursor-not-allowed bg-slate-800 text-slate-500",
          ].join(" ")}
          title={workspacePath ?? "Chưa cấu hình workspace path"}
        >
          <Zap className="h-4 w-4" />
          {workspacePath ? (
            <span className="flex items-center gap-1.5">
              Open in VS Code
              <FolderOpen className="h-3.5 w-3.5 opacity-60" />
            </span>
          ) : (
            "Chưa cấu hình workspace"
          )}
        </button>
      </div>
    </div>
  );
};

export default ActiveCourseDispatcher;
