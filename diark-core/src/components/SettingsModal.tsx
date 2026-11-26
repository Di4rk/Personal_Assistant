import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { usePrivacyStore } from '../stores/usePrivacyStore';
import {
  getUserProfile,
  saveUserProfile,
  getCfHandle,
  setCfHandle,
  getStudentProfile,
  getSystemStorageStats,
  launchPortalSsoSync,
  launchWecodeSsoSync,
  getGeminiConfig,
  saveGeminiConfig,
  testGeminiKey,
  openExternalUrl,
  getSsoCredentialsStatus,
  saveSsoCredentials,
  clearSsoCredentials,
  StudentProfilePayload,
  SystemStorageStats,
} from '../lib/tauri-client';
import { listInstalledPlugins, togglePlugin } from '../lib/plugin-sdk';
import { PluginMetaDto } from '../types/plugin';
import { APP_VERSION } from '../constants/app';
import {
  User,
  Blocks,
  RefreshCw,
  Database,
  X,
  Shield,
  Check,
  Loader2,
  GraduationCap,
  Code,
  ExternalLink,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  ArrowUpCircle,
  Power,
  Keyboard,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import {
  getSystemPreferences,
  updateAutostartSetting,
  updateStartMinimizedSetting,
  updateGlobalShortcut,
} from '../services/systemService';
import { ShortcutRecorder } from './ShortcutRecorder';

interface SettingsModalProps {
  onResetGenesis?: () => void;
}

export const PRESET_GEMINI_MODELS = [
  { id: "gemini-2.5-flash", name: "gemini-2.5-flash (Khuyên dùng — Thế hệ mới, cực nhanh & thông minh)" },
  { id: "gemini-2.5-pro", name: "gemini-2.5-pro (Mạnh mẽ — Suy luận chuyên sâu, giải thuật khó)" },
  { id: "gemini-2.5-flash-lite", name: "gemini-2.5-flash-lite (Hạn mức cao 10 RPM / 250K TPM)" },
  { id: "gemini-2.0-flash", name: "gemini-2.0-flash (Thế hệ 2.0 chuẩn)" },
  { id: "gemini-3-flash", name: "gemini-3-flash (Thế hệ 3 Preview)" },
  { id: "gemini-3.1-flash-lite", name: "gemini-3.1-flash-lite (Hạn mức cao 15 RPM / 500 RPD)" },
  { id: "gemini-3.5-flash", name: "gemini-3.5-flash (Thế hệ 3.5 Flash)" },
  { id: "gemini-3.7-flash", name: "gemini-3.7-flash (Thế hệ 3.7 Thinking)" },
  { id: "gemini-3.8-flash", name: "gemini-3.8-flash (Thế hệ 3.8 Flash)" },
  { id: "gemini-1.5-flash", name: "gemini-1.5-flash (Legacy — Ổn định, hạn mức cao)" },
  { id: "gemini-1.5-pro", name: "gemini-1.5-pro (Legacy Pro — Phân tích chi tiết)" },
];

export const SettingsModal: React.FC<SettingsModalProps> = () => {
  const { isOpen, activeTab, closeSettings, setActiveTab } = useSettingsStore();
  const { isDemoMode, toggleDemoMode } = usePrivacyStore();

  // Tab: Profile state
  const [nickname, setNickname] = useState('');
  const [isSavingNick, setIsSavingNick] = useState(false);
  const [nickSavedSuccess, setNickSavedSuccess] = useState(false);
  const [cfHandle, setCfHandleState] = useState('');
  const [isSavingCf, setIsSavingCf] = useState(false);
  const [cfSavedSuccess, setCfSavedSuccess] = useState(false);
  const [studentProfile, setStudentProfile] = useState<StudentProfilePayload | null>(null);

  // Tab: Plugins state
  const [plugins, setPlugins] = useState<PluginMetaDto[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(false);

  // Tab: Services state
  const [syncingPortal, setSyncingPortal] = useState(false);
  const [syncingWecode, setSyncingWecode] = useState(false);
  const [ssoUsername, setSsoUsername] = useState('');
  const [ssoPassword, setSsoPassword] = useState('');
  const [ssoHasPassword, setSsoHasPassword] = useState(false);
  const [ssoAutoLogin, setSsoAutoLogin] = useState(true);
  const [isSavingSso, setIsSavingSso] = useState(false);
  const [ssoFeedback, setSsoFeedback] = useState<string | null>(null);

  // Tab: System stats state
  const [storageStats, setStorageStats] = useState<SystemStorageStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  // Tab: AI Copilot (BYOK) state
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash');
  const [isCustomModel, setIsCustomModel] = useState(false);
  const [isSavingGemini, setIsSavingGemini] = useState(false);
  const [geminiSavedSuccess, setGeminiSavedSuccess] = useState(false);
  const [isTestingGemini, setIsTestingGemini] = useState(false);
  const [testGeminiResult, setTestGeminiResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  // Tab: System preferences (Dynamic Hotkey & Autostart)
  const [autostartEnabled, setAutostartEnabled] = useState<boolean>(false);
  const [startMinimized, setStartMinimized] = useState<boolean>(true);
  const [globalShortcut, setGlobalShortcut] = useState<string>('Alt+K');
  const [hotkeyActive, setHotkeyActive] = useState<boolean>(true);
  const [isUpdatingAutostart, setIsUpdatingAutostart] = useState<boolean>(false);
  const [isUpdatingStartMinimized, setIsUpdatingStartMinimized] = useState<boolean>(false);
  const [isResettingShortcut, setIsResettingShortcut] = useState<boolean>(false);
  const [systemPrefError, setSystemPrefError] = useState<string | null>(null);

  // Listen to Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        closeSettings();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeSettings]);

  // Load data when modal opens or tab changes
  useEffect(() => {
    if (!isOpen) return;

    // Load basic profile
    getUserProfile()
      .then((p) => setNickname(p.nickname || 'Diark'))
      .catch((e) => console.error('Failed to get user profile:', e));

    getCfHandle()
      .then((h) => setCfHandleState(h || ''))
      .catch((e) => console.error('Failed to get CF handle:', e));

    getStudentProfile()
      .then((sp) => setStudentProfile(sp))
      .catch((e) => console.error('Failed to get student profile:', e));

    // Load plugins
    setLoadingPlugins(true);
    listInstalledPlugins()
      .then((pl) => setPlugins(pl))
      .catch((e) => console.error('Failed to list plugins:', e))
      .finally(() => setLoadingPlugins(false));

    // Load system storage stats
    setLoadingStats(true);
    getSystemStorageStats()
      .then((s) => setStorageStats(s))
      .catch((e) => console.error('Failed to get storage stats:', e))
      .finally(() => setLoadingStats(false));

    // Load Gemini Copilot config
    getGeminiConfig()
      .then((cfg) => {
        setGeminiApiKey(cfg.api_key || '');
        const targetModel = cfg.model || 'gemini-2.5-flash';
        setGeminiModel(targetModel);
        const isPreset = PRESET_GEMINI_MODELS.some((m) => m.id === targetModel);
        setIsCustomModel(!isPreset);
      })
      .catch((e) => console.error('Failed to get Gemini config:', e));

    // Load System Preferences (Autostart & Hotkey)
    getSystemPreferences()
      .then((prefs) => {
        setAutostartEnabled(prefs.autostartEnabled);
        setStartMinimized(prefs.startMinimized);
        setGlobalShortcut(prefs.globalShortcut);
        setHotkeyActive(prefs.hotkeyActive);
      })
      .catch((e) => console.error('Failed to get system preferences:', e));

    getSsoCredentialsStatus()
      .then((status) => {
        setSsoUsername(status.username || '');
        setSsoHasPassword(status.has_password);
        setSsoAutoLogin(status.auto_login);
        setSsoPassword('');
        setSsoFeedback(null);
      })
      .catch((e) => console.error('Failed to get SSO status:', e));
  }, [isOpen]);

  // Listen to hotkey-registration-failed event from backend
  useEffect(() => {
    const unlistenPromise = listen<{ code: string; message: string }>(
      'hotkey-registration-failed',
      (event) => {
        setHotkeyActive(false);
        setSystemPrefError(`Cảnh báo phím tắt: ${event.payload.message || 'Không thể đăng ký phím tắt với hệ thống.'}`);
      }
    );
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleToggleAutostart = async () => {
    if (isUpdatingAutostart) return;
    const nextVal = !autostartEnabled;
    setIsUpdatingAutostart(true);
    setSystemPrefError(null);
    setAutostartEnabled(nextVal);
    try {
      await updateAutostartSetting(nextVal);
    } catch (err: unknown) {
      setAutostartEnabled(!nextVal); // rollback
      const error = err as { message?: string };
      setSystemPrefError(error.message || 'Thao tác cấu hình khởi động cùng hệ thống thất bại.');
    } finally {
      setIsUpdatingAutostart(false);
    }
  };

  const handleToggleStartMinimized = async () => {
    if (isUpdatingStartMinimized || !autostartEnabled) return;
    const nextVal = !startMinimized;
    setIsUpdatingStartMinimized(true);
    setSystemPrefError(null);
    setStartMinimized(nextVal);
    try {
      await updateStartMinimizedSetting(nextVal);
    } catch (err: unknown) {
      setStartMinimized(!nextVal); // rollback
      const error = err as { message?: string };
      setSystemPrefError(error.message || 'Thao tác cấu hình khởi động thu nhỏ thất bại.');
    } finally {
      setIsUpdatingStartMinimized(false);
    }
  };

  const handleResetDefaultShortcut = async () => {
    if (isResettingShortcut) return;
    setIsResettingShortcut(true);
    setSystemPrefError(null);
    try {
      const canonical = await updateGlobalShortcut('Alt+K');
      setGlobalShortcut(canonical);
      setHotkeyActive(true);
    } catch (err: unknown) {
      const error = err as { message?: string };
      setSystemPrefError(error.message || 'Không thể khôi phục phím tắt mặc định.');
    } finally {
      setIsResettingShortcut(false);
    }
  };

  if (!isOpen) return null;

  const handleSaveNickname = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || isSavingNick) return;
    setIsSavingNick(true);
    setNickSavedSuccess(false);
    try {
      await saveUserProfile(nickname.trim(), 'CS');
      setNickSavedSuccess(true);
      setTimeout(() => setNickSavedSuccess(false), 2500);
    } catch (err) {
      console.error('Lỗi khi lưu Nickname:', err);
    } finally {
      setIsSavingNick(false);
    }
  };

  const handleSaveCfHandle = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = cfHandle.trim();
    if (!trimmed || isSavingCf) return;
    setIsSavingCf(true);
    setCfSavedSuccess(false);
    try {
      await setCfHandle(trimmed);
      setCfSavedSuccess(true);
      setTimeout(() => setCfSavedSuccess(false), 2500);
    } catch (err) {
      console.error('Lỗi khi lưu Codeforces handle:', err);
    } finally {
      setIsSavingCf(false);
    }
  };

  const handleTogglePlugin = async (pluginId: string, currentEnabled: boolean) => {
    try {
      await togglePlugin(pluginId, !currentEnabled);
      setPlugins((prev) =>
        prev.map((p) => (p.pluginId === pluginId ? { ...p, isEnabled: !currentEnabled } : p))
      );
    } catch (err) {
      console.error('Lỗi khi chuyển trạng thái plugin:', err);
    }
  };

  const handleTriggerPortalSync = async () => {
    setSyncingPortal(true);
    try {
      await launchPortalSsoSync();
    } catch (err) {
      console.error('Lỗi mở SSO Portal:', err);
    } finally {
      setSyncingPortal(false);
    }
  };

  const handleTriggerWecodeSync = async () => {
    setSyncingWecode(true);
    try {
      await launchWecodeSsoSync();
    } catch (err) {
      console.error('Lỗi mở SSO Wecode:', err);
    } finally {
      setSyncingWecode(false);
    }
  };

  const handleSaveGeminiConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingGemini) return;
    setIsSavingGemini(true);
    setGeminiSavedSuccess(false);
    setTestGeminiResult(null);
    try {
      await saveGeminiConfig(geminiApiKey.trim(), geminiModel);
      setGeminiSavedSuccess(true);
      setTimeout(() => setGeminiSavedSuccess(false), 2500);
    } catch (err) {
      console.error('Lỗi khi lưu cấu hình Gemini:', err);
    } finally {
      setIsSavingGemini(false);
    }
  };

  const handleTestGeminiKey = async () => {
    const key = geminiApiKey.trim();
    if (!key || isTestingGemini) return;
    setIsTestingGemini(true);
    setTestGeminiResult(null);
    try {
      const pingResponse = await testGeminiKey(key, geminiModel);
      setTestGeminiResult({
        success: true,
        message: `Xác thực thành công! Phản hồi từ Gemini: "${pingResponse.slice(0, 80)}..."`,
      });
    } catch (err) {
      setTestGeminiResult({
        success: false,
        message: typeof err === 'string' ? err : 'Kiểm tra thất bại. Vui lòng kiểm tra lại API Key.',
      });
    } finally {
      setIsTestingGemini(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
      <div className="flex h-[560px] w-full max-w-3xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl text-zinc-100">
        {/* Left Column: Tab Navigation */}
        <div className="w-56 border-r border-zinc-800 bg-zinc-950/70 p-4 flex flex-col justify-between">
          <div>
            <div className="mb-6 px-2 flex items-center gap-3">
              <img
                src="/app-icon.png"
                alt="DIARK // OS Logo"
                className="w-9 h-9 rounded-lg border border-zinc-700 object-cover"
              />
              <div>
                <p className="font-mono text-[10px] uppercase tracking-widest text-emerald-400">Cài đặt</p>
                <h2 className="font-mono text-sm font-bold tracking-wider text-zinc-100">DIARK OS</h2>
              </div>
            </div>

            <nav className="space-y-1">
              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition cursor-pointer ${
                  activeTab === 'profile'
                    ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border border-transparent'
                }`}
              >
                <User className="w-4 h-4" />
                <span>Hồ sơ</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('plugins')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition cursor-pointer ${
                  activeTab === 'plugins'
                    ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border border-transparent'
                }`}
              >
                <Blocks className="w-4 h-4" />
                <span>Tiện ích mở rộng</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('services')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition cursor-pointer ${
                  activeTab === 'services'
                    ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border border-transparent'
                }`}
              >
                <RefreshCw className="w-4 h-4" />
                <span>Dịch vụ Học vụ</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('copilot')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition cursor-pointer ${
                  activeTab === 'copilot'
                    ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border border-transparent'
                }`}
              >
                <Key className="w-4 h-4 text-emerald-400" />
                <span>Trợ lý Gemini</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('system')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition cursor-pointer ${
                  activeTab === 'system'
                    ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 border border-transparent'
                }`}
              >
                <Database className="w-4 h-4" />
                <span>Hệ thống</span>
              </button>
            </nav>
          </div>

          <div className="px-2 pt-4 border-t border-slate-800/80 font-mono text-[10px] text-slate-500">
            DIARK // OS {APP_VERSION}
          </div>
        </div>

        {/* Right Column: Tab Content */}
        <div className="flex-1 flex flex-col min-w-0 bg-slate-900/60">
          {/* Header Bar with Close Button */}
          <div className="flex items-center justify-between border-b border-slate-800 px-6 py-3.5">
            <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-slate-200">
              {activeTab === 'profile' && 'Cấu hình Định danh & Hồ sơ'}
              {activeTab === 'plugins' && 'Quản lý Phân hệ & Plugins'}
              {activeTab === 'services' && 'Cổng Đồng bộ Dịch vụ Ngoài'}
              {activeTab === 'copilot' && 'Trợ lý AI Copilot (BYOK)'}
              {activeTab === 'system' && 'Thông số & Bảo mật Hệ thống'}
            </h3>
            <button
              type="button"
              onClick={closeSettings}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition cursor-pointer"
              title="Đóng (Escape)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* TAB 1: PROFILE */}
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <form onSubmit={handleSaveNickname} className="space-y-3">
                  <label className="block font-mono text-xs uppercase tracking-wider text-slate-300">
                    Signature Handle / Nickname
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                      placeholder="Nhập tên gọi của bạn..."
                      required
                    />
                    <button
                      type="submit"
                      disabled={isSavingNick || !nickname.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 font-mono text-xs font-bold uppercase text-slate-950 hover:bg-cyan-500 transition disabled:opacity-50 cursor-pointer"
                    >
                      {isSavingNick ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      <span>Lưu</span>
                    </button>
                  </div>
                  {nickSavedSuccess && (
                    <p className="font-mono text-xs text-emerald-400">✓ Đã cập nhật chữ ký định danh thành công.</p>
                  )}
                </form>

                {/* Codeforces Handle Config */}
                <form onSubmit={handleSaveCfHandle} className="space-y-3">
                  <label className="block font-mono text-xs uppercase tracking-wider text-slate-300">
                    Codeforces Handle
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={cfHandle}
                      onChange={(e) => setCfHandleState(e.target.value)}
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 font-mono text-sm text-slate-100 outline-none transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                      placeholder="Nhập handle Codeforces (ví dụ: tourist)..."
                    />
                    <button
                      type="submit"
                      disabled={isSavingCf || !cfHandle.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 font-mono text-xs font-bold uppercase text-slate-950 hover:bg-cyan-500 transition disabled:opacity-50 cursor-pointer"
                    >
                      {isSavingCf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      <span>Lưu</span>
                    </button>
                  </div>
                  {cfSavedSuccess && (
                    <p className="font-mono text-xs text-emerald-400">✓ Đã cập nhật Codeforces handle thành công.</p>
                  )}
                </form>

                <div className="space-y-3">
                  <p className="font-mono text-xs uppercase tracking-wider text-slate-400">
                    Dữ liệu sinh viên UIT (Đồng bộ tự động từ Portal)
                  </p>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <p className="font-mono text-[10px] text-slate-500 uppercase">Mã số sinh viên (MSSV)</p>
                      <p className="font-mono text-sm font-semibold text-slate-200 mt-0.5">
                        {studentProfile?.student_id || 'Chưa đồng bộ'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <p className="font-mono text-[10px] text-slate-500 uppercase">Họ và tên</p>
                      <p className="font-mono text-sm font-semibold text-slate-200 mt-0.5">
                        {studentProfile?.full_name || 'Chưa đồng bộ'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <p className="font-mono text-[10px] text-slate-500 uppercase">Lớp sinh hoạt</p>
                      <p className="font-mono text-sm font-semibold text-slate-200 mt-0.5">
                        {studentProfile?.student_class || 'Chưa đồng bộ'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <p className="font-mono text-[10px] text-slate-500 uppercase">Ngành / Chuyên ngành</p>
                      <p className="font-mono text-sm font-semibold text-slate-200 mt-0.5 truncate">
                        {studentProfile?.specialization || studentProfile?.major_code || 'Chưa đồng bộ'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: PLUGINS */}
            {activeTab === 'plugins' && (
              <div className="space-y-4">
                <p className="text-xs text-slate-400">
                  Kích hoạt hoặc vô hiệu hóa các phân hệ chức năng trong không gian làm việc.
                </p>

                {loadingPlugins ? (
                  <div className="flex items-center justify-center p-8 text-slate-400">
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {plugins.map((plugin) => (
                      <div
                        key={plugin.pluginId}
                        className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 p-3.5 hover:border-slate-700/80 transition"
                      >
                        <div className="min-w-0 pr-4">
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-sm text-slate-200">{plugin.name}</p>
                            <span className="font-mono text-[10px] text-slate-500 uppercase">
                              v{plugin.version}
                            </span>
                            {plugin.trustTier === 'first_party' ? (
                              <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-400">
                                Native
                              </span>
                            ) : (
                              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-400">
                                Sandboxed
                              </span>
                            )}
                          </div>
                          <p className="font-mono text-xs text-slate-400 mt-0.5 truncate">{plugin.pluginId}</p>
                        </div>

                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={plugin.isEnabled}
                            onChange={() => handleTogglePlugin(plugin.pluginId, plugin.isEnabled)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: SERVICES */}
            {activeTab === 'services' && (
              <div className="space-y-4">
                <p className="text-xs text-slate-400">
                  Đồng bộ dữ liệu học vụ định danh từ các cổng thông tin UIT.
                </p>

                <div className="space-y-3">
                  {/* Portal UIT Card */}
                  <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <GraduationCap className="w-4 h-4 text-cyan-400" />
                        <h4 className="font-semibold text-slate-200 text-sm">Cổng Thông Tin Đào Tạo (Portal UIT)</h4>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        Bóc tách hồ sơ sinh viên, bảng điểm chi tiết và điểm rèn luyện theo học kỳ.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleTriggerPortalSync}
                      disabled={syncingPortal}
                      className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3.5 py-2 font-mono text-xs font-bold text-cyan-300 hover:bg-cyan-500/20 transition disabled:opacity-50 cursor-pointer"
                    >
                      {syncingPortal ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      <span>Đồng bộ Portal</span>
                    </button>
                  </div>

                  {/* Wecode UIT Card */}
                  <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <Code className="w-4 h-4 text-blue-400" />
                        <h4 className="font-semibold text-slate-200 text-sm">Hệ thống Nộp bài Thực hành (Wecode UIT)</h4>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        Đồng bộ bài nộp, trạng thái điểm số First-AC và danh sách bài tập thực hành.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleTriggerWecodeSync}
                      disabled={syncingWecode}
                      className="flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3.5 py-2 font-mono text-xs font-bold text-blue-300 hover:bg-blue-500/20 transition disabled:opacity-50 cursor-pointer"
                    >
                      {syncingWecode ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      <span>Đồng bộ Wecode</span>
                    </button>
                  </div>

                  {/* Moodle UIT Card */}
                  <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <ExternalLink className="w-4 h-4 text-emerald-400" />
                        <h4 className="font-semibold text-zinc-200 text-sm">Học tập Trực tuyến (Moodle / Courses)</h4>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1">
                        Đồng bộ môn học, hạn nộp bài tập, tài liệu và điểm quá trình từ Courses UIT.
                      </p>
                    </div>
                    <span className="font-mono text-xs text-zinc-500">Đồng bộ tự động</span>
                  </div>

                  {/* Tự động đăng nhập SSO UIT */}
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-semibold text-zinc-100">Tự động đăng nhập SSO UIT</h4>
                        <p className="text-xs text-zinc-400 mt-0.5">
                          Lưu tài khoản và mật khẩu ngay trên máy của bạn để tự điền mỗi khi phiên đăng nhập hết hạn.
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-zinc-300 shrink-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={ssoAutoLogin}
                          onChange={(e) => setSsoAutoLogin(e.target.checked)}
                          className="h-3.5 w-3.5 accent-emerald-500"
                        />
                        <span>Tự động vào</span>
                      </label>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <input
                        type="text"
                        value={ssoUsername}
                        onChange={(e) => setSsoUsername(e.target.value)}
                        placeholder="MSSV (vd: 25520458)"
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                      />
                      <input
                        type="password"
                        value={ssoPassword}
                        onChange={(e) => setSsoPassword(e.target.value)}
                        placeholder={ssoHasPassword ? "•••••••• (đã lưu, nhập để đổi)" : "Mật khẩu SSO"}
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-mono text-zinc-500">
                        {ssoFeedback || (ssoHasPassword ? `Đã lưu cục bộ cho ${ssoUsername}` : "Chưa lưu mật khẩu")}
                      </span>
                      <div className="flex items-center gap-2">
                        {ssoHasPassword && (
                          <button
                            type="button"
                            onClick={() => {
                              setIsSavingSso(true);
                              void clearSsoCredentials()
                                .then(() => {
                                  setSsoUsername('');
                                  setSsoPassword('');
                                  setSsoHasPassword(false);
                                  setSsoAutoLogin(false);
                                  setSsoFeedback('Đã xóa thông tin đăng nhập đã lưu.');
                                })
                                .catch((e) => setSsoFeedback(String(e)))
                                .finally(() => setIsSavingSso(false));
                            }}
                            disabled={isSavingSso}
                            className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-rose-400 hover:bg-zinc-800 cursor-pointer"
                          >
                            Xóa đã lưu
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setIsSavingSso(true);
                            void saveSsoCredentials(
                              ssoUsername,
                              ssoPassword.length > 0 ? ssoPassword : null,
                              ssoAutoLogin
                            )
                              .then(() => {
                                if (ssoPassword.length > 0) setSsoHasPassword(true);
                                setSsoPassword('');
                                setSsoFeedback('Đã lưu cấu hình SSO cục bộ.');
                              })
                              .catch((e) => setSsoFeedback(String(e)))
                              .finally(() => setIsSavingSso(false));
                          }}
                          disabled={isSavingSso || !ssoUsername.trim()}
                          className="rounded-md bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-zinc-200 disabled:opacity-40 cursor-pointer"
                        >
                          Lưu SSO
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB: AI COPILOT (BYOK) */}
            {activeTab === 'copilot' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                    <Key className="w-4 h-4 text-emerald-400" />
                    <span>Trợ lý Gemini cá nhân</span>
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1">
                    Dùng khóa API cá nhân của bạn. Khóa được lưu ngay trên máy và gọi trực tiếp tới Google AI.
                  </p>
                </div>

                <form onSubmit={handleSaveGeminiConfig} className="space-y-4">
                  {/* API Key Input */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="font-mono text-xs uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                        <Key className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Google Gemini API Key</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => openExternalUrl('https://aistudio.google.com/app/apikey')}
                        className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
                      >
                        <span>Lấy API Key miễn phí tại Google AI Studio</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    </div>

                    <div className="relative">
                      <input
                        type={showApiKey ? 'text' : 'password'}
                        value={geminiApiKey}
                        onChange={(e) => setGeminiApiKey(e.target.value)}
                        placeholder="AIzaSy..."
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 pr-10 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                      >
                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Model Selection */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="font-mono text-xs uppercase tracking-wider text-zinc-400">
                        Mô hình Gemini (Model)
                      </label>
                      <button
                        type="button"
                        onClick={() => setIsCustomModel((prev) => !prev)}
                        className="text-[11px] font-mono text-zinc-400 hover:text-zinc-200 underline cursor-pointer"
                      >
                        {isCustomModel ? "Chọn từ danh sách có sẵn" : "Nhập mã model tùy chỉnh"}
                      </button>
                    </div>

                    {!isCustomModel ? (
                      <select
                        value={geminiModel}
                        onChange={(e) => {
                          if (e.target.value === "__custom__") {
                            setIsCustomModel(true);
                          } else {
                            setGeminiModel(e.target.value);
                          }
                        }}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 font-mono text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none cursor-pointer"
                      >
                        {PRESET_GEMINI_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                        <option value="__custom__">Tùy chỉnh (Nhập mã model bất kỳ...)</option>
                      </select>
                    ) : (
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          value={geminiModel}
                          onChange={(e) => setGeminiModel(e.target.value)}
                          placeholder="Ví dụ: gemini-3.8-flash..."
                          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-4 py-2.5 font-mono text-xs text-zinc-200 focus:border-zinc-500 focus:outline-none"
                          autoFocus
                        />
                        <p className="text-[10px] text-zinc-500 font-mono">
                          Nhập chính xác Model ID từ Google AI Studio (ví dụ: gemini-2.5-flash, gemini-3.1-flash-lite...)
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-3 pt-2">
                    <button
                      type="submit"
                      disabled={isSavingGemini}
                      className="flex items-center gap-2 rounded-lg bg-zinc-100 hover:bg-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-950 transition cursor-pointer disabled:opacity-50"
                    >
                      {isSavingGemini ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : geminiSavedSuccess ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : null}
                      <span>{geminiSavedSuccess ? 'Đã lưu cấu hình' : 'Lưu cấu hình'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleTestGeminiKey}
                      disabled={isTestingGemini || !geminiApiKey.trim()}
                      className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 px-4 py-2 text-xs font-medium text-zinc-200 transition cursor-pointer disabled:opacity-50"
                    >
                      {isTestingGemini ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                      <span>Kiểm tra kết nối</span>
                    </button>
                  </div>
                </form>

                {/* Test Result Feedback */}
                {testGeminiResult && (
                  <div
                    className={`rounded-lg border p-3.5 text-xs font-mono flex items-start gap-2.5 ${
                      testGeminiResult.success
                        ? 'border-emerald-600/30 bg-emerald-950/30 text-emerald-300'
                        : 'border-rose-600/30 bg-rose-950/30 text-rose-300'
                    }`}
                  >
                    {testGeminiResult.success ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="font-semibold">{testGeminiResult.success ? 'Kết nối thành công!' : 'Lỗi kết nối:'}</p>
                      <p className="text-[11px] mt-0.5 opacity-90">{testGeminiResult.message}</p>
                    </div>
                  </div>
                )}

                {/* Security Policy */}
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3.5 text-[11px] text-zinc-400 space-y-1">
                  <p className="font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Quyền riêng tư (Lưu trên máy):</span>
                  </p>
                  <p>
                    • API Key chỉ lưu ngay trên máy tính của bạn, không gửi qua máy chủ trung gian.
                  </p>
                  <p>
                    • Mọi yêu cầu kết nối trực tiếp tới Google Gemini API qua giao thức mã hóa HTTPS.
                  </p>
                </div>
              </div>
            )}

            {/* TAB 4: SYSTEM */}
            {activeTab === 'system' && (
              <div className="space-y-6">
                {/* Hotkey Registration Warning Banner */}
                {!hotkeyActive && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 text-xs text-amber-300">
                    <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-amber-200">Cảnh báo: Phím tắt chưa thể kích hoạt</p>
                      <p className="mt-1 text-slate-300 leading-relaxed">
                        Phím tắt toàn cục ({globalShortcut}) đang bị ứng dụng khác chiếm dụng (ví dụ: Unikey, EVKey hoặc phần mềm khác). Bạn vẫn có thể mở Diark bằng cách nhấp đúp biểu tượng dưới khay hệ thống (System Tray).
                      </p>
                    </div>
                  </div>
                )}

                {systemPrefError && (
                  <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-950/20 p-3 text-xs text-rose-300">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>{systemPrefError}</span>
                  </div>
                )}

                {/* 1. Global Shortcut & HUD */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-slate-200 font-semibold text-xs font-mono">
                        <Keyboard className="w-4 h-4 text-cyan-400" />
                        <span>PHÍM TẮT TOÀN CỤC (QUICK HUD)</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Bật/tắt nhanh giao diện Diark OS từ bất kỳ đâu trên máy tính.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleResetDefaultShortcut}
                      disabled={isResettingShortcut}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white font-mono text-xs transition cursor-pointer disabled:opacity-50"
                      title="Đặt lại về Alt+K"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>{isResettingShortcut ? 'Đang khôi phục...' : 'Khôi phục mặc định'}</span>
                    </button>
                  </div>

                  <div className="pt-2 border-t border-slate-800/80">
                    <ShortcutRecorder
                      currentShortcut={globalShortcut}
                      onShortcutChanged={(canonical) => {
                        setGlobalShortcut(canonical);
                        setHotkeyActive(true);
                        setSystemPrefError(null);
                      }}
                    />
                  </div>
                </div>

                {/* 2. Autostart & Window Persistence */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-slate-200 font-semibold text-xs font-mono">
                        <Power className="w-4 h-4 text-emerald-400" />
                        <span>KHỞI ĐỘNG CÙNG HỆ THỐNG</span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Tự động khởi chạy ứng dụng khi đăng nhập Windows (Registry Run key).
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleToggleAutostart}
                      disabled={isUpdatingAutostart}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg font-mono text-xs font-bold border transition cursor-pointer disabled:opacity-50 ${
                        autostartEnabled
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                          : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                      }`}
                    >
                      {isUpdatingAutostart ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <span>{autostartEnabled ? 'BẬT (ON)' : 'TẮT (OFF)'}</span>
                      )}
                    </button>
                  </div>

                  <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-slate-300">Khởi động thu nhỏ vào khay (Start Minimized)</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Khi bật tự động lúc khởi động máy, app sẽ ẩn dưới khay hệ thống thay vì bung toàn màn hình.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleToggleStartMinimized}
                      disabled={!autostartEnabled || isUpdatingStartMinimized}
                      className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg font-mono text-xs font-bold border transition cursor-pointer ${
                        !autostartEnabled
                          ? 'opacity-40 cursor-not-allowed bg-slate-900 border-slate-800 text-slate-600'
                          : startMinimized
                          ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50'
                          : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                      }`}
                    >
                      {isUpdatingStartMinimized ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <span>{startMinimized ? 'BẬT (ON)' : 'TẮT (OFF)'}</span>
                      )}
                    </button>
                  </div>
                </div>

                {/* Demo Privacy Shield */}
                <div className="flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-950/10 p-4">
                  <div>
                    <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
                      <Shield className="w-4 h-4" />
                      <span>Demo Privacy Shield</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Ẩn MSSV và tên định danh khi chụp ảnh màn hình hoặc demo thuyết trình.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={toggleDemoMode}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg font-mono text-xs font-bold border transition cursor-pointer ${
                      isDemoMode
                        ? 'bg-amber-500/30 text-amber-300 border-amber-500/60'
                        : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                    }`}
                  >
                    <span>{isDemoMode ? 'ĐANG BẬT (ON)' : 'TẮT (OFF)'}</span>
                  </button>
                </div>

                {/* Storage & DB Stats */}
                <div className="space-y-3">
                  <p className="font-mono text-xs uppercase tracking-wider text-zinc-400">
                    Thống kê dữ liệu lưu trên máy
                  </p>

                  {loadingStats ? (
                    <div className="flex items-center justify-center p-6 text-zinc-400">
                      <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3.5 text-center">
                        <p className="font-mono text-[10px] text-zinc-500 uppercase">Dung lượng dữ liệu</p>
                        <p className="font-mono text-base font-bold text-zinc-100 mt-1">
                          {formatBytes(storageStats?.db_size_bytes || 0)}
                        </p>
                      </div>

                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3.5 text-center">
                        <p className="font-mono text-[10px] text-zinc-500 uppercase">Bộ đệm tạm</p>
                        <p className="font-mono text-base font-bold text-zinc-300 mt-1">
                          {formatBytes(storageStats?.wal_size_bytes || 0)}
                        </p>
                      </div>

                      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3.5 text-center">
                        <p className="font-mono text-[10px] text-zinc-500 uppercase">Tổng số bản ghi</p>
                        <p className="font-mono text-base font-bold text-emerald-400 mt-1">
                          {storageStats?.total_records_count?.toLocaleString() || 0}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Auto-Updater Section */}
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-zinc-200 font-semibold text-xs font-mono">
                        <ArrowUpCircle className="w-4 h-4 text-emerald-400" />
                        <span>CẬP NHẬT ỨNG DỤNG</span>
                      </div>
                      <p className="text-[11px] text-zinc-400 mt-1">
                        Phiên bản hiện tại: <span className="font-mono text-emerald-400">{APP_VERSION}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent('check-app-updates'));
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-mono text-xs transition cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Kiểm tra bản mới</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
