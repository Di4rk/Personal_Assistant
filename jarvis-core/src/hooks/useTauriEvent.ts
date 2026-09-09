import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Generic, StrictMode-safe hook for subscribing to Tauri backend events.
 *
 * **Why the `cancelled` flag?**
 * React 18 StrictMode intentionally mounts → unmounts → remounts every component
 * in development to surface bugs in cleanup logic. `listen()` is async, so
 * there's a race: the component can unmount before the Promise resolves,
 * leaving an unlisten function we never called. The `cancelled` flag catches
 * that window: if cleanup runs before `listen()` resolves, we call `unlisten()`
 * immediately when the Promise finally settles.
 *
 * @param eventName - Tauri event name emitted from Rust (e.g. "cf-sync-complete")
 * @param handler   - Callback receiving the typed payload. Stable reference
 *                    recommended (wrap in useCallback if needed) — hook re-registers
 *                    whenever `eventName` or `handler` reference changes.
 */
export function useTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void
): void {
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        const unlistenFn = await listen<T>(eventName, (event) => {
          handler(event.payload);
        });

        if (cancelled) {
          // Component unmounted while listen() was still in flight.
          // Call unlisten immediately to prevent the ghost listener.
          unlistenFn();
          return;
        }

        unlisten = unlistenFn;
      } catch (err) {
        if (!cancelled) {
          console.error(`[useTauriEvent] Failed to register listener for "${eventName}":`, err);
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventName]);
}
