import React, { useState } from "react";
import { Terminal, Shield, ArrowRight, AlertCircle, Sparkles } from "lucide-react";
import { DEFAULT_NICKNAME, DEFAULT_MAJOR, APP_SUBTITLE } from "../../../constants/app";

interface GenesisModalProps {
  onComplete: (nickname: string, major: string) => void;
}

export const GenesisModal: React.FC<GenesisModalProps> = ({ onComplete }) => {
  const [nickname, setNickname] = useState<string>(DEFAULT_NICKNAME);
  const [major, setMajor] = useState<string>(DEFAULT_MAJOR);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedNick = nickname.trim();
    const trimmedMajor = major.trim();

    if (!trimmedNick) {
      setError("Signature Handle / Nickname không được để trống.");
      return;
    }

    if (!trimmedMajor) {
      setError("Major / Chuyên ngành không được để trống.");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      onComplete(trimmedNick, trimmedMajor);
    } catch (err) {
      setError(typeof err === "string" ? err : "Đã xảy ra lỗi khi khởi tạo hệ thống.");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300">
      <div className="w-full max-w-lg rounded-2xl border border-cyan-500/30 bg-slate-950/95 p-8 shadow-[0_0_50px_rgba(6,182,212,0.15)] text-slate-100 relative overflow-hidden">
        {/* Cyberpunk accent bar top */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-500 via-violet-500 to-emerald-400" />

        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-cyan-400 text-xs font-mono tracking-widest uppercase">
              <Terminal className="w-4 h-4 text-cyan-400 animate-pulse" />
              <span>SYSTEM GENESIS SEQUENCE</span>
            </div>
            <h2 className="text-2xl font-black tracking-tight text-white flex items-center gap-2">
              INITIALIZE <span className="text-cyan-400">// OS</span>
            </h2>
            <p className="text-xs text-slate-400 font-mono">{APP_SUBTITLE}</p>
          </div>
          <div className="p-2.5 rounded-xl bg-cyan-950/50 border border-cyan-500/20 text-cyan-400">
            <Shield className="w-6 h-6" />
          </div>
        </div>

        {/* Description */}
        <div className="mb-6 rounded-lg border border-slate-800/80 bg-slate-900/60 p-3.5 text-xs text-slate-300 leading-relaxed space-y-1 font-mono">
          <div className="flex items-center gap-1.5 text-cyan-300 font-semibold">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Zero-Cloud, Pure Local Identity</span>
          </div>
          <p className="text-slate-400">
            Hệ điều hành vận hành hoàn toàn cục bộ trên SQLite WAL. Hãy thiết lập chữ ký định danh cá nhân để định cấu hình không gian làm việc.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="genesis-nickname"
              className="block text-xs font-mono font-medium text-slate-300 mb-1.5 uppercase tracking-wider"
            >
              Signature Handle / Nickname
            </label>
            <input
              id="genesis-nickname"
              type="text"
              autoFocus
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. Diark"
              disabled={isSubmitting}
              className="w-full rounded-lg bg-slate-900 border border-slate-800 px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-colors"
            />
          </div>

          <div>
            <label
              htmlFor="genesis-major"
              className="block text-xs font-mono font-medium text-slate-300 mb-1.5 uppercase tracking-wider"
            >
              Major / Chuyên ngành
            </label>
            <input
              id="genesis-major"
              type="text"
              value={major}
              onChange={(e) => {
                setMajor(e.target.value);
                if (error) setError(null);
              }}
              placeholder="e.g. CS (Computer Science)"
              disabled={isSubmitting}
              className="w-full rounded-lg bg-slate-900 border border-slate-800 px-4 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-colors"
            />
          </div>

          {/* Error display */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-950/60 border border-red-500/40 text-red-300 text-xs font-mono animate-in fade-in duration-200">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          {/* Action button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full mt-2 flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 px-5 py-3 text-sm font-bold text-white shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <span>KÍCH HOẠT HỆ ĐIỀU HÀNH</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        {/* Footer info */}
        <div className="mt-6 pt-4 border-t border-slate-900 flex items-center justify-between text-[11px] font-mono text-slate-500">
          <span>STATUS: READY FOR BOOT</span>
          <span>SEC: LOCAL_SANDBOX</span>
        </div>
      </div>
    </div>
  );
};
