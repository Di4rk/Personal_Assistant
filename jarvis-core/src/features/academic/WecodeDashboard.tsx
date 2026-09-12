import React from "react";
import { Terminal, Award, CheckCircle2, Clock } from "lucide-react";

export const WecodeDashboard: React.FC = () => {
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-5">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-emerald-950/60 border border-emerald-800/50 text-emerald-400">
            <Terminal className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-zinc-100 font-mono">UIT Wecode Tracker</h2>
            <p className="text-xs text-zinc-500 font-mono">
              Hệ thống theo dõi bài tập thực hành lập trình cổng wecode.uit.edu.vn
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-xs">
          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Bài tập hoàn thành</span>
            </div>
            <div className="text-xl font-bold text-white">100%</div>
            <span className="text-[11px] text-zinc-500">Môn Thực hành Cấu trúc Dữ liệu & Giải thuật</span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Clock className="w-4 h-4 text-amber-400" />
              <span>Chấm điểm tự động</span>
            </div>
            <div className="text-xl font-bold text-amber-400">Active</div>
            <span className="text-[11px] text-zinc-500">Hook đồng bộ loopback bridge</span>
          </div>

          <div className="rounded-lg bg-slate-950/80 border border-slate-800 p-3.5">
            <div className="flex items-center gap-2 text-zinc-400 mb-1">
              <Award className="w-4 h-4 text-cyan-400" />
              <span>Activity Events</span>
            </div>
            <div className="text-xl font-bold text-cyan-400">Synced</div>
            <span className="text-[11px] text-zinc-500">Ghi nhận XP tự động vào Life Matrix</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WecodeDashboard;
