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

export interface ActivityEventInput {
  eventDate: string;
  eventType: string;
  xpValue: number;
  refId?: string;
}
