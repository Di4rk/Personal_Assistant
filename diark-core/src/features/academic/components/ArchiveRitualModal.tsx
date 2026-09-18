import React, { useState } from "react";
import {
  Archive,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FolderArchive,
  FileCheck,
  Database,
  X,
} from "lucide-react";
import {
  archiveSemester,
  getVaultPath,
  type ArchiveSemesterResultDto,
} from "../../../lib/tauri-client";
import type { AcademicCourseRecord } from "../types";

export interface ArchiveRitualModalProps {
  isOpen: boolean;
  onClose: () => void;
  semesterId: string;
  courses: AcademicCourseRecord[];
  onArchiveSuccess?: (result: ArchiveSemesterResultDto) => void;
}

export const ArchiveRitualModal: React.FC<ArchiveRitualModalProps> = ({
  isOpen,
  onClose,
  semesterId,
  courses,
  onArchiveSuccess,
}) => {
  const [isArchiving, setIsArchiving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ArchiveSemesterResultDto | null>(null);

  if (!isOpen) return null;

  // Calculate semester grade summary
  let totalPoints10 = 0;
  let totalPoints4 = 0;
  let gradedCredits = 0;

  for (const c of courses) {
    if (c.summaryScore10 !== null && c.summaryScore10 !== undefined) {
      totalPoints10 += c.summaryScore10 * c.credits;
      if (c.summaryScore4 !== null && c.summaryScore4 !== undefined) {
        totalPoints4 += c.summaryScore4 * c.credits;
      }
      gradedCredits += c.credits;
    }
  }

  const termGpa10 = gradedCredits > 0 ? (totalPoints10 / gradedCredits).toFixed(2) : "0.00";
  const termGpa4 = gradedCredits > 0 ? (totalPoints4 / gradedCredits).toFixed(2) : "0.00";

  const handleExecuteArchive = async () => {
    try {
      setIsArchiving(true);
      setError(null);

      const vaultRoot = await getVaultPath();
      if (!vaultRoot || !vaultRoot.trim()) {
        setError("Vui lòng chọn thư mục Obsidian Vault trong cài đặt Vault trước khi thực hiện Nghi thức Đóng kỳ!");
        setIsArchiving(false);
        return;
      }

      const res = await archiveSemester(semesterId, vaultRoot);
      setResult(res);
      if (onArchiveSuccess) {
        onArchiveSuccess(res);
      }
    } catch (err) {
      console.error("[ArchiveRitualModal] Lỗi đóng kỳ:", err);
      setError(typeof err === "string" ? err : "Đã xảy ra lỗi khi thực thi Nghi thức Đóng kỳ");
    } finally {
      setIsArchiving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Archive className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>Nghi Thức Đóng Kỳ (Archive Ritual)</span>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                  {semesterId}
                </span>
              </h3>
              <p className="text-[11px] font-mono text-zinc-400">
                Chuẩn hóa dữ liệu điểm số, đồng bộ frontmatter và chuyển giao thư mục Vault
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            disabled={isArchiving}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Success View */}
        {result ? (
          <div className="space-y-4 py-2">
            <div className="p-4 rounded-xl bg-emerald-950/40 border border-emerald-800/50 space-y-2">
              <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                <CheckCircle2 className="h-5 w-5" />
                <span>Nghi thức Đóng kỳ thành công mỹ mãn!</span>
              </div>
              <p className="text-xs text-zinc-300">
                Đã hoàn tất đóng học kỳ <strong className="font-mono text-white">{result.semesterId}</strong> và đồng bộ toàn bộ ghi chú trên Obsidian.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                <span className="text-zinc-400 text-[11px]">Số môn học lưu trữ</span>
                <div className="text-base font-bold font-mono text-white">
                  {result.archivedCoursesCount} môn
                </div>
              </div>
              <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 space-y-1">
                <span className="text-zinc-400 text-[11px]">GPA Tổng kết kỳ</span>
                <div className="text-base font-bold font-mono text-emerald-400">
                  {result.summaryGpa10 !== null ? `${result.summaryGpa10}/10` : "—"}
                </div>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-xs space-y-1 font-mono">
              <div className="text-zinc-400 text-[11px]">Thư mục lưu trữ mới:</div>
              <div className="text-zinc-300 truncate text-[11px]">{result.movedTo}</div>
              <div className="text-emerald-400 text-[11px] pt-1">
                ✓ Đã cập nhật YAML frontmatter cho {result.updatedIndexFiles.length} file 00_Index.md
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                Hoàn tất & Đóng
              </button>
            </div>
          </div>
        ) : (
          /* Confirmation & Action View */
          <div className="space-y-4">
            {/* Semester Final Summary */}
            <div className="flex items-center justify-between p-3.5 rounded-lg bg-zinc-900/90 border border-zinc-800 text-xs">
              <div>
                <span className="text-zinc-400 block text-[11px]">Kết quả học tập học kỳ:</span>
                <span className="font-semibold text-zinc-200">
                  {courses.length} môn học ({gradedCredits} tín chỉ đã có điểm)
                </span>
              </div>
              <div className="text-right">
                <span className="text-zinc-400 block text-[11px]">Điểm trung bình học kỳ:</span>
                <span className="font-mono font-bold text-sm text-emerald-400">
                  {termGpa10}/10 ({termGpa4}/4)
                </span>
              </div>
            </div>

            {/* Ritual Steps Checklist */}
            <div className="space-y-2 rounded-lg bg-zinc-950/80 border border-zinc-800 p-3.5 text-xs">
              <span className="font-semibold text-zinc-300 block mb-1">
                Các tác vụ hệ thống sẽ tự động thi hành:
              </span>
              <div className="space-y-2 text-zinc-400 text-[11px]">
                <div className="flex items-start gap-2">
                  <FileCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Ghi điểm vào YAML frontmatter:</strong> Bổ sung điểm số (`final_score_10`, `grade_char`, `status: archived`) vào từng file `00_Index.md`.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <Database className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Cập nhật trạng thái SQLite:</strong> Đổi trạng thái môn học & học kỳ sang <code className="text-zinc-300">archived</code>.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <FolderArchive className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Di chuyển thư mục Vault:</strong> Dời thư mục học kỳ từ <code className="text-zinc-300">00_Current_Semester</code> vào <code className="text-zinc-300">01_Archive/{semesterId}/</code>.
                  </span>
                </div>
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800/50 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{error}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={onClose}
                disabled={isArchiving}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleExecuteArchive}
                disabled={isArchiving || courses.length === 0}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white transition-colors shadow-sm cursor-pointer border border-amber-500/30"
              >
                {isArchiving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-200" />
                    <span>Đang thực thi Nghi thức...</span>
                  </>
                ) : (
                  <>
                    <Archive className="h-3.5 w-3.5 text-amber-200" />
                    <span>Xác nhận Đóng kỳ</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
