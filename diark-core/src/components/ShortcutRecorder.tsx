import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  suspendHotkey,
  resumeHotkey,
  updateGlobalShortcut,
  type SystemErrorCode,
} from "../services/systemService";

interface ShortcutRecorderProps {
  currentShortcut: string;
  onShortcutChanged: (newCanonicalShortcut: string) => void;
  disabled?: boolean;
}

export {
  mapCodeToTauriToken,
  validateShortcutUi,
  getFriendlyErrorMessage,
} from "../utils/shortcutHelper";
import {
  mapCodeToTauriToken,
  validateShortcutUi,
  getFriendlyErrorMessage,
} from "../utils/shortcutHelper";

export const ShortcutRecorder: React.FC<ShortcutRecorderProps> = ({
  currentShortcut,
  onShortcutChanged,
  disabled = false,
}) => {
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const isRecordingRef = useRef<boolean>(false);
  isRecordingRef.current = isRecording;

  // An toàn: khi thoát recording bằng bất kỳ lý do nào (unmount, blur, escape, done)
  // luôn gọi resumeHotkey() để đảm bảo hotkey không bị treo.
  const stopRecording = useCallback(async () => {
    setIsRecording(false);
    try {
      await resumeHotkey();
    } catch (err) {
      console.warn("[ShortcutRecorder] resumeHotkey error:", err);
    }
  }, []);

  const startRecording = async () => {
    if (disabled || isSaving) return;
    setErrorMessage(null);
    setIsRecording(true);
    try {
      await suspendHotkey();
    } catch (err) {
      console.warn("[ShortcutRecorder] suspendHotkey error:", err);
    }
  };

  useEffect(() => {
    // Cleanup effect nếu component unmount trong khi đang recording
    return () => {
      if (isRecordingRef.current) {
        resumeHotkey().catch((err) =>
          console.warn("[ShortcutRecorder] unmount resume error:", err)
        );
      }
    };
  }, []);

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!isRecording || isSaving) return;

    e.preventDefault();
    e.stopPropagation();

    // Bỏ qua lặp phím khi giữ phím (auto-repeat)
    if (e.repeat) return;

    // Thoát ghi phím bằng Escape nếu không kèm modifier nào
    if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      await stopRecording();
      return;
    }

    // Cảnh báo nếu nhấn AltGr (tránh gõ ký tự đặc biệt)
    if (e.getModifierState && e.getModifierState("AltGraph")) {
      setErrorMessage("Phát hiện phím AltGr. Vui lòng không sử dụng phím này cho hotkey.");
      return;
    }

    // Lấy key token chính
    const keyToken = mapCodeToTauriToken(e.code);
    if (!keyToken) {
      // Người dùng mới chỉ bấm phím bổ trợ (Ctrl/Alt/Shift/Meta) -> chờ tiếp
      return;
    }

    const ctrl = e.ctrlKey;
    const alt = e.altKey;
    const shift = e.shiftKey;
    const meta = e.metaKey;

    // Validate nhanh phía UI
    const validationError = validateShortcutUi(ctrl, alt, shift, meta, keyToken);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    // Ghép tổ hợp phím theo cú pháp Tauri (ưu tiên: Ctrl + Alt + Shift + Super + Key)
    const tokens: string[] = [];
    if (ctrl) tokens.push("Ctrl");
    if (alt) tokens.push("Alt");
    if (shift) tokens.push("Shift");
    if (meta) tokens.push("Super");
    tokens.push(keyToken);
    const candidateShortcut = tokens.join("+");

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const canonical = await updateGlobalShortcut(candidateShortcut);
      onShortcutChanged(canonical);
      await stopRecording();
    } catch (err: unknown) {
      const errorObj = err as { code?: SystemErrorCode; message?: string };
      const code = errorObj.code || "UNKNOWN_ERROR";
      setErrorMessage(getFriendlyErrorMessage(code, errorObj.message));
    } finally {
      setIsSaving(false);
    }
  };

  const handleBlur = () => {
    if (isRecording && !isSaving) {
      stopRecording();
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          disabled={disabled || isSaving}
          className={`px-4 py-2 text-sm font-mono font-medium rounded border transition-colors focus:outline-none focus:ring-1 ${
            isRecording
              ? "bg-amber-500/10 border-amber-500/50 text-amber-300 animate-pulse focus:ring-amber-500"
              : "bg-slate-800/80 hover:bg-slate-700/80 border-slate-700 text-slate-200 focus:ring-slate-500"
          } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          title={isRecording ? "Nhấn phím tắt mới hoặc Esc để hủy" : "Nhấp để đổi phím tắt"}
        >
          {isSaving
            ? "Đang lưu..."
            : isRecording
            ? "Nhấn tổ hợp phím mới (hoặc Esc)..."
            : currentShortcut || "Chưa gán"}
        </button>

        {isRecording && (
          <span className="text-xs text-amber-400/80">
            Đang ghi nhận... (Nhấn Esc để hủy)
          </span>
        )}
      </div>

      {errorMessage && (
        <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 rounded">
          {errorMessage}
        </div>
      )}
    </div>
  );
};
