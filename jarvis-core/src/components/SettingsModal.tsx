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
  StudentProfilePayload,
  SystemStorageStats,
} from '../lib/tauri-client';
import { listInstalledPlugins, togglePlugin } from '../lib/plugin-sdk';
import { PluginMetaDto } from '../types/plugin';
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
} from 'lucide-react';

interface SettingsModalProps {
  onResetGenesis?: () => void;
}

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

  // Tab: System stats state
  const [storageStats, setStorageStats] = useState<SystemStorageStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

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
  }, [isOpen]);

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

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4">
      <div className="flex h-[560px] w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/95 shadow-2xl shadow-cyan-950/20 text-slate-100">
        {/* Left Column: Tab Navigation */}
        <div className="w-56 border-r border-slate-800 bg-slate-950/50 p-4 flex flex-col justify-between">
          <div>
            <div className="mb-6 px-2">
              <p className="font-mono text-[10px] uppercase tracking-widest text-cyan-400">Settings Hub</p>
              <h2 className="font-mono text-lg font-bold tracking-wider text-slate-100">// CONFIG</h2>
            </div>

            <nav className="space-y-1">
              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-mono text-xs font-semibold transition cursor-pointer ${
                  activeTab === 'profile'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <User className="w-4 h-4" />
                <span>Hồ sơ</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('plugins')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-mono text-xs font-semibold transition cursor-pointer ${
                  activeTab === 'plugins'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <Blocks className="w-4 h-4" />
                <span>Phân hệ / Plugins</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('services')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-mono text-xs font-semibold transition cursor-pointer ${
                  activeTab === 'services'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <RefreshCw className="w-4 h-4" />
                <span>Dịch vụ Học vụ</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('system')}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg font-mono text-xs font-semibold transition cursor-pointer ${
                  activeTab === 'system'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <Database className="w-4 h-4" />
                <span>Hệ thống</span>
              </button>
            </nav>
          </div>

          <div className="px-2 pt-4 border-t border-slate-800/80 font-mono text-[10px] text-slate-500">
            DIARK // OS v1.0.0
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
                  <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <ExternalLink className="w-4 h-4 text-purple-400" />
                        <h4 className="font-semibold text-slate-200 text-sm">Học tập Trực tuyến (Moodle / Courses)</h4>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        Thu nạp hạn nộp bài tập qua cơ chế parser HTML Workspace &amp; Native Vault.
                      </p>
                    </div>
                    <span className="font-mono text-xs text-slate-500">HTML Ingestion</span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 4: SYSTEM */}
            {activeTab === 'system' && (
              <div className="space-y-6">
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
                  <p className="font-mono text-xs uppercase tracking-wider text-slate-400">
                    Thống kê Lưu trữ Cục bộ (SQLite SSOT)
                  </p>

                  {loadingStats ? (
                    <div className="flex items-center justify-center p-6 text-slate-400">
                      <Loader2 className="w-5 h-5 animate-spin" />
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3.5 text-center">
                        <p className="font-mono text-[10px] text-slate-500 uppercase">Kích thước DB</p>
                        <p className="font-mono text-base font-bold text-cyan-400 mt-1">
                          {formatBytes(storageStats?.db_size_bytes || 0)}
                        </p>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3.5 text-center">
                        <p className="font-mono text-[10px] text-slate-500 uppercase">WAL Log Buffer</p>
                        <p className="font-mono text-base font-bold text-blue-400 mt-1">
                          {formatBytes(storageStats?.wal_size_bytes || 0)}
                        </p>
                      </div>

                      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3.5 text-center">
                        <p className="font-mono text-[10px] text-slate-500 uppercase">Tổng số bản ghi</p>
                        <p className="font-mono text-base font-bold text-purple-400 mt-1">
                          {storageStats?.total_records_count?.toLocaleString() || 0}
                        </p>
                      </div>
                    </div>
                  )}
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
