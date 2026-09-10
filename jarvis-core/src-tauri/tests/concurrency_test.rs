use std::sync::{Arc, Mutex};
use rusqlite::Connection;

#[test]
fn test_ingest_and_recompute_lock_cycle() {
    let conn = Connection::open_in_memory().expect("in-memory db must open");
    jarvis_core_lib::db::schema::create_tables(&conn).expect("create_tables must succeed");
    let db_arc = Arc::new(Mutex::new(conn));

    // Bước 1: Giả lập lock của transaction ghi
    {
        let conn_guard = db_arc.lock().expect("mutex lock must succeed");
        conn_guard
            .execute(
                "INSERT INTO cf_submissions (id, contest_id, problem_index, submission_time, verdict) 
                 VALUES (1, 1000, 'A', 1710000000, 'OK')",
                [],
            )
            .expect("insert submission must succeed");
    } // Guard phải drop tại đây để nhả lock hoàn toàn

    // Bước 2: Gọi recompute độc lập ngay sau đó
    let conn_guard = db_arc.lock().expect("mutex lock must succeed");
    let recompute_result = jarvis_core_lib::db::matrix::recompute_daily_matrix_for_date(
        &conn_guard,
        "2024-03-09",
    );
    assert!(recompute_result.is_ok(), "Recompute must succeed without deadlock");
}
