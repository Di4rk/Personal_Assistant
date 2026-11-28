import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { VaultGraphDto } from "../src/features/vault/types.ts";
import {
  buildDisplayGraph,
  FOLDER_NODE_FOLDER,
  isVirtualGraphNode,
  TAG_NODE_FOLDER,
} from "../src/features/vault/utils/vaultGraphTransform.ts";

const BASE_GRAPH: VaultGraphDto = {
  nodes: [
    { id: "a.md", title: "Note A", folder: "IT005/Week1", linkCount: 1, isUnresolved: false },
    { id: "b.md", title: "Note B", folder: "IT005/Week1", linkCount: 1, isUnresolved: false },
    { id: "c.md", title: "Orphan Note", folder: "notes", linkCount: 0, isUnresolved: false },
    { id: "missing", title: "Missing", folder: "notes", linkCount: 0, isUnresolved: true },
  ],
  edges: [{ source: "a.md", target: "b.md" }],
};

describe("buildDisplayGraph", () => {
  it("adds #tag virtual hubs, edges, and updates linkCount when showTagNodes is true", () => {
    const tags = new Map<string, readonly string[]>([
      ["a.md", ["#UIT", "Network"]],
      ["b.md", ["uit"]],
    ]);

    const res = buildDisplayGraph(BASE_GRAPH, tags, {
      showOrphans: true,
      showTagNodes: true,
      groupByFolder: false,
      searchQuery: "",
    });

    const uitTag = res.nodes.find((n) => n.id === "tag:uit");
    assert.ok(uitTag);
    assert.equal(uitTag.folder, TAG_NODE_FOLDER);
    assert.equal(uitTag.title, "#uit");
    assert.equal(uitTag.linkCount, 2);
    assert.equal(isVirtualGraphNode(uitTag), true);

    const netTag = res.nodes.find((n) => n.id === "tag:network");
    assert.ok(netTag);
    assert.equal(netTag.linkCount, 1);
    assert.equal(res.edges.length, 4);
  });

  it("adds folder virtual hubs connecting notes in the same folder", () => {
    const res = buildDisplayGraph(BASE_GRAPH, new Map(), {
      showOrphans: true,
      showTagNodes: false,
      groupByFolder: true,
      searchQuery: "",
    });

    const weekHub = res.nodes.find((n) => n.id === "folder:IT005/Week1");
    assert.ok(weekHub);
    assert.equal(weekHub.folder, FOLDER_NODE_FOLDER);
    assert.equal(weekHub.title, "Week1");
    assert.equal(weekHub.linkCount, 2);
    assert.equal(isVirtualGraphNode(weekHub), true);

    const notesHub = res.nodes.find((n) => n.id === "folder:notes");
    assert.ok(notesHub);
    assert.equal(notesHub.title, "Chung");
    assert.equal(notesHub.linkCount, 1);
  });

  it("hides 0-degree nodes when showOrphans is false while preserving keepNodeId", () => {
    const res = buildDisplayGraph(BASE_GRAPH, new Map(), {
      showOrphans: false,
      showTagNodes: false,
      groupByFolder: false,
      searchQuery: "",
      keepNodeId: "c.md",
    });

    assert.deepEqual(
      res.nodes.map((n) => n.id).sort(),
      ["a.md", "b.md", "c.md"],
    );
  });

  it("filters by searchQuery while retaining direct 1-hop neighbors", () => {
    const res = buildDisplayGraph(BASE_GRAPH, new Map(), {
      showOrphans: true,
      showTagNodes: false,
      groupByFolder: false,
      searchQuery: "Note A",
    });

    assert.deepEqual(
      res.nodes.map((n) => n.id).sort(),
      ["a.md", "b.md"],
    );
    assert.equal(res.edges.length, 1);
  });
});
