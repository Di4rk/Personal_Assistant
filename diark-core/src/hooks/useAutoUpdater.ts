import { useState, useEffect, useCallback, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const AUTO_CHECK_STORAGE_KEY = "diark_auto_check_updates";
const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready-to-relaunch"
  | "error"
  | "dismissed";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
}

export interface UseAutoUpdaterReturn {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  downloadProgress: number; // 0 to 100
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
  isChecking: boolean;
  isDownloading: boolean;
  autoCheckEnabled: boolean;
  lastCheckedAt: number | null;
  setAutoCheckEnabled: (enabled: boolean) => void;
  checkForUpdates: (manual?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissUpdate: () => void;
}

export function useAutoUpdater(): UseAutoUpdaterReturn {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadedBytes, setDownloadedBytes] = useState<number>(0);
  const [totalBytes, setTotalBytes] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [autoCheckEnabled, setAutoCheckEnabledState] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(AUTO_CHECK_STORAGE_KEY);
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });

  const pendingUpdateRef = useRef<Update | null>(null);
  const checkingLockRef = useRef<boolean>(false);

  const setAutoCheckEnabled = useCallback((enabled: boolean) => {
    setAutoCheckEnabledState(enabled);
    try {
      window.localStorage.setItem(AUTO_CHECK_STORAGE_KEY, enabled ? "true" : "false");
    } catch {
      // ignore storage restrictions
    }
  }, []);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (checkingLockRef.current) return;
    checkingLockRef.current = true;
    setError(null);
    setStatus("checking");

    try {
      const update = await check();
      setLastCheckedAt(Date.now());

      if (update && (update.available ?? true)) {
        pendingUpdateRef.current = update;
        setUpdateInfo({
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body ?? "",
          date: update.date ?? undefined,
        });
        setStatus("available");
      } else {
        pendingUpdateRef.current = null;
        setUpdateInfo(null);
        setStatus(manual ? "up-to-date" : "idle");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[AutoUpdater] Check failed:", message);
      pendingUpdateRef.current = null;
      setLastCheckedAt(Date.now());

      if (manual) {
        setError(message);
        setStatus("error");
      } else {
        setStatus("idle");
      }
    } finally {
      checkingLockRef.current = false;
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) {
      setError("Không tìm thấy bản cập nhật sẵn sàng để tải.");
      setStatus("error");
      return;
    }

    try {
      setStatus("downloading");
      setDownloadProgress(0);
      setDownloadedBytes(0);
      setTotalBytes(0);
      setError(null);

      let accumulatedBytes = 0;
      let targetContentLength = 0;

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          targetContentLength = event.data.contentLength ?? 0;
          setTotalBytes(targetContentLength);
        } else if (event.event === "Progress") {
          accumulatedBytes += event.data.chunkLength;
          setDownloadedBytes(accumulatedBytes);
          if (targetContentLength > 0) {
            const percent = Math.min(
              100,
              Math.round((accumulatedBytes / targetContentLength) * 100)
            );
            setDownloadProgress(percent);
          }
        } else if (event.event === "Finished") {
          setDownloadProgress(100);
          setStatus("ready-to-relaunch");
        }
      });

      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[AutoUpdater] Download/Install error:", err);
      setError(`Không thể cập nhật: ${message}`);
      setStatus("error");
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setStatus("dismissed");
  }, []);

  useEffect(() => {
    if (!autoCheckEnabled) return;

    const initialTimer = window.setTimeout(() => {
      void checkForUpdates(false);
    }, 2500);

    const periodicTimer = window.setInterval(() => {
      void checkForUpdates(false);
    }, AUTO_CHECK_INTERVAL_MS);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(periodicTimer);
    };
  }, [autoCheckEnabled, checkForUpdates]);

  const isChecking = status === "checking";
  const isDownloading = status === "downloading";

  return {
    status,
    updateInfo,
    downloadProgress,
    downloadedBytes,
    totalBytes,
    error,
    isChecking,
    isDownloading,
    autoCheckEnabled,
    lastCheckedAt,
    setAutoCheckEnabled,
    checkForUpdates,
    installUpdate,
    dismissUpdate,
  };
}
