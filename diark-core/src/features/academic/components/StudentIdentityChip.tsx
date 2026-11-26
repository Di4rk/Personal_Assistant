import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getAcademicMacroMetricsSsot,
  getPortalRegisteredClasses,
  getStudentProfile,
  StudentProfilePayload,
} from "@/lib/tauri-client";
import { usePrivacyStore } from "@/stores/usePrivacyStore";
import { maskStudentId, maskFullName, maskClassName, formatVietnameseName } from "@/utils/masking";
import { Eye, EyeOff, UserCheck } from "lucide-react";

export function StudentIdentityChip() {
  const [profile, setProfile] = useState<StudentProfilePayload | null>(null);
  const [termBadge, setTermBadge] = useState<string>("Đang học");
  const isDemoMode = usePrivacyStore((s) => s.isDemoMode);
  const toggleDemoMode = usePrivacyStore((s) => s.toggleDemoMode);

  useEffect(() => {
    let isMounted = true;
    const loadIdentityAndTerm = () => {
      Promise.allSettled([
        getStudentProfile(),
        getPortalRegisteredClasses(),
        getAcademicMacroMetricsSsot(),
      ])
        .then(([profRes, clsRes, macroRes]) => {
          if (!isMounted) return;
          if (profRes.status === "fulfilled" && profRes.value) {
            setProfile(profRes.value);
          }
          const classes = clsRes.status === "fulfilled" ? clsRes.value : [];
          const macros = macroRes.status === "fulfilled" ? macroRes.value : [];
          if (classes.length > 0 && classes[0].hoc_ky > 0) {
            setTermBadge(`Đang học · Học kỳ ${classes[0].hoc_ky}`);
          } else if (macros.length > 0 && macros[macros.length - 1].semesterLabel) {
            setTermBadge(`Đang học · ${macros[macros.length - 1].semesterLabel}`);
          } else {
            setTermBadge("Đang học");
          }
        })
        .catch((err: unknown) => {
          console.error("Lỗi getStudentProfile:", err);
        });
    };

    loadIdentityAndTerm();

    const unlistenPromise = listen<StudentProfilePayload>(
      "student-profile-synced",
      (event) => {
        if (isMounted && event.payload) {
          setProfile(event.payload);
        }
      }
    );
    const unlistenExtra = listen("portal-extra-synced", () => {
      if (isMounted) loadIdentityAndTerm();
    });

    return () => {
      isMounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
      void unlistenExtra.then((unlisten) => unlisten());
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
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 rounded-lg bg-zinc-900/60 border border-zinc-800/80">
      {/* Tầng 1 & 2: Mini Identity Card */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-md bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-300 font-bold text-xs shrink-0">
          <UserCheck className="w-4 h-4" />
        </div>

        <div className="space-y-0.5">
          {/* Tầng 1: Họ tên chuẩn + Tag trạng thái học vụ */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-zinc-100 tracking-tight">
              {displayName}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 bg-emerald-950/50 border border-emerald-900/60 px-2 py-0.5 rounded-md">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              {termBadge}
            </span>
          </div>

          {/* Tầng 2: Metadata thu gọn: MSSV • Lớp • Hệ */}
          <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
            <span className="text-zinc-300 font-medium">MSSV: {displayId}</span>
            <span className="text-zinc-600">•</span>
            <span className="text-zinc-200 font-medium">Lớp: {displayClass}</span>
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
