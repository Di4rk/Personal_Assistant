pub mod curriculum_resolver;
pub mod degree_audit;
pub mod drl_ingestion;
pub mod moodle_parser;
pub mod parser;
pub mod portal_ingestion;
pub mod sync_server;
pub mod validation;

#[cfg(test)]
pub mod tests;

pub mod calc {
    pub use crate::db::academic::GradeScale;
}

pub mod models {
    pub use crate::db::academic::SemesterOverview as AcademicOverviewDto;
}

pub mod db {
    pub use crate::db::academic::get_all_semesters_with_stats as calculate_academic_overview;
}
