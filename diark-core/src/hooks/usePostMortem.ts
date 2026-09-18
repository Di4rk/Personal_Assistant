import { useCallback, useEffect, useRef, useState } from "react";
import { savePostMortem, searchPostMortems, deletePostMortem } from "../lib/tauri-client";
import type { PostMortemInput, PostMortemRecord, PostMortemSearchResult } from "../types/post_mortem";

// ============================================================
// Hook state types — explicit discriminated union keeps consumer
// code clean: no boolean soup (isLoading + isError + data).
// ============================================================

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "success"; record: PostMortemRecord }
  | { status: "error"; message: string };

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "done"; results: PostMortemSearchResult[] }
  | { status: "error"; message: string };

export interface UsePostMortemReturn {
  /** Current save lifecycle state. */
  saveState: SaveState;
  /** Current search lifecycle state. */
  searchState: SearchState;
  /**
   * Upsert a post-mortem. Resolves with the saved record on success.
   * On failure, sets `saveState` to `{ status: "error", message }` and returns null.
   */
  save: (input: PostMortemInput) => Promise<PostMortemRecord | null>;
  /**
   * Full-text search via FTS5 MATCH. Debounced: rapid calls within
   * `debounceMs` (default 250ms) are coalesced — safe to call on every keystroke.
   */
  search: (query: string, limit?: number) => void;
  /**
   * Delete a post-mortem by problemId. Returns true if a record was removed.
   * Resets search results to idle so the caller can refresh if needed.
   */
  remove: (problemId: string) => Promise<boolean>;
  /** Clears save state back to idle (e.g., after the modal closes). */
  resetSave: () => void;
  /** Clears search results back to idle. */
  resetSearch: () => void;
}

/**
 * Manages post-mortem CRUD + FTS5 search state for a component tree.
 *
 * Design decisions:
 * - Search is debounced internally to avoid hammering SQLite on every keystroke.
 *   The debounce is cancelled on unmount via `useRef` tracking the pending timer.
 * - Save uses a `mounted` ref guard (same pattern as CfSettingsPanel) to prevent
 *   setState on unmounted component if the modal closes before the IPC round-trip.
 * - No global state / context — hook is instantiated per-modal, keeping
 *   state lifecycle strictly tied to component lifetime.
 */
export function usePostMortem(debounceMs: number = 250): UsePostMortemReturn {
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });

  const mounted = useRef(true);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the latest search query so stale responses from an older query
  // don't overwrite the result of a newer one.
  const latestQuery = useRef<string>("");

  const save = useCallback(async (input: PostMortemInput): Promise<PostMortemRecord | null> => {
    setSaveState({ status: "saving" });

    try {
      const record = await savePostMortem(input);
      if (mounted.current) {
        setSaveState({ status: "success", record });
      }
      return record;
    } catch (err) {
      const message =
        typeof err === "string"
          ? err
          : err instanceof Error
            ? err.message
            : "Không thể lưu post-mortem.";

      if (mounted.current) {
        setSaveState({ status: "error", message });
      }
      console.error("[usePostMortem] save error:", err);
      return null;
    }
  }, []);

  const search = useCallback(
    (query: string, limit: number = 20) => {
      // Cancel any pending debounced call.
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
      }

      const trimmed = query.trim();

      // Empty query → reset to idle immediately, no network call.
      if (!trimmed) {
        latestQuery.current = "";
        setSearchState({ status: "idle" });
        return;
      }

      latestQuery.current = trimmed;

      debounceTimer.current = setTimeout(async () => {
        const capturedQuery = trimmed;
        if (!mounted.current) return;

        setSearchState({ status: "searching" });

        try {
          const results = await searchPostMortems(capturedQuery, limit);

          // Discard stale response if a newer query was started.
          if (!mounted.current || latestQuery.current !== capturedQuery) return;

          setSearchState({ status: "done", results });
        } catch (err) {
          if (!mounted.current || latestQuery.current !== capturedQuery) return;

          const message =
            typeof err === "string" ? err : "Lỗi tìm kiếm — kiểm tra kết nối DB.";
          setSearchState({ status: "error", message });
          console.error("[usePostMortem] search error:", err);
        }
      }, debounceMs);
    },
    [debounceMs]
  );

  const remove = useCallback(async (problemId: string): Promise<boolean> => {
    const deleted = await deletePostMortem(problemId);
    if (deleted && mounted.current) {
      // Reset search so the caller can trigger a fresh search after deletion.
      setSearchState({ status: "idle" });
    }
    return deleted;
  }, []);

  const resetSave = useCallback(() => {
    setSaveState({ status: "idle" });
  }, []);

  const resetSearch = useCallback(() => {
    latestQuery.current = "";
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    setSearchState({ status: "idle" });
  }, []);

  // Cleanup on unmount: cancel pending debounce timer and mark component dead.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, []);

  return { saveState, searchState, save, search, remove, resetSave, resetSearch };
}
