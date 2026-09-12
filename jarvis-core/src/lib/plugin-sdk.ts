import { invoke } from '@tauri-apps/api/core';
import type { PluginMetaDto, ActivityEventInput } from '@/types/plugin';

export interface DiarkPluginSDK {
  storage: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
  };
  activity: {
    record: (input: ActivityEventInput) => Promise<void>;
  };
  ui: {
    notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  };
}

export function createPluginSDK(pluginId: string): DiarkPluginSDK {
  return {
    storage: {
      get: (key) => invoke<string | null>('plugin_storage_get', { pluginId, key }),
      set: (key, value) => invoke<void>('plugin_storage_set', { pluginId, key, value }),
    },
    activity: {
      record: (input) =>
        invoke<void>('record_activity_event', {
          pluginId,
          input: {
            event_date: input.eventDate,
            event_type: input.eventType,
            xp_value: input.xpValue,
            ref_id: input.refId,
          },
        }),
    },
    ui: {
      notify: (message, type = 'info') => {
        console.log(`[Plugin: ${pluginId}][${type.toUpperCase()}] ${message}`);
      },
    },
  };
}

export async function listInstalledPlugins(): Promise<PluginMetaDto[]> {
  return invoke<PluginMetaDto[]>('list_installed_plugins');
}

export async function togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
  return invoke<void>('toggle_plugin', { pluginId, enabled });
}

export async function triggerRecomputeDailyMatrix(date: string): Promise<void> {
  return invoke<void>('trigger_recompute_daily_matrix', { date });
}
