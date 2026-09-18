import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getStudentProfile, StudentProfilePayload } from "@/lib/tauri-client";
import { usePrivacyStore } from "@/stores/usePrivacyStore";
import { maskStudentId, maskFullName, maskClassName, formatVietnameseName } from "@/utils/masking";
import { Eye, EyeOff, UserCheck } from "lucide-react";

export function StudentIdentityChip() {
  const [profile, setProfile] = useState<StudentProfilePayload | null>(null);
  const isDemoMode = usePrivacyStore((s) => s.isDemoMode);
  const toggleDemoMode = usePrivacyStore((s) => s.toggleDemoMode);

  useEffect(() => {
    let isMounted = true;
    getStudentProfile()
      .then((data) => {
        if (isMounted && data) {
          setProfile(data);
        }
      })
      .catch((err: unknown) => {
        console.error("Lỗi getStudentProfile:", err);
      });

    const unlistenPromise = listen<StudentProfilePayload>(
      "student-profile-synced",
      (event) => {
        if (isMounted && event.payload) {
          setProfile(event.payload);
        }
      }
    );

    return () => {
      isMounted = false;
      void unlistenPromise.then((unlisten) => {
        unlisten();
      });
    };
  }, []);

  if (!profile || !profile.student_id) return null;

  const rawFullName = formatVietnameseName(profile.full_name);
  const displayName = isDemoMode ? maskFullName(rawFullName) : rawFullName;
  const displayId = isDemoMode ? maskStudentId(profile.student_id) : profile.student_id;
  const displayClass = isDemoMode ? maskClassName(profile.student_class) : profile.student_class;

  // Xác định hệ đào tạo chuẩn từ curriculum_code hoặc specialization
  const trainingSystem = (() => {
    const code = (profile.curriculum_code || "").toUpperCase();
    if (code.includes("CLC")) return "Chất lượng cao";
    if (code.includes("CTTT")) return "Tiên tiến";
    if (code.includes("KHTN")) return "Tài năng";
    return "Chuẩn";
  })();

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 rounded-xl bg-zinc-900/90 border border-zinc-800 shadow-md">
      {/* Tầng 1 & 2: Mini Identity Card */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-violet-950/70 border border-violet-800/50 flex items-center justify-center text-violet-400 font-bold text-xs shrink-0 shadow-inner">
          <UserCheck className="w-4 h-4" />
        </div>

        <div className="space-y-0.5">
          {/* Tầng 1: Họ tên chuẩn + Tag trạng thái học vụ */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-zinc-100 tracking-tight">
              {displayName}
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 px-2 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Đang học - Học kỳ 2
            </span>
          </div>

          {/* Tầng 2: Metadata thu gọn: MSSV • Lớp • Hệ */}
          <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
            <span className="text-zinc-300 font-medium">MSSV: {displayId}</span>
            <span className="text-zinc-600">•</span>
            <span className="text-cyan-400 font-medium">Lớp: {displayClass}</span>
            <span className="text-zinc-600">•</span>
            <span className="text-zinc-400 font-sans">Hệ: {trainingSystem}</span>
            {profile.cohort && (
              <>
                <span className="text-zinc-600">•</span>
                <span className="text-zinc-400 font-sans">{profile.cohort}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Nút bật/tắt Privacy Mode (Chỉ đổi icon con mắt) */}
      <div className="flex items-center self-end sm:self-center">
        <button
          type="button"
          onClick={toggleDemoMode}
          className={`p-2 rounded-lg border transition-colors cursor-pointer ${
            isDemoMode
              ? "bg-zinc-800 text-zinc-100 border-zinc-700 hover:bg-zinc-700"
              : "bg-zinc-900/80 text-zinc-400 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-200"
          }`}
          title={isDemoMode ? "Chế độ riêng tư: Đang bật (Click để hiện thông tin)" : "Chế độ riêng tư: Đang tắt (Click để ẩn thông tin)"}
          aria-label="Toggle Privacy Mode"
        >
          {isDemoMode ? (
            <EyeOff className="w-4 h-4 text-zinc-200" />
          ) : (
            <Eye className="w-4 h-4 text-zinc-400" />
          )}
        </button>
      </div>
    </div>
  );
}
