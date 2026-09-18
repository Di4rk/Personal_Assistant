pub mod onenote_guard;
pub mod scaffolder;
pub mod scanner;

pub use onenote_guard::validate_onenote_uri;
pub use scaffolder::{
    find_course_folder, sanitize_folder_name, scaffold_semester_courses, ScaffoldResultDto,
};
pub use scanner::{
    build_safe_fts5_query, extract_frontmatter_and_content, extract_wikilinks,
    resolve_unresolved_links, scan_and_sync_vault, VaultNoteParsed, VaultStatsDto,
};
