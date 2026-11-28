import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { VaultNoteSummaryDto } from "../src/features/vault/types.ts";
import { buildVaultTree, getAncestorFolderPaths } from "../src/features/vault/utils/vaultTree.ts";

function makeNote(id: string, title?: string): VaultNoteSummaryDto {
  const parts = id.split("/");
  const fallbackTitle = parts[parts.length - 1]?.replace(/\.md$/i, "") ?? id;
  const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "root";
  return {
    id,
    title: title ?? fallbackTitle,
    folder,
    tags: [],
    noteType: "academic",
    updatedAt: 1700000000,
    externalUri: `file:///vault/${id}`,
  };
}

describe("buildVaultTree", () => {
  it("groups nested notes into folder hierarchy and counts descendants", () => {
    const tree = buildVaultTree([
      makeNote("01_DaiHoc_UIT/2025-2026_HK2/IT005/00_IT005_Index.md", "00_IT005_Index"),
      makeNote("01_DaiHoc_UIT/2025-2026_HK2/IT007/00_IT007_Index.md", "00_IT007_Index"),
      makeNote("README.md", "README"),
    ]);

    assert.equal(tree.length, 2);
    assert.equal(tree[0].kind, "folder");
    assert.equal(tree[1].kind, "file");

    if (tree[0].kind === "folder") {
      assert.equal(tree[0].name, "01_DaiHoc_UIT");
      assert.equal(tree[0].path, "01_DaiHoc_UIT");
      assert.equal(tree[0].noteCount, 2);
      assert.equal(tree[0].children.length, 1);

      const hk2 = tree[0].children[0];
      assert.equal(hk2.kind, "folder");
      if (hk2.kind === "folder") {
        assert.equal(hk2.path, "01_DaiHoc_UIT/2025-2026_HK2");
        assert.equal(hk2.noteCount, 2);
        assert.equal(hk2.children.length, 2);
      }
    }
  });

  it("places folders before files and sorts both naturally", () => {
    const tree = buildVaultTree([
      makeNote("z-root.md", "Z Note"),
      makeNote("a-root.md", "A Note"),
      makeNote("B_Folder/file2.md", "File 2"),
      makeNote("A_Folder/file1.md", "File 1"),
    ]);

    assert.deepEqual(
      tree.map((node) => `${node.kind}:${node.name}`),
      ["folder:A_Folder", "folder:B_Folder", "file:A Note", "file:Z Note"],
    );
  });

  it("normalizes Windows backslashes when building tree paths", () => {
    const tree = buildVaultTree([makeNote("03_GhiChep\\algo\\dp.md", "Quy hoach dong")]);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].kind, "folder");
    if (tree[0].kind === "folder") {
      assert.equal(tree[0].path, "03_GhiChep");
      const sub = tree[0].children[0];
      assert.equal(sub.kind, "folder");
      if (sub.kind === "folder") {
        assert.equal(sub.path, "03_GhiChep/algo");
        assert.equal(sub.children[0].kind, "file");
      }
    }
  });
});

describe("getAncestorFolderPaths", () => {
  it("returns ordered ancestor folder paths for nested note ids", () => {
    assert.deepEqual(
      getAncestorFolderPaths("01_DaiHoc_UIT/2025-2026_HK2/IT005/00_IT005_Index.md"),
      [
        "01_DaiHoc_UIT",
        "01_DaiHoc_UIT/2025-2026_HK2",
        "01_DaiHoc_UIT/2025-2026_HK2/IT005",
      ],
    );
  });

  it("returns empty array for root notes or null/empty ids", () => {
    assert.deepEqual(getAncestorFolderPaths("README.md"), []);
    assert.deepEqual(getAncestorFolderPaths(null), []);
    assert.deepEqual(getAncestorFolderPaths(""), []);
  });
});
