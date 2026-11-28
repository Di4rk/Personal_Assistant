import type { VaultGraphDto, VaultGraphEdgeDto, VaultGraphNodeDto } from "../types";

export const TAG_NODE_FOLDER = "__tag__";
export const FOLDER_NODE_FOLDER = "__folder__";

export interface VaultGraphFilterOptions {
  showOrphans: boolean;
  showTagNodes: boolean;
  groupByFolder: boolean;
  searchQuery: string;
  keepNodeId?: string | null;
}

export function isVirtualGraphNode(node: VaultGraphNodeDto): boolean {
  return node.folder === TAG_NODE_FOLDER || node.folder === FOLDER_NODE_FOLDER;
}

function formatFolderHubTitle(folderKey: string): string {
  if (folderKey === "root" || folderKey === "notes" || folderKey.trim() === "") {
    return "Chung";
  }
  const segments = folderKey.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? folderKey;
}

function recomputeLinkCounts(
  nodes: VaultGraphNodeDto[],
  edges: readonly VaultGraphEdgeDto[],
): VaultGraphNodeDto[] {
  const degreeById = new Map<string, number>();
  for (const edge of edges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + 1);
  }
  return nodes.map((node) => ({
    ...node,
    linkCount: degreeById.get(node.id) ?? 0,
  }));
}

/**
 * Transform a base vault graph with optional virtual tag/folder cluster hubs,
 * search filtering (including 1-hop neighbors), and orphan visibility filtering.
 */
export function buildDisplayGraph(
  graph: VaultGraphDto,
  noteTagsById: ReadonlyMap<string, readonly string[]>,
  options: VaultGraphFilterOptions,
): VaultGraphDto {
  const nodeMap = new Map<string, VaultGraphNodeDto>();
  for (const node of graph.nodes) {
    nodeMap.set(node.id, { ...node });
  }

  const edges: VaultGraphEdgeDto[] = graph.edges.map((e) => ({ ...e }));

  if (options.showTagNodes) {
    for (const node of graph.nodes) {
      if (node.isUnresolved) continue;
      const rawTags = noteTagsById.get(node.id) ?? [];
      const seenTagsForNote = new Set<string>();

      for (const rawTag of rawTags) {
        const normalized = rawTag.trim().replace(/^#/, "").toLowerCase();
        if (!normalized || seenTagsForNote.has(normalized)) continue;
        seenTagsForNote.add(normalized);

        const tagId = `tag:${normalized}`;
        if (!nodeMap.has(tagId)) {
          nodeMap.set(tagId, {
            id: tagId,
            title: `#${normalized}`,
            folder: TAG_NODE_FOLDER,
            linkCount: 0,
            isUnresolved: false,
          });
        }
        edges.push({ source: node.id, target: tagId });
      }
    }
  }

  if (options.groupByFolder) {
    for (const node of graph.nodes) {
      if (node.isUnresolved) continue;
      const folderKey = node.folder || "root";
      const folderId = `folder:${folderKey}`;
      if (!nodeMap.has(folderId)) {
        nodeMap.set(folderId, {
          id: folderId,
          title: formatFolderHubTitle(folderKey),
          folder: FOLDER_NODE_FOLDER,
          linkCount: 0,
          isUnresolved: false,
        });
      }
      edges.push({ source: node.id, target: folderId });
    }
  }

  let nodes = recomputeLinkCounts(Array.from(nodeMap.values()), edges);
  let activeEdges = edges;

  const trimmedQuery = options.searchQuery.trim().toLowerCase();
  if (trimmedQuery) {
    const matchedIds = new Set<string>();
    for (const node of nodes) {
      if (
        node.title.toLowerCase().includes(trimmedQuery) ||
        node.folder.toLowerCase().includes(trimmedQuery)
      ) {
        matchedIds.add(node.id);
      }
    }

    const keptIds = new Set<string>(matchedIds);
    for (const edge of activeEdges) {
      if (matchedIds.has(edge.source)) keptIds.add(edge.target);
      if (matchedIds.has(edge.target)) keptIds.add(edge.source);
    }

    activeEdges = activeEdges.filter(
      (edge) => keptIds.has(edge.source) && keptIds.has(edge.target),
    );
    nodes = recomputeLinkCounts(
      nodes.filter((node) => keptIds.has(node.id)),
      activeEdges,
    );
  }

  if (!options.showOrphans) {
    const visibleIds = new Set<string>();
    for (const node of nodes) {
      if (node.linkCount > 0 || (options.keepNodeId && node.id === options.keepNodeId)) {
        visibleIds.add(node.id);
      }
    }
    activeEdges = activeEdges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );
    nodes = recomputeLinkCounts(
      nodes.filter((node) => visibleIds.has(node.id)),
      activeEdges,
    );
  }

  return { nodes, edges: activeEdges };
}
