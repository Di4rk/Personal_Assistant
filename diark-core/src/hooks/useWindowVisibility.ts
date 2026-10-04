import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Hook theo dõi trạng thái hiển thị của cửa sổ (Visible vs Hidden).
 * Lắng nghe cả event Tauri (`window-shown`, `window-hidden`) lẫn API trình duyệt `document.visibilitychange`.
 * Giúp các UI timer (Exam Countdown, Clock ticker) tạm dừng khi cửa sổ ẩn xuống khay để giảm CPU về ~0%.
 */
export function useWindowVisibility(): boolean {
  const [isVisible, setIsVisible] = useState<boolean>(() =>
    typeof document !== "undefined" ? !document.hidden : true
  );

  useEffect(() => {
    let unlistenHidden: (() => void) | undefined;
    let unlistenShown: (() => void) | undefined;
    let isCleanedUp = false;

    // Lắng nghe window-hidden từ backend Tauri (khi đóng vào khay hoặc hotkey ẩn)
    listen("window-hidden", () => {
      if (!isCleanedUp) {
        setIsVisible(false);
      }
    })
      .then((unlisten) => {
        if (isCleanedUp) {
          unlisten();
        } else {
          unlistenHidden = unlisten;
        }
      })
      .catch((err) => console.warn("[useWindowVisibility] listen window-hidden error:", err));

    // Lắng nghe window-shown từ backend Tauri (khi click khay hoặc hotkey hiện)
    listen("window-shown", () => {
      if (!isCleanedUp) {
        setIsVisible(true);
      }
    })
      .then((unlisten) => {
        if (isCleanedUp) {
          unlisten();
        } else {
          unlistenShown = unlisten;
        }
      })
      .catch((err) => console.warn("[useWindowVisibility] listen window-shown error:", err));

    // Lắng nghe visibilitychange chuẩn của WebView
    const handleVisibilityChange = () => {
      if (!isCleanedUp) {
        setIsVisible(!document.hidden);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isCleanedUp = true;
      if (unlistenHidden) unlistenHidden();
      if (unlistenShown) unlistenShown();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return isVisible;
}
