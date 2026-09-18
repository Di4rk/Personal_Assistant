/**
 * TypeScript definitions for Native Vault Core (Module 5).
 * Matches Rust DTOs in `src-tauri/src/commands/vault.rs` and `src-tauri/src/modules/vault/scanner.rs`.
 */

// Khớp chính xác với default value bên SQLite schema
export type NoteType = 'GENERAL' | 'ALGO_TRICK' | 'ACADEMIC_SUMMARY' | 'TEACHING_SHEET' | 'ONENOTE_LINK';

export interface CreateStructuredNoteDto {
  title: string;
  noteType: NoteType;
  tags: string[];
  prose: string;
  codeSnippet?: string;
  externalUri?: string;
  vaultPath?: string;
}

export interface VaultRecentNote {
  id: string;
  title: string;
  updatedAt: number;
  noteType?: NoteType;
  externalUri?: string;
}

export interface VaultStatsDto {
  totalNotes: number;
  totalLinks: number;
  totalTags: number;
  recentNotes: VaultRecentNote[];
}

export interface VaultSearchResultDto {
  id: string;
  title: string;
  snippet: string;
}

export interface ScaffoldResultDto {
  createdFolders: number;
  createdNotes: number;
  skippedNotes: number;
  semesterFolder: string;
}
