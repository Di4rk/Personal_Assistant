import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Calendar,
  Clock,
  MapPin,
  CheckSquare,
  Square,
  Bell,
  Sparkles,
  ClipboardPaste,
  Code2,
  Check,
  AlertCircle,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Plus,
  Trash2,
} from "lucide-react";
import type { AcademicExamRecord, ExamChecklistItem, PortalExamItemDto } from "../types";
import {
  getExamSchedules,
  syncExamSchedules,
  updateExamChecklist,
  triggerDailyBriefing,
  type DailyBriefingDto,
} from "../../../lib/tauri-client";
import { PORTAL_EXAM_SCHEDULE_SYNC_SCRIPT } from "../utils/browserSyncScripts";

interface ExamRadarCardProps {
  className?: string;
}

interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isPast: boolean;
  totalSeconds: number;
}

function calculateCountdown(targetTimestamp: number): Countdown {
  const now = Math.floor(Date.now() / 1000);
  const diff = targetTimestamp - now;

  if (diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, isPast: true, totalSeconds: 0 };
  }

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;

  return { days, hours, minutes, seconds, isPast: false, totalSeconds: diff };
}

function parseChecklist(jsonStr: string): ExamChecklistItem[] {
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    // fallback
  }
  return [];
}

function formatExamFormat(format: string): { label: string; color: string } {
  const f = format.toLowerCase().trim();
  if (f === "tl" || f === "essay") {
    return { label: "Tự luận", color: "bg-blue-950/70 text-blue-300 border-blue-800" };
  }
  if (f === "tn" || f === "multiple_choice") {
    return { label: "Trắc nghiệm", color: "bg-emerald-950/70 text-emerald-300 border-emerald-800" };
  }
  if (f === "practical" || f === "th") {
    return { label: "Thực hành Máy tính", color: "bg-purple-950/70 text-purple-300 border-purple-800" };
  }
  if (f === "oral" || f === "vd") {
    return { label: "Vấn đáp", color: "bg-amber-950/70 text-amber-300 border-amber-800" };
  }
  return { label: format || "Chưa rõ", color: "bg-slate-800 text-slate-300 border-slate-700" };
}

function formatExamTerm(term: string): string {
  const t = term.toLowerCase().trim();
  if (t === "final_term" || t === "cuối kỳ" || t === "ck") return "Thi Cuối Kỳ";
  if (t === "midterm" || t === "giữa kỳ" || t === "gk") return "Thi Giữa Kỳ";
  return term || "Kỳ thi";
}

export const ExamRadarCard: React.FC<ExamRadarCardProps> = ({ className = "" }) => {
  const [exams, setExams] = useState<AcademicExamRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [nowTs, setNowTs] = useState<number>(Math.floor(Date.now() / 1000));
  const [expandedExamId, setExpandedExamId] = useState<number | null>(null);

  // Modal dán JSON / Script đồng bộ
  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [jsonInput, setJsonInput] = useState<string>("");
  const [importStatus, setImportStatus] = useState<string>("");
  const [copiedScript, setCopiedScript] = useState<boolean>(false);

  // Daily Briefing test state
  const [briefingResult, setBriefingResult] = useState<DailyBriefingDto | null>(null);
  const [briefingLoading, setBriefingLoading] = useState<boolean>(false);

  // Load danh sách lịch thi từ DB
  const loadExams = useCallback(async () => {
    try {
      const records = await getExamSchedules();
      setExams(records);
    } catch (err) {
      console.error("[ExamRadarCard] Lỗi tải lịch thi:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  // 1. Phân loại ca thi sắp tới và đã qua (không chạy lại mỗi giây, giảm tải CPU)
  const { upcomingExams, pastExams } = useMemo(() => {
    const currentEpoch = Math.floor(Date.now() / 1000);
    const upcoming: AcademicExamRecord[] = [];
    const past: AcademicExamRecord[] = [];
    for (const e of exams) {
      if (e.exam_timestamp >= currentEpoch) {
        upcoming.push(e);
      } else {
        past.push(e);
      }
    }
    return { upcomingExams: upcoming, pastExams: past };
  }, [exams, nowTs >= (exams[0]?.exam_timestamp ?? 0)]);

  const nextExam = upcomingExams[0] || null;

  // 2. Chỉ kích hoạt timer 1s khi THỰC SỰ có ca thi sắp tới — idle footprint tối thiểu
  useEffect(() => {
    if (!nextExam) return;
    const timer = setInterval(() => {
      setNowTs(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [nextExam?.exam_timestamp]);

  // 3. Countdown của ca thi gần nhất
  const countdown = useMemo(() => {
    if (!nextExam) return null;
    return calculateCountdown(nextExam.exam_timestamp);
  }, [nextExam, nowTs]);

  // 4. Khi ca thi vừa kết thúc, tự động refresh danh sách
  useEffect(() => {
    if (countdown?.isPast && nextExam) {
      loadExams();
    }
  }, [countdown?.isPast, nextExam, loadExams]);

  // Checkbox toggle handler
  const handleToggleChecklist = async (exam: AcademicExamRecord, itemId: string) => {
    const currentList = parseChecklist(exam.checklist_items);
    const updatedList = currentList.map((item) =>
      item.id === itemId ? { ...item, is_checked: !item.is_checked } : item
    );
    const updatedJson = JSON.stringify(updatedList);

    // Optimistic UI update
    setExams((prev) =>
      prev.map((e) => (e.id === exam.id ? { ...e, checklist_items: updatedJson } : e))
    );

    try {
      await updateExamChecklist(exam.id, updatedJson);
    } catch (err) {
      console.error("[ExamRadarCard] Lỗi cập nhật checklist:", err);
      // rollback
      loadExams();
    }
  };

  // Thêm item mới vào checklist
  const handleAddChecklistItem = async (exam: AcademicExamRecord, label: string) => {
    if (!label.trim()) return;
    const currentList = parseChecklist(exam.checklist_items);
    const newItem: ExamChecklistItem = {
      id: `custom_${Date.now()}`,
      label: label.trim(),
      is_checked: false,
    };
    const updatedList = [...currentList, newItem];
    const updatedJson = JSON.stringify(updatedList);

    setExams((prev) =>
      prev.map((e) => (e.id === exam.id ? { ...e, checklist_items: updatedJson } : e))
    );

    try {
      await updateExamChecklist(exam.id, updatedJson);
    } catch (err) {
      console.error("[ExamRadarCard] Lỗi thêm item:", err);
      loadExams();
    }
  };

  // Xóa item khỏi checklist
  const handleRemoveChecklistItem = async (exam: AcademicExamRecord, itemId: string) => {
    const currentList = parseChecklist(exam.checklist_items);
    const updatedList = currentList.filter((item) => item.id !== itemId);
    const updatedJson = JSON.stringify(updatedList);

    setExams((prev) =>
      prev.map((e) => (e.id === exam.id ? { ...e, checklist_items: updatedJson } : e))
    );

    try {
      await updateExamChecklist(exam.id, updatedJson);
    } catch (err) {
      console.error("[ExamRadarCard] Lỗi xóa item:", err);
      loadExams();
    }
  };

  // Xử lý nạp JSON lịch thi
  const handleImportJson = async () => {
    if (!jsonInput.trim()) {
      setImportStatus("Vui lòng dán dữ liệu JSON lịch thi.");
      return;
    }

    try {
      let rawObj;
      try {
        rawObj = JSON.parse(jsonInput.trim());
      } catch {
        throw new Error("JSON không hợp lệ. Vui lòng kiểm tra cú pháp.");
      }

      let items: PortalExamItemDto[] = [];
      if (Array.isArray(rawObj)) {
        items = rawObj;
      } else if (rawObj && Array.isArray(rawObj.items)) {
        items = rawObj.items;
      } else {
        throw new Error("Dữ liệu JSON không chứa mảng lịch thi (items).");
      }

      setImportStatus("Đang lưu lịch thi vào SQLite...");
      const count = await syncExamSchedules({ items });
      setImportStatus(`✅ Đã nạp thành công ${count} ca thi vào Exam Radar!`);
      setJsonInput("");
      await loadExams();
      setTimeout(() => {
        setShowImportModal(false);
        setImportStatus("");
      }, 1200);
    } catch (err) {
      setImportStatus(`Lỗi: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Điền mẫu thử nghiệm Giữa kỳ
  const handleLoadMidtermSample = () => {
    const sample = {
      items: [
        {
          id: 1,
          subject_code: "IT012",
          subject_name: "Tổ chức và cấu trúc máy tính 2",
          section_class_id: "IT012.Q22",
          section_class_code: "IT012.Q22",
          format: "tl",
          examination: "midterm",
          shift: "3",
          start_time: "13:30",
          end_time: "15:30",
          weekday: "Thứ 3",
          date: "07/04/2026",
          room: "B1.18",
          absent: "Không",
          note: "",
        },
        {
          id: 2,
          subject_code: "MA004",
          subject_name: "Cấu trúc rời rạc",
          section_class_id: "MA004.Q217",
          section_class_code: "MA004.Q217",
          format: "tl",
          examination: "midterm",
          shift: "2",
          start_time: "09:30",
          end_time: "11:30",
          weekday: "Thứ 2",
          date: "06/04/2026",
          room: "C309",
          absent: "Không",
          note: "",
        },
        {
          id: 3,
          subject_code: "MA005",
          subject_name: "Xác suất thống kê",
          section_class_id: "MA005.Q219",
          section_class_code: "MA005.Q219",
          format: "tl",
          examination: "midterm",
          shift: "2",
          start_time: "09:30",
          end_time: "11:30",
          weekday: "Thứ 4",
          date: "08/04/2026",
          room: "B1.04",
          absent: "Không",
          note: "",
        },
      ],
    };
    setJsonInput(JSON.stringify(sample, null, 2));
  };

  // Điền mẫu thử nghiệm Cuối kỳ
  const handleLoadFinaltermSample = () => {
    const sample = {
      items: [
        {
          id: 1,
          subject_code: "IT012",
          subject_name: "Tổ chức và cấu trúc máy tính 2",
          section_class_id: "IT012.Q22",
          section_class_code: "IT012.Q22",
          format: "essay",
          examination: "final_term",
          shift: "3",
          start_time: "13:30",
          end_time: "15:30",
          weekday: "Thứ 5",
          date: "09/07/2026",
          room: "B3.12",
          absent: "Không",
          note: "Xác nhận đủ_Nguyễn Hiếu Nghĩa_09/07/2026 08:17:53\n",
        },
        {
          id: 2,
          subject_code: "MA004",
          subject_name: "Cấu trúc rời rạc",
          section_class_id: "MA004.Q217",
          section_class_code: "MA004.Q217",
          format: "essay",
          examination: "final_term",
          shift: "2",
          start_time: "09:30",
          end_time: "11:30",
          weekday: "Thứ 4",
          date: "08/07/2026",
          room: "C309",
          absent: "Không",
          note: "Xác nhận đủ_Lê Anh Tuấn_08/07/2026 03:26:37\n",
        },
        {
          id: 3,
          subject_code: "IT003",
          subject_name: "Cấu trúc dữ liệu và giải thuật",
          section_class_id: "IT003.Q27",
          section_class_code: "IT003.Q27",
          format: "essay",
          examination: "final_term",
          shift: "2",
          start_time: "09:30",
          end_time: "11:30",
          weekday: "Thứ 5",
          date: "09/07/2026",
          room: "B3.20",
          absent: "Không",
          note: "",
        },
        {
          id: 4,
          subject_code: "IT002",
          subject_name: "Lập trình hướng đối tượng",
          section_class_id: "IT002.Q24",
          section_class_code: "IT002.Q24",
          format: "essay",
          examination: "final_term",
          shift: "2",
          start_time: "09:30",
          end_time: "11:30",
          weekday: "Thứ 6",
          date: "10/07/2026",
          room: "B4.20",
          absent: "Không",
          note: "",
        },
        {
          id: 5,
          subject_code: "SS007",
          subject_name: "Triết học Mác – Lênin",
          section_class_id: "SS007.Q26",
          section_class_code: "SS007.Q26",
          format: "essay",
          examination: "final_term",
          shift: "3",
          start_time: "13:30",
          end_time: "15:30",
          weekday: "Thứ 6",
          date: "10/07/2026",
          room: "B1.16",
          absent: "Không",
          note: "Xác nhận đủ_Đào Đức Cơ_10/07/2026 06:51:14",
        },
        {
          id: 6,
          subject_code: "MA005",
          subject_name: "Xác suất thống kê",
          section_class_id: "MA005.Q219",
          section_class_code: "MA005.Q219",
          format: "essay",
          examination: "final_term",
          shift: "2",
          start_time: "09:30",
          end_time: "11:30",
          weekday: "Thứ 2",
          date: "13/07/2026",
          room: "B1.04",
          absent: "Không",
          note: "",
        },
      ],
    };
    setJsonInput(JSON.stringify(sample, null, 2));
  };

  // Kích hoạt Daily Briefing
  const handleTriggerBriefing = async () => {
    setBriefingLoading(true);
    try {
      const res = await triggerDailyBriefing();
      setBriefingResult(res);
      setTimeout(() => setBriefingResult(null), 8000);
    } catch (err) {
      console.error("[ExamRadarCard] Lỗi kích hoạt Briefing:", err);
    } finally {
      setBriefingLoading(false);
    }
  };

  // Sao chép Console Script
  const handleCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(PORTAL_EXAM_SCHEDULE_SYNC_SCRIPT);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 2500);
    } catch (err) {
      console.error("Lỗi copy script:", err);
    }
  };

  return (
    <div
      className={`bg-slate-900/95 border border-slate-800 rounded-xl p-5 shadow-xl text-slate-200 transition-all ${className}`}
    >
      {/* 1. Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 shadow-inner">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold tracking-tight text-white uppercase">
                Exam Radar — Lịch Thi & Đếm Ngược
              </h2>
              <span className="px-2 py-0.5 text-xs font-semibold rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                v0.7.0
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Đồng bộ chính thức Portal UIT • Đếm ngược ca thi, phòng thi & checklist phòng thi
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleTriggerBriefing}
            disabled={briefingLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
            title="Bắn thử thông báo Windows Native qua khay hệ thống"
          >
            <Bell className={`w-3.5 h-3.5 ${briefingLoading ? "animate-spin text-amber-400" : "text-amber-400"}`} />
            <span>{briefingLoading ? "Đang gửi..." : "Daily Briefing"}</span>
          </button>

          <button
            onClick={() => setShowImportModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            <ClipboardPaste className="w-3.5 h-3.5 text-sky-400" />
            <span>Nạp Lịch Thi</span>
          </button>

          <button
            onClick={handleCopyScript}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition"
            title="Copy script dán vào F12 Console trên trang portal.uit.edu.vn"
          >
            {copiedScript ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Code2 className="w-3.5 h-3.5" />}
            <span>{copiedScript ? "Đã copy Script!" : "Script Portal"}</span>
          </button>
        </div>
      </div>

      {/* Thông báo kết quả Daily Briefing */}
      {briefingResult && (
        <div className="mt-3 p-3 rounded-lg bg-amber-950/40 border border-amber-500/30 text-xs flex items-start gap-2.5 animate-fadeIn">
          <Bell className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold text-amber-300">{briefingResult.title}</div>
            <div className="text-slate-300 whitespace-pre-line mt-0.5">{briefingResult.message}</div>
          </div>
        </div>
      )}

      {/* 2. Hero Section: Ca thi sắp tới & Đồng hồ đếm ngược */}
      {loading ? (
        <div className="py-12 flex flex-col items-center justify-center gap-2 text-slate-400">
          <RefreshCw className="w-6 h-6 animate-spin text-amber-400" />
          <span className="text-xs">Đang nạp dữ liệu lịch thi từ SQLite...</span>
        </div>
      ) : nextExam && countdown ? (
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Cột trái: Countdown & Chi tiết ca thi */}
          <div className="lg:col-span-7 bg-slate-950/70 border border-slate-800/80 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="text-xs font-semibold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                  Ca Thi Sắp Tới
                </span>
                <span className="text-xs font-mono text-slate-400">
                  {nextExam.weekday}, {nextExam.date_str}
                </span>
              </div>

              {/* Tên môn học */}
              <h3 className="text-lg font-bold text-white tracking-tight leading-snug">
                {nextExam.subject_name}
              </h3>
              <div className="text-xs font-mono text-slate-400 mt-0.5">
                Mã môn: <span className="text-slate-200 font-semibold">{nextExam.subject_code}</span>
                {nextExam.section_class_code ? ` • Lớp: ${nextExam.section_class_code}` : ""}
              </div>

              {/* Badges thông tin: Hình thức, Kỳ thi, Phòng, Ca */}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {(() => {
                  const fmt = formatExamFormat(nextExam.format);
                  return (
                    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${fmt.color}`}>
                      {fmt.label}
                    </span>
                  );
                })()}

                <span className="px-2 py-0.5 text-xs font-medium rounded bg-slate-800 text-slate-300 border border-slate-700">
                  {formatExamTerm(nextExam.examination)}
                </span>

                <span className="px-2.5 py-0.5 text-xs font-bold rounded bg-amber-500/10 text-amber-300 border border-amber-500/30 flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {nextExam.room || "Phòng chưa xếp"}
                </span>

                <span className="px-2 py-0.5 text-xs font-medium rounded bg-slate-800 text-slate-300 border border-slate-700 flex items-center gap-1">
                  <Clock className="w-3 h-3 text-slate-400" />
                  Ca {nextExam.shift}: {nextExam.start_time} - {nextExam.end_time}
                </span>

                {nextExam.seat_number && nextExam.seat_number !== "0" && (
                  <span className="px-2 py-0.5 text-xs font-mono font-semibold rounded bg-indigo-950/60 text-indigo-300 border border-indigo-800">
                    SBD: {nextExam.seat_number}
                  </span>
                )}
              </div>

              {/* Ghi chú thi */}
              {nextExam.note && (
                <div className="mt-3 text-xs text-amber-300/90 bg-amber-950/20 border border-amber-500/20 rounded p-2 flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-amber-200">Ghi chú:</strong> {nextExam.note}
                  </span>
                </div>
              )}
            </div>

            {/* Đồng hồ đếm ngược số to chuẩn Dark Grid */}
            <div className="mt-5 pt-4 border-t border-slate-800/80">
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-2xl md:text-3xl font-mono font-black text-white tracking-tight">
                    {String(countdown.days).padStart(2, "0")}
                  </div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Ngày</div>
                </div>

                <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-2xl md:text-3xl font-mono font-black text-amber-400 tracking-tight">
                    {String(countdown.hours).padStart(2, "0")}
                  </div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Giờ</div>
                </div>

                <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-2xl md:text-3xl font-mono font-black text-amber-400 tracking-tight">
                    {String(countdown.minutes).padStart(2, "0")}
                  </div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Phút</div>
                </div>

                <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-2xl md:text-3xl font-mono font-black text-emerald-400 tracking-tight">
                    {String(countdown.seconds).padStart(2, "0")}
                  </div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Giây</div>
                </div>
              </div>
            </div>
          </div>

          {/* Cột phải: Checklist đồ dùng phòng thi */}
          <div className="lg:col-span-5 bg-slate-950/70 border border-slate-800/80 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-200">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Checklist Đồ Dùng Phòng Thi</span>
                </div>
                {(() => {
                  const items = parseChecklist(nextExam.checklist_items);
                  const checkedCount = items.filter((i) => i.is_checked).length;
                  return (
                    <span className="text-xs font-mono font-semibold text-emerald-400">
                      {checkedCount}/{items.length} sẵn sàng
                    </span>
                  );
                })()}
              </div>

              {/* Progress bar */}
              {(() => {
                const items = parseChecklist(nextExam.checklist_items);
                const checkedCount = items.filter((i) => i.is_checked).length;
                const pct = items.length > 0 ? Math.round((checkedCount / items.length) * 100) : 0;
                return (
                  <div className="w-full bg-slate-800 rounded-full h-1.5 mb-3 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                );
              })()}

              {/* Danh sách checkboxes */}
              <div className="space-y-2 mt-3 max-h-56 overflow-y-auto pr-1">
                {parseChecklist(nextExam.checklist_items).map((item) => (
                  <div
                    key={item.id}
                    onClick={() => handleToggleChecklist(nextExam, item.id)}
                    className={`flex items-center justify-between p-2 rounded-lg border text-xs cursor-pointer select-none transition ${
                      item.is_checked
                        ? "bg-emerald-950/20 border-emerald-900/50 text-slate-300"
                        : "bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {item.is_checked ? (
                        <CheckSquare className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-500 shrink-0" />
                      )}
                      <span className={item.is_checked ? "line-through text-slate-500" : "font-medium text-slate-200"}>
                        {item.label}
                      </span>
                    </div>

                    {item.id.startsWith("custom_") && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveChecklistItem(nextExam, item.id);
                        }}
                        className="text-slate-500 hover:text-rose-400 p-0.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Thêm đồ dùng mới */}
            <div className="mt-4 pt-3 border-t border-slate-800/80">
              <AddChecklistInput onAdd={(label) => handleAddChecklistItem(nextExam, label)} />
            </div>
          </div>
        </div>
      ) : (
        /* Empty State */
        <div className="mt-5 py-10 px-6 rounded-xl bg-slate-950/60 border border-slate-800 text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
            <Sparkles className="w-6 h-6 text-amber-400" />
          </div>
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">
            {exams.length > 0 ? "🎉 Đã Hoàn Thành Tất Cả Ca Thi!" : "Chưa Có Lịch Thi Nào"}
          </h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
            {exams.length > 0
              ? "Tất cả các môn thi trong danh sách đã diễn ra. Chúc mừng bạn đã hoàn thành kỳ thi!"
              : "Nhấn 'Script Portal' rồi dán vào Console trên Portal UIT, hoặc bấm 'Nạp Lịch Thi' để dán JSON."}
          </p>
          <div className="flex justify-center gap-2 mt-4">
            <button
              onClick={() => setShowImportModal(true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 transition"
            >
              Nạp dữ liệu lịch thi
            </button>
          </div>
        </div>
      )}

      {/* 3. Danh sách toàn bộ ca thi (Timeline Table) */}
      {exams.length > 0 && (
        <div className="mt-6 pt-4 border-t border-slate-800">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
              <span>Toàn Bộ Ca Thi Kỳ Này ({exams.length} môn)</span>
              <span className="px-2 py-0.5 text-[10px] rounded bg-slate-800 text-slate-400 border border-slate-700">
                {upcomingExams.length} sắp thi • {pastExams.length} đã thi
              </span>
            </div>
          </div>

          <div className="space-y-2">
            {exams.map((exam) => {
              const isUpcoming = exam.exam_timestamp >= nowTs;
              const isExpanded = expandedExamId === exam.id;
              const checklistItems = parseChecklist(exam.checklist_items);
              const checkedCount = checklistItems.filter((i) => i.is_checked).length;
              const fmt = formatExamFormat(exam.format);

              return (
                <div
                  key={exam.id}
                  className={`rounded-lg border transition ${
                    isUpcoming
                      ? "bg-slate-950/60 border-slate-800 hover:border-slate-700"
                      : "bg-slate-950/30 border-slate-800/50 opacity-70"
                  }`}
                >
                  <div
                    onClick={() => setExpandedExamId(isExpanded ? null : exam.id)}
                    className="p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 cursor-pointer select-none"
                  >
                    <div className="flex items-start md:items-center gap-3">
                      {/* Cột ngày giờ */}
                      <div className="min-w-28 text-left">
                        <div className="text-xs font-bold font-mono text-white">{exam.date_str}</div>
                        <div className="text-[11px] text-slate-400">
                          {exam.weekday} • Ca {exam.shift} ({exam.start_time})
                        </div>
                      </div>

                      {/* Tên môn học */}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">{exam.subject_name}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                            {exam.subject_code}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                          <span>{formatExamTerm(exam.examination)}</span>
                          <span>•</span>
                          <span className="font-semibold text-amber-300">Phòng {exam.room}</span>
                          {exam.seat_number && exam.seat_number !== "0" && (
                            <>
                              <span>•</span>
                              <span className="font-mono text-indigo-300">SBD: {exam.seat_number}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Trạng thái & Badges */}
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-0.5 text-[11px] font-medium rounded border ${fmt.color}`}>
                        {fmt.label}
                      </span>

                      <span
                        className={`text-xs font-mono px-2 py-0.5 rounded border ${
                          checkedCount === checklistItems.length && checklistItems.length > 0
                            ? "bg-emerald-950/50 text-emerald-300 border-emerald-800"
                            : "bg-slate-800 text-slate-400 border-slate-700"
                        }`}
                      >
                        ✓ {checkedCount}/{checklistItems.length}
                      </span>

                      {isUpcoming ? (
                        <span className="text-[11px] font-semibold text-amber-400">Sắp thi</span>
                      ) : (
                        <span className="text-[11px] text-slate-500">Đã thi</span>
                      )}

                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-slate-400" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-slate-400" />
                      )}
                    </div>
                  </div>

                  {/* Expanded Checklist Sub-drawer */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-slate-800/80 bg-slate-950/80">
                      <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Checklist đồ dùng cho môn {exam.subject_code}</span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
                        {checklistItems.map((item) => (
                          <div
                            key={item.id}
                            onClick={() => handleToggleChecklist(exam, item.id)}
                            className={`flex items-center justify-between p-2 rounded border text-xs cursor-pointer select-none ${
                              item.is_checked
                                ? "bg-emerald-950/20 border-emerald-900/40 text-slate-300"
                                : "bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              {item.is_checked ? (
                                <CheckSquare className="w-4 h-4 text-emerald-400 shrink-0" />
                              ) : (
                                <Square className="w-4 h-4 text-slate-500 shrink-0" />
                              )}
                              <span className={item.is_checked ? "line-through text-slate-500" : ""}>
                                {item.label}
                              </span>
                            </div>

                            {item.id.startsWith("custom_") && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveChecklistItem(exam, item.id);
                                }}
                                className="text-slate-500 hover:text-rose-400"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>

                      <AddChecklistInput onAdd={(label) => handleAddChecklistItem(exam, label)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. Modal nạp JSON / Dán lịch thi */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-xl w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2 text-white font-bold text-base">
                <ClipboardPaste className="w-5 h-5 text-amber-400" />
                <span>Nạp Lịch Thi Chính Thức Từ Portal</span>
              </div>
              <button
                onClick={() => setShowImportModal(false)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300">
              Dán mảng JSON ca thi hoặc đối tượng <code className="bg-slate-800 px-1 py-0.5 rounded text-amber-300">&#123; "items": [...] &#125;</code> từ API{" "}
              <span className="font-mono text-sky-400">https://portal.uit.edu.vn/api/sv/exam-schedule</span>.
            </p>

            <textarea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              placeholder="Dán JSON lịch thi vào đây..."
              rows={8}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-xs text-slate-200 focus:outline-none focus:border-amber-500"
            />

            {importStatus && (
              <div
                className={`text-xs p-2.5 rounded ${
                  importStatus.startsWith("✅")
                    ? "bg-emerald-950/50 text-emerald-300 border border-emerald-800"
                    : "bg-rose-950/50 text-rose-300 border border-rose-800"
                }`}
              >
                {importStatus}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-slate-400">Dữ liệu mẫu UIT:</span>
                <button
                  type="button"
                  onClick={handleLoadMidtermSample}
                  className="text-xs text-amber-400 hover:text-amber-300 underline"
                >
                  Giữa kỳ (3 môn)
                </button>
                <span className="text-slate-600">•</span>
                <button
                  type="button"
                  onClick={handleLoadFinaltermSample}
                  className="text-xs text-amber-400 hover:text-amber-300 underline"
                >
                  Cuối kỳ (6 môn)
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                >
                  Đóng
                </button>
                <button
                  type="button"
                  onClick={handleImportJson}
                  className="px-4 py-1.5 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 transition"
                >
                  Lưu Lịch Thi
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Component con để nhập item mới vào checklist
const AddChecklistInput: React.FC<{ onAdd: (label: string) => void }> = ({ onAdd }) => {
  const [val, setVal] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (val.trim()) {
      onAdd(val.trim());
      setVal("");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="+ Thêm đồ dùng cần mang (VD: Áo khoác, Thước kẻ)..."
        className="flex-1 bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-slate-700"
      />
      <button
        type="submit"
        disabled={!val.trim()}
        className="px-2.5 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40 transition flex items-center gap-1"
      >
        <Plus className="w-3 h-3" />
        <span>Thêm</span>
      </button>
    </form>
  );
};
