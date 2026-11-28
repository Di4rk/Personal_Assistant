import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VAULT_SHORTCUTS,
  canonicalizeShortcutString,
  matchesShortcut,
  normalizeShortcutFromEvent,
} from "../src/features/vault/utils/vaultShortcuts.ts";
import { VAULT_TEMPLATES, formatTodayShort } from "../src/features/vault/utils/vaultTemplates.ts";

describe("vaultShortcuts", () => {
  it("ignores standalone modifier keys and normalizes key combos", () => {
    assert.equal(
      normalizeShortcutFromEvent({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: "Control",
        code: "ControlLeft",
      }),
      null
    );

    assert.equal(
      normalizeShortcutFromEvent({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        key: "G",
        code: "KeyG",
      }),
      "Ctrl+Shift+G"
    );

    assert.equal(
      normalizeShortcutFromEvent({
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        key: "F2",
        code: "F2",
      }),
      "F2"
    );
  });

  it("matches shortcuts case-insensitively and treats metaKey as Ctrl", () => {
    assert.equal(canonicalizeShortcutString(" ctrl + shift + t "), "Ctrl+Shift+T");
    assert.equal(
      matchesShortcut(
        {
          ctrlKey: false,
          metaKey: true,
          altKey: false,
          shiftKey: false,
          key: "s",
          code: "KeyS",
        },
        DEFAULT_VAULT_SHORTCUTS.saveNote
      ),
      true
    );
    assert.equal(
      matchesShortcut(
        {
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: true,
          key: "S",
          code: "KeyS",
        },
        DEFAULT_VAULT_SHORTCUTS.saveNote
      ),
      false
    );
  });
});

describe("vaultTemplates", () => {
  it("provides all UIT study and report templates with valid default folders and markdown bodies", () => {
    const today = formatTodayShort(new Date("2026-11-28T08:00:00Z"));
    assert.equal(today, "28/11");
    assert.equal(VAULT_TEMPLATES.length, 9);

    const ids = new Set(VAULT_TEMPLATES.map((t) => t.id));
    for (const expected of [
      "blank",
      "lecture",
      "code",
      "teamwork",
      "exam",
      "lab",
      "course-project",
      "thesis",
      "internship",
    ]) {
      assert.equal(ids.has(expected), true);
    }

    assert.ok(VAULT_TEMPLATES.some((t) => t.category === "study"));
    assert.ok(VAULT_TEMPLATES.some((t) => t.category === "report"));

    for (const tpl of VAULT_TEMPLATES) {
      if (tpl.id === "blank") continue;
      assert.ok(tpl.buildTitle(today).length > 0);
      assert.ok(tpl.buildContent(today).includes("# "));
      assert.ok(tpl.defaultFolder.length > 0);
    }
  });
});
