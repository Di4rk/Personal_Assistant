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
import { VaultDashboard } from "./features/vault";
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
import { Code2, GraduationCap, FolderGit2, Blocks, Settings, BookOpen, Terminal } from "lucide-react";
import { APP_VERSION, APP_SUBTITLE } from "./constants/app";
import {
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
  const [activeTab, setActiveTab] = useState<string>("academic");
  const [plugins, setPlugins] = useState<PluginMetaDto[]>([]);
  const [isPluginModalOpen, setIsPluginModalOpen] = useState(false);

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
    setActiveTab("academic");
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
      {/* Header chính: bg zinc-900 (đúng Surface card token), border zinc-800 */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-zinc-800 bg-zinc-900/95 backdrop-blur-md px-6 py-3">
        <div>
          <h1 className="text-xl font-black tracking-wider text-white">
            {profile.nickname.toUpperCase()} <span className="text-emerald-400">// OS</span>
          </h1>
          <p className="text-xs font-mono text-zinc-500">{APP_SUBTITLE}</p>
        </div>

        <div className="flex items-center gap-4">
          {/* Navigation Tabs */}
          <nav className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-1 text-xs" aria-label="Main navigation">
            <button
              onClick={() => setActiveTab("academic")}
              aria-current={activeTab === "academic" ? "page" : undefined}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all duration-150 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 ${
                activeTab === "academic"
                  ? "bg-zinc-700 text-zinc-100 shadow-sm border border-zinc-600"
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <GraduationCap className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Academic Radar</span>
            </button>

            {/* Dynamic Enabled Plugins */}
            {plugins
              .filter((p) => p.isEnabled)
              .map((p) => {
                const isSelected = activeTab === p.pluginId;
                const iconEl =
                  p.pluginId === "cp-codeforces" ? (
                    <Code2 className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : p.pluginId === "uit-courses" ? (
                    <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : p.pluginId === "uit-wecode" ? (
                    <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <Blocks className="w-3.5 h-3.5" aria-hidden="true" />
                  );
                return (
                  <button
                    key={p.pluginId}
                    onClick={() => setActiveTab(p.pluginId)}
                    aria-current={isSelected ? "page" : undefined}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all duration-150 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 ${
                      isSelected
                        ? "bg-zinc-700 text-zinc-100 shadow-sm border border-zinc-600"
                        : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50"
                    }`}
                  >
                    {iconEl}
                    <span>{p.name}</span>
                  </button>
                );
              })}

            <button
              onClick={() => setActiveTab("vault")}
              aria-current={activeTab === "vault" ? "page" : undefined}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-all duration-150 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 ${
                activeTab === "vault"
                  ? "bg-zinc-700 text-zinc-100 shadow-sm border border-zinc-600"
                  : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <FolderGit2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Native Vault</span>
            </button>
          </nav>

          {/* Settings Hub Button */}
          <button
            onClick={() => useSettingsStore.getState().openSettings()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs font-mono text-zinc-400 hover:text-emerald-400 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
            title="Cài đặt hệ thống (Settings Hub)"
            aria-label="Mở Settings Hub"
          >
            <Settings className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Settings</span>
          </button>

          <span className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-xs text-emerald-400" aria-label={`Phiên bản ${APP_VERSION}`}>
            {APP_VERSION}
          </span>
        </div>
      </header>

      <main className="p-6">
        {activeTab === "academic" ? (
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

      <CommandPaletteModal />

      {/* --- Toast notifications --- */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-in slide-in-from-bottom-2 ${
              toast.isFirstAc
                ? "bg-violet-600 text-white"
                : "bg-zinc-800 text-zinc-200 border border-zinc-700"
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
