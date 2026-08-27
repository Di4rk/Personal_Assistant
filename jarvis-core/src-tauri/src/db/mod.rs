pub mod schema;

#[cfg(debug_assertions)]
pub mod mock;

pub use schema::{init_db, insert_submission_and_update_daily, SharedDb};

#[cfg(debug_assertions)]
pub use mock::{clear_mock_data, seed_mock_data};
