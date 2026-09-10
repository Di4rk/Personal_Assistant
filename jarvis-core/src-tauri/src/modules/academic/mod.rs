pub mod drl_ingestion;
pub mod moodle_parser;
pub mod parser;

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
