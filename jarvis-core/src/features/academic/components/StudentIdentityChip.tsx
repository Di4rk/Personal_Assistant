import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getStudentProfile, StudentProfilePayload } from "@/lib/tauri-client";
import { usePrivacyStore } from "@/stores/usePrivacyStore";
import { maskStudentId, maskFullName, maskClassName } from "@/utils/masking";

export function StudentIdentityChip() {
  const [profile, setProfile] = useState<StudentProfilePayload | null>(null);
  const isDemoMode = usePrivacyStore((s) => s.isDemoMode);

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

  if (!profile) return null;

  const displayName = isDemoMode ? maskFullName(profile.full_name) : profile.full_name;
  const displayId = isDemoMode ? maskStudentId(profile.student_id) : profile.student_id;
  const displayClass = isDemoMode ? maskClassName(profile.student_class) : profile.student_class;

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-400 shadow-sm">
      <span className="font-mono font-medium text-slate-200">{displayName}</span>
      <span className="text-slate-600">•</span>
      <span className="font-mono text-slate-300">{displayId}</span>
      <span className="text-slate-600">•</span>
      <span className="text-cyan-400/90">{displayClass}</span>
      <span className="text-slate-600">•</span>
      <span className="text-slate-400">{profile.faculty}</span>
    </div>
  );
}
