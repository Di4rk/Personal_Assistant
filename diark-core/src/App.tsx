import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  RefreshCw,
  Check,
} from "lucide-react";
import uitLogoMono from "./assets/uit-logo-mono.png";
import { APP_VERSION } from "./constants/app";
import {
  clearSsoCredentials,
  getGoogleOAuthStatus,
  getSsoCredentialsStatus,
  getUserProfile,
  saveUserProfile,
  syncGoogleCalendars,
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
  const isMoodleSyncing = useSyncOrchestratorStore((s) => s.serviceState.moodle.isSyncing);
  const isWecodeSyncing = useSyncOrchestratorStore((s) => s.serviceState.wecode.isSyncing);
  const [isCalSyncing, setIsCalSyncing] = useState(false);
  const [isQuickRefreshing, setIsQuickRefreshing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const wasSyncingRef = useRef(false);
  const isCurrentTabSyncing =
    isQuickRefreshing ||
    (activeTab === "home"
      ? isPortalSyncing || isMoodleSyncing || isCalSyncing
      : activeTab === "schedule"
      ? isCalSyncing
      : activeTab === "academic"
      ? isPortalSyncing
      : activeTab === "uit-courses"
      ? isMoodleSyncing
      : activeTab === "uit-wecode"
      ? isWecodeSyncing
      : false);

  useEffect(() => {
    if (isCurrentTabSyncing) {
      wasSyncingRef.current = true;
      setJustSynced(false);
      return;
    }
    if (wasSyncingRef.current) {
      wasSyncingRef.current = false;
      setJustSynced(true);
      const timer = window.setTimeout(() => setJustSynced(false), 2000);
      return () => window.clearTimeout(timer);
    }
  }, [isCurrentTabSyncing]);
  const navItemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [navIndicator, setNavIndicator] = useState<{
    y: number;
    h: number;
    visible: boolean;
  }>({ y: 0, h: 20, visible: false });

  useLayoutEffect(() => {
    const el = navItemRefs.current.get(activeTab);
    if (!el) {
      setNavIndicator((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      return;
    }
    setNavIndicator({
      y: el.offsetTop,
      h: el.offsetHeight,
      visible: true,
    });
  }, [activeTab, sidebarCollapsed, plugins.length, profileState.status]);

  useEffect(() => {
    try {
      window.localStorage.setItem("diark_sidebar_collapsed", sidebarCollapsed ? "true" : "false");
    } catch {
      // ignore storage restrictions
    }
  }, [sidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
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
    isChecking: isCheckingUpdate,
    autoCheckEnabled: autoCheckUpdates,
    lastCheckedAt,
    setAutoCheckEnabled: setAutoCheckUpdates,
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

  // Load User Profile on mount (bypass onboarding directly to workspace when SSO credentials are already saved)
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

    Promise.allSettled([getUserProfile(), getSsoCredentialsStatus()])
      .then(([profileRes, ssoRes]) => {
        if (!isMounted) return;
        clearTimeout(fallbackTimer);

        const sso = ssoRes.status === "fulfilled" ? ssoRes.value : null;
        const hasSavedSso = Boolean(sso && sso.has_password && sso.username.trim().length > 0);
        const profile =
          profileRes.status === "fulfilled"
            ? profileRes.value
            : { nickname: sso?.username.trim() || "Diark", major: "CS", is_initialized: false };

        if (hasSavedSso) {
          const resolvedNickname = profile.nickname || sso!.username.trim();
          const resolvedMajor = profile.major || "CS";
          if (!profile.is_initialized) {
            void saveUserProfile(resolvedNickname, resolvedMajor).catch(() => undefined);
          }
          setProfileState({
            status: "ready",
            profile: {
              nickname: resolvedNickname,
              major: resolvedMajor,
              is_initialized: true,
            },
          });
          return;
        }

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

  const handleSyncCurrentTab = useCallback(async () => {
    const syncCalendarOnly = async () => {
      setIsCalSyncing(true);
      try {
        const googleStatus = await getGoogleOAuthStatus().catch(() => null);
        if (googleStatus?.connected) {
          await syncGoogleCalendars();
          window.dispatchEvent(new Event("calendar-settings-updated"));
        }
      } catch {
        // Bỏ qua lỗi đồng bộ lịch tạm thời
      } finally {
        setIsCalSyncing(false);
      }
    };

    const ensureSsoAndSync = async (services: Array<"portal" | "moodle" | "wecode">) => {
      const sso = await getSsoCredentialsStatus().catch(() => null);
      if (!sso?.has_password) {
        setIsSsoLoginOpen(true);
        return;
      }
      const store = useSyncOrchestratorStore.getState();
      for (const svc of services) {
        void store.requestSync(svc, { bypassTtl: true, bypassCircuitBreaker: true });
      }
    };

    switch (activeTab) {
      case "schedule":
        await syncCalendarOnly();
        return;
      case "home":
        await Promise.allSettled([
          syncCalendarOnly(),
          ensureSsoAndSync(["portal", "moodle"]),
        ]);
        return;
      case "academic":
        await ensureSsoAndSync(["portal"]);
        return;
      case "uit-courses":
        await ensureSsoAndSync(["moodle"]);
        return;
      case "uit-wecode":
        await ensureSsoAndSync(["wecode"]);
        return;
      case "cp":
      case "cp-codeforces":
        setIsQuickRefreshing(true);
        try {
          await refetchAll();
        } finally {
          window.setTimeout(() => setIsQuickRefreshing(false), 600);
        }
        return;
      case "vault":
        setIsQuickRefreshing(true);
        window.dispatchEvent(new Event("vault-refresh"));
        window.setTimeout(() => setIsQuickRefreshing(false), 600);
        return;
      default:
        await ensureSsoAndSync(["portal"]);
    }
  }, [activeTab, refetchAll]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F5" || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (profileState.status !== "ready") return;
      if (isSsoLoginOpen || useSettingsStore.getState().isOpen) return;
      void handleSyncCurrentTab();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [profileState.status, isSsoLoginOpen, handleSyncCurrentTab]);

  // Tự động đồng bộ nền Portal, Moodle, Wecode khi khởi động và định kỳ theo TTL
  useEffect(() => {
    if (profileState.status !== "ready") return;
    if (!ssoStatus?.has_password || !ssoStatus.auto_login) return;

    const runAutoSync = async () => {
      const store = useSyncOrchestratorStore.getState();
      await store.initSyncTimestamps();
      void store.requestSync("portal");
      void store.requestSync("moodle");
      void store.requestSync("wecode");
    };

    void runAutoSync();
    const timer = window.setInterval(() => {
      void runAutoSync();
    }, 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [profileState.status, ssoStatus?.has_password, ssoStatus?.auto_login]);

  const handleLogout = useCallback(async () => {
    try {
      await clearSsoCredentials();
    } catch {
      // Tiếp tục đưa về màn hình đăng nhập
    }
    window.dispatchEvent(new Event("sso-credentials-updated"));
    useSettingsStore.getState().closeSettings();
    setSsoStatus(null);
    setProfileState({ status: "needs-onboarding" });
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
      ? "Tổng quan"
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
    <div className="flex h-screen w-screen overflow-hidden bg-[#080B12] text-zinc-100">
      {/* Collapsible UIT Navy Left Sidebar */}
      <aside
        className={`flex shrink-0 flex-col border-r border-[#1D263B]/80 bg-[#060910] transition-[width] duration-200 ease-out ${
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
            className={`flex h-8 w-full items-center rounded-lg border border-[#1D263B] bg-[#0F1420] text-xs text-zinc-400 transition-colors hover:border-[#2F6BFF]/30 hover:bg-[#151C2C] hover:text-zinc-200 cursor-pointer ${
              sidebarCollapsed ? "justify-center px-0" : "justify-between px-2.5"
            }`}
            title="Tìm kiếm nhanh (Ctrl+K)"
          >
            <span className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
              {!sidebarCollapsed && <span>Tìm kiếm...</span>}
            </span>
            {!sidebarCollapsed && (
              <kbd className="rounded border border-[#1D263B] bg-[#151C2C] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                Ctrl K
              </kbd>
            )}
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto px-2.5 space-y-5" aria-label="Main navigation">
          <div className="relative space-y-0.5">
            {!sidebarCollapsed && (
              <div className="px-2.5 pb-1 text-[11px] font-medium text-zinc-500">
                Học tập
              </div>
            )}

            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 z-20 w-[2px] rounded-r bg-[#2F6BFF] shadow-[0_0_8px_rgba(47,107,255,0.8)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{
                height: `${Math.max(16, navIndicator.h - 12)}px`,
                transform: `translateY(${navIndicator.y + 6}px)`,
                opacity: navIndicator.visible ? 1 : 0,
              }}
            />

            <button
              ref={(el) => {
                if (el) navItemRefs.current.set("home", el);
                else navItemRefs.current.delete("home");
              }}
              type="button"
              onClick={() => setActiveTab("home")}
              aria-current={activeTab === "home" ? "page" : undefined}
              title="Tổng quan"
              className={`relative flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "home"
                  ? "border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-200"
              }`}
            >
              <Home className={`h-4 w-4 shrink-0 ${activeTab === "home" ? "text-[#2F6BFF]" : ""}`} aria-hidden="true" />
              {!sidebarCollapsed && <span>Tổng quan</span>}
            </button>

            <button
              ref={(el) => {
                if (el) navItemRefs.current.set("schedule", el);
                else navItemRefs.current.delete("schedule");
              }}
              type="button"
              onClick={() => setActiveTab("schedule")}
              aria-current={activeTab === "schedule" ? "page" : undefined}
              title="Lịch"
              className={`relative flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "schedule"
                  ? "border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-200"
              }`}
            >
              <CalendarDays className={`h-4 w-4 shrink-0 ${activeTab === "schedule" ? "text-[#2F6BFF]" : ""}`} aria-hidden="true" />
              {!sidebarCollapsed && <span>Lịch</span>}
            </button>

            <button
              ref={(el) => {
                if (el) navItemRefs.current.set("academic", el);
                else navItemRefs.current.delete("academic");
              }}
              type="button"
              onClick={() => setActiveTab("academic")}
              aria-current={activeTab === "academic" ? "page" : undefined}
              title="Học vụ"
              className={`relative flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "academic"
                  ? "border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-200"
              }`}
            >
              <GraduationCap className={`h-4 w-4 shrink-0 ${activeTab === "academic" ? "text-[#2F6BFF]" : ""}`} aria-hidden="true" />
              {!sidebarCollapsed && <span>Học vụ</span>}
            </button>

            {enabledPlugins.map((p) => {
              const isSelected = activeTab === p.pluginId;
              const iconCls = `h-4 w-4 shrink-0 ${isSelected ? "text-[#2F6BFF]" : ""}`;
              const iconEl =
                p.pluginId === "cp-codeforces" ? (
                  <Code2 className={iconCls} aria-hidden="true" />
                ) : p.pluginId === "uit-courses" ? (
                  <BookOpen className={iconCls} aria-hidden="true" />
                ) : p.pluginId === "uit-wecode" ? (
                  <Terminal className={iconCls} aria-hidden="true" />
                ) : (
                  <Blocks className={iconCls} aria-hidden="true" />
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
                  ref={(el) => {
                    if (el) navItemRefs.current.set(p.pluginId, el);
                    else navItemRefs.current.delete(p.pluginId);
                  }}
                  type="button"
                  onClick={() => setActiveTab(p.pluginId)}
                  aria-current={isSelected ? "page" : undefined}
                  title={shortName}
                  className={`relative flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                    sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
                  } ${
                    isSelected
                      ? "border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-white"
                      : "border border-transparent text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-200"
                  }`}
                >
                  {iconEl}
                  {!sidebarCollapsed && <span className="truncate">{shortName}</span>}
                </button>
              );
            })}

            <button
              ref={(el) => {
                if (el) navItemRefs.current.set("vault", el);
                else navItemRefs.current.delete("vault");
              }}
              type="button"
              onClick={() => setActiveTab("vault")}
              aria-current={activeTab === "vault" ? "page" : undefined}
              title="Ghi chú"
              className={`relative flex h-8 w-full items-center rounded-lg text-xs font-medium transition-colors duration-150 cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
              } ${
                activeTab === "vault"
                  ? "border border-[#2F6BFF]/30 bg-[#2F6BFF]/[0.14] text-white"
                  : "border border-transparent text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-200"
              }`}
            >
              <FolderGit2 className={`h-4 w-4 shrink-0 ${activeTab === "vault" ? "text-[#2F6BFF]" : ""}`} aria-hidden="true" />
              {!sidebarCollapsed && <span>Ghi chú</span>}
            </button>
          </div>
        </nav>

        {/* Bottom Settings + Single Profile Card */}
        <div className="shrink-0 space-y-2 border-t border-[#1D263B]/80 p-2.5">
          <button
            type="button"
            onClick={() => useSettingsStore.getState().openSettings()}
            title="Cài đặt hệ thống"
            className={`flex h-8 w-full items-center rounded-lg border border-transparent text-xs font-medium text-zinc-400 transition-colors duration-150 hover:bg-[#151C2C] hover:text-zinc-200 cursor-pointer ${
              sidebarCollapsed ? "justify-center px-0" : "gap-2.5 px-2.5"
            }`}
          >
            <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
            {!sidebarCollapsed && <span>Cài đặt</span>}
          </button>

          <div className="flex items-center gap-1 rounded-lg border border-[#1D263B] bg-[#0F1420] p-1">
            <button
              type="button"
              onClick={() => setIsSsoLoginOpen(true)}
              title="Tài khoản UIT SSO"
              className={`flex h-8 min-w-0 flex-1 items-center rounded-md text-left transition-colors hover:bg-[#151C2C] cursor-pointer ${
                sidebarCollapsed ? "justify-center px-0" : "gap-2 px-1.5"
              }`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#2F6BFF]/[0.18] text-[11px] font-semibold text-[#6B9BFF]">
                {(ssoStatus?.username || profile.nickname || "U").slice(0, 2).toUpperCase()}
              </span>
              {!sidebarCollapsed && (
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-100">
                    {profile.nickname}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-zinc-500">
                    {ssoStatus?.username || "Chưa lưu SSO"}
                  </span>
                </span>
              )}
            </button>

            {!sidebarCollapsed && (
              <button
                type="button"
                onClick={() => void handleSyncCurrentTab()}
                disabled={isCurrentTabSyncing}
                title={`Làm mới ${pageTitle} (F5)`}
                aria-label={`Làm mới ${pageTitle}`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-[#6B9BFF] disabled:opacity-50 cursor-pointer"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${isCurrentTabSyncing ? "animate-spin text-[#6B9BFF]" : ""}`}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Workspace */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#080B12]">
        {/* Ambient UIT Blue Logo Background Watermark */}
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden select-none"
          aria-hidden="true"
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse 75% 42% at 50% -8%, rgba(47,107,255,0.13) 0%, rgba(47,107,255,0.04) 45%, rgba(8,11,18,0) 78%), radial-gradient(circle at 86% 84%, rgba(47,107,255,0.14) 0%, rgba(47,107,255,0.05) 36%, rgba(8,11,18,0) 70%)",
            }}
          />
          <div
            className="absolute -bottom-16 -right-14 h-[520px] w-[520px] opacity-[0.10] blur-[0.6px]"
            style={{
              background:
                "linear-gradient(135deg, #6B9BFF 0%, #2F6BFF 58%, #163E9E 100%)",
              WebkitMaskImage: `url(${uitLogoMono})`,
              maskImage: `url(${uitLogoMono})`,
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
              WebkitMaskSize: "contain",
              maskSize: "contain",
            }}
          />
        </div>

        <header className="relative z-10 flex h-12 shrink-0 items-center justify-between border-b border-[#1D263B]/80 bg-[#080B12]/90 px-6 backdrop-blur-sm">
          <h1 className="text-sm font-semibold tracking-tight text-zinc-100">{pageTitle}</h1>

          <div className="flex items-center gap-2">
            {isCurrentTabSyncing ? (
              <span
                role="status"
                aria-live="polite"
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.12] px-2.5 text-[11px] font-medium text-[#6B9BFF]"
              >
                <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Đang đồng bộ...</span>
              </span>
            ) : justSynced ? (
              <span
                role="status"
                aria-live="polite"
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[#1D263B] bg-[#0F1420] px-2.5 text-[11px] font-medium text-zinc-300"
              >
                <Check className="h-3.5 w-3.5 text-emerald-400/80" aria-hidden="true" />
                <span>Đã cập nhật</span>
              </span>
            ) : null}
            <PortalQuickActionsPopover />
          </div>
        </header>

        <main className="relative z-10 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
        {activeTab === "home" ? (
          <HomeDashboard
            onNavigateTab={(tab) => setActiveTab(tab)}
            onSyncPortal={() => void handleSyncCurrentTab()}
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

      <SettingsModal
        onResetGenesis={handleResetToGenesis}
        onOpenSsoLogin={() => {
          useSettingsStore.getState().closeSettings();
          setIsSsoLoginOpen(true);
        }}
        onLogout={() => void handleLogout()}
        updateStatus={updateStatus}
        updateInfo={updateInfo}
        updateError={updateError}
        isCheckingUpdate={isCheckingUpdate}
        autoCheckUpdates={autoCheckUpdates}
        lastCheckedAt={lastCheckedAt}
        onToggleAutoCheckUpdates={setAutoCheckUpdates}
        onCheckUpdates={() => void checkForUpdates(true)}
        onInstallUpdate={() => void installUpdate()}
      />
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
