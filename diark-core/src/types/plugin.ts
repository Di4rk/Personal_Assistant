export type PluginTrustTier = 'first_party' | 'third_party';

export interface PluginMetaDto {
  pluginId: string;
  name: string;
  version: string;
  author: string;
  category: string;
  isEnabled: boolean;
  isBuiltin: boolean;
  trustTier: PluginTrustTier;
}

/** Remount key for the plugin nav/viewport tree when enable flags change. */
export function pluginViewportKey(plugins: PluginMetaDto[]): string {
  return plugins.map((p) => `${p.pluginId}:${p.isEnabled ? "on" : "off"}`).join("|");
}

export interface ActivityEventInput {
  eventDate: string;
  eventType: string;
  xpValue: number;
  refId?: string;
}

export interface RemotePluginDto {
  id: string;
  name: string;
  version: string;
  author: string;
  download_url: string;
  sha256: string;
  manifest_url: string;
}
