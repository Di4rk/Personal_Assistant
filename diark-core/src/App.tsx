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

import { AcademicDashboard } from "./features/academic";
import { VaultDashboard } from "./features/vault";
import { CommandPaletteModal } from "./features/command-palette";
import { GenesisModal } from "./features/onboarding";
import { DevControlDock } from "./components/DevControlDock";
import { PluginMarketplaceModal } from "./components/PluginMarketplaceModal";
import { PluginViewportRouter } from "./features/plugins/PluginViewportRouter";
import { SettingsModal } from "./components/SettingsModal";
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

type ProfileState =
  | { status: "loading" }
  | { status: "needs-onboarding" }
  | { status: "ready"; profile: UserProfileDto };

export default function App() {
  const [profileState, setProfileState] = useState<ProfileState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<string>("academic");
  const [plugins, setPlugins] = useState<PluginMetaDto[]>([]);
  const [isPluginModalOpen, setIsPluginModalOpen] = useState(false);

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
        const toast: Toast = {
          id: ++toastIdCounter,
          message,
          isFirstAc: false, // full_ac_count not in SyncCompletePayload; use SyncResult event for that
        };
        setToasts((prev) => [...prev, toast]);
        const timer = setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== toast.id));
        }, 5000);
        // Note: timer is intentionally not cleared here because toast cleanup
        // is keyed by ID and the component stays mounted for the app lifetime.
        void timer;
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

      const toast: Toast = {
        id: ++toastIdCounter,
        message,
        isFirstAc: payload.first_ac_count > 0,
      };
      setToasts((prev) => [...prev, toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 5000);
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-6 py-4">
        <div>
          <h1 className="text-xl font-black tracking-wider text-white">
            {profile.nickname.toUpperCase()} <span className="text-cyan-400">// OS</span>
          </h1>
          <p className="text-xs font-mono text-slate-400">{APP_SUBTITLE}</p>
        </div>

        <div className="flex items-center gap-4">
          {/* Navigation Tabs */}
          <nav className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-1 text-xs">
            <button
              onClick={() => setActiveTab("academic")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                activeTab === "academic"
                  ? "bg-violet-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <GraduationCap className="w-3.5 h-3.5" />
              <span>Academic Radar</span>
            </button>

            {/* Dynamic Enabled Plugins */}
            {plugins
              .filter((p) => p.isEnabled)
              .map((p) => {
                const isSelected = activeTab === p.pluginId;
                return (
                  <button
                    key={p.pluginId}
                    onClick={() => setActiveTab(p.pluginId)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-violet-600 text-white shadow-sm"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {p.pluginId === "cp-codeforces" ? (
                      <Code2 className="w-3.5 h-3.5" />
                    ) : p.pluginId === "uit-courses" ? (
                      <BookOpen className="w-3.5 h-3.5" />
                    ) : p.pluginId === "uit-wecode" ? (
                      <Terminal className="w-3.5 h-3.5" />
                    ) : (
                      <Blocks className="w-3.5 h-3.5" />
                    )}
                    <span>{p.name}</span>
                  </button>
                );
              })}

            <button
              onClick={() => setActiveTab("vault")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                activeTab === "vault"
                  ? "bg-violet-600 text-white shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <FolderGit2 className="w-3.5 h-3.5" />
              <span>Native Vault</span>
            </button>
          </nav>

          {/* Settings Hub Button */}
          <button
            onClick={() => useSettingsStore.getState().openSettings()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-mono text-slate-300 hover:text-cyan-400 transition-colors cursor-pointer"
            title="Cài đặt hệ thống (Settings Hub)"
          >
            <Settings className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Settings</span>
          </button>

          <span className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-xs text-cyan-400">
            {APP_VERSION}
          </span>
        </div>
      </header>

      <main className="flex-1 p-6">
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
    </div>
  );
}
