import React, { useState } from "react";
import {
  Terminal,
  Shield,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  Sparkles,
  Check,
  Laptop,
  Trophy,
  Bot,
  ShieldCheck,
} from "lucide-react";
import { DEFAULT_NICKNAME, APP_SUBTITLE } from "../../../constants/app";
import { togglePlugin } from "../../../lib/plugin-sdk";

interface GenesisModalProps {
  onComplete: (nickname: string, major: string) => void;
}

interface WorkspaceGoal {
  id: string;
  title: string;
  description: string;
  badge: string;
  icon: React.ComponentType<{ className?: string }>;
  pluginIds: string[];
}

const WORKSPACE_GOALS: WorkspaceGoal[] = [
  {
    id: "uit_standard",
    title: "Học tập Cơ sở (UIT Standard)",
    description: "Kích hoạt Wecode UIT Tracker + Moodle Radar.",
    badge: "Core Academic",
    icon: Laptop,
    pluginIds: ["uit-wecode"],
  },
  {
    id: "competitive_programming",
    title: "Luyện Thuật toán / ICPC (Competitive Programming)",
    description: "Bật thêm Codeforces Engine + LeetCode Tracker.",
    badge: "Algorithms",
    icon: Trophy,
    pluginIds: ["cp-codeforces", "cp-leetcode"],
  },
  {
    id: "ai_data",
    title: "Nghiên cứu Trí tuệ Nhân tạo (AI & Data)",
    description: "Bật thêm AI Lab (Kaggle Hub).",
    badge: "Data Science",
    icon: Bot,
    pluginIds: ["ai-lab"],
  },
  {
    id: "cyber_security",
    title: "An toàn Thông tin (Cyber Security)",
    description: "Bật thêm CTF Logger.",
    badge: "Security",
    icon: ShieldCheck,
    pluginIds: ["sec-ctf"],
  },
];

export const GenesisModal: React.FC<GenesisModalProps> = ({ onComplete }) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [nickname, setNickname] = useState<string>(DEFAULT_NICKNAME);
  const [selectedGoals, setSelectedGoals] = useState<string[]>([
    "uit_standard",
    "competitive_programming",
  ]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const toggleGoal = (id: string) => {
    setSelectedGoals((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]
    );
  };

  const handleNextStep = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedNick = nickname.trim();

    if (!trimmedNick) {
      setError("Signature Handle / Nickname không được để trống.");
      return;
    }

    setError(null);
    setStep(2);
  };

  const handleFinalSubmit = async () => {
    const trimmedNick = nickname.trim();
    if (!trimmedNick) {
      setStep(1);
      setError("Signature Handle / Nickname không được để trống.");
      return;
    }

    if (selectedGoals.length === 0) {
      setError("Vui lòng chọn ít nhất 1 mục tiêu không gian làm việc.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      // Gather selected plugin IDs
      const targetPlugins = new Set<string>();
      for (const goalId of selectedGoals) {
        const goal = WORKSPACE_GOALS.find((g) => g.id === goalId);
        if (goal) {
          for (const pid of goal.pluginIds) {
            targetPlugins.add(pid);
          }
        }
      }

      // Configure plugins according to goals
      const allKnownPlugins = [
        "uit-wecode",
        "cp-codeforces",
        "cp-leetcode",
        "ai-lab",
        "sec-ctf",
      ];

      await Promise.all(
        allKnownPlugins.map((pid) => togglePlugin(pid, targetPlugins.has(pid)))
      );

      onComplete(trimmedNick, "CS");
    } catch (err) {
      console.error("Lỗi hoàn tất Genesis onboarding:", err);
      setError(
        typeof err === "string" ? err : "Đã xảy ra lỗi khi khởi tạo hệ thống."
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300">
      <div className="w-full max-w-xl rounded-2xl border border-cyan-500/30 bg-slate-950/95 p-8 shadow-[0_0_50px_rgba(6,182,212,0.15)] text-slate-100 relative overflow-hidden">
        {/* Cyberpunk accent bar top */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-cyan-500 via-violet-500 to-emerald-400" />

        {/* Step Indicator */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-cyan-400 text-xs font-mono tracking-widest uppercase">
            <Terminal className="w-4 h-4 text-cyan-400 animate-pulse" />
            <span>
              SYSTEM GENESIS // STEP {step} OF 2
            </span>
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
            <span
              className={`px-2 py-0.5 rounded ${
                step === 1
                  ? "bg-cyan-950 text-cyan-300 border border-cyan-700/60 font-bold"
                  : "bg-slate-900 text-slate-400"
              }`}
            >
              01: HANDLE
            </span>
            <span>→</span>
            <span
              className={`px-2 py-0.5 rounded ${
                step === 2
                  ? "bg-cyan-950 text-cyan-300 border border-cyan-700/60 font-bold"
                  : "bg-slate-900 text-slate-400"
              }`}
            >
              02: GOALS
            </span>
          </div>
        </div>

        {/* Header */}
        <div className="mb-6 flex items-start justify-between">
          <div className="space-y-1">
            <h2 className="text-2xl font-black tracking-tight text-white flex items-center gap-2">
              {step === 1 ? (
                <>
                  INITIALIZE <span className="text-cyan-400">// OS</span>
                </>
              ) : (
                <>
                  THIẾT LẬP <span className="text-cyan-400">KHÔNG GIAN LÀM VIỆC</span>
                </>
              )}
            </h2>
            <p className="text-xs text-slate-400 font-mono">
              {step === 1
                ? APP_SUBTITLE
                : "Chọn mục tiêu và phong cách cá nhân để tự động định hình các phân hệ"}
            </p>
          </div>
          <div className="p-2.5 rounded-xl bg-cyan-950/50 border border-cyan-500/20 text-cyan-400 shrink-0">
            <Shield className="w-6 h-6" />
          </div>
        </div>

        {/* Step 1: Signature Handle */}
        {step === 1 && (
          <form onSubmit={handleNextStep} className="space-y-5">
            <div className="rounded-lg border border-slate-800/80 bg-slate-900/60 p-3.5 text-xs text-slate-300 leading-relaxed space-y-1 font-mono">
              <div className="flex items-center gap-1.5 text-cyan-300 font-semibold">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Zero-Cloud, Pure Local Identity</span>
              </div>
              <p className="text-slate-400">
                Hệ điều hành vận hành hoàn toàn cục bộ trên SQLite WAL. Hãy thiết lập chữ ký định danh cá nhân để định cấu hình không gian làm việc.
              </p>
            </div>

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
                className="w-full rounded-lg bg-slate-900 border border-slate-800 px-4 py-3 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-colors"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-950/60 border border-red-500/40 text-red-300 text-xs font-mono animate-in fade-in duration-200">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full mt-2 flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 px-5 py-3 text-sm font-bold text-white shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all active:scale-[0.99] cursor-pointer"
            >
              <span>TIẾP TỤC</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}

        {/* Step 2: Workspace Goals */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2.5 max-h-[320px] overflow-y-auto pr-1">
              {WORKSPACE_GOALS.map((goal) => {
                const isSelected = selectedGoals.includes(goal.id);
                const IconComponent = goal.icon;

                return (
                  <div
                    key={goal.id}
                    onClick={() => toggleGoal(goal.id)}
                    className={`cursor-pointer rounded-xl border p-3.5 transition-all flex items-start gap-3.5 ${
                      isSelected
                        ? "border-cyan-500/80 bg-cyan-950/30 shadow-[0_0_15px_rgba(6,182,212,0.1)]"
                        : "border-slate-800 bg-slate-900/50 hover:border-slate-700"
                    }`}
                  >
                    <div
                      className={`p-2 rounded-lg shrink-0 mt-0.5 ${
                        isSelected
                          ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                          : "bg-slate-800 text-slate-400 border border-slate-700"
                      }`}
                    >
                      <IconComponent className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-white font-mono truncate">
                          {goal.title}
                        </span>
                        <span
                          className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold shrink-0 ${
                            isSelected
                              ? "bg-cyan-900/60 text-cyan-300 border border-cyan-700/60"
                              : "bg-slate-800 text-slate-500"
                          }`}
                        >
                          {goal.badge}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 font-mono leading-relaxed">
                        {goal.description}
                      </p>
                    </div>

                    <div
                      className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border transition-all mt-0.5 ${
                        isSelected
                          ? "bg-cyan-500 border-cyan-400 text-slate-950"
                          : "border-slate-700 bg-slate-800"
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-950/60 border border-red-500/40 text-red-300 text-xs font-mono animate-in fade-in duration-200">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep(1);
                }}
                disabled={isSubmitting}
                className="px-4 py-3 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-mono font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>QUAY LẠI</span>
              </button>

              <button
                type="button"
                onClick={handleFinalSubmit}
                disabled={isSubmitting}
                className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 px-5 py-3 text-sm font-bold text-white shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <span>
                  {isSubmitting ? "ĐANG KHỞI TẠO..." : "KÍCH HOẠT HỆ ĐIỀU HÀNH"}
                </span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Footer info */}
        <div className="mt-6 pt-4 border-t border-slate-900 flex items-center justify-between text-[11px] font-mono text-slate-500">
          <span>STATUS: READY FOR BOOT</span>
          <span>SEC: LOCAL_SANDBOX</span>
        </div>
      </div>
    </div>
  );
};

export default GenesisModal;
