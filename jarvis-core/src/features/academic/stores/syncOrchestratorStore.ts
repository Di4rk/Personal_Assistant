import { create } from 'zustand';
import {
  launchPortalSilentSync,
  launchWecodeSilentSync,
  launchMoodleSilentSync,
  getSyncTimestamps,
} from '../../../lib/tauri-client';

export type SyncService = 'portal' | 'wecode' | 'moodle';
export type AuthStatus = 'authenticated' | 'expired';

export interface ServiceSyncState {
  lastSyncedAt: number; // Unix epoch seconds
  failCount: number;
  lastFailedAt: number; // Date.now() ms
  authStatus: AuthStatus;
  isSyncing: boolean;
}

export interface SyncRequestOptions {
  bypassTtl?: boolean;
  bypassCircuitBreaker?: boolean;
}

export interface SyncOrchestratorStore {
  activeService: SyncService | null;
  queue: SyncService[];
  serviceState: Record<SyncService, ServiceSyncState>;
  isOffline: boolean;

  setOffline: (offline: boolean) => void;
  initSyncTimestamps: () => Promise<void>;
  requestSync: (service: SyncService, options?: SyncRequestOptions) => Promise<boolean>;
  openInteractiveLogin: (service: SyncService) => Promise<void>;
}

const TTL_SECONDS: Record<SyncService, number> = {
  portal: 14400, // 4 hours
  wecode: 900,   // 15 minutes
  moodle: 1800,  // 30 minutes
};

const CIRCUIT_BREAKER_MAX_FAILS = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export const useSyncOrchestratorStore = create<SyncOrchestratorStore>((set, get) => ({
  activeService: null,
  queue: [],
  serviceState: {
    portal: {
      lastSyncedAt: 0,
      failCount: 0,
      lastFailedAt: 0,
      authStatus: 'authenticated',
      isSyncing: false,
    },
    wecode: {
      lastSyncedAt: 0,
      failCount: 0,
      lastFailedAt: 0,
      authStatus: 'authenticated',
      isSyncing: false,
    },
    moodle: {
      lastSyncedAt: 0,
      failCount: 0,
      lastFailedAt: 0,
      authStatus: 'authenticated',
      isSyncing: false,
    },
  },
  isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,

  setOffline: (offline: boolean) => set({ isOffline: offline }),

  initSyncTimestamps: async () => {
    try {
      const timestamps = await getSyncTimestamps();
      set((state) => ({
        serviceState: {
          portal: {
            ...state.serviceState.portal,
            lastSyncedAt: timestamps.portal_last_synced_at || state.serviceState.portal.lastSyncedAt,
          },
          wecode: {
            ...state.serviceState.wecode,
            lastSyncedAt: timestamps.wecode_last_synced_at || state.serviceState.wecode.lastSyncedAt,
          },
          moodle: {
            ...state.serviceState.moodle,
            lastSyncedAt: timestamps.moodle_last_synced_at || state.serviceState.moodle.lastSyncedAt,
          },
        },
      }));
    } catch (err) {
      console.warn('[SyncOrchestrator] Failed to fetch sync timestamps:', err);
    }
  },

  openInteractiveLogin: async (service: SyncService) => {
    try {
      if (service === 'portal') {
        const { launchPortalSsoSync } = await import('../../../lib/tauri-client');
        await launchPortalSsoSync();
      } else if (service === 'wecode') {
        const { launchWecodeSsoSync } = await import('../../../lib/tauri-client');
        await launchWecodeSsoSync();
      } else {
        const { launchMoodleSsoSync } = await import('../../../lib/tauri-client');
        await launchMoodleSsoSync();
      }
    } catch (err) {
      console.error(`[SyncOrchestrator] Failed to open interactive login for ${service}:`, err);
    }
  },

  requestSync: async (service: SyncService, options?: SyncRequestOptions): Promise<boolean> => {
    const state = get();

    if (state.isOffline && !options?.bypassTtl) {
      console.log(`[SyncOrchestrator] Skipped sync for ${service}: Network is offline.`);
      return false;
    }

    const currentServiceState = state.serviceState[service];

    // 1. Check Circuit Breaker
    if (!options?.bypassCircuitBreaker && currentServiceState.failCount >= CIRCUIT_BREAKER_MAX_FAILS) {
      const timeSinceLastFail = Date.now() - currentServiceState.lastFailedAt;
      if (timeSinceLastFail < CIRCUIT_BREAKER_COOLDOWN_MS) {
        console.warn(`[SyncOrchestrator] Circuit breaker tripped for ${service}. Cooling down.`);
        return false;
      }
    }

    // 2. Check TTL
    if (!options?.bypassTtl) {
      const nowSec = Math.floor(Date.now() / 1000);
      const elapsed = nowSec - currentServiceState.lastSyncedAt;
      if (elapsed < TTL_SECONDS[service]) {
        console.log(`[SyncOrchestrator] TTL valid for ${service} (${elapsed}s / ${TTL_SECONDS[service]}s). Skip.`);
        return false;
      }
    }

    // 3. FIFO Queueing if another service is actively syncing
    if (state.activeService !== null) {
      if (state.activeService === service || state.queue.includes(service)) {
        return false;
      }
      set((s) => ({ queue: [...s.queue, service] }));
      return true;
    }

    // 4. Start execution directly
    executeSync(service, set, get);
    return true;
  },
}));

async function executeSync(
  service: SyncService,
  set: (fn: (state: SyncOrchestratorStore) => Partial<SyncOrchestratorStore>) => void,
  get: () => SyncOrchestratorStore,
) {
  set((s) => ({
    activeService: service,
    serviceState: {
      ...s.serviceState,
      [service]: {
        ...s.serviceState[service],
        isSyncing: true,
      },
    },
  }));

  let errorType: 'AUTH_EXPIRED' | 'SERVER_ERROR' | 'TIMEOUT' | null = null;

  try {
    if (service === 'portal') {
      await launchPortalSilentSync();
    } else if (service === 'wecode') {
      await launchWecodeSilentSync();
    } else {
      await launchMoodleSilentSync();
    }
  } catch (err: unknown) {
    const errStr = String(err);
    if (errStr.includes('AUTH_EXPIRED')) {
      errorType = 'AUTH_EXPIRED';
    } else if (errStr.includes('TIMEOUT')) {
      errorType = 'TIMEOUT';
    } else {
      errorType = 'SERVER_ERROR';
    }
    console.error(`[SyncOrchestrator] Sync failed for ${service}:`, err);
  } finally {
    onSyncSettled(service, errorType, set, get);
  }
}

function onSyncSettled(
  service: SyncService,
  errorType: 'AUTH_EXPIRED' | 'SERVER_ERROR' | 'TIMEOUT' | null,
  set: (fn: (state: SyncOrchestratorStore) => Partial<SyncOrchestratorStore>) => void,
  get: () => SyncOrchestratorStore,
) {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  set((state) => {
    const current = state.serviceState[service];
    let nextFailCount = current.failCount;
    let nextLastFailedAt = current.lastFailedAt;
    let nextAuthStatus: AuthStatus = current.authStatus;
    let nextLastSyncedAt = current.lastSyncedAt;

    if (!errorType) {
      // Success
      nextFailCount = 0;
      nextLastFailedAt = 0;
      nextAuthStatus = 'authenticated';
      nextLastSyncedAt = nowSec;
    } else if (errorType === 'AUTH_EXPIRED') {
      // Expired session
      nextAuthStatus = 'expired';
    } else {
      // Server error / timeout
      nextFailCount += 1;
      nextLastFailedAt = nowMs;
    }

    return {
      activeService: null,
      serviceState: {
        ...state.serviceState,
        [service]: {
          ...current,
          isSyncing: false,
          failCount: nextFailCount,
          lastFailedAt: nextLastFailedAt,
          authStatus: nextAuthStatus,
          lastSyncedAt: nextLastSyncedAt,
        },
      },
    };
  });

  // Execute next queued service if available
  const nextItem = get().queue[0];
  if (nextItem && get().activeService === null) {
    const queueWithoutFirst = get().queue.slice(1);
    set(() => ({ queue: queueWithoutFirst }));
    executeSync(nextItem, set, get);
  }
}
