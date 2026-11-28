import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore';
import { usePrivacyStore } from '../stores/usePrivacyStore';
import { useVaultShortcutsStore } from '../stores/useVaultShortcutsStore';
import {
  VAULT_SHORTCUT_META,
  normalizeShortcutFromEvent,
  type VaultShortcutAction,
} from '../features/vault/utils/vaultShortcuts';
import {
  addGoogleCalendar,
  connectGoogleCalendarOAuth,
  disconnectGoogleCalendarOAuth,
  getCfHandle,
  getGeminiConfig,
  getGoogleOAuthStatus,
  getSsoCredentialsStatus,
  getStudentProfile,
  getSystemStorageStats,
  getUserProfile,
  listGoogleCalendars,
  openExternalUrl,
  removeGoogleCalendar,
  saveGeminiConfig,
  saveGoogleOAuthClientConfig,
  saveUserProfile,
  setCfHandle,
  syncGoogleCalendars,
  testGeminiKey,
  toggleGoogleCalendar,
  StudentProfilePayload,
  SystemStorageStats,
} from '../lib/tauri-client';
import type { GoogleCalendarConfig, GoogleOAuthStatus } from '../types/portal-extra';
import type { UpdateInfo, UpdateStatus } from '../hooks/useAutoUpdater';
import { APP_VERSION } from '../constants/app';
import { formatTimeHm } from '../utils/scheduleTime';
import {
  User,
  Blocks,
  RefreshCw,
  Database,
  X,
  Shield,
  Check,
  Loader2,
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
  Calendar,
  ChevronDown,
  Lock,
  LogIn,
  LogOut,
  Plus,
  Settings2,
  Trash2,
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
  onOpenSsoLogin?: () => void;
  onLogout?: () => void;
  updateStatus?: UpdateStatus;
  updateInfo?: UpdateInfo | null;
  updateError?: string | null;
  isCheckingUpdate?: boolean;
  autoCheckUpdates?: boolean;
  lastCheckedAt?: number | null;
  onToggleAutoCheckUpdates?: (enabled: boolean) => void;
  onCheckUpdates?: () => void;
  onInstallUpdate?: () => void;
}

const CALENDAR_PALETTE = ['#2F6BFF', '#6B9BFF', '#94a3b8', '#f87171', '#e4e4e7'];

const AI_PROVIDER_PRESETS = [
  { id: 'gemini', label: 'Google Gemini', baseUrl: '', model: 'gemini-2.5-flash' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'ollama', label: 'Ollama Local', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
] as const;

interface UitToggleProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  loading?: boolean;
  ariaLabel: string;
}

const UitToggle: React.FC<UitToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  loading = false,
  ariaLabel,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    onClick={onChange}
    disabled={disabled || loading}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 ${
      disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
    } ${checked ? 'bg-[#2F6BFF]' : 'bg-[#1D263B]'}`}
  >
    <span
      className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white transition-transform duration-150 ${
        checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
      }`}
    >
      {loading && <Loader2 className="h-2.5 w-2.5 animate-spin text-[#080B12]" />}
    </span>
  </button>
);

function isLocalBaseUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('0.0.0.0');
}

function formatLastCheckedTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mm} ${dd}/${mo}`;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  onOpenSsoLogin,
  onLogout,
  updateStatus = 'idle',
  updateInfo = null,
  updateError = null,
  isCheckingUpdate = false,
  autoCheckUpdates = true,
  lastCheckedAt = null,
  onToggleAutoCheckUpdates,
  onCheckUpdates,
  onInstallUpdate,
}) => {
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

  // Logout 2-step confirm state
  const [confirmLogout, setConfirmLogout] = useState(false);

  // Tab: Kết nối & Đồng bộ state
  const [ssoUsername, setSsoUsername] = useState('');
  const [ssoHasPassword, setSsoHasPassword] = useState(false);
  const [calendars, setCalendars] = useState<GoogleCalendarConfig[]>([]);
  const [oauthStatus, setOauthStatus] = useState<GoogleOAuthStatus | null>(null);
  const [isConnectingOAuth, setIsConnectingOAuth] = useState(false);
  const [showOAuthSetup, setShowOAuthSetup] = useState(false);
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [isSavingOAuthConfig, setIsSavingOAuthConfig] = useState(false);
  const [showIcsAdvanced, setShowIcsAdvanced] = useState(false);
  const [newIcsName, setNewIcsName] = useState('');
  const [newIcsUrl, setNewIcsUrl] = useState('');
  const [newIcsColor, setNewIcsColor] = useState(CALENDAR_PALETTE[0]);
  const [isAddingIcs, setIsAddingIcs] = useState(false);
  const [calendarFeedback, setCalendarFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Tab: System stats state
  const [storageStats, setStorageStats] = useState<SystemStorageStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  // Tab: AI API Config (Universal BYOK) state
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('gemini-2.5-flash');
  const [isSavingAi, setIsSavingAi] = useState(false);
  const [aiSavedSuccess, setAiSavedSuccess] = useState(false);
  const [isTestingAi, setIsTestingAi] = useState(false);
  const [testAiResult, setTestAiResult] = useState<{ success: boolean; message: string } | null>(null);
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

  const {
    shortcuts: vaultShortcuts,
    setShortcut: setVaultShortcut,
    resetShortcuts: resetVaultShortcuts,
  } = useVaultShortcutsStore();
  const [recordingVaultAction, setRecordingVaultAction] = useState<VaultShortcutAction | null>(null);
  const [vaultShortcutHint, setVaultShortcutHint] = useState<string | null>(null);

  const loadCalendarConnections = useCallback(async () => {
    const [calsRes, oauthRes] = await Promise.allSettled([
      listGoogleCalendars(),
      getGoogleOAuthStatus(),
    ]);
    if (calsRes.status === 'fulfilled') setCalendars(calsRes.value);
    if (oauthRes.status === 'fulfilled') setOauthStatus(oauthRes.value);
  }, []);

  const refreshSsoSummary = useCallback(() => {
    getSsoCredentialsStatus()
      .then((status) => {
        setSsoUsername(status.username || '');
        setSsoHasPassword(status.has_password);
      })
      .catch((e) => console.error('Failed to get SSO status:', e));
  }, []);

  useEffect(() => {
    if (isOpen && activeTab === 'plugins') {
      setActiveTab('profile');
    }
  }, [isOpen, activeTab, setActiveTab]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !recordingVaultAction) {
        closeSettings();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeSettings, recordingVaultAction]);

  useEffect(() => {
    if (!recordingVaultAction) return;
    const handleRecord = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecordingVaultAction(null);
        setVaultShortcutHint(null);
        return;
      }
      const combo = normalizeShortcutFromEvent(e);
      if (!combo) {
        setVaultShortcutHint('Hãy nhấn tổ hợp có Ctrl / Alt (hoặc phím F1-F12).');
        return;
      }
      const conflict = VAULT_SHORTCUT_META.find(
        (m) => m.action !== recordingVaultAction && vaultShortcuts[m.action] === combo
      );
      setVaultShortcut(recordingVaultAction, combo);
      setRecordingVaultAction(null);
      setVaultShortcutHint(
        conflict
          ? `Đã lưu ${combo}. Lưu ý: đang trùng với "${conflict.label}".`
          : `Đã cập nhật phím tắt: ${combo}`
      );
    };
    window.addEventListener('keydown', handleRecord, true);
    return () => window.removeEventListener('keydown', handleRecord, true);
  }, [recordingVaultAction, setVaultShortcut, vaultShortcuts]);

  useEffect(() => {
    if (!isOpen) return;

    setConfirmLogout(false);
    setCalendarFeedback(null);
    void loadCalendarConnections();
    refreshSsoSummary();

    getUserProfile()
      .then((p) => setNickname(p.nickname || 'Diark'))
      .catch((e) => console.error('Failed to get user profile:', e));

    getCfHandle()
      .then((h) => setCfHandleState(h || ''))
      .catch((e) => console.error('Failed to get CF handle:', e));

    getStudentProfile()
      .then((sp) => setStudentProfile(sp))
      .catch((e) => console.error('Failed to get student profile:', e));

    setLoadingStats(true);
    getSystemStorageStats()
      .then((s) => setStorageStats(s))
      .catch((e) => console.error('Failed to get storage stats:', e))
      .finally(() => setLoadingStats(false));

    getGeminiConfig()
      .then((cfg) => {
        setAiBaseUrl(cfg.base_url || '');
        setAiApiKey(cfg.api_key || '');
        setAiModel(cfg.model || 'gemini-2.5-flash');
      })
      .catch((e) => console.error('Failed to get AI config:', e));

    getSystemPreferences()
      .then((prefs) => {
        setAutostartEnabled(prefs.autostartEnabled);
        setStartMinimized(prefs.startMinimized);
        setGlobalShortcut(prefs.globalShortcut);
        setHotkeyActive(prefs.hotkeyActive);
      })
      .catch((e) => console.error('Failed to get system preferences:', e));
  }, [isOpen, loadCalendarConnections, refreshSsoSummary]);

  useEffect(() => {
    window.addEventListener('sso-credentials-updated', refreshSsoSummary);
    return () => window.removeEventListener('sso-credentials-updated', refreshSsoSummary);
  }, [refreshSsoSummary]);

  useEffect(() => {
    const unlistenPromise = listen<{ code: string; message: string }>(
      'hotkey-registration-failed',
      (event) => {
        setHotkeyActive(false);
        setSystemPrefError(
          `Cảnh báo phím tắt: ${event.payload.message || 'Không thể đăng ký phím tắt với hệ thống.'}`
        );
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
      setAutostartEnabled(!nextVal);
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
      setStartMinimized(!nextVal);
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

  const oauthCalendars = calendars.filter((c) => c.source === 'oauth');
  const icsCalendars = calendars.filter((c) => c.source !== 'oauth');

  const notifyCalendarChanged = () => {
    window.dispatchEvent(new Event('calendar-settings-updated'));
  };

  const handleConnectGoogleOAuth = async () => {
    setIsConnectingOAuth(true);
    setCalendarFeedback(null);
    try {
      const res = await connectGoogleCalendarOAuth();
      await loadCalendarConnections();
      notifyCalendarChanged();
      if (res.errors.length > 0) {
        setCalendarFeedback({
          ok: false,
          text: `Đã kết nối Google nhưng có lỗi tải lịch: ${res.errors.join('; ')}`,
        });
      } else {
        setCalendarFeedback({
          ok: true,
          text: `Đã kết nối Google và kéo về ${res.total_events} sự kiện từ ${res.synced_calendars} lịch.`,
        });
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes('OAuth Client ID')) {
        setShowOAuthSetup(true);
      }
      setCalendarFeedback({ ok: false, text: msg });
    } finally {
      setIsConnectingOAuth(false);
    }
  };

  const handleDisconnectGoogleOAuth = async () => {
    setCalendarFeedback(null);
    try {
      await disconnectGoogleCalendarOAuth();
      await loadCalendarConnections();
      notifyCalendarChanged();
      setCalendarFeedback({ ok: true, text: 'Đã ngắt kết nối tài khoản Google Calendar.' });
    } catch (err) {
      setCalendarFeedback({ ok: false, text: String(err) });
    }
  };

  const handleSaveOAuthConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oauthClientId.trim()) return;
    setIsSavingOAuthConfig(true);
    setCalendarFeedback(null);
    try {
      await saveGoogleOAuthClientConfig(oauthClientId.trim(), oauthClientSecret.trim());
      setOauthClientSecret('');
      setShowOAuthSetup(false);
      await loadCalendarConnections();
      setCalendarFeedback({
        ok: true,
        text: 'Đã lưu cấu hình OAuth Client. Giờ bạn có thể bấm Đăng nhập bằng Google.',
      });
    } catch (err) {
      setCalendarFeedback({ ok: false, text: String(err) });
    } finally {
      setIsSavingOAuthConfig(false);
    }
  };

  const handleAddIcsCalendar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIcsName.trim() || !newIcsUrl.trim()) return;
    setIsAddingIcs(true);
    setCalendarFeedback(null);
    try {
      await addGoogleCalendar(newIcsName.trim(), newIcsUrl.trim(), newIcsColor);
      setNewIcsName('');
      setNewIcsUrl('');
      const res = await syncGoogleCalendars();
      await loadCalendarConnections();
      notifyCalendarChanged();
      setCalendarFeedback({
        ok: res.errors.length === 0,
        text:
          res.errors.length > 0
            ? res.errors.join('; ')
            : `Đã thêm và tải ${res.total_events} sự kiện.`,
      });
    } catch (err) {
      setCalendarFeedback({ ok: false, text: String(err) });
    } finally {
      setIsAddingIcs(false);
    }
  };

  const handleToggleCalendar = async (id: string, current: boolean) => {
    await toggleGoogleCalendar(id, !current);
    await loadCalendarConnections();
    notifyCalendarChanged();
  };

  const handleDeleteCalendar = async (id: string) => {
    await removeGoogleCalendar(id);
    await loadCalendarConnections();
    notifyCalendarChanged();
  };

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

  const handleSaveAiConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingAi) return;
    setIsSavingAi(true);
    setAiSavedSuccess(false);
    setTestAiResult(null);
    try {
      await saveGeminiConfig(
        aiApiKey.trim(),
        aiModel.trim() || 'gemini-2.5-flash',
        aiBaseUrl.trim()
      );
      setAiSavedSuccess(true);
      setTimeout(() => setAiSavedSuccess(false), 2500);
    } catch (err) {
      console.error('Lỗi khi lưu cấu hình AI:', err);
    } finally {
      setIsSavingAi(false);
    }
  };

  const handleTestAiConnection = async () => {
    const key = aiApiKey.trim();
    const url = aiBaseUrl.trim();
    if (!key && !isLocalBaseUrl(url)) return;
    if (isTestingAi) return;
    setIsTestingAi(true);
    setTestAiResult(null);
    try {
      const pingResponse = await testGeminiKey(
        key,
        aiModel.trim() || 'gemini-2.5-flash',
        url
      );
      setTestAiResult({
        success: true,
        message: pingResponse,
      });
    } catch (err) {
      setTestAiResult({
        success: false,
        message:
          typeof err === 'string'
            ? err
            : 'Kiểm tra thất bại. Vui lòng kiểm tra lại API Base URL, Key và Model.',
      });
    } finally {
      setIsTestingAi(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const primaryBtnCls =
    'flex items-center justify-center gap-1.5 rounded-lg bg-uit px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#255CE6] disabled:opacity-50 cursor-pointer';
  const secondaryBtnCls =
    'flex items-center gap-1.5 rounded-lg border border-line bg-surface-hover px-3.5 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-uit/50 hover:text-white disabled:opacity-50 cursor-pointer';
  const inputCls =
    'w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs text-zinc-100 placeholder-zinc-500 outline-none transition-colors focus:border-uit/60';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,7,15,0.7)] p-4"
      onClick={closeSettings}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cài đặt DIARK OS"
        onClick={(e) => e.stopPropagation()}
        className="uit-modal-in flex h-[590px] w-full max-w-3xl overflow-hidden rounded-xl border border-[#1D263B] bg-[#0F1420] text-zinc-100 shadow-2xl"
      >
        {/* Left Column: UIT Dark Tab Navigation */}
        <div className="flex w-56 shrink-0 flex-col justify-between border-r border-[#1D263B] bg-[#0A0F1A] p-4">
          <div>
            <div className="mb-6 flex items-center gap-3 px-2">
              <img
                src="/app-icon.png"
                alt="DIARK // OS Logo"
                className="h-9 w-9 rounded-lg border border-[#1D263B] object-cover"
              />
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-[#6B9BFF]">
                  CÀI ĐẶT
                </p>
                <h2 className="font-mono text-sm font-bold tracking-wider text-zinc-100">
                  DIARK OS
                </h2>
              </div>
            </div>

            <nav className="space-y-1">
              {(
                [
                  { id: 'profile', label: 'Hồ sơ', Icon: User, locked: false },
                  { id: 'plugins', label: 'Tiện ích mở rộng', Icon: Blocks, locked: true },
                  { id: 'services', label: 'Kết nối & Đồng bộ', Icon: RefreshCw, locked: false },
                  { id: 'copilot', label: 'Cấu hình AI (API)', Icon: Key, locked: false },
                  { id: 'system', label: 'Hệ thống', Icon: Database, locked: false },
                ] as const
              ).map(({ id, label, Icon, locked }) => {
                const isActive = activeTab === id && !locked;
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      if (!locked) setActiveTab(id);
                    }}
                    title={locked ? 'Tạm khóa — đang hoàn thiện' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      locked
                        ? 'cursor-not-allowed border-transparent text-zinc-500 opacity-50'
                        : isActive
                        ? 'cursor-pointer border-[#2F6BFF]/35 bg-[#2F6BFF]/[0.14] text-white'
                        : 'cursor-pointer border-transparent text-zinc-400 hover:bg-[#151C2C] hover:text-zinc-200'
                    }`}
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-[#6B9BFF]' : ''}`} />
                    <span className="truncate">{label}</span>
                    {locked && <Lock className="ml-auto h-3 w-3 shrink-0 text-zinc-500" />}
                  </button>
                );
              })}
            </nav>
          </div>

          <div>
            {onLogout && (
              <button
                type="button"
                onClick={() => {
                  if (!confirmLogout) {
                    setConfirmLogout(true);
                    return;
                  }
                  setConfirmLogout(false);
                  onLogout();
                }}
                className={`mb-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
                  confirmLogout
                    ? 'border-red-500/40 bg-red-500/15 text-red-300'
                    : 'border-[#1D263B] bg-[#080B12] text-red-400 hover:border-red-500/35 hover:bg-red-500/10'
                }`}
              >
                <LogOut className="h-3.5 w-3.5 shrink-0" />
                <span>{confirmLogout ? 'Xác nhận đăng xuất' : 'Đăng xuất'}</span>
              </button>
            )}
            <div className="border-t border-[#1D263B]/80 px-2 pt-3 font-mono text-[10px] text-zinc-500">
              DIARK // OS {APP_VERSION}
            </div>
          </div>
        </div>

        {/* Right Column: Tab Content */}
        <div className="flex min-w-0 flex-1 flex-col bg-[#0F1420]">
          {/* Header Bar */}
          <div className="flex items-center justify-between border-b border-[#1D263B] px-6 py-3.5">
            <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-zinc-100">
              {activeTab === 'profile' && 'Cấu hình Định danh & Hồ sơ'}
              {activeTab === 'services' && 'Kết nối & Đồng bộ'}
              {activeTab === 'copilot' && 'Cấu hình AI (API)'}
              {activeTab === 'system' && 'Thông số & Bảo mật Hệ thống'}
            </h3>
            <button
              type="button"
              onClick={closeSettings}
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-[#151C2C] hover:text-white cursor-pointer"
              title="Đóng (Escape)"
              aria-label="Đóng"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Content Body */}
          <div className="flex-1 space-y-5 overflow-y-auto p-6">
            {/* TAB 1: PROFILE */}
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <form onSubmit={handleSaveNickname} className="space-y-2.5">
                  <label htmlFor="settings-nickname-input" className="block font-mono text-xs uppercase tracking-wider text-zinc-300">
                    Signature Handle / Nickname
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="settings-nickname-input"
                      type="text"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      className={`${inputCls} flex-1 text-sm`}
                      placeholder="Nhập tên gọi của bạn..."
                      required
                    />
                    <button
                      type="submit"
                      disabled={isSavingNick || !nickname.trim()}
                      className={primaryBtnCls}
                    >
                      {isSavingNick ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      <span>Lưu</span>
                    </button>
                  </div>
                  {nickSavedSuccess && (
                    <p className="font-mono text-xs text-emerald-400">
                      ✓ Đã cập nhật chữ ký định danh thành công.
                    </p>
                  )}
                </form>

                <form onSubmit={handleSaveCfHandle} className="space-y-2.5">
                  <label htmlFor="settings-cf-handle-input" className="block font-mono text-xs uppercase tracking-wider text-zinc-300">
                    Codeforces Handle
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="settings-cf-handle-input"
                      type="text"
                      value={cfHandle}
                      onChange={(e) => setCfHandleState(e.target.value)}
                      className={`${inputCls} flex-1 text-sm`}
                      placeholder="Nhập handle Codeforces (ví dụ: tourist)..."
                    />
                    <button
                      type="submit"
                      disabled={isSavingCf || !cfHandle.trim()}
                      className={primaryBtnCls}
                    >
                      {isSavingCf ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      <span>Lưu</span>
                    </button>
                  </div>
                  {cfSavedSuccess && (
                    <p className="font-mono text-xs text-emerald-400">
                      ✓ Đã cập nhật Codeforces handle thành công.
                    </p>
                  )}
                </form>

                <div className="space-y-3">
                  <p className="font-mono text-xs uppercase tracking-wider text-zinc-400">
                    Dữ liệu sinh viên UIT (Đồng bộ tự động từ Portal)
                  </p>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-3">
                      <p className="font-mono text-[10px] uppercase text-zinc-500">
                        Mã số sinh viên (MSSV)
                      </p>
                      <p className="mt-0.5 font-mono text-sm font-semibold text-zinc-200">
                        {studentProfile?.student_id || 'Chưa đồng bộ'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-3">
                      <p className="font-mono text-[10px] uppercase text-zinc-500">Họ và tên</p>
                      <p className="mt-0.5 font-mono text-sm font-semibold text-zinc-200">
                        {studentProfile?.full_name || 'Chưa đồng bộ'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-3">
                      <p className="font-mono text-[10px] uppercase text-zinc-500">Lớp sinh hoạt</p>
                      <p className="mt-0.5 font-mono text-sm font-semibold text-zinc-200">
                        {studentProfile?.student_class || 'Chưa đồng bộ'}
                      </p>
                    </div>

                    <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-3">
                      <p className="font-mono text-[10px] uppercase text-zinc-500">
                        Ngành / Chuyên ngành
                      </p>
                      <p className="mt-0.5 truncate font-mono text-sm font-semibold text-zinc-200">
                        {studentProfile?.specialization ||
                          studentProfile?.major_code ||
                          'Chưa đồng bộ'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: KẾT NỐI & ĐỒNG BỘ */}
            {activeTab === 'services' && (
              <div className="space-y-4">
                {/* Compact UIT SSO Account Status Row */}
                <div className="flex items-center justify-between gap-3 rounded-xl border border-[#1D263B] bg-[#080B12] px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2.5 text-xs">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        ssoHasPassword ? 'bg-emerald-400' : 'bg-zinc-600'
                      }`}
                    />
                    <div className="flex flex-wrap items-center gap-1.5 truncate">
                      <span className="font-semibold text-zinc-100">Tài khoản UIT SSO</span>
                      <span className="text-zinc-600">·</span>
                      <span className="font-mono text-zinc-300">
                        MSSV: {ssoUsername || 'Chưa thiết lập'}
                      </span>
                      <span className="text-zinc-600">·</span>
                      <span className={ssoHasPassword ? 'font-medium text-emerald-400' : 'text-zinc-500'}>
                        {ssoHasPassword ? 'Đã lưu' : 'Chưa lưu'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenSsoLogin?.()}
                    className={`${secondaryBtnCls} shrink-0 py-1.5 px-3`}
                  >
                    Đổi tài khoản
                  </button>
                </div>

                {calendarFeedback && (
                  <div
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      calendarFeedback.ok
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-red-500/30 bg-red-500/10 text-red-300'
                    }`}
                  >
                    {calendarFeedback.text}
                  </div>
                )}

                {/* Google Calendar (2 chiều) */}
                <div className="space-y-3 rounded-xl border border-[#1D263B] bg-[#080B12] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-[#6B9BFF]" aria-hidden="true" />
                      <h4 className="text-sm font-semibold text-zinc-100">
                        Google Calendar (2 chiều)
                      </h4>
                    </div>
                    {oauthStatus?.connected && (
                      <button
                        type="button"
                        onClick={() => void handleDisconnectGoogleOAuth()}
                        className="flex items-center gap-1 rounded-md border border-[#1D263B] bg-[#0F1420] px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:border-red-500/30 hover:text-red-300 cursor-pointer"
                      >
                        <LogOut className="h-3 w-3" aria-hidden="true" />
                        <span>Ngắt kết nối</span>
                      </button>
                    )}
                  </div>

                  {!oauthStatus?.connected ? (
                    <div className="space-y-3">
                      <p className="text-xs leading-relaxed text-zinc-400">
                        Đăng nhập bằng tài khoản Google để tự động lấy toàn bộ lịch, tạo sự kiện mới và đồng bộ TKB UIT lên điện thoại.
                      </p>

                      <button
                        type="button"
                        onClick={() => void handleConnectGoogleOAuth()}
                        disabled={isConnectingOAuth}
                        className={`${primaryBtnCls} h-9 w-full`}
                      >
                        <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>
                          {isConnectingOAuth
                            ? 'Đang chờ xác nhận trên trình duyệt...'
                            : 'Đăng nhập bằng Google'}
                        </span>
                      </button>

                      {oauthStatus && !oauthStatus.is_embedded_config && (
                        <div className="border-t border-[#1D263B]/80 pt-2.5">
                          <button
                            type="button"
                            onClick={() => setShowOAuthSetup((v) => !v)}
                            className="flex w-full items-center justify-between text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                          >
                            <span className="flex items-center gap-1.5">
                              <Settings2 className="h-3 w-3" aria-hidden="true" />
                              <span>
                                {oauthStatus.is_configured
                                  ? 'Đổi OAuth Client ID (bản dev)'
                                  : 'Cấu hình OAuth (dành cho bản dev)'}
                              </span>
                            </span>
                            <ChevronDown
                              className={`h-3.5 w-3.5 transition-transform duration-150 ${
                                showOAuthSetup ? 'rotate-180' : ''
                              }`}
                            />
                          </button>

                          {showOAuthSetup && (
                            <form
                              onSubmit={(e) => void handleSaveOAuthConfig(e)}
                              className="mt-2.5 space-y-2"
                            >
                              <p className="text-[11px] text-zinc-500">
                                Dán Desktop OAuth Client ID &amp; Secret từ Google Cloud Console.
                              </p>
                              <input
                                type="text"
                                value={oauthClientId}
                                onChange={(e) => setOauthClientId(e.target.value)}
                                aria-label="Google OAuth Client ID"
                                placeholder="Google OAuth Client ID"
                                className={inputCls}
                              />
                              <input
                                type="password"
                                value={oauthClientSecret}
                                onChange={(e) => setOauthClientSecret(e.target.value)}
                                aria-label="Google OAuth Client Secret"
                                placeholder="Client Secret (tùy chọn)"
                                className={inputCls}
                              />
                              <button
                                type="submit"
                                disabled={isSavingOAuthConfig || !oauthClientId.trim()}
                                className={`${primaryBtnCls} h-8 w-full`}
                              >
                                {isSavingOAuthConfig ? 'Đang lưu...' : 'Lưu cấu hình OAuth'}
                              </button>
                            </form>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-2 rounded-lg border border-[#1D263B] bg-[#0F1420] px-3 py-2">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                        <span className="truncate font-mono text-xs text-zinc-200">
                          {oauthStatus.email || 'Đã đăng nhập Google'}
                        </span>
                      </div>

                      {oauthCalendars.length > 0 && (
                        <div className="divide-y divide-[#1D263B]/70 border-t border-[#1D263B]/80">
                          {oauthCalendars.map((cal) => (
                            <label
                              key={cal.id}
                              className="flex items-center justify-between gap-2 py-2 cursor-pointer"
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={cal.is_enabled}
                                  onChange={() =>
                                    void handleToggleCalendar(cal.id, cal.is_enabled)
                                  }
                                  className="h-3.5 w-3.5 rounded border-[#1D263B] bg-[#080B12] accent-[#2F6BFF]"
                                />
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: cal.color }}
                                />
                                <span className="truncate text-xs font-medium text-zinc-200">
                                  {cal.name}
                                </span>
                              </div>
                              <span className="shrink-0 font-mono text-[10px] text-zinc-500">
                                {cal.can_write ? '2 chiều' : 'Chỉ đọc'}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Collapsible ICS Calendar Feed Manager */}
                <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-4">
                  <button
                    type="button"
                    onClick={() => setShowIcsAdvanced((v) => !v)}
                    aria-expanded={showIcsAdvanced}
                    className="flex w-full items-center justify-between gap-2 text-left cursor-pointer"
                  >
                    <span className="text-xs font-semibold text-zinc-300">
                      Nâng cao: Thêm lịch bằng link .ics ({icsCalendars.length})
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${
                        showIcsAdvanced ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  <div
                    className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                      showIcsAdvanced ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="mt-3 space-y-3 border-t border-[#1D263B]/75 pt-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-zinc-400">
                            Nguồn iCalendar công khai / bí mật
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              void openExternalUrl(
                                'https://calendar.google.com/calendar/r/settings'
                              )
                            }
                            className="flex items-center gap-1 rounded border border-[#1D263B] bg-[#151C2C] px-2 py-1 text-[11px] font-medium text-[#6B9BFF] transition-colors hover:border-[#2F6BFF]/50 cursor-pointer"
                          >
                            <span>Mở Google Calendar</span>
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>

                        <form
                          onSubmit={(e) => void handleAddIcsCalendar(e)}
                          className="space-y-2.5"
                        >
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <input
                              type="text"
                              value={newIcsName}
                              onChange={(e) => setNewIcsName(e.target.value)}
                              aria-label="Tên lịch ICS"
                              placeholder="Tên lịch (vd: Cá nhân, CLB)"
                              className={inputCls}
                            />
                            <input
                              type="url"
                              value={newIcsUrl}
                              onChange={(e) => setNewIcsUrl(e.target.value)}
                              aria-label="Đường dẫn lịch ICS"
                              placeholder="https://calendar.google.com/calendar/ical/..."
                              className={inputCls}
                            />
                          </div>
                          <div className="flex items-center justify-between pt-0.5">
                            <div className="flex items-center gap-1.5">
                              {CALENDAR_PALETTE.map((hex) => (
                                <button
                                  key={hex}
                                  type="button"
                                  onClick={() => setNewIcsColor(hex)}
                                  aria-label={`Chọn màu ${hex}`}
                                  className={`h-4 w-4 rounded-full transition-transform duration-100 cursor-pointer ${
                                    newIcsColor === hex
                                      ? 'ring-2 ring-zinc-200 ring-offset-2 ring-offset-[#080B12]'
                                      : ''
                                  }`}
                                  style={{ backgroundColor: hex }}
                                />
                              ))}
                            </div>
                            <button
                              type="submit"
                              disabled={isAddingIcs || !newIcsName.trim() || !newIcsUrl.trim()}
                              className={`${primaryBtnCls} h-7 px-3`}
                            >
                              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>{isAddingIcs ? 'Đang thêm...' : 'Thêm lịch'}</span>
                            </button>
                          </div>
                        </form>

                        <div className="divide-y divide-[#1D263B]/70 border-t border-[#1D263B]/80">
                          {icsCalendars.length === 0 ? (
                            <div className="py-3 text-center text-xs text-zinc-500">
                              Chưa gắn lịch .ics nào.
                            </div>
                          ) : (
                            icsCalendars.map((cal) => (
                              <div
                                key={cal.id}
                                className="flex items-center justify-between gap-2 py-2"
                              >
                                <label className="flex min-w-0 flex-1 items-center gap-2.5 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={cal.is_enabled}
                                    onChange={() =>
                                      void handleToggleCalendar(cal.id, cal.is_enabled)
                                    }
                                    className="h-3.5 w-3.5 rounded border-[#1D263B] bg-[#080B12] accent-[#2F6BFF]"
                                  />
                                  <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: cal.color }}
                                  />
                                  <div className="min-w-0">
                                    <div className="truncate text-xs font-medium text-zinc-200">
                                      {cal.name}
                                    </div>
                                    <div className="font-mono text-[10px] text-zinc-500">
                                      {cal.last_synced_at > 0
                                        ? `Cập nhật ${formatTimeHm(cal.last_synced_at)}`
                                        : 'Chưa đồng bộ'}
                                    </div>
                                  </div>
                                </label>
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteCalendar(cal.id)}
                                  className="rounded p-1 text-zinc-500 transition-colors hover:bg-[#151C2C] hover:text-red-400 cursor-pointer"
                                  aria-label={`Xóa lịch ${cal.name}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Unified Auto-Sync Summary */}
                <div className="flex items-center justify-between gap-3 rounded-xl border border-[#1D263B]/80 bg-[#080B12]/70 px-4 py-3 text-xs text-zinc-400">
                  <span>
                    Portal, Moodle, Wecode và Lịch tự động đồng bộ nền định kỳ. Bạn có thể bấm icon{' '}
                    <span className="font-mono text-[#6B9BFF]">↻</span> ở góc dưới thanh bên để đồng bộ ngay toàn bộ dữ liệu.
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-emerald-400">Tự động</span>
                </div>
              </div>
            )}

            {/* TAB 3: CẤU HÌNH AI (API) */}
            {activeTab === 'copilot' && (
              <div className="space-y-5">
                <div>
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                    <Key className="h-4 w-4 text-[#6B9BFF]" />
                    <span>Kết nối AI API (BYOK)</span>
                  </h3>
                  <p className="mt-1 text-xs text-zinc-400">
                    Hỗ trợ Google Gemini mặc định hoặc bất kỳ nhà cung cấp nào chuẩn OpenAI (OpenAI, OpenRouter, DeepSeek, Groq, Ollama Local, endpoint riêng...).
                  </p>
                </div>

                {/* Provider Presets */}
                <div className="space-y-1.5">
                  <span className="block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    Điền nhanh theo nhà cung cấp
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {AI_PROVIDER_PRESETS.map((preset) => {
                      const isActivePreset =
                        aiBaseUrl.trim() === preset.baseUrl &&
                        (preset.baseUrl !== '' || aiBaseUrl.trim() === '');
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setAiBaseUrl(preset.baseUrl);
                            setAiModel(preset.model);
                            setTestAiResult(null);
                          }}
                          className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                            isActivePreset
                              ? 'border-[#2F6BFF]/50 bg-[#2F6BFF]/[0.16] text-[#6B9BFF]'
                              : 'border-[#1D263B] bg-[#080B12] text-zinc-300 hover:border-[#2F6BFF]/35 hover:bg-[#151C2C]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <form onSubmit={handleSaveAiConfig} className="space-y-3.5">
                  <div className="space-y-1.5">
                    <label htmlFor="settings-ai-base-url" className="block font-mono text-xs uppercase tracking-wider text-zinc-400">
                      API Base URL (Endpoint)
                    </label>
                    <input
                      id="settings-ai-base-url"
                      type="text"
                      value={aiBaseUrl}
                      onChange={(e) => setAiBaseUrl(e.target.value)}
                      placeholder="Để trống để dùng Google Gemini mặc định, hoặc dán https://api.openai.com/v1"
                      className={`${inputCls} py-2`}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label htmlFor="settings-ai-api-key" className="font-mono text-xs uppercase tracking-wider text-zinc-400">
                        API Key {isLocalBaseUrl(aiBaseUrl) ? '(tùy chọn với Local)' : ''}
                      </label>
                      {aiBaseUrl.trim() === '' && (
                        <button
                          type="button"
                          onClick={() => openExternalUrl('https://aistudio.google.com/app/apikey')}
                          className="flex items-center gap-1 text-[11px] text-uit-accent transition-colors hover:text-[#8BB2FF] cursor-pointer"
                        >
                          <span>Lấy key miễn phí tại AI Studio</span>
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    <div className="relative">
                      <input
                        id="settings-ai-api-key"
                        type={showApiKey ? 'text' : 'password'}
                        value={aiApiKey}
                        onChange={(e) => setAiApiKey(e.target.value)}
                        placeholder={
                          isLocalBaseUrl(aiBaseUrl)
                            ? 'Có thể để trống với Ollama/Local...'
                            : 'sk-... hoặc AIzaSy...'
                        }
                        className={`${inputCls} py-2 pr-10`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((v) => !v)}
                        aria-label={showApiKey ? 'Ẩn API key' : 'Hiện API key'}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                      >
                        {showApiKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="settings-ai-model-id" className="block font-mono text-xs uppercase tracking-wider text-zinc-400">
                      Model ID
                    </label>
                    <input
                      id="settings-ai-model-id"
                      type="text"
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      placeholder="Ví dụ: gemini-2.5-flash, gpt-4o-mini, deepseek-chat, llama3.2..."
                      className={`${inputCls} py-2`}
                    />
                  </div>

                  <div className="flex items-center gap-3 pt-1">
                    <button
                      type="submit"
                      disabled={isSavingAi || !aiModel.trim()}
                      className={primaryBtnCls}
                    >
                      {isSavingAi ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : aiSavedSuccess ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : null}
                      <span>{aiSavedSuccess ? 'Đã lưu cấu hình' : 'Lưu cấu hình'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleTestAiConnection()}
                      disabled={isTestingAi || (!aiApiKey.trim() && !isLocalBaseUrl(aiBaseUrl))}
                      className={secondaryBtnCls}
                    >
                      {isTestingAi ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#6B9BFF]" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#6B9BFF]" />
                      )}
                      <span>Kiểm tra kết nối</span>
                    </button>
                  </div>
                </form>

                {testAiResult && (
                  <div
                    className={`flex items-start gap-2.5 rounded-lg border p-3.5 font-mono text-xs ${
                      testAiResult.success
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                    }`}
                  >
                    {testAiResult.success ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    )}
                    <div>
                      <p className="font-semibold">
                        {testAiResult.success ? 'Kết nối thành công!' : 'Lỗi kết nối:'}
                      </p>
                      <p className="mt-0.5 text-[11px] opacity-90">{testAiResult.message}</p>
                    </div>
                  </div>
                )}

                <div className="space-y-1 rounded-xl border border-[#1D263B] bg-[#080B12] p-3.5 text-[11px] text-zinc-400">
                  <p className="flex items-center gap-1.5 font-semibold text-zinc-200">
                    <Shield className="h-3.5 w-3.5 text-[#6B9BFF]" />
                    <span>Quyền riêng tư (Lưu cục bộ):</span>
                  </p>
                  <p>• Khóa API và Endpoint chỉ lưu trong SQLite trên máy, không qua máy chủ trung gian.</p>
                </div>
              </div>
            )}

            {/* TAB 4: SYSTEM */}
            {activeTab === 'system' && (
              <div className="space-y-5">
                {!hotkeyActive && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 text-xs text-amber-300">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                    <div>
                      <p className="font-semibold text-amber-200">
                        Cảnh báo: Phím tắt chưa thể kích hoạt
                      </p>
                      <p className="mt-1 leading-relaxed text-zinc-300">
                        Phím tắt toàn cục ({globalShortcut}) đang bị ứng dụng khác chiếm dụng (ví dụ: Unikey, EVKey hoặc phần mềm khác). Bạn vẫn có thể mở Diark bằng cách nhấp đúp biểu tượng dưới khay hệ thống (System Tray).
                      </p>
                    </div>
                  </div>
                )}

                {systemPrefError && (
                  <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                    <span>{systemPrefError}</span>
                  </div>
                )}

                {/* 1. Global Shortcut & HUD */}
                <div className="space-y-4 rounded-xl border border-[#1D263B] bg-[#080B12] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-xs font-semibold text-zinc-100">
                        <Keyboard className="h-4 w-4 text-[#6B9BFF]" />
                        <span>PHÍM TẮT TOÀN CỤC (QUICK HUD)</span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400">
                        Bật/tắt nhanh giao diện Diark OS từ bất kỳ đâu trên máy tính.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleResetDefaultShortcut}
                      disabled={isResettingShortcut}
                      className={`${secondaryBtnCls} py-1.5 px-3`}
                      title="Đặt lại về Alt+K"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>{isResettingShortcut ? 'Đang khôi phục...' : 'Khôi phục mặc định'}</span>
                    </button>
                  </div>

                  <div className="border-t border-[#1D263B]/80 pt-3">
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

                {/* 1.5 Vault Notes Shortcuts */}
                <div className="space-y-3 rounded-xl border border-[#1D263B] bg-[#080B12] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-xs font-semibold text-zinc-100">
                        <Keyboard className="h-4 w-4 text-[#6B9BFF]" />
                        <span>PHÍM TẮT GHI CHÚ</span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400">
                        Nhấp vào ô phím tắt rồi bấm tổ hợp mới để đổi, nhấn Esc để hủy ghi.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        resetVaultShortcuts();
                        setRecordingVaultAction(null);
                        setVaultShortcutHint('Đã khôi phục toàn bộ phím tắt ghi chú mặc định.');
                      }}
                      className={`${secondaryBtnCls} py-1.5 px-3`}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Khôi phục mặc định</span>
                    </button>
                  </div>

                  {vaultShortcutHint && (
                    <div className="rounded-lg border border-[#2F6BFF]/40 bg-[#2F6BFF]/10 px-3 py-1.5 text-[11px] text-[#6B9BFF]">
                      {vaultShortcutHint}
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-2 border-t border-[#1D263B]/80 pt-3 sm:grid-cols-2">
                    {VAULT_SHORTCUT_META.map((item) => {
                      const isRec = recordingVaultAction === item.action;
                      return (
                        <div
                          key={item.action}
                          className="flex items-center justify-between gap-2 rounded-lg border border-[#1D263B] bg-[#0F1420] px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-zinc-200">
                              {item.label}
                            </div>
                            <div className="truncate text-[10px] text-zinc-500">
                              {item.description}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setRecordingVaultAction(isRec ? null : item.action);
                              setVaultShortcutHint(null);
                            }}
                            className={`shrink-0 rounded-md border px-2 py-1 font-mono text-[11px] font-semibold transition-colors cursor-pointer ${
                              isRec
                                ? 'border-[#2F6BFF] bg-[#2F6BFF]/25 text-[#6B9BFF]'
                                : 'border-[#2B3957] bg-[#080B12] text-zinc-200 hover:border-[#2F6BFF]/60 hover:text-[#6B9BFF]'
                            }`}
                          >
                            {isRec ? 'Nhấn tổ hợp...' : vaultShortcuts[item.action]}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2. Autostart & Window Persistence */}
                <div className="space-y-4 rounded-xl border border-[#1D263B] bg-[#080B12] p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-xs font-semibold text-zinc-100">
                        <Power className="h-4 w-4 text-[#6B9BFF]" />
                        <span>KHỞI ĐỘNG CÙNG HỆ THỐNG</span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400">
                        Tự động khởi chạy ứng dụng khi đăng nhập Windows (Registry Run key).
                      </p>
                    </div>
                    <UitToggle
                      checked={autostartEnabled}
                      loading={isUpdatingAutostart}
                      onChange={() => void handleToggleAutostart()}
                      ariaLabel="Khởi động cùng hệ thống"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-4 border-t border-[#1D263B]/80 pt-3">
                    <div>
                      <p className="text-xs font-semibold text-zinc-200">
                        Khởi động thu nhỏ vào khay (Start Minimized)
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        Khi bật tự động lúc khởi động máy, app sẽ ẩn dưới khay hệ thống thay vì bung toàn màn hình.
                      </p>
                    </div>
                    <UitToggle
                      checked={startMinimized}
                      disabled={!autostartEnabled}
                      loading={isUpdatingStartMinimized}
                      onChange={() => void handleToggleStartMinimized()}
                      ariaLabel="Khởi động thu nhỏ vào khay"
                    />
                  </div>
                </div>

                {/* Demo Privacy Shield */}
                <div className="flex items-center justify-between gap-4 rounded-xl border border-amber-500/30 bg-amber-950/10 p-4">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-amber-400">
                      <Shield className="h-4 w-4" />
                      <span>Demo Privacy Shield</span>
                    </div>
                    <p className="mt-1 text-xs text-zinc-400">
                      Ẩn MSSV và tên định danh khi chụp ảnh màn hình hoặc demo thuyết trình.
                    </p>
                  </div>
                  <UitToggle
                    checked={isDemoMode}
                    onChange={toggleDemoMode}
                    ariaLabel="Demo Privacy Shield"
                  />
                </div>

                {/* Storage & DB Stats */}
                <div className="space-y-3">
                  <p className="font-mono text-xs uppercase tracking-wider text-zinc-400">
                    Thống kê dữ liệu lưu trên máy
                  </p>

                  {loadingStats ? (
                    <div className="flex items-center justify-center p-6 text-zinc-400">
                      <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-3.5 text-center">
                        <p className="font-mono text-[10px] uppercase text-zinc-500">
                          Dung lượng dữ liệu
                        </p>
                        <p className="mt-1 font-mono text-base font-bold text-zinc-100">
                          {formatBytes(storageStats?.db_size_bytes || 0)}
                        </p>
                      </div>

                      <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-3.5 text-center">
                        <p className="font-mono text-[10px] uppercase text-zinc-500">Bộ đệm tạm</p>
                        <p className="mt-1 font-mono text-base font-bold text-zinc-300">
                          {formatBytes(storageStats?.wal_size_bytes || 0)}
                        </p>
                      </div>

                      <div className="rounded-xl border border-[#1D263B] bg-[#080B12] p-3.5 text-center">
                        <p className="font-mono text-[10px] uppercase text-zinc-500">
                          Tổng số bản ghi
                        </p>
                        <p className="mt-1 font-mono text-base font-bold text-[#6B9BFF]">
                          {storageStats?.total_records_count?.toLocaleString() || 0}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Auto-Updater Section (Codex / Antigravity style) */}
                <div className="space-y-3 rounded-xl border border-[#1D263B] bg-[#080B12] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 font-mono text-xs font-semibold text-zinc-100">
                        <ArrowUpCircle className="h-4 w-4 text-[#6B9BFF]" />
                        <span>CẬP NHẬT ỨNG DỤNG</span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400">
                        Phiên bản hiện tại:{' '}
                        <span className="font-mono text-emerald-400">{APP_VERSION}</span>
                        {lastCheckedAt ? (
                          <span className="ml-2 text-zinc-500">
                            · Kiểm tra lúc {formatLastCheckedTime(lastCheckedAt)}
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {updateStatus === 'available' && updateInfo && onInstallUpdate && (
                        <button
                          type="button"
                          onClick={onInstallUpdate}
                          className={`${primaryBtnCls} py-1.5 px-3`}
                        >
                          Cập nhật v{updateInfo.version}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isCheckingUpdate}
                        onClick={() => {
                          if (onCheckUpdates) {
                            onCheckUpdates();
                          } else {
                            window.dispatchEvent(new CustomEvent('check-app-updates'));
                          }
                        }}
                        className={`${secondaryBtnCls} py-1.5 px-3`}
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${isCheckingUpdate ? 'animate-spin text-[#6B9BFF]' : ''}`}
                        />
                        <span>{isCheckingUpdate ? 'Đang kiểm tra...' : 'Kiểm tra bản mới'}</span>
                      </button>
                    </div>
                  </div>

                  {updateStatus !== 'idle' && (
                    <div className="border-t border-[#1D263B]/70 pt-2.5 text-xs">
                      {updateStatus === 'checking' && (
                        <span className="text-zinc-400">Đang kết nối máy chủ phát hành để kiểm tra phiên bản mới...</span>
                      )}
                      {updateStatus === 'up-to-date' && (
                        <span className="flex items-center gap-1.5 text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Diark OS đang ở phiên bản mới nhất ({APP_VERSION}).</span>
                        </span>
                      )}
                      {updateStatus === 'available' && updateInfo && (
                        <span className="text-[#6B9BFF]">
                          Đã có bản cập nhật mới <span className="font-mono font-semibold">v{updateInfo.version}</span>. Bấm &ldquo;Cập nhật&rdquo; để tải và cài đặt tự động.
                        </span>
                      )}
                      {updateStatus === 'downloading' && (
                        <span className="text-[#6B9BFF]">Đang tải bản cập nhật...</span>
                      )}
                      {updateStatus === 'error' && updateError && (
                        <span className="text-rose-400">Không thể kiểm tra: {updateError}</span>
                      )}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-4 border-t border-[#1D263B]/80 pt-3">
                    <div>
                      <p className="text-xs font-semibold text-zinc-200">
                        Tự động kiểm tra bản cập nhật
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        Kiểm tra ngầm khi khởi động và định kỳ mỗi 4 giờ, thông báo ngay khi có bản phát hành mới.
                      </p>
                    </div>
                    <UitToggle
                      checked={autoCheckUpdates}
                      onChange={() => onToggleAutoCheckUpdates?.(!autoCheckUpdates)}
                      ariaLabel="Tự động kiểm tra bản cập nhật"
                    />
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
