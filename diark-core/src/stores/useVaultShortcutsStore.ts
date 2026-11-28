import { create } from "zustand";
import {
  DEFAULT_VAULT_SHORTCUTS,
  canonicalizeShortcutString,
  type VaultShortcutAction,
  type VaultShortcutMap,
} from "../features/vault/utils/vaultShortcuts";

const STORAGE_KEY = "diark_vault_shortcuts_v1";

function loadInitialShortcuts(): VaultShortcutMap {
  if (typeof window === "undefined") {
    return { ...DEFAULT_VAULT_SHORTCUTS };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VAULT_SHORTCUTS };
    const parsed = JSON.parse(raw) as Partial<Record<VaultShortcutAction, string>>;
    const next: VaultShortcutMap = { ...DEFAULT_VAULT_SHORTCUTS };
    for (const key of Object.keys(DEFAULT_VAULT_SHORTCUTS) as VaultShortcutAction[]) {
      const candidate = parsed[key];
      if (typeof candidate === "string") {
        const canonical = canonicalizeShortcutString(candidate);
        if (canonical) next[key] = canonical;
      }
    }
    return next;
  } catch {
    return { ...DEFAULT_VAULT_SHORTCUTS };
  }
}

function persistShortcuts(map: VaultShortcutMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

interface VaultShortcutsState {
  shortcuts: VaultShortcutMap;
  setShortcut: (action: VaultShortcutAction, combo: string) => void;
  resetShortcuts: () => void;
}

export const useVaultShortcutsStore = create<VaultShortcutsState>((set) => ({
  shortcuts: loadInitialShortcuts(),
  setShortcut: (action, combo) =>
    set((state) => {
      const canonical = canonicalizeShortcutString(combo);
      if (!canonical) return state;
      const next: VaultShortcutMap = {
        ...state.shortcuts,
        [action]: canonical,
      };
      persistShortcuts(next);
      return { shortcuts: next };
    }),
  resetShortcuts: () =>
    set(() => {
      const next = { ...DEFAULT_VAULT_SHORTCUTS };
      persistShortcuts(next);
      return { shortcuts: next };
    }),
}));
