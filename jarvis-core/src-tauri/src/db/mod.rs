pub mod academic;
pub mod matrix;
pub mod post_mortem;
pub mod schema;
pub mod settings;
pub mod submissions;
pub mod vault_schema;

pub use matrix::{query_life_matrix_range, recompute_daily_matrix_for_date, LifeMatrixEntryDto};

pub use academic::{
    ensure_academic_schema, init_academic_module, get_all_curriculum_courses, get_all_macro_metrics,
    get_all_semesters_with_stats, get_courses_by_semester, persist_portal_sync,
    persist_unified_academic_sync, upsert_courses, upsert_semester, AcademicCourseRecord,
    SemesterOverview, UpsertCourseDto, UpsertSemesterDto,
};
pub use post_mortem::{
    delete_post_mortem, get_post_mortem_by_problem, search_post_mortems, upsert_post_mortem,
    PostMortemInput, PostMortemRecord, SearchResultItem,
};
pub use schema::{apply_legacy_compatibility_migrations, create_tables, init_db, insert_submission_and_update_daily, purge_mock_submissions, SharedDb};
pub use settings::{get_setting, set_setting};
pub use submissions::{
    batch_insert_new_submissions, ingest_cf_submissions, ingest_cf_submissions_with_result,
    NewSubmission, SyncResult,
};
