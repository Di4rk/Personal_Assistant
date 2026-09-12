import { usePrivacyStore } from '@/stores/usePrivacyStore';

export function DemoModeBanner() {
  const isDemoMode = usePrivacyStore((s) => s.isDemoMode);
  const toggleDemoMode = usePrivacyStore((s) => s.toggleDemoMode);

  if (!isDemoMode) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] flex items-center justify-center gap-3 bg-amber-500/90 py-1.5 text-xs font-mono font-bold text-slate-950 shadow-md backdrop-blur">
      <span>🔒 DEMO PRIVACY MODE ĐANG BẬT — Dữ liệu cá nhân đang bị che</span>
      <button
        type="button"
        onClick={toggleDemoMode}
        className="rounded bg-slate-950/20 px-2 py-0.5 hover:bg-slate-950/30 transition-colors cursor-pointer"
      >
        Tắt ngay
      </button>
    </div>
  );
}
