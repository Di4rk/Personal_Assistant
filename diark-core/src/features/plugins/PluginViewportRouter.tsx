import React, { lazy, Suspense } from "react";
import { PluginSandboxViewport } from "./PluginSandboxViewport";
import type { PluginMetaDto } from "@/types/plugin";

interface FirstPartyProps {
  [key: string]: unknown;
}

// First-party component map with React.lazy
const FIRST_PARTY_COMPONENTS: Record<string, React.LazyExoticComponent<React.ComponentType<FirstPartyProps>>> = {
  "cp-codeforces": lazy(() => import("@/features/cp/CodeforcesDashboard")),
  "uit-wecode": lazy(() => import("@/features/academic/WecodeDashboard")),
  "uit-courses": lazy(() => import("@/features/academic/CoursesDashboard")),
};

interface PluginViewportRouterProps {
  plugin: PluginMetaDto;
  extraProps?: Record<string, unknown>;
}

export const PluginViewportRouter: React.FC<PluginViewportRouterProps> = ({ plugin, extraProps = {} }) => {
  if (!plugin.isEnabled) return null;

  if (plugin.trustTier === "first_party") {
    const Component = FIRST_PARTY_COMPONENTS[plugin.pluginId];
    if (!Component) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-xs font-mono text-slate-400">
          First-party plugin <span className="text-cyan-400">{plugin.pluginId}</span> chưa đăng ký component render.
        </div>
      );
    }
    return (
      <Suspense
        fallback={
          <div className="p-8 font-mono text-xs text-slate-500 animate-pulse">
            Đang tải phân hệ {plugin.name}...
          </div>
        }
      >
        <Component {...extraProps} />
      </Suspense>
    );
  }

  return <PluginSandboxViewport pluginId={plugin.pluginId} />;
};
