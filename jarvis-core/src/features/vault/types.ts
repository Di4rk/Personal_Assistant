/**
 * TypeScript definitions for Native Vault Core (Module 5).
 * Matches Rust DTOs in `src-tauri/src/commands/vault.rs` and `src-tauri/src/modules/vault/scanner.rs`.
 */

export interface VaultRecentNote {
  id: string;
  title: string;
  updatedAt: number;
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
