import { useState, useEffect, useCallback, useRef } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

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

  const pendingUpdateRef = useRef<Update | null>(null);
  const checkingLockRef = useRef<boolean>(false);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (checkingLockRef.current) return;
    checkingLockRef.current = true;
    setError(null);
    setStatus("checking");

    try {
      const update = await check();

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

      if (manual) {
        setError(message);
        setStatus("error");
      } else {
        // Lỗi kiểm tra tự động khi app mount (offline, dev mode, hoặc repo chưa có release)
        // không làm phiền người dùng.
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

      // Sau khi cài đặt hoàn tất, gọi relaunch() để khởi động lại ứng dụng
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

  // Tự động kiểm tra bản cập nhật khi app mount
  useEffect(() => {
    // Trì hoãn nhẹ 2.5s để nhường tài nguyên cho quá trình khởi động ban đầu
    const timer = setTimeout(() => {
      void checkForUpdates(false);
    }, 2500);

    return () => clearTimeout(timer);
  }, [checkForUpdates]);

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
    checkForUpdates,
    installUpdate,
    dismissUpdate,
  };
}
