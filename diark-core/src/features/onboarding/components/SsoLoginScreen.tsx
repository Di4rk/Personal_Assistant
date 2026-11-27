import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, Trash2, X } from "lucide-react";
import uitLogoMono from "../../../assets/uit-logo-mono.png";
import uitLogoHalftone from "../../../assets/uit-logo-halftone.png";
import {
  clearSsoCredentials,
  getSsoCredentialsStatus,
  saveUserProfile,
  verifyAndSaveSsoCredentials,
} from "../../../lib/tauri-client";
import { useSyncOrchestratorStore } from "../../academic/stores/syncOrchestratorStore";

export interface SsoLoginScreenProps {
  mode?: "onboarding" | "modal";
  isOpen?: boolean;
  onComplete?: (nickname?: string, major?: string) => void | Promise<void>;
  onClose?: () => void;
}

export const SsoLoginScreen: React.FC<SsoLoginScreenProps> = ({
  mode = "onboarding",
  isOpen = true,
  onComplete,
  onClose,
}) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [autoLogin, setAutoLogin] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setErrorMsg(null);
    setSuccessMsg(null);
    setPassword("");

    getSsoCredentialsStatus()
      .then((status) => {
        if (!active) return;
        setUsername(status.username || "");
        setHasSavedPassword(status.has_password);
        setAutoLogin(status.has_password ? status.auto_login : true);
      })
      .catch(() => {
        // Bỏ qua nếu lần đầu mở chưa có cấu hình
      });

    return () => {
      active = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || mode !== "modal" || !onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, mode, onClose]);

  if (!isOpen) return null;

  const enableDefaultStudentPlugins = async () => {
    const defaults = [
      { pluginId: "uit-courses", enabled: true },
      { pluginId: "uit-wecode", enabled: true },
    ];
    for (const item of defaults) {
      await invoke("toggle_plugin", item).catch(() => undefined);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const cleanUser = username.trim();
    if (!cleanUser) {
      setErrorMsg("Vui lòng nhập MSSV / tài khoản SSO.");
      return;
    }

    if (!password && !hasSavedPassword) {
      setErrorMsg("Vui lòng nhập mật khẩu SSO.");
      return;
    }

    setIsSubmitting(true);
    try {
      await verifyAndSaveSsoCredentials(cleanUser, password ? password : null, autoLogin);
      window.dispatchEvent(new Event("sso-credentials-updated"));

      if (mode === "onboarding") {
        await saveUserProfile(cleanUser, "CS");
        await invoke("save_setting", { key: "user_nickname", value: cleanUser }).catch(() => undefined);
        await enableDefaultStudentPlugins();
      }

      if (autoLogin) {
        void useSyncOrchestratorStore
          .getState()
          .requestSync("portal", { bypassTtl: true, bypassCircuitBreaker: true })
          .catch(() => undefined);
      }

      setHasSavedPassword(true);
      setPassword("");
      setSuccessMsg(
        autoLogin
          ? "Xác thực UIT SSO thành công! Đã lưu và kích hoạt đồng bộ Portal."
          : "Xác thực và lưu tài khoản UIT SSO thành công."
      );

      if (onComplete) {
        await onComplete(cleanUser, "CS");
      }
      if (mode === "modal" && onClose) {
        window.setTimeout(() => onClose(), 450);
      }
    } catch (err) {
      setPassword("");
      setErrorMsg(typeof err === "string" ? err : "Không thể xác thực tài khoản UIT SSO.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkipOnboarding = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const fallbackName = username.trim() || "Sinh viên UIT";
      await saveUserProfile(fallbackName, "CS");
      await enableDefaultStudentPlugins();
      if (onComplete) {
        await onComplete(fallbackName, "CS");
      }
    } catch {
      if (onComplete) {
        await onComplete("Sinh viên UIT", "CS");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClearCredentials = async () => {
    setIsClearing(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      await clearSsoCredentials();
      setHasSavedPassword(false);
      setUsername("");
      setPassword("");
      window.dispatchEvent(new Event("sso-credentials-updated"));
      setSuccessMsg("Đã xóa tài khoản SSO khỏi bộ nhớ cục bộ.");
    } catch (err) {
      setErrorMsg(typeof err === "string" ? err : "Không thể xóa tài khoản đã lưu.");
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[#0a0a0c] p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Đăng nhập UIT SSO"
    >
      {/* Monochrome atmospheric mountain landscape behind login card */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden select-none" aria-hidden="true">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 18%, rgba(160,160,170,0.14) 0%, rgba(28,28,32,0.72) 48%, #070708 100%)",
          }}
        />
        <svg
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
          className="h-full w-full opacity-90"
        >
          <path
            d="M0,470 L180,350 L360,420 L560,295 L790,390 L980,285 L1210,365 L1440,290 L1440,900 L0,900 Z"
            fill="#27272b"
            opacity="0.55"
          />
          <path
            d="M0,560 L140,470 L320,535 L520,420 L740,515 L960,405 L1180,490 L1440,425 L1440,900 L0,900 Z"
            fill="#1c1c20"
            opacity="0.72"
          />
          <path
            d="M0,655 L210,565 L430,630 L670,520 L890,615 L1130,535 L1340,595 L1440,560 L1440,900 L0,900 Z"
            fill="#131316"
            opacity="0.88"
          />
          <path
            d="M0,765 L260,695 L510,760 L760,675 L1030,750 L1270,690 L1440,735 L1440,900 L0,900 Z"
            fill="#09090b"
          />
        </svg>
      </div>

      {/* Split Monochrome Glass + Halftone Card */}
      <div className="relative z-10 flex w-full max-w-[860px] min-h-[500px] overflow-hidden rounded-[24px] border border-white/[0.14] bg-[#070708] shadow-[0_32px_90px_rgba(0,0,0,0.88)]">
        {mode === "modal" && onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cửa sổ đăng nhập"
            className="absolute right-4 top-4 z-30 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-zinc-300 transition hover:bg-white/[0.14] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Left Glass Form Panel */}
        <div className="relative z-20 flex w-full flex-col justify-center bg-gradient-to-br from-[#343439]/90 via-[#212125]/92 to-[#121215]/96 px-8 py-10 backdrop-blur-xl sm:px-12 md:w-[52%]">
          <div className="mb-6 flex items-center gap-2.5">
            <img src={uitLogoMono} alt="UIT" className="h-6 w-6 object-contain opacity-90" />
            <span className="text-[11px] font-medium tracking-[0.16em] text-zinc-300/80 uppercase">
              Diark · UIT Portal
            </span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-white">Đăng nhập</h1>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-300/75">
            Nhập tài khoản SSO một lần để lưu an toàn và tự động kéo TKB, điểm số, lịch thi, Moodle.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="sso-username" className="text-xs font-medium text-zinc-200">
                  Tài khoản SSO (MSSV)
                </label>
                {hasSavedPassword && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Đã lưu sẵn
                  </span>
                )}
              </div>
              <input
                id="sso-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Ví dụ: 25520458"
                autoFocus
                autoComplete="username"
                className="w-full rounded-full border border-white/[0.22] bg-white/[0.08] px-4 py-2.5 text-sm text-white placeholder-white/40 outline-none transition focus:border-white/50 focus:bg-white/[0.12]"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="sso-password" className="text-xs font-medium text-zinc-200">
                  Mật khẩu
                </label>
                <span className="text-[10px] text-zinc-400">Mã hóa cục bộ DPAPI</span>
              </div>
              <div className="relative">
                <input
                  id="sso-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={hasSavedPassword ? "Để trống để giữ mật khẩu đang lưu" : "Nhập mật khẩu UIT"}
                  autoComplete="current-password"
                  className="w-full rounded-full border border-white/[0.22] bg-white/[0.08] py-2.5 pl-4 pr-11 text-sm text-white placeholder-white/40 outline-none transition focus:border-white/50 focus:bg-white/[0.12]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-300/70 transition hover:text-white cursor-pointer"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2 pt-0.5 text-xs text-zinc-300/85 select-none">
              <input
                type="checkbox"
                checked={autoLogin}
                onChange={(e) => setAutoLogin(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/30 bg-white/10 accent-white cursor-pointer"
              />
              <span>Tự động đăng nhập khi đồng bộ Portal</span>
            </label>

            {errorMsg && (
              <div className="flex items-center gap-2 rounded-2xl border border-rose-500/35 bg-rose-950/50 px-3.5 py-2 text-xs text-rose-200">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/35 bg-emerald-950/50 px-3.5 py-2 text-xs text-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span>{successMsg}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-full border border-white/15 bg-[#09090b] py-3 text-sm font-semibold text-white transition hover:bg-black active:scale-[0.99] disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Đang xác thực với UIT SSO...</span>
                </>
              ) : (
                <span>Đăng nhập</span>
              )}
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400">
            {mode === "onboarding" ? (
              <button
                type="button"
                onClick={() => void handleSkipOnboarding()}
                disabled={isSubmitting}
                className="mx-auto underline decoration-zinc-600 underline-offset-4 transition hover:text-zinc-200 cursor-pointer"
              >
                Vào ứng dụng trước, đăng nhập sau
              </button>
            ) : hasSavedPassword ? (
              <button
                type="button"
                onClick={() => void handleClearCredentials()}
                disabled={isClearing || isSubmitting}
                className="inline-flex items-center gap-1.5 text-zinc-400 transition hover:text-rose-300 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                <span>{isClearing ? "Đang xóa..." : "Xóa tài khoản SSO đã lưu"}</span>
              </button>
            ) : (
              <span>Dữ liệu chỉ lưu cục bộ trên máy của bạn.</span>
            )}
          </div>
        </div>

        {/* Right Pure-Obsidian Halftone Logo Panel */}
        <div className="relative hidden overflow-hidden bg-[#070708] md:flex md:w-[48%] md:items-end md:justify-end">
          {/* Seamless left transition fade */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-28"
            style={{
              background:
                "linear-gradient(90deg, rgba(18,18,21,0.96) 0%, rgba(7,7,8,0.65) 55%, rgba(7,7,8,0) 100%)",
            }}
            aria-hidden="true"
          />
          <img
            src={uitLogoHalftone}
            alt="UIT Monochrome Halftone Emblem"
            className="pointer-events-none h-[440px] w-[440px] translate-x-6 translate-y-6 select-none object-contain opacity-90"
          />
          {/* Corner vignette fade so bottom/right corners stay soft */}
          <div
            className="pointer-events-none absolute inset-0 z-10"
            style={{
              background:
                "radial-gradient(circle at 64% 58%, rgba(7,7,8,0) 36%, rgba(7,7,8,0.68) 82%, #070708 100%)",
            }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
};

export default SsoLoginScreen;
