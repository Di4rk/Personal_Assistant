import React, { useEffect, useState, useCallback } from "react";
import {
  Blocks,
  Check,
  X,
  Shield,
  RefreshCw,
  Download,
  Package,
  Store,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  listInstalledPlugins,
  togglePlugin,
  fetchRemoteRegistry,
  installRemotePlugin,
} from "@/lib/plugin-sdk";
import type { PluginMetaDto, RemotePluginDto } from "@/types/plugin";

interface PluginMarketplaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPluginsChanged?: () => void;
}

export const PluginMarketplaceModal: React.FC<PluginMarketplaceModalProps> = ({
  isOpen,
  onClose,
  onPluginsChanged,
}) => {
  const [activeTab, setActiveTab] = useState<"installed" | "marketplace">("installed");
  const [installedPlugins, setInstalledPlugins] = useState<PluginMetaDto[]>([]);
  const [remotePlugins, setRemotePlugins] = useState<RemotePluginDto[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isLoadingRemote, setIsLoadingRemote] = useState<boolean>(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadInstalledPlugins = useCallback(async () => {
    try {
      setIsLoading(true);
      const list = await listInstalledPlugins();
      setInstalledPlugins(list);
    } catch (err) {
      console.error("Lỗi nạp plugin registry:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadRemotePlugins = useCallback(async () => {
    try {
      setIsLoadingRemote(true);
      setErrorMsg(null);
      const list = await fetchRemoteRegistry();
      setRemotePlugins(list);
    } catch (err) {
      console.error("Lỗi nạp remote plugin registry:", err);
      setErrorMsg("Không thể tải danh sách plugin từ kho từ xa.");
    } finally {
      setIsLoadingRemote(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      void loadInstalledPlugins();
      void loadRemotePlugins();
    }
  }, [isOpen, loadInstalledPlugins, loadRemotePlugins]);

  if (!isOpen) return null;

  const handleToggle = async (plugin: PluginMetaDto) => {
    if (togglingId) return;
    setTogglingId(plugin.pluginId);
    const nextState = !plugin.isEnabled;
    try {
      await togglePlugin(plugin.pluginId, nextState);
      setInstalledPlugins((prev) =>
        prev.map((p) =>
          p.pluginId === plugin.pluginId ? { ...p, isEnabled: nextState } : p
        )
      );
      onPluginsChanged?.();
    } catch (err) {
      console.error("Lỗi toggle plugin:", err);
    } finally {
      setTogglingId(null);
    }
  };

  const handleInstall = async (plugin: RemotePluginDto) => {
    if (installingId) return;
    setInstallingId(plugin.id);
    setErrorMsg(null);

    try {
      await installRemotePlugin(plugin);
      await loadInstalledPlugins();
      onPluginsChanged?.();
    } catch (err) {
      console.error("Lỗi cài đặt remote plugin:", err);
      setErrorMsg(
        typeof err === "string" ? err : "Đã xảy ra lỗi khi tải hoặc giải nén plugin."
      );
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl text-slate-100 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-500/30 text-cyan-400">
              <Blocks className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white font-mono flex items-center gap-2">
                PLUGIN REGISTRY &amp; RUNTIME HUB
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Quản lý các phân hệ tính năng mở rộng &amp; Zero-Trust Sandboxed Registry
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 pt-3 pb-1 border-b border-slate-900 font-mono text-xs">
          <button
            onClick={() => setActiveTab("installed")}
            className={`px-3.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors cursor-pointer ${
              activeTab === "installed"
                ? "bg-cyan-950 text-cyan-300 border border-cyan-700/60 font-bold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Package className="w-3.5 h-3.5" />
            <span>ĐÃ CÀI ĐẶT ({installedPlugins.length})</span>
          </button>

          <button
            onClick={() => setActiveTab("marketplace")}
            className={`px-3.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors cursor-pointer ${
              activeTab === "marketplace"
                ? "bg-cyan-950 text-cyan-300 border border-cyan-700/60 font-bold"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
            }`}
          >
            <Store className="w-3.5 h-3.5" />
            <span>KHO PLUGIN (MARKETPLACE)</span>
          </button>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="mt-3 p-3 rounded-lg bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs font-mono flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto py-3 space-y-3 pr-1">
          {/* TAB 1: INSTALLED */}
          {activeTab === "installed" && (
            <>
              {isLoading ? (
                <div className="flex items-center justify-center py-12 text-slate-500 font-mono text-xs gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
                  <span>Đang đọc bảng đăng ký plugin...</span>
                </div>
              ) : installedPlugins.length === 0 ? (
                <div className="text-center py-12 text-slate-500 font-mono text-xs">
                  Chưa có plugin nào được cài đặt trong hệ thống.
                </div>
              ) : (
                installedPlugins.map((plugin) => {
                  const isToggling = togglingId === plugin.pluginId;
                  const isFirstParty = plugin.trustTier === "first_party";

                  return (
                    <div
                      key={plugin.pluginId}
                      className={`rounded-xl border p-4 transition-colors flex items-center justify-between gap-4 ${
                        plugin.isEnabled
                          ? "border-slate-700 bg-slate-900/80"
                          : "border-slate-800/60 bg-slate-900/30 opacity-70"
                      }`}
                    >
                      <div className="space-y-1 font-mono">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">
                            {plugin.name}
                          </span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold ${
                              isFirstParty
                                ? "bg-cyan-950 text-cyan-300 border border-cyan-800/60"
                                : "bg-amber-950 text-amber-300 border border-amber-800/60"
                            }`}
                          >
                            {isFirstParty ? "First-Party" : "Sandboxed"}
                          </span>
                          <span className="text-[10px] text-slate-500">
                            v{plugin.version}
                          </span>
                        </div>

                        <div className="text-xs text-slate-400 flex items-center gap-3">
                          <span>
                            ID: <code className="text-slate-300">{plugin.pluginId}</code>
                          </span>
                          <span>•</span>
                          <span>
                            Category:{" "}
                            <span className="text-slate-300">{plugin.category}</span>
                          </span>
                          <span>•</span>
                          <span>
                            Tác giả:{" "}
                            <span className="text-slate-300">{plugin.author}</span>
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={() => handleToggle(plugin)}
                        disabled={isToggling}
                        className={`shrink-0 px-3.5 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                          plugin.isEnabled
                            ? "bg-emerald-950 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-900/60"
                            : "bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700"
                        } disabled:opacity-50`}
                      >
                        {isToggling ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : plugin.isEnabled ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span>BẬT</span>
                          </>
                        ) : (
                          <span>TẮT</span>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </>
          )}

          {/* TAB 2: MARKETPLACE */}
          {activeTab === "marketplace" && (
            <>
              {isLoadingRemote ? (
                <div className="flex items-center justify-center py-12 text-slate-500 font-mono text-xs gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
                  <span>Đang kết nối kho plugin từ xa...</span>
                </div>
              ) : remotePlugins.length === 0 ? (
                <div className="text-center py-12 text-slate-500 font-mono text-xs">
                  Kho plugin hiện chưa có tiện ích mới.
                </div>
              ) : (
                remotePlugins.map((remote) => {
                  const isInstalled = installedPlugins.some(
                    (p) => p.pluginId === remote.id
                  );
                  const isInstalling = installingId === remote.id;

                  return (
                    <div
                      key={remote.id}
                      className="rounded-xl border border-slate-800/80 bg-slate-900/50 p-4 transition-colors flex items-center justify-between gap-4"
                    >
                      <div className="space-y-1.5 font-mono">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">
                            {remote.name}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800/60 font-semibold">
                            Community
                          </span>
                          <span className="text-[10px] text-slate-500">
                            v{remote.version}
                          </span>
                        </div>

                        <div className="text-xs text-slate-400 flex items-center gap-3">
                          <span>
                            ID: <code className="text-slate-300">{remote.id}</code>
                          </span>
                          <span>•</span>
                          <span>
                            Tác giả:{" "}
                            <span className="text-slate-300">{remote.author}</span>
                          </span>
                        </div>

                        <div className="text-[11px] text-slate-500 flex items-center gap-1">
                          <Shield className="w-3 h-3 text-cyan-400" />
                          <span>
                            SHA-256:{" "}
                            <code className="text-slate-400">
                              {remote.sha256.slice(0, 12)}...
                            </code>
                          </span>
                        </div>
                      </div>

                      <div>
                        {isInstalled ? (
                          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 text-xs font-mono">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Đã cài</span>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleInstall(remote)}
                            disabled={isInstalling}
                            className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-mono text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                          >
                            {isInstalling ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                <span>Cài đặt...</span>
                              </>
                            ) : (
                              <>
                                <Download className="w-3.5 h-3.5" />
                                <span>Cài đặt</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        {/* Footer info */}
        <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-500">
          <div className="flex items-center gap-1.5 text-slate-400">
            <Shield className="w-3.5 h-3.5 text-cyan-400" />
            <span>Zip-Slip Guard • SHA-256 Quarantine Checked</span>
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors cursor-pointer"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};

export default PluginMarketplaceModal;
