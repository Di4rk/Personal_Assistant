import type { VaultNoteSummaryDto } from "../types";

export interface VaultTreeFolderNode {
  kind: "folder";
  name: string;
  path: string;
  noteCount: number;
  children: VaultTreeNode[];
}

export interface VaultTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  note: VaultNoteSummaryDto;
}

export type VaultTreeNode = VaultTreeFolderNode | VaultTreeFileNode;

interface MutableFolderNode {
  name: string;
  path: string;
  noteCount: number;
  folders: Map<string, MutableFolderNode>;
  files: VaultTreeFileNode[];
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "vi", { numeric: true, sensitivity: "base" });
}

function finalizeFolder(folder: MutableFolderNode): VaultTreeFolderNode {
  const folderChildren = Array.from(folder.folders.values())
    .sort((a, b) => compareNames(a.name, b.name))
    .map(finalizeFolder);

  const fileChildren = [...folder.files].sort((a, b) => compareNames(a.name, b.name));

  return {
    kind: "folder",
    name: folder.name,
    path: folder.path,
    noteCount: folder.noteCount,
    children: [...folderChildren, ...fileChildren],
  };
}

function normalizeSegments(noteId: string): string[] {
  return noteId
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Build a hierarchical folder/file tree from flat vault note summaries.
 * Folders are ordered before files at each level using natural locale sorting.
 */
export function buildVaultTree(notes: readonly VaultNoteSummaryDto[]): VaultTreeNode[] {
  const root: MutableFolderNode = {
    name: "",
    path: "",
    noteCount: 0,
    folders: new Map(),
    files: [],
  };

  for (const note of notes) {
    const segments = normalizeSegments(note.id);
    const fileNameSegment = segments[segments.length - 1] ?? note.id;
    const displayName = note.title.trim() || fileNameSegment;
    const folderSegments = segments.length > 1 ? segments.slice(0, -1) : [];

    let cursor = root;
    cursor.noteCount += 1;

    let currentPath = "";
    for (const folderName of folderSegments) {
      currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;
      let child = cursor.folders.get(folderName);
      if (!child) {
        child = {
          name: folderName,
          path: currentPath,
          noteCount: 0,
          folders: new Map(),
          files: [],
        };
        cursor.folders.set(folderName, child);
      }
      child.noteCount += 1;
      cursor = child;
    }

    cursor.files.push({
      kind: "file",
      name: displayName,
      path: note.id,
      note,
    });
  }

  return finalizeFolder(root).children;
}

/**
 * Return all ancestor folder paths for a note id so active notes can auto-expand in the tree.
 */
export function getAncestorFolderPaths(noteId: string | null | undefined): string[] {
  if (!noteId) return [];
  const segments = normalizeSegments(noteId);
  if (segments.length <= 1) return [];

  const ancestors: string[] = [];
  let currentPath = "";
  for (let i = 0; i < segments.length - 1; i += 1) {
    currentPath = currentPath ? `${currentPath}/${segments[i]}` : segments[i];
    ancestors.push(currentPath);
  }
  return ancestors;
}

function collectFolderSubtreePaths(folder: VaultTreeFolderNode, out: string[]): void {
  out.push(folder.path);
  for (const child of folder.children) {
    if (child.kind === "folder") {
      collectFolderSubtreePaths(child, out);
    }
  }
}

function findFolderNode(
  nodes: readonly VaultTreeNode[],
  targetPath: string,
): VaultTreeFolderNode | null {
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    if (node.path === targetPath) return node;
    if (targetPath.startsWith(`${node.path}/`)) {
      const nested = findFolderNode(node.children, targetPath);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Return targetPath followed by all descendant subfolder paths in its subtree.
 */
export function getDescendantFolderPaths(
  nodes: readonly VaultTreeNode[],
  targetPath: string,
): string[] {
  const folder = findFolderNode(nodes, targetPath);
  if (!folder) return [];
  const paths: string[] = [];
  collectFolderSubtreePaths(folder, paths);
  return paths;
}
