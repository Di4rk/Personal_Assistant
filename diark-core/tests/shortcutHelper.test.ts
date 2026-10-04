import test from "node:test";
import assert from "node:assert/strict";
import {
  mapCodeToTauriToken,
  validateShortcutUi,
  getFriendlyErrorMessage,
} from "../src/utils/shortcutHelper.ts";

test("mapCodeToTauriToken maps letters, digits, and special keys correctly", () => {
  // Letters
  assert.equal(mapCodeToTauriToken("KeyA"), "A");
  assert.equal(mapCodeToTauriToken("KeyK"), "K");
  assert.equal(mapCodeToTauriToken("KeyZ"), "Z");

  // Digits
  assert.equal(mapCodeToTauriToken("Digit0"), "0");
  assert.equal(mapCodeToTauriToken("Digit5"), "5");
  assert.equal(mapCodeToTauriToken("Digit9"), "9");

  // Function keys F1 - F12
  assert.equal(mapCodeToTauriToken("F1"), "F1");
  assert.equal(mapCodeToTauriToken("F5"), "F5");
  assert.equal(mapCodeToTauriToken("F12"), "F12");

  // Common navigation / action keys
  assert.equal(mapCodeToTauriToken("Space"), "Space");
  assert.equal(mapCodeToTauriToken("Escape"), "Escape");
  assert.equal(mapCodeToTauriToken("Tab"), "Tab");
  assert.equal(mapCodeToTauriToken("Backspace"), "Backspace");
  assert.equal(mapCodeToTauriToken("Enter"), "Enter");
  assert.equal(mapCodeToTauriToken("ArrowUp"), "ArrowUp");
  assert.equal(mapCodeToTauriToken("ArrowDown"), "ArrowDown");
  assert.equal(mapCodeToTauriToken("ArrowLeft"), "ArrowLeft");
  assert.equal(mapCodeToTauriToken("ArrowRight"), "ArrowRight");
  assert.equal(mapCodeToTauriToken("Home"), "Home");
  assert.equal(mapCodeToTauriToken("End"), "End");
  assert.equal(mapCodeToTauriToken("PageUp"), "PageUp");
  assert.equal(mapCodeToTauriToken("PageDown"), "PageDown");
  assert.equal(mapCodeToTauriToken("Insert"), "Insert");
  assert.equal(mapCodeToTauriToken("Delete"), "Delete");

  // Numpad
  assert.equal(mapCodeToTauriToken("Numpad0"), "Numpad0");
  assert.equal(mapCodeToTauriToken("Numpad7"), "Numpad7");
});

test("mapCodeToTauriToken ignores standalone modifiers and invalid codes", () => {
  assert.equal(mapCodeToTauriToken("ControlLeft"), null);
  assert.equal(mapCodeToTauriToken("ControlRight"), null);
  assert.equal(mapCodeToTauriToken("ShiftLeft"), null);
  assert.equal(mapCodeToTauriToken("ShiftRight"), null);
  assert.equal(mapCodeToTauriToken("AltLeft"), null);
  assert.equal(mapCodeToTauriToken("AltRight"), null);
  assert.equal(mapCodeToTauriToken("MetaLeft"), null);
  assert.equal(mapCodeToTauriToken("OSLeft"), null);
  assert.equal(mapCodeToTauriToken("UnknownCode123"), null);
});

test("validateShortcutUi accepts valid desktop shortcuts", () => {
  // Alt+K
  assert.equal(validateShortcutUi(false, true, false, false, "K"), null);
  // Ctrl+Shift+D
  assert.equal(validateShortcutUi(true, false, true, false, "D"), null);
  // Super+K
  assert.equal(validateShortcutUi(false, false, false, true, "K"), null);
  // Ctrl+F5
  assert.equal(validateShortcutUi(true, false, false, false, "F5"), null);
  // Alt+Space
  assert.equal(validateShortcutUi(false, true, false, false, "Space"), null);
});

test("validateShortcutUi rejects shortcuts lacking Ctrl/Alt/Win modifiers", () => {
  // Pure key (no modifiers)
  const noMod = validateShortcutUi(false, false, false, false, "K");
  assert.ok(noMod && noMod.includes("Ctrl, Alt hoặc Win"));

  // Shift only (not allowed for global shortcuts)
  const shiftOnly = validateShortcutUi(false, false, true, false, "K");
  assert.ok(shiftOnly && shiftOnly.includes("Ctrl, Alt hoặc Win"));
});

test("validateShortcutUi rejects Ctrl+Alt+<char|digit> to avoid AltGr/Vietnamese IME conflict", () => {
  const ctrlAltLetter = validateShortcutUi(true, true, false, false, "A");
  assert.ok(ctrlAltLetter && ctrlAltLetter.includes("AltGr"));

  const ctrlAltDigit = validateShortcutUi(true, true, false, false, "1");
  assert.ok(ctrlAltDigit && ctrlAltDigit.includes("AltGr"));

  // But function key with Ctrl+Alt is allowed
  assert.equal(validateShortcutUi(true, true, false, false, "F5"), null);
});

test("validateShortcutUi rejects critical system shortcut denylist", () => {
  const denylistCases = [
    { ctrl: true, alt: false, shift: false, meta: false, key: "C" }, // Ctrl+C
    { ctrl: true, alt: false, shift: false, meta: false, key: "V" }, // Ctrl+V
    { ctrl: true, alt: false, shift: false, meta: false, key: "X" }, // Ctrl+X
    { ctrl: true, alt: false, shift: false, meta: false, key: "Z" }, // Ctrl+Z
    { ctrl: true, alt: false, shift: false, meta: false, key: "A" }, // Ctrl+A
    { ctrl: true, alt: false, shift: false, meta: false, key: "S" }, // Ctrl+S
    { ctrl: true, alt: false, shift: false, meta: false, key: "W" }, // Ctrl+W
    { ctrl: false, alt: true, shift: false, meta: false, key: "Tab" }, // Alt+Tab
    { ctrl: false, alt: true, shift: false, meta: false, key: "F4" }, // Alt+F4
    { ctrl: false, alt: true, shift: false, meta: false, key: "Escape" }, // Alt+Escape
    { ctrl: true, alt: false, shift: false, meta: false, key: "Escape" }, // Ctrl+Escape
    { ctrl: true, alt: false, shift: true, meta: false, key: "Escape" }, // Ctrl+Shift+Escape
    { ctrl: false, alt: false, shift: false, meta: true, key: "L" }, // Win+L
    { ctrl: false, alt: false, shift: false, meta: true, key: "D" }, // Win+D
  ];

  for (const tc of denylistCases) {
    const res = validateShortcutUi(tc.ctrl, tc.alt, tc.shift, tc.meta, tc.key);
    assert.ok(res !== null, `Expected rejection for combo with key ${tc.key}`);
    assert.ok(res?.includes("cấm"), `Message should explain that combo is forbidden`);
  }
});

test("getFriendlyErrorMessage translates all system error codes to Vietnamese", () => {
  assert.ok(getFriendlyErrorMessage("INVALID_SHORTCUT_FORMAT").includes("Định dạng"));
  assert.ok(getFriendlyErrorMessage("SHORTCUT_TOO_RISKY").includes("rủi ro"));
  assert.ok(getFriendlyErrorMessage("HOTKEY_ALREADY_REGISTERED").includes("ứng dụng khác chiếm"));
  assert.ok(getFriendlyErrorMessage("PERSIST_FAILED").includes("cơ sở dữ liệu"));
  assert.ok(getFriendlyErrorMessage("AUTOSTART_OS_FAILED").includes("Windows Registry"));
  assert.ok(getFriendlyErrorMessage("AUTOSTART_PERSIST_FAILED").includes("cơ sở dữ liệu"));
  assert.ok(getFriendlyErrorMessage("INTERNAL_LOCK_POISONED").includes("khóa"));
  assert.equal(getFriendlyErrorMessage("UNKNOWN_ERROR", "Custom fallback"), "Custom fallback");
});
