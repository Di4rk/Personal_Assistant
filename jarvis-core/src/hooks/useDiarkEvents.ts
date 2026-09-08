import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const EVENT_SYNC = "cf://sync-event";

/**
 * Payload khớp CHÍNH XÁC với struct SyncResult trong
 * src-tauri/src/db/submissions.rs - Rust emit thẳng struct này, không có
 * struct payload riêng, nên field name ở đây PHẢI đồng bộ tay khi Rust đổi.
 */
export interface SyncEventPayload {
  new_submissions_count: number;
  total_daily_xp: number;
  first_ac_count: number;
}

export interface DiarkEventsState {
  /** Payload của lần emit gần nhất, null nếu chưa có event nào từ lúc app mở. */
  lastSync: SyncEventPayload | null;
  /**
   * Tăng dần mỗi lần nhận event mới. Dùng làm dependency trong useEffect của
   * component cha để trigger refetch data qua Tauri command - tách biệt rõ
   * "biết có gì mới" (event, việc của hook này) và "lấy gì mới" (command call,
   * việc của component dùng hook).
   */
  syncVersion: number;
  /** true kể từ lúc setup listener xong, dùng để phân biệt "chưa kết nối" vs "đã kết nối nhưng chưa có event". */
  isListening: boolean;
}

/**
 * Hook lắng nghe sự kiện "cf://sync-event" bắn từ Rust background worker
 * (services/cf_worker.rs). Hoàn toàn event-driven - KHÔNG còn setInterval
 * nào ở phía React. Worker Rust tự quyết định khi nào có data thật sự mới
 * (đã lọc trùng bằng UNIQUE INDEX cf_submission_id) rồi mới emit; React chỉ
 * việc phản ứng lại, tiết kiệm hẳn các lượt gọi Tauri command vô ích mỗi vài
 * giây dù chẳng có gì thay đổi.
 */
export function useDiarkEvents(): DiarkEventsState {
  const [lastSync, setLastSync] = useState<SyncEventPayload | null>(null);
  const [syncVersion, setSyncVersion] = useState(0);
  const [isListening, setIsListening] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const setup = async () => {
      try {
        const unlistenFn = await listen<SyncEventPayload>(EVENT_SYNC, (event) => {
          setLastSync(event.payload);
          setSyncVersion((v) => v + 1);
        });

        if (cancelled) {
          // Component đã unmount trước khi setup xong (race condition hiếm gặp
          // nhưng có thể xảy ra) - dọn dẹp ngay, không để listener rò rỉ.
          unlistenFn();
          return;
        }

        unlisten = unlistenFn;
        setIsListening(true);
      } catch (err) {
        console.error("[useDiarkEvents] Không đăng ký được listener:", err);
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  return { lastSync, syncVersion, isListening };
}
