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
import { GenesisModal } from "./features/onboarding";
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
import { Code2, GraduationCap, FolderGit2, Blocks, Settings, BookOpen, Terminal, Home, CalendarDays, Search } from "lucide-react";
import { APP_VERSION } from "./constants/app";
import {
  getSsoCredentialsStatus,
  getUserProfile,
  saveUserProfile,
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
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 font-mono select-none">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex h-12 w-12 items-center justify-center">
            <div className="absolute h-11 w-11 animate-[spin_0.9s_cubic-bezier(0.5,0,0.5,1)_infinite] rounded-full border-2 border-zinc-800 border-t-emerald-400" />
            <div className="absolute h-6 w-6 animate-[spin_1.3s_linear_infinite_reverse] rounded-full border-2 border-zinc-800 border-b-cyan-400" />
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs font-bold tracking-[0.15em] text-zinc-100">
              DIARK <span className="text-cyan-400">// OS</span>
            </span>
            <span className="text-[11px] tracking-wider text-zinc-500 animate-pulse">
              Đang khởi tạo nhân hệ thống...
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (profileState.status === "needs-onboarding") {
    return <GenesisModal onComplete={handleGenesisComplete} />;
  }

  const { profile } = profileState;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-zinc-950 text-zinc-100">
      {/* Header phẳng, mật độ cao theo chuẩn Linear/Vercel */}
      <header className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-zinc-800/80 bg-zinc-950 px-5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
            <span className="text-xs font-semibold tracking-tight text-zinc-100">
              {profile.nickname}
            </span>
            <span className="font-mono text-[11px] text-zinc-600">{APP_VERSION}</span>
          </div>

          <nav className="flex items-center gap-1 text-xs" aria-label="Main navigation">
            <button
              type="button"
              onClick={() => setActiveTab("home")}
              aria-current={activeTab === "home" ? "page" : undefined}
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors duration-150 ease-out cursor-pointer ${
                activeTab === "home"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <Home className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Hôm nay</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("schedule")}
              aria-current={activeTab === "schedule" ? "page" : undefined}
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors duration-150 ease-out cursor-pointer ${
                activeTab === "schedule"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Lịch</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("academic")}
              aria-current={activeTab === "academic" ? "page" : undefined}
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors duration-150 ease-out cursor-pointer ${
                activeTab === "academic"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Học vụ</span>
            </button>

            {plugins
              .filter((p) => p.isEnabled)
              .map((p) => {
                const isSelected = activeTab === p.pluginId;
                const iconEl =
                  p.pluginId === "cp-codeforces" ? (
                    <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : p.pluginId === "uit-courses" ? (
                    <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : p.pluginId === "uit-wecode" ? (
                    <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Blocks className="h-3.5 w-3.5" aria-hidden="true" />
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
                    className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors duration-150 ease-out cursor-pointer ${
                      isSelected
                        ? "bg-zinc-800 text-zinc-100"
                        : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    {iconEl}
                    <span>{shortName}</span>
                  </button>
                );
              })}

            <button
              type="button"
              onClick={() => setActiveTab("vault")}
              aria-current={activeTab === "vault" ? "page" : undefined}
              className={`flex h-8 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors duration-150 ease-out cursor-pointer ${
                activeTab === "vault"
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Ghi chú</span>
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <PortalQuickActionsPopover />

          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
            }}
            className="flex h-8 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-400 transition-colors duration-150 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200 cursor-pointer"
            title="Mở bảng lệnh (Ctrl+K)"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            <kbd className="font-mono text-[10px] text-zinc-500">Ctrl K</kbd>
          </button>

          <button
            type="button"
            onClick={() => useSettingsStore.getState().openSettings()}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors duration-150 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100 cursor-pointer"
            title="Cài đặt hệ thống"
            aria-label="Mở Settings"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="p-5">
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
