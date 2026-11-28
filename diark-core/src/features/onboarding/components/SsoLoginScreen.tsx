import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Check, CheckCircle2, Eye, EyeOff, Loader2, Lock, Trash2, X } from "lucide-react";
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
  const hasAutoCompletedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setErrorMsg(null);
    setSuccessMsg(null);
    setPassword("");

    getSsoCredentialsStatus()
      .then((status) => {
        if (!active) return;
        const savedUser = status.username || "";
        setUsername(savedUser);
        setHasSavedPassword(status.has_password);
        setAutoLogin(status.has_password ? status.auto_login : true);

        if (
          mode === "onboarding" &&
          status.has_password &&
          savedUser.trim().length > 0 &&
          onComplete &&
          !hasAutoCompletedRef.current
        ) {
          hasAutoCompletedRef.current = true;
          void onComplete(savedUser.trim(), "CS");
        }
      })
      .catch(() => {
        // Bỏ qua nếu lần đầu mở chưa có cấu hình
      });

    return () => {
      active = false;
    };
  }, [isOpen, mode, onComplete]);

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
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[#070709] p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Đăng nhập UIT SSO"
    >
      {/* Monochrome matte atmospheric backdrop with parallax ridge waves */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 18%, rgba(255,255,255,0.045) 0%, rgba(24,24,28,0.65) 48%, #070709 100%)",
          }}
        />
        {/* Layer 1: Far angular peaks */}
        <svg
          className="uit-ridge-wave-1 absolute -bottom-6 -left-[8%] h-[62%] w-[116%]"
          viewBox="0 0 1440 480"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M0 300 L180 185 L340 245 L560 110 L760 225 L980 130 L1180 235 L1340 165 L1440 215 L1440 480 L0 480 Z"
            fill="#202026"
            fillOpacity="0.46"
          />
          <polyline
            points="0,300 180,185 340,245 560,110 760,225 980,130 1180,235 1340,165 1440,215"
            stroke="rgba(255,255,255,0.075)"
            strokeWidth="1.2"
          />
        </svg>

        {/* Layer 2: Mid-back geometric ridge with subtle UIT blue rim */}
        <svg
          className="uit-ridge-wave-2 absolute -bottom-6 -left-[8%] h-[62%] w-[116%]"
          viewBox="0 0 1440 480"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M0 340 L150 250 L370 305 L610 190 L830 285 L1070 195 L1270 285 L1440 235 L1440 480 L0 480 Z"
            fill="#16161c"
            fillOpacity="0.78"
          />
          <polyline
            points="0,340 150,250 370,305 610,190 830,285 1070,195 1270,285 1440,235"
            stroke="rgba(107,155,255,0.14)"
            strokeWidth="1.2"
          />
        </svg>

        {/* Layer 3: Mid-front sharp facets */}
        <svg
          className="uit-ridge-wave-3 absolute -bottom-6 -left-[8%] h-[62%] w-[116%]"
          viewBox="0 0 1440 480"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M0 390 L220 310 L460 365 L720 275 L960 355 L1220 290 L1440 345 L1440 480 L0 480 Z"
            fill="#101014"
          />
          <polyline
            points="0,390 220,310 460,365 720,275 960,355 1220,290 1440,345"
            stroke="rgba(255,255,255,0.055)"
            strokeWidth="1"
          />
        </svg>

        {/* Layer 4: Foreground dark base ridge */}
        <svg
          className="uit-ridge-wave-4 absolute -bottom-6 -left-[6%] h-[56%] w-[112%]"
          viewBox="0 0 1440 480"
          preserveAspectRatio="none"
          fill="none"
        >
          <path
            d="M0 430 L260 385 L520 420 L820 375 L1120 415 L1440 385 L1440 480 L0 480 Z"
            fill="#070709"
          />
        </svg>
      </div>

      {/* Split Monochrome Card */}
      <div className="uit-modal-in relative z-10 flex w-full max-w-[860px] min-h-[500px] overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#09090B] shadow-[0_32px_90px_rgba(0,0,0,0.88)]">
        {mode === "modal" && onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cửa sổ đăng nhập"
            className="absolute right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-transparent text-zinc-400 transition-colors duration-150 hover:bg-[#18181B] hover:text-white cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Left Form Panel */}
        <div className="relative z-20 flex w-full flex-col justify-center bg-[#121215] px-8 py-10 sm:px-12 md:w-[52%] md:border-r md:border-white/[0.08]">
          <div className="mb-6 flex items-center gap-2.5">
            <img src={uitLogoMono} alt="UIT" className="h-5 w-5 shrink-0 object-contain opacity-90" />
            <span className="text-[11px] font-semibold tracking-[0.16em] text-zinc-400 uppercase">
              Diark · UIT Portal
            </span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-white">Đăng nhập</h1>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
            Đồng bộ TKB, điểm số và Moodle.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="sso-username" className="text-xs font-medium text-zinc-200">
                  MSSV
                </label>
                {hasSavedPassword && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Đã lưu
                  </span>
                )}
              </div>
              <input
                id="sso-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Ví dụ: 21520001"
                autoFocus
                autoComplete="username"
                className="w-full rounded-xl border border-[#27272A] bg-[#0B0B0D] px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-[border-color,box-shadow] duration-150 focus:border-[#2F6BFF]/70 focus:shadow-[0_0_0_3px_rgba(47,107,255,0.14)]"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="sso-password" className="text-xs font-medium text-zinc-200">
                  Mật khẩu
                </label>
                <span
                  title="Mã hóa cục bộ DPAPI"
                  aria-label="Mã hóa cục bộ DPAPI"
                  className="inline-flex items-center text-zinc-500"
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                </span>
              </div>
              <div className="relative">
                <input
                  id="sso-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={hasSavedPassword ? "Giữ nguyên nếu để trống" : "Nhập mật khẩu UIT"}
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-[#27272A] bg-[#0B0B0D] py-2.5 pl-3.5 pr-10 text-sm text-zinc-100 placeholder-zinc-500 outline-none transition-[border-color,box-shadow] duration-150 focus:border-[#2F6BFF]/70 focus:shadow-[0_0_0_3px_rgba(47,107,255,0.14)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors duration-150 hover:text-zinc-200 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2.5 pt-0.5 text-xs text-zinc-300 select-none">
              <input
                type="checkbox"
                checked={autoLogin}
                onChange={(e) => setAutoLogin(e.target.checked)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-150 ${
                  autoLogin
                    ? "border-[#F4F4F5] bg-[#F4F4F5] text-[#09090B]"
                    : "border-[#3F3F46] bg-[#0B0B0D] text-transparent"
                }`}
              >
                <Check className="h-3 w-3 stroke-[3]" />
              </span>
              <span>Tự động đăng nhập khi đồng bộ</span>
            </label>

            {errorMsg && (
              <div className="flex items-center gap-2 rounded-xl border border-red-500/35 bg-red-500/10 px-3.5 py-2 text-xs text-red-300">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            {successMsg && (
              <div className="flex items-center gap-2 rounded-xl border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.12] px-3.5 py-2 text-xs text-[#8BB2FF]">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#6B9BFF]" />
                <span>{successMsg}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-[#F4F4F5] py-2.5 text-sm font-semibold text-[#09090B] transition-[background-color,transform] duration-[120ms] hover:bg-white active:scale-[0.99] disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-[#09090B]" />
                  <span>Đang xác thực với UIT SSO...</span>
                </>
              ) : (
                <span>Đăng nhập</span>
              )}
            </button>
          </form>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
            {mode === "onboarding" ? (
              <button
                type="button"
                onClick={() => void handleSkipOnboarding()}
                disabled={isSubmitting}
                className="mx-auto underline decoration-zinc-700 underline-offset-4 transition-colors duration-150 hover:text-zinc-200 cursor-pointer"
              >
                Vào ứng dụng trước, đăng nhập sau
              </button>
            ) : hasSavedPassword ? (
              <button
                type="button"
                onClick={() => void handleClearCredentials()}
                disabled={isClearing || isSubmitting}
                className="inline-flex items-center gap-1.5 text-zinc-400 transition-colors duration-150 hover:text-red-300 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                <span>{isClearing ? "Đang xóa..." : "Xóa tài khoản đã lưu"}</span>
              </button>
            ) : (
              <span>Dữ liệu chỉ lưu cục bộ trên máy của bạn.</span>
            )}
          </div>
        </div>

        {/* Right Logo Showcase Panel */}
        <div className="relative hidden overflow-hidden bg-[#09090B] md:flex md:w-[48%] md:items-center md:justify-center">
          {/* Subtle 5% UIT blue radial aura breathing behind logo center */}
          <div
            aria-hidden="true"
            className="uit-mono-aura pointer-events-none absolute h-[400px] w-[400px] rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(37, 99, 235, 0.75) 0%, rgba(37, 99, 235, 0.25) 45%, rgba(9, 9, 11, 0) 72%)",
            }}
          />

          <div className="relative z-10 flex h-[370px] w-[370px] items-center justify-center overflow-hidden">
            <img
              src={uitLogoHalftone}
              alt="UIT Halftone Emblem"
              className="pointer-events-none h-full w-full select-none object-contain opacity-65"
            />

            {/* Dot-masked luminance scan sweep (strictly inside logo dots) */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
              style={{
                WebkitMaskImage: `url(${uitLogoHalftone})`,
                maskImage: `url(${uitLogoHalftone})`,
                WebkitMaskSize: "contain",
                maskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskPosition: "center",
              }}
            >
              <div
                className="uit-logo-scan absolute inset-x-0 top-0 h-full"
                style={{
                  background:
                    "linear-gradient(180deg, transparent 28%, rgba(47, 107, 255, 0.72) 44%, rgba(147, 197, 255, 0.96) 50%, rgba(255, 255, 255, 1) 53%, rgba(255, 255, 255, 0.95) 55%, transparent 60%)",
                }}
              />
            </div>
          </div>

          <span className="pointer-events-none absolute bottom-5 right-6 z-20 font-mono text-[10px] tracking-[0.18em] text-zinc-600">
            UIT · VNU-HCM // OS
          </span>
        </div>
      </div>
    </div>
  );
};

export default SsoLoginScreen;
