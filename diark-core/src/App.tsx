import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTodayStats, fetchLevelInfo, fetchRecentSubmissions } from "./lib/tauri-client";
import type { SyncCompletePayload } from "./lib/tauri-client";
import { useTauriEvent } from "./hooks/useTauriEvent";
import type { DailyStats, LevelInfo, SubmissionRecord } from "./types";
import PostMortemModal from "./components/PostMortemModal";

interface Toast {
  id: number;
  message: string;
  isFirstAc: boolean;
}

let toastIdCounter = 0;
// Lưu các timer cleanup để tránh memory leak khi toast bị dismiss trước timeout
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

import { AcademicDashboard } from "./features/academic";
import { SyncPortalModal } from "./features/academic/components/SyncPortalModal";
import { useSyncOrchestratorStore } from "./features/academic/stores/syncOrchestratorStore";
import { HomeDashboard } from "./features/home";
import { ScheduleDashboard } from "./features/schedule";
import { VaultDashboard } from "./features/vault";
import { PortalQuickActionsPopover } from "./components/PortalQuickActionsPopover";
import { CommandPaletteModal } from "./features/command-palette";
import { GenesisModal, SsoLoginScreen } from "./features/onboarding";
import { DevControlDock } from "./components/DevControlDock";
import { PluginMarketplaceModal } from "./components/PluginMarketplaceModal";
import { PluginViewportRouter } from "./features/plugins/PluginViewportRouter";
import { SettingsModal } from "./components/SettingsModal";
import { AutoUpdateModal } from "./components/AutoUpdateModal";
import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { QuickCaptureModal } from "./features/vault/components/QuickCaptureModal";
import { useQuickCaptureStore } from "./stores/useQuickCaptureStore";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useAppStore } from "./stores/useAppStore";
import { useAcademicStore } from "./stores/useAcademicStore";
import { useWecodeStore } from "./stores/useWecodeStore";
import { usePrivacyStore } from "./stores/usePrivacyStore";
import { listInstalledPlugins } from "./lib/plugin-sdk";
import type { PluginMetaDto } from "./types/plugin";
import {
  Code2,
  GraduationCap,
  FolderGit2,
  Blocks,
  Settings,
  BookOpen,
  Terminal,
  Home,
  CalendarDays,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  LogIn,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import uitLogoMono from "./assets/uit-logo-mono.png";
import { APP_VERSION } from "./constants/app";
import {
  getSsoCredentialsStatus,
  getUserProfile,
  saveUserProfile,
  type SsoCredentialsStatus,
  type UserProfileDto,
} from "./lib/tauri-client";
import { notifyUiReady } from "./services/systemService";

type ProfileState =
  | { status: "loading" }
  | { status: "needs-onboarding" }
  | { status: "ready"; profile: UserProfileDto };

export default function App() {
  const [profileState, setProfileState] = useState<ProfileState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<string>("home");
  const [plugins, setPlugins] = useState<PluginMetaDto[]>([]);
  const [isPluginModalOpen, setIsPluginModalOpen] = useState(false);
  const [isPortalSyncModalOpen, setIsPortalSyncModalOpen] = useState(false);
  const [isSsoLoginOpen, setIsSsoLoginOpen] = useState(false);
  const [ssoStatus, setSsoStatus] = useState<SsoCredentialsStatus | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("diark_sidebar_collapsed") === "true";
    } catch {
      return false;
    }
  });
  const isPortalSyncing = useSyncOrchestratorStore((s) => s.serviceState.portal.isSyncing);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("diark_sidebar_collapsed", next ? "true" : "false");
      } catch {
        // ignore storage restrictions
      }
      return next;
    });
  }, []);

  const refreshSsoStatus = useCallback(async () => {
    try {
      const status = await getSsoCredentialsStatus();
      setSsoStatus(status);
    } catch {
      setSsoStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshSsoStatus();
    const onSsoUpdated = () => {
      void refreshSsoStatus();
    };
    window.addEventListener("sso-credentials-updated", onSsoUpdated);
    return () => window.removeEventListener("sso-credentials-updated", onSsoUpdated);
  }, [refreshSsoStatus]);

  // Auto-Update Engine (Tauri v2 official updater plugin)
  const {
    status: updateStatus,
    updateInfo,
    downloadProgress,
    downloadedBytes,
    totalBytes,
    error: updateError,
    checkForUpdates,
    installUpdate,
    dismissUpdate,
  } = useAutoUpdater();

  useEffect(() => {
    const handleManualCheck = () => {
      void checkForUpdates(true);
    };
    window.addEventListener("check-app-updates", handleManualCheck);
    return () => window.removeEventListener("check-app-updates", handleManualCheck);
  }, [checkForUpdates]);

  const handleResetIdentity = () => {
    setProfileState({ status: "needs-onboarding" });
  };

  const handleResetToGenesis = useCallback(() => {
    // 1. Reset các stores cục bộ
    useAcademicStore.getState().reset();
    useWecodeStore.getState().reset();
    useAppStore.getState().reset();
    usePrivacyStore.getState().setDemoMode(false);

    // 2. Chuyển view về Genesis onboarding flow và tab mặc định
    setActiveTab("home");
    setProfileState({ status: "needs-onboarding" });
  }, []);

  // Load Plugins on mount
  const loadPlugins = useCallback(async () => {
    try {
      const list = await listInstalledPlugins();
      setPlugins(list);
    } catch (err) {
      console.error("Lỗi đọc installed plugins:", err);
    }
  }, []);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  // Báo hiệu cho backend WindowGate rằng UI đã mount và render lần đầu ổn định (anti white-flash)
  useEffect(() => {
    let fired = false;
    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!fired) {
          fired = true;
          notifyUiReady().catch((err: unknown) => {
            console.warn("[App] notifyUiReady failed:", err);
          });
        }
      });
    });
    return () => {
      fired = true;
      cancelAnimationFrame(rafId);
    };
  }, []);

  useEffect(() => {
    const handleOpenSettings = (e: Event) => {
      const customEvent = e as CustomEvent<{ tab?: "profile" | "plugins" | "services" | "system" }>;
      const tab = customEvent.detail?.tab || "profile";
      useSettingsStore.getState().openSettings(tab);
    };
    window.addEventListener("open-settings", handleOpenSettings);
    return () => window.removeEventListener("open-settings", handleOpenSettings);
  }, []);

  // Load User Profile on mount
  useEffect(() => {
    let isMounted = true;

    const fallbackTimer = setTimeout(() => {
      if (isMounted) {
        setProfileState((curr) => {
          if (curr.status === "loading") {
            console.warn("[App] getUserProfile timeout, defaulting to needs-onboarding");
            return { status: "needs-onboarding" };
          }
          return curr;
        });
      }
    }, 2500);

    getUserProfile()
      .then((profile) => {
        if (!isMounted) return;
        clearTimeout(fallbackTimer);
        if (!profile.is_initialized) {
          setProfileState({ status: "needs-onboarding" });
        } else {
          setProfileState({ status: "ready", profile });
        }
      })
      .catch((err) => {
        console.error("Failed to load user profile:", err);
        if (isMounted) {
          clearTimeout(fallbackTimer);
          setProfileState({
            status: "ready",
            profile: { nickname: "Diark", major: "CS", is_initialized: false },
          });
        }
      });

    return () => {
      isMounted = false;
      clearTimeout(fallbackTimer);
    };
  }, []);

  const handleGenesisComplete = async (nickname?: string, major?: string) => {
    try {
      if (nickname) {
        await saveUserProfile(nickname, major || "CS");
      }
      const profile = await getUserProfile();
      await loadPlugins();
      setProfileState({
        status: "ready",
        profile: {
          nickname: profile.nickname || nickname || "Diark",
          major: profile.major || major || "CS",
          is_initialized: true,
        },
      });
    } catch (err) {
      console.error("Failed to complete genesis onboarding:", err);
      setProfileState({
        status: "ready",
        profile: { nickname: "Diark", major: "CS", is_initialized: true },
      });
    }
  };

  // ============================================================
  // SINGLE SOURCE OF TRUTH: mọi state hiển thị dồn về đây, các
  // component con (LevelProgressBar...) chỉ nhận props, KHÔNG tự fetch.
  // ============================================================
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [levelInfo, setLevelInfo] = useState<LevelInfo | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedSubmission, setSelectedSubmission] = useState<{
    problemId: string;
    problemName: string;
    verdict: string;
  } | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const refetchAll = useCallback(async () => {
    const [statsData, levelData, submissionsData] = await Promise.all([
      fetchTodayStats(),
      fetchLevelInfo(),
      fetchRecentSubmissions(20),
    ]);
    setStats(statsData);
    setLevelInfo(levelData);
    setSubmissions(submissionsData);
  }, []);

  // Fetch 1 lần duy nhất lúc mount - nguồn dữ liệu ban đầu khi app vừa mở,
  // trước khi có bất kỳ sync event nào xảy ra.
  useEffect(() => {
    refetchAll();
  }, [refetchAll]);

  // ============================================================
  // Event-driven refresh: lắng nghe cả 2 event channel từ Rust worker.
  // - "cf-sync-complete" → payload đầy đủ, dùng cho toast + refetch
  // - "cf://sync-event"  → legacy channel, refetch only (backward compat)
  // useTauriEvent tự cleanup khi unmount, safe với React 18 StrictMode.
  // ============================================================

  // Flag để bỏ qua lần chạy đầu tiên của handler (tương đương isFirstSyncRender cũ).
  const initialRender = useRef(true);

  const handleSyncComplete = useCallback(
    (payload: SyncCompletePayload) => {
      if (initialRender.current) {
        // React StrictMode có thể fire listener ngay sau mount do pending events.
        // Bỏ qua lần đầu nếu payload trống (new_submissions_count === 0).
        if (payload.new_submissions_count === 0) return;
      }
      initialRender.current = false;

      // Refetch data mỗi khi có sync mới (dù có submission mới hay không,
      // để đảm bảo heatmap và level bar luôn up-to-date sau IPC trigger).
      refetchAll();

      // Chỉ bắn toast khi có data mới thực sự
      if (payload.new_submissions_count > 0) {
        const message = `+${payload.new_submissions_count} submission mới, +${payload.new_submissions_count} XP hôm nay`;
        const toastId = ++toastIdCounter;
        const toast: Toast = { id: toastId, message, isFirstAc: false };
        setToasts((prev) => [...prev, toast]);
        const timer = setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toastId));
          toastTimers.delete(toastId);
        }, 5000);
        toastTimers.set(toastId, timer);
      }
    },
    [refetchAll]
  );

  // SyncResult from worker carries first_ac_count — use for rich toast.
  const handleLegacySync = useCallback(
    (payload: { new_submissions_count: number; total_daily_xp: number; first_ac_count: number }) => {
      if (payload.new_submissions_count === 0) return;

      refetchAll();

      const message =
        payload.first_ac_count > 0
          ? `🎉 First AC! +${payload.total_daily_xp} XP hôm nay (${payload.new_submissions_count} submission mới)`
          : `+${payload.new_submissions_count} submission mới, +${payload.total_daily_xp} XP hôm nay`;

      const toastId = ++toastIdCounter;
      const toast: Toast = { id: toastId, message, isFirstAc: payload.first_ac_count > 0 };
      setToasts((prev) => [...prev, toast]);
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toastId));
        toastTimers.delete(toastId);
      }, 5000);
      toastTimers.set(toastId, timer);
    },
    [refetchAll]
  );

  useTauriEvent<SyncCompletePayload>("cf-sync-complete", handleSyncComplete);
  useTauriEvent<{
    new_submissions_count: number;
    total_daily_xp: number;
    first_ac_count: number;
  }>("cf://sync-event", handleLegacySync);
  useTauriEvent<void>("system-genesis-reset", handleResetToGenesis);
  useTauriEvent<string>("portal-sync-failed", () => {
    setIsPortalSyncModalOpen(true);
  });

  const handleQuickPortalSync = useCallback(async () => {
    try {
      const status = await getSsoCredentialsStatus().catch(() => null);
      if (status?.auto_login && status.has_password) {
        const started = await useSyncOrchestratorStore
          .getState()
          .requestSync("portal", { bypassTtl: true, bypassCircuitBreaker: true });
        if (started) return;
      }
    } catch {
      // Fallback sang mở modal trực tiếp
    }
    setIsPortalSyncModalOpen(true);
  }, []);

  // Khai báo vô điều kiện trước mọi early-return để tuân thủ React Rules of Hooks
  const isQuickCaptureOpen = useQuickCaptureStore((s) => s.isOpen);
  const quickCapturePrefill = useQuickCaptureStore((s) => s.prefill);

  if (profileState.status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#080808] select-none">
        <div className="flex flex-col items-center gap-3.5">
          <div className="h-9 w-9 animate-spin rounded-full border-2 border-[#222225] border-t-zinc-100" />
          <div className="flex items-center gap-2">
            <img src={uitLogoMono} alt="UIT" className="h-4 w-4 opacity-80" />
            <span className="text-xs font-semibold tracking-wider text-zinc-200">Diark</span>
          </div>
        </div>
      </div>
    );
  }

  if (profileState.status === "needs-onboarding") {
    return <GenesisModal onComplete={handleGenesisComplete} />;
  }

  const { profile } = profileState;

  const pageTitle =
    activeTab === "home"
      ? "Hôm nay"
      : activeTab === "schedule"
      ? "Lịch học & Cá nhân"
      : activeTab === "academic"
      ? "Sức khỏe học vụ"
      : activeTab === "vault"
      ? "Ghi chú"
      : activeTab === "uit-courses"
      ? "Moodle Courses"
      : activeTab === "uit-wecode"
      ? "Wecode"
      : activeTab === "cp" || activeTab === "cp-codeforces"
      ? "Codeforces"
      : plugins.find((p) => p.pluginId === activeTab)?.name || "Tổng quan";

  const enabledPlugins = plugins.filter((p) => p.isEnabled);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#080808] text-zinc-100">
      {/* Collapsible Monochrome Left Sidebar */}
      <aside
        className={`flex shrink-0 flex-col border-r border-white/[0.06] bg-[#080808] transition-[width] duration-200 ease-out ${
          sidebarCollapsed ? "w-[68px]" : "w-[236px]"
        }`}
      >
        {/* Brand Row */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <img
              src={uitLogoMono}
              alt="UIT Logo"
              className="h-6 w-6 shrink-0 object-contain opacity-90"
            />
            {!sidebarCollapsed && (
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="truncate text-sm font-semibold tracking-tight text-white">
                  Diark
                </span>
                <span className="font-mono text-[10px] text-zinc-500">{APP_VERSION}</span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={toggleSidebar}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 cursor-pointer"
            title={sidebarCollapsed ? "Mở rộng thanh bên" : "Thu gọn thanh bên"}
            aria-label={sidebarCollapsed ? "Mở rộng thanh bên" : "Thu gọn thanh bên"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Search Trigger Pill */}
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
            }}
            className={`flex h-8 w-full items-center rounded-lg border border-white/[0.07] bg-[#121213] text-xs text-zinc-400 transition-colors hover:border-white/[0.14] hover:text-zinc-200 cursor-pointer ${
              sidebarCollapsed ? "justify-center px-0" : "justify-between px-2.5"
            }`}
            title="Tìm kiếm nhanh (Ctrl+K)"
          >
            <span className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              {!sidebarCollapsed && <span>Tìm kiếm...</span>}
            </span>
            {!sidebarCollapsed && (
              <kbd className="rounded bg-[#1b1b1e] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 border border-white/[0.05]">
                Ctrl K
              </kbd>
            )}
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto px-2.5 space-y-5" aria-label="Main navigation">
          <div className="space-y-0.5">
            {!sidebarCollapsed && (
              <div className="px-2.5 pb-1 text-[11px] font-medium text-zinc-500">
                Học tập
              </div>
            )}

            <button
              type="button"
              onClick={() => setActiveTab("home")}
              aria-current={activeTab === "home" ? "page" : undefined}
              title="Hôm nay"
              className={`flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "home"
                  ? "border border-white/[0.07] bg-[#18181b] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
              }`}
            >
              <Home className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!sidebarCollapsed && <span>Hôm nay</span>}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("schedule")}
              aria-current={activeTab === "schedule" ? "page" : undefined}
              title="Lịch"
              className={`flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "schedule"
                  ? "border border-white/[0.07] bg-[#18181b] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
              }`}
            >
              <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!sidebarCollapsed && <span>Lịch</span>}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("academic")}
              aria-current={activeTab === "academic" ? "page" : undefined}
              title="Học vụ"
              className={`flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "academic"
                  ? "border border-white/[0.07] bg-[#18181b] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
              }`}
            >
              <GraduationCap className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!sidebarCollapsed && <span>Học vụ</span>}
            </button>

            {enabledPlugins.map((p) => {
              const isSelected = activeTab === p.pluginId;
              const iconEl =
                p.pluginId === "cp-codeforces" ? (
                  <Code2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : p.pluginId === "uit-courses" ? (
                  <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : p.pluginId === "uit-wecode" ? (
                  <Terminal className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Blocks className="h-4 w-4 shrink-0" aria-hidden="true" />
                );
              const shortName =
                p.pluginId === "uit-courses"
                  ? "Moodle"
                  : p.pluginId === "uit-wecode"
                  ? "Wecode"
                  : p.pluginId === "cp-codeforces"
                  ? "Codeforces"
                  : p.name;
              return (
                <button
                  key={p.pluginId}
                  type="button"
                  onClick={() => setActiveTab(p.pluginId)}
                  aria-current={isSelected ? "page" : undefined}
                  title={shortName}
                  className={`flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                    sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
                  } ${
                    isSelected
                      ? "border border-white/[0.07] bg-[#18181b] text-white"
                      : "border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                  }`}
                >
                  {iconEl}
                  {!sidebarCollapsed && <span className="truncate">{shortName}</span>}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setActiveTab("vault")}
              aria-current={activeTab === "vault" ? "page" : undefined}
              title="Ghi chú"
              className={`flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "vault"
                  ? "border border-white/[0.07] bg-[#18181b] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
              }`}
            >
              <FolderGit2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!sidebarCollapsed && <span>Ghi chú</span>}
            </button>
          </div>

          <div className="space-y-0.5">
            {!sidebarCollapsed && (
              <div className="px-2.5 pb-1 text-[11px] font-medium text-zinc-500">
                Hệ thống
              </div>
            )}

            <button
              type="button"
              onClick={() => setIsSsoLoginOpen(true)}
              title="Tài khoản UIT SSO"
              className={`flex h-8 w-full items-center rounded-lg border border-transparent text-xs font-medium text-zinc-400 transition-colors duration-150 hover:bg-white/[0.04] hover:text-zinc-200 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "justify-between px-2.5"
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                {!sidebarCollapsed && <span className="truncate">Tài khoản SSO</span>}
              </span>
              {!sidebarCollapsed && (
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    ssoStatus?.has_password ? "bg-emerald-400" : "bg-zinc-600"
                  }`}
                />
              )}
            </button>

            <button
              type="button"
              onClick={() => useSettingsStore.getState().openSettings()}
              title="Cài đặt hệ thống"
              className={`flex h-8 w-full items-center rounded-lg border border-transparent text-xs font-medium text-zinc-400 transition-colors duration-150 hover:bg-white/[0.04] hover:text-zinc-200 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              }`}
            >
              <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
              {!sidebarCollapsed && <span>Cài đặt</span>}
            </button>
          </div>
        </nav>

        {/* Bottom SSO Status Card + User Profile Footer */}
        <div className="shrink-0 p-2.5 space-y-2 border-t border-white/[0.06]">
          {!sidebarCollapsed && (
            <div className="rounded-xl border border-white/[0.07] bg-[#111112] p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-zinc-300">
                  {ssoStatus?.has_password ? "UIT SSO đã lưu" : "Chưa lưu SSO"}
                </span>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    ssoStatus?.has_password ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
              </div>
              <p className="truncate font-mono text-[11px] text-zinc-500">
                {ssoStatus?.username ? `MSSV: ${ssoStatus.username}` : "Đăng nhập một lần để đồng bộ tự động."}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (ssoStatus?.has_password) {
                    void handleQuickPortalSync();
                  } else {
                    setIsSsoLoginOpen(true);
                  }
                }}
                disabled={isPortalSyncing}
                className="flex h-7 w-full items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#1a1a1d] text-[11px] font-medium text-zinc-100 transition-colors hover:bg-[#232327] disabled:opacity-50 cursor-pointer"
              >
                {ssoStatus?.has_password ? (
                  <>
                    <RefreshCw className={`h-3 w-3 ${isPortalSyncing ? "animate-spin" : ""}`} />
                    <span>{isPortalSyncing ? "Đang đồng bộ..." : "Đồng bộ Portal"}</span>
                  </>
                ) : (
                  <>
                    <LogIn className="h-3 w-3" />
                    <span>Đăng nhập SSO</span>
                  </>
                )}
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setIsSsoLoginOpen(true)}
            title="Mở cửa sổ đăng nhập UIT SSO"
            className={`flex h-9 w-full items-center rounded-lg border border-white/[0.06] bg-[#101012] text-left transition-colors hover:border-white/[0.12] hover:bg-[#151518] cursor-pointer ${
              sidebarCollapsed ? "justify-center px-0" : "justify-between px-2.5"
            }`}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.08] text-[11px] font-semibold text-zinc-100">
                {(ssoStatus?.username || profile.nickname || "U").slice(0, 2).toUpperCase()}
              </span>
              {!sidebarCollapsed && (
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-100">
                    {profile.nickname}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-zinc-500">
                    {ssoStatus?.username || "UIT Student"}
                  </span>
                </span>
              )}
            </span>
            {!sidebarCollapsed && <LogIn className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
          </button>
        </div>
      </aside>

      {/* Main Content Workspace */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#0c0c0d]">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0c0c0d]/95 px-6">
          <h1 className="text-sm font-semibold tracking-tight text-zinc-100">{pageTitle}</h1>

          <div className="flex items-center gap-2">
            <PortalQuickActionsPopover />

            <button
              type="button"
              onClick={() => setIsSsoLoginOpen(true)}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-[#121213] px-2.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/[0.15] hover:bg-[#19191b] hover:text-white cursor-pointer"
              title="Đăng nhập hoặc đổi tài khoản SSO UIT"
            >
              <LogIn className="h-3.5 w-3.5 text-zinc-400" aria-hidden="true" />
              <span className="hidden sm:inline">
                {ssoStatus?.has_password ? "Đổi SSO" : "Đăng nhập SSO"}
              </span>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
        {activeTab === "home" ? (
          <HomeDashboard
            onNavigateTab={(tab) => setActiveTab(tab)}
            onSyncPortal={() => void handleQuickPortalSync()}
          />
        ) : activeTab === "schedule" ? (
          <ScheduleDashboard />
        ) : activeTab === "academic" ? (
          <AcademicDashboard />
        ) : activeTab === "vault" ? (
          <VaultDashboard />
        ) : activeTab === "cp" || activeTab === "cp-codeforces" ? (
          <PluginViewportRouter
            plugin={{
              pluginId: "cp-codeforces",
              name: "Codeforces Engine",
              version: "1.0.0",
              author: "Diark",
              category: "competitive_programming",
              isEnabled: true,
              isBuiltin: true,
              trustTier: "first_party",
            }}
            extraProps={{
              stats,
              levelInfo,
              submissions,
              userProfile: profile,
              onSyncComplete: handleSyncComplete,
              onProfileUpdated: (updated: UserProfileDto) =>
                setProfileState({ status: "ready", profile: updated }),
              onResetIdentity: handleResetIdentity,
              onSelectSubmission: (sub: { problemId: string; problemName: string; verdict: string }) => {
                setSelectedSubmission(sub);
                setIsModalOpen(true);
              },
            }}
          />
        ) : (
          (() => {
            const currentPlugin = plugins.find((p) => p.pluginId === activeTab);
            if (currentPlugin) {
              return <PluginViewportRouter plugin={currentPlugin} />;
            }
            return (
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-xs font-mono text-slate-400">
                Phân hệ chưa được cấu hình hoặc đã bị vô hiệu hóa.
              </div>
            );
          })()
        )}
        </main>
      </div>

      <PluginMarketplaceModal
        isOpen={isPluginModalOpen}
        onClose={() => setIsPluginModalOpen(false)}
        onPluginsChanged={loadPlugins}
      />

      <PostMortemModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        submission={selectedSubmission}
      />

      <CommandPaletteModal onNavigateTab={(tab) => setActiveTab(tab)} />

      {/* --- Toast notifications --- */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-3.5 py-2.5 rounded-md shadow-lg text-xs font-medium ${
              toast.isFirstAc
                ? "bg-emerald-950 text-emerald-200 border border-emerald-800/70"
                : "bg-zinc-900 text-zinc-200 border border-zinc-800"
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>

      <QuickCaptureModal
        isOpen={isQuickCaptureOpen}
        onClose={() => useQuickCaptureStore.getState().closeQuickCapture()}
        prefill={quickCapturePrefill}
      />

      <SettingsModal onResetGenesis={handleResetToGenesis} />
      <DevControlDock onResetIdentity={handleResetIdentity} />
      <SyncPortalModal
        isOpen={isPortalSyncModalOpen}
        onClose={() => setIsPortalSyncModalOpen(false)}
      />

      <SsoLoginScreen
        mode="modal"
        isOpen={isSsoLoginOpen}
        onClose={() => setIsSsoLoginOpen(false)}
        onComplete={() => {
          void refreshSsoStatus();
        }}
      />

      <AutoUpdateModal
        status={updateStatus}
        updateInfo={updateInfo}
        downloadProgress={downloadProgress}
        downloadedBytes={downloadedBytes}
        totalBytes={totalBytes}
        error={updateError}
        onInstall={() => void installUpdate()}
        onDismiss={dismissUpdate}
      />
    </div>
  );
}
