pub mod onenote_guard;
pub mod scanner;

pub use onenote_guard::validate_onenote_uri;
pub use scanner::{
    build_safe_fts5_query, extract_frontmatter_and_content, extract_wikilinks,
    resolve_unresolved_links, scan_and_sync_vault, VaultNoteParsed, VaultStatsDto,
};
