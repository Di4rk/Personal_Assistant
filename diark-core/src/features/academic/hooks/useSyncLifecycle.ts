import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useSyncOrchestratorStore } from '../stores/syncOrchestratorStore';
import type { WecodeAssignmentGroup } from '../../../types/wecode';

interface UseSyncLifecycleOptions {
  assignments?: WecodeAssignmentGroup[];
  onDataRefresh?: () => void;
}

export function useSyncLifecycle(options?: UseSyncLifecycleOptions) {
  const { assignments, onDataRefresh } = options || {};
  const {
    requestSync,
    initSyncTimestamps,
    setOffline,
    serviceState,
    activeService,
    isOffline,
    openInteractiveLogin,
  } = useSyncOrchestratorStore();

  const onDataRefreshRef = useRef(onDataRefresh);
  onDataRefreshRef.current = onDataRefresh;

  const assignmentsRef = useRef(assignments);
  assignmentsRef.current = assignments;

  // 1. Initial boot: fetch DB timestamps and run initial TTL-checked sync
  useEffect(() => {
    let unmounted = false;

    async function init() {
      await initSyncTimestamps();
      if (!unmounted) {
        // Initial sync checks
        void requestSync('portal');
        void requestSync('wecode');
      }
    }

    void init();

    return () => {
      unmounted = true;
    };
  }, [initSyncTimestamps, requestSync]);

  // 2. Online / Offline listeners
  useEffect(() => {
    const handleOnline = () => {
      setOffline(false);
      void requestSync('wecode');
      void requestSync('portal');
    };

    const handleOffline = () => {
      setOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOffline, requestSync]);

  // 3. Tier A: Window focus listener (debounced to avoid focus-bounce loops)
  useEffect(() => {
    let lastFocusCheck = 0;
    const handleFocus = () => {
      const now = Date.now();
      if (now - lastFocusCheck < 30000) return; // ít nhất 30s giữa các lần focus
      lastFocusCheck = now;
      void requestSync('wecode');
      void requestSync('portal');
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [requestSync]);

  // 4. Tier B: Adaptive background poller (60s tick)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const currentHour = now.getHours();

      // Hibernation: 01:00 to 06:00
      if (currentHour >= 1 && currentHour < 6) {
        return;
      }

      // Check if there is any unfinished assignment with deadline < 24 hours
      let hasUrgentDeadline = false;
      const currentAssignments = assignmentsRef.current || [];
      const nowMs = Date.now();
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;

      for (const a of currentAssignments) {
        if (a.deadlineStatus === 'critical' || a.deadlineStatus === 'urgent') {
          if (a.finish_time && a.solvedProblems < a.totalProblems) {
            const finishMs = new Date(a.finish_time).getTime();
            if (finishMs > nowMs && finishMs - nowMs < twentyFourHoursMs) {
              hasUrgentDeadline = true;
              break;
            }
          }
        }
      }

      // If urgent deadline exists, we allow wecode sync at 20 min interval
      if (hasUrgentDeadline) {
        const wecodeState = useSyncOrchestratorStore.getState().serviceState.wecode;
        const elapsedSec = Math.floor(nowMs / 1000) - wecodeState.lastSyncedAt;
        if (elapsedSec >= 1200) {
          void requestSync('wecode', { bypassTtl: true });
        }
      } else {
        // Standard TTL checks
        void requestSync('wecode');
        void requestSync('portal');
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [requestSync]);

  // 5. Tauri event listeners for backend synced events
  useEffect(() => {
    let unlistenWecode: (() => void) | undefined;
    let unlistenAcademic: (() => void) | undefined;

    const setupListeners = async () => {
      try {
        unlistenWecode = await listen('wecode-submissions-synced', () => {
          onDataRefreshRef.current?.();
        });

        unlistenAcademic = await listen('academic-data-synced', () => {
          onDataRefreshRef.current?.();
        });
      } catch (err) {
        console.warn('[useSyncLifecycle] Could not register Tauri event listeners:', err);
      }
    };

    void setupListeners();

    return () => {
      unlistenWecode?.();
      unlistenAcademic?.();
    };
  }, []);

  return {
    serviceState,
    activeService,
    isOffline,
    requestSync,
    openInteractiveLogin,
  };
}
