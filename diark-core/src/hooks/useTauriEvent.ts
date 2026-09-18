import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Generic, StrictMode-safe hook for subscribing to Tauri backend events.
 *
 * Uses `useRef` for the handler to prevent stale closure bugs while
 * maintaining a stable event subscription.
 */
export function useTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        const unlistenFn = await listen<T>(eventName, (event) => {
          handlerRef.current(event.payload);
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
