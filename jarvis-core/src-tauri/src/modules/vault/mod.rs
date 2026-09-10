pub mod scanner;

pub use scanner::{
    build_safe_fts5_query, extract_frontmatter_and_content, extract_wikilinks,
    resolve_unresolved_links, scan_and_sync_vault, VaultNoteParsed, VaultStatsDto,
};
