import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface GenesisModalProps {
  onComplete: () => void;
}

export const GenesisModal: React.FC<GenesisModalProps> = ({ onComplete }) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [nickname, setNickname] = useState('Diark');
  const [selectedGoals, setSelectedGoals] = useState<{
    cp: boolean;
    ai: boolean;
    sec: boolean;
  }>({
    cp: true,
    ai: false,
    sec: false,
  });

  const handleNextStep = (e: React.FormEvent) => {
    e.preventDefault();
    if (nickname.trim()) setStep(2);
  };

  const handleActivate = async () => {
    try {
      const trimmed = nickname.trim();
      await invoke('save_user_profile', { nickname: trimmed, major: 'CS' });
      try {
        await invoke('save_setting', { key: 'user_nickname', value: trimmed });
      } catch (_) {}

      // Core UIT (Wecode) luôn bật mặc định
      await invoke('toggle_plugin', { pluginId: 'uit-wecode', enabled: true });
      await invoke('toggle_plugin', { pluginId: 'cp-codeforces', enabled: selectedGoals.cp });
      await invoke('toggle_plugin', { pluginId: 'ai-lab', enabled: selectedGoals.ai });
      await invoke('toggle_plugin', { pluginId: 'sec-ctf', enabled: selectedGoals.sec });

      onComplete();
    } catch (err) {
      console.error('Kích hoạt hệ điều hành thất bại:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur-md p-4">
      <div className="w-full max-w-lg rounded-2xl border border-cyan-500/30 bg-slate-900/95 p-8 shadow-2xl shadow-cyan-500/10">
        {step === 1 ? (
          <form onSubmit={handleNextStep} className="space-y-6">
            <div>
              <p className="font-mono text-xs uppercase tracking-widest text-cyan-400">System Genesis Sequence</p>
              <h2 className="mt-1 font-mono text-2xl font-bold tracking-wider text-slate-100">INITIALIZE // OS</h2>
              <p className="mt-2 text-sm text-slate-400">Thiết lập chữ ký định danh cá nhân để định cấu hình không gian làm việc cục bộ.</p>
            </div>

            <div className="space-y-2">
              <label className="block font-mono text-xs uppercase tracking-wider text-slate-300">
                Signature Handle / Nickname
              </label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-3 font-mono text-slate-100 outline-none transition focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                placeholder="Nhập tên gọi của bạn..."
                required
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 py-3 font-mono text-sm font-bold uppercase tracking-wider text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110 active:scale-[0.99]"
            >
              Tiếp Tục →
            </button>
          </form>
        ) : (
          <div className="space-y-6">
            <div>
              <p className="font-mono text-xs uppercase tracking-widest text-cyan-400">Personal Workspace Configuration</p>
              <h2 className="mt-1 font-mono text-2xl font-bold tracking-wider text-slate-100">CHỌN MỤC TIÊU &amp; PHÂN HỆ</h2>
              <p className="mt-2 text-sm text-slate-400">Chọn các mục tiêu ưu tiên để hệ thống kích hoạt không gian làm việc tương ứng.</p>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-cyan-500/40 bg-cyan-950/20 p-4">
                <div>
                  <p className="font-medium text-slate-200">Học vụ UIT &amp; Wecode</p>
                  <p className="text-xs text-slate-400">Bảng điểm, DRL, tiến độ CTĐT &amp; bài tập thực hành</p>
                </div>
                <span className="rounded bg-cyan-500/20 px-2.5 py-1 font-mono text-xs font-semibold text-cyan-400">Cốt lõi</span>
              </div>

              <label className={`flex cursor-pointer items-center justify-between rounded-xl border p-4 transition ${selectedGoals.cp ? 'border-blue-500/50 bg-blue-950/20' : 'border-slate-800 bg-slate-800/40 hover:border-slate-700'}`}>
                <div>
                  <p className="font-medium text-slate-200">Luyện Thuật toán / ICPC</p>
                  <p className="text-xs text-slate-400">Codeforces Engine, LeetCode Radar &amp; Life Matrix XP</p>
                </div>
                <input
                  type="checkbox"
                  checked={selectedGoals.cp}
                  onChange={(e) => setSelectedGoals({ ...selectedGoals, cp: e.target.checked })}
                  className="h-5 w-5 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                />
              </label>

              <label className={`flex cursor-pointer items-center justify-between rounded-xl border p-4 transition ${selectedGoals.ai ? 'border-purple-500/50 bg-purple-950/20' : 'border-slate-800 bg-slate-800/40 hover:border-slate-700'}`}>
                <div>
                  <p className="font-medium text-slate-200">Trí tuệ Nhân tạo (AI &amp; Data)</p>
                  <p className="text-xs text-slate-400">Kaggle Notebooks Tracker &amp; Research Lab</p>
                </div>
                <input
                  type="checkbox"
                  checked={selectedGoals.ai}
                  onChange={(e) => setSelectedGoals({ ...selectedGoals, ai: e.target.checked })}
                  className="h-5 w-5 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                />
              </label>

              <label className={`flex cursor-pointer items-center justify-between rounded-xl border p-4 transition ${selectedGoals.sec ? 'border-emerald-500/50 bg-emerald-950/20' : 'border-slate-800 bg-slate-800/40 hover:border-slate-700'}`}>
                <div>
                  <p className="font-medium text-slate-200">An toàn Thông tin (InfoSec)</p>
                  <p className="text-xs text-slate-400">CTF Challenge Logger &amp; Writeups Vault</p>
                </div>
                <input
                  type="checkbox"
                  checked={selectedGoals.sec}
                  onChange={(e) => setSelectedGoals({ ...selectedGoals, sec: e.target.checked })}
                  className="h-5 w-5 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                />
              </label>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="w-1/3 rounded-lg border border-slate-700 bg-slate-800 py-3 font-mono text-sm font-semibold text-slate-300 transition hover:bg-slate-700"
              >
                ← Quay lại
              </button>
              <button
                type="button"
                onClick={handleActivate}
                className="w-2/3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 py-3 font-mono text-sm font-bold uppercase tracking-wider text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110 active:scale-[0.99]"
              >
                Kích Hoạt Hệ Điều Hành →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default GenesisModal;
