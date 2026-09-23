import { create } from "zustand";
import { listInstalledPlugins, togglePlugin } from "@/lib/plugin-sdk";
import type { PluginMetaDto } from "@/types/plugin";

interface PluginStoreState {
  plugins: PluginMetaDto[];
  revision: number;
  loadPlugins: () => Promise<void>;
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
}

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  plugins: [],
  revision: 0,
  loadPlugins: async () => {
    const list = await listInstalledPlugins();
    set((s) => ({ plugins: list, revision: s.revision + 1 }));
  },
  setPluginEnabled: async (pluginId, enabled) => {
    const previous = get().plugins;
    set((s) => ({
      plugins: s.plugins.map((p) =>
        p.pluginId === pluginId ? { ...p, isEnabled: enabled } : p
      ),
      revision: s.revision + 1,
    }));
    try {
      await togglePlugin(pluginId, enabled);
    } catch (err) {
      set((s) => ({ plugins: previous, revision: s.revision + 1 }));
      throw err;
    }
  },
}));
