import { useState } from "react";
import { devSeedMockData, devClearMockData } from "../lib/tauri-client";

/**
 * Panel test-only. Không cần tự ẩn bằng import.meta.env.DEV ở đây vì:
 * Rust command dev_seed_mock_data / dev_clear_mock_data đã bị strip hoàn toàn
 * khỏi release build (cfg debug_assertions) - nếu lỡ để component này trong
 * bundle release, bấm nút chỉ nhận lỗi "command not found" vô hại, không có
 * cách nào ghi được data giả vào bản thật.
 *
 * Dù vậy vẫn nên bọc <DevMockPanel /> trong {import.meta.env.DEV && ...} ở nơi
 * dùng, để UI sạch sẽ khi build release.
 */
export default function DevMockPanel() {
  const [busy, setBusy] = useState(false);
  const [lastMessage, setLastMessage] = useState<string>("");

  const handleSeed = async (days: number) => {
    setBusy(true);
    const inserted = await devSeedMockData(days);
    setLastMessage(
      inserted > 0
        ? `Đã tạo ${inserted} submission giả cho ${days} ngày gần nhất.`
        : "Không seed được - có đang chạy debug build không?"
    );
    setBusy(false);
  };

  const handleClear = async () => {
    setBusy(true);
    const deleted = await devClearMockData();
    setLastMessage(`Đã xoá ${deleted} submission mock.`);
    setBusy(false);
  };

  return (
    <div className="rounded-xl border border-dashed border-amber-700/50 bg-amber-950/20 p-3">
      <p className="text-xs font-medium text-amber-500 mb-2">⚠ DEV ONLY - Mock Data Panel</p>
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={() => handleSeed(30)}
          className="px-3 py-1.5 text-xs rounded-md bg-amber-800/40 text-amber-300 hover:bg-amber-800/60 disabled:opacity-50"
        >
          Seed 30 ngày
        </button>
        <button
          disabled={busy}
          onClick={() => handleSeed(365)}
          className="px-3 py-1.5 text-xs rounded-md bg-amber-800/40 text-amber-300 hover:bg-amber-800/60 disabled:opacity-50"
        >
          Seed 365 ngày (full năm)
        </button>
        <button
          disabled={busy}
          onClick={handleClear}
          className="px-3 py-1.5 text-xs rounded-md bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
        >
          Xoá mock data
        </button>
      </div>
      {lastMessage && <p className="text-xs text-zinc-500 mt-2">{lastMessage}</p>}
    </div>
  );
}
