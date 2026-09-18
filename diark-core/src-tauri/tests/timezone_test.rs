use rusqlite::Connection;

#[test]
fn test_unixepoch_ict_conversion() {
    let conn = Connection::open_in_memory().expect("in-memory connection should succeed");
    // 1710000000 = Sun Mar 09 2024 16:00:00 UTC -> 23:00:00 ICT (Cùng ngày 2024-03-09)
    // 1710005000 = Sun Mar 09 2024 17:23:20 UTC -> 00:23:20 ICT ngày hôm sau (2024-03-10)
    let res: String = conn
        .query_row(
            "SELECT date(datetime(1710005000, 'unixepoch', '+7 hours'))",
            [],
            |r| r.get(0),
        )
        .expect("timezone query should succeed");
    assert_eq!(res, "2024-03-10");

    let res_same_day: String = conn
        .query_row(
            "SELECT date(datetime(1710000000, 'unixepoch', '+7 hours'))",
            [],
            |r| r.get(0),
        )
        .expect("timezone query should succeed");
    assert_eq!(res_same_day, "2024-03-09");
}
