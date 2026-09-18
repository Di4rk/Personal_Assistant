use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Local, TimeZone, Utc};
use reqwest::Client;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::Database;

const CODEFORCES_API: &str = "https://codeforces.com/api/user.status";
const XP_PER_FIRST_AC: i64 = 20;

#[derive(Debug, Serialize, Deserialize)]
pub struct CodeforcesResponse {
    pub status: String,
    pub result: Option<Vec<CodeforcesSubmission>>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodeforcesSubmission {
    pub id: i64,

    #[serde(rename = "contestId")]
    pub contest_id: Option<i64>,

    pub problem: Problem,

    pub verdict: Option<String>,

    #[serde(rename = "programmingLanguage")]
    pub programming_language: Option<String>,

    #[serde(rename = "creationTimeSeconds")]
    pub creation_time_seconds: i64,

    pub author: Author,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Problem {
    pub index: String,

    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Author {
    pub members: Vec<Member>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Member {
    pub handle: String,
}

#[derive(Debug, Serialize)]
pub struct SubmissionDto {
    pub submission_id: i64,
    pub handle: String,

    pub contest_id: Option<i64>,
    pub problem_index: String,
    pub problem_name: String,

    pub verdict: String,
    pub programming_language: String,

    pub submitted_at: String,
}

#[derive(Debug, Serialize)]
pub struct SyncResult {
    pub handle: String,

    pub fetched: usize,
    pub inserted: usize,

    pub new_ac: usize,
    pub xp_earned: i64,

    pub today_xp: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum CodeforcesError {
    #[error("Invalid Codeforces handle")]
    InvalidHandle,

    #[error("Network error: {0}")]
    Network(String),

    #[error("Codeforces API error: {0}")]
    Api(String),

    #[error("Invalid API response")]
    InvalidResponse,

    #[error("Database error: {0}")]
    Database(String),
}

impl From<rusqlite::Error> for CodeforcesError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value.to_string())
    }
}

pub async fn sync_submissions(
    db: Arc<Database>,
    handle: String,
) -> Result<SyncResult, CodeforcesError> {
    let handle = handle.trim().to_string();

    if handle.is_empty() {
        return Err(CodeforcesError::InvalidHandle);
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("DIARK-Personal-OS/0.1")
        .build()
        .map_err(|e| CodeforcesError::Network(e.to_string()))?;

    let response = client
        .get(CODEFORCES_API)
        .query(&[
            ("handle", handle.as_str()),
            ("from", "1"),
            ("count", "10"),
        ])
        .send()
        .await
        .map_err(|e| CodeforcesError::Network(e.to_string()))?;

    if !response.status().is_success() {
        return Err(CodeforcesError::Network(format!(
            "HTTP status {}",
            response.status()
        )));
    }

    let data: CodeforcesResponse = response
        .json()
        .await
        .map_err(|e| CodeforcesError::InvalidResponse)?;

    if data.status != "OK" {
        return Err(CodeforcesError::Api(
            data.comment
                .unwrap_or_else(|| "Unknown Codeforces API error".to_string()),
        ));
    }

    let mut submissions = data
        .result
        .ok_or(CodeforcesError::InvalidResponse)?;

    // API trả submission mới nhất trước.
    // Ta xử lý cũ -> mới để First AC được xác định đúng.
    submissions.sort_by_key(|submission| submission.creation_time_seconds);

    let mut inserted = 0usize;
    let mut new_ac = 0usize;
    let mut xp_earned = 0i64;

    {
        let conn = db
            .conn
            .lock()
            .map_err(|_| CodeforcesError::Database("Database lock poisoned".into()))?;

        for submission in &submissions {
            let already_exists: bool = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM submissions
                    WHERE submission_id = ?1
                )",
                params![submission.id],
                |row| row.get(0),
            )?;

            if already_exists {
                continue;
            }

            let verdict = submission
                .verdict
                .clone()
                .unwrap_or_else(|| "UNKNOWN".to_string());

            let language = submission
                .programming_language
                .clone()
                .unwrap_or_else(|| "Unknown".to_string());

            let submitted_at =
                Utc.timestamp_opt(submission.creation_time_seconds, 0)
                    .single()
                    .ok_or(CodeforcesError::InvalidResponse)?;

            /*
             * Chỉ thưởng XP nếu:
             *
             * 1. Submission mới.
             * 2. Verdict = OK.
             * 3. Trước đó chưa có OK cho cùng problem.
             */
            let is_first_ac = verdict == "OK"
                && !has_previous_ac(
                    &conn,
                    &handle,
                    submission.contest_id,
                    &submission.problem.index,
                )?;

            conn.execute(
                r#"
                INSERT INTO submissions (
                    submission_id,
                    handle,
                    contest_id,
                    problem_index,
                    problem_name,
                    verdict,
                    programming_language,
                    submitted_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    submission.id,
                    handle,
                    submission.contest_id,
                    submission.problem.index,
                    submission.problem.name,
                    verdict,
                    language,
                    submission.creation_time_seconds
                ],
            )?;

            inserted += 1;

            if is_first_ac {
                let activity_date = submitted_at
                    .with_timezone(&Local)
                    .date_naive()
                    .to_string();

                conn.execute(
                    r#"
                    INSERT INTO daily_activity (
                        activity_date,
                        xp,
                        ac_count
                    )
                    VALUES (?1, ?2, 1)

                    ON CONFLICT(activity_date)
                    DO UPDATE SET
                        xp = xp + excluded.xp,
                        ac_count = ac_count + 1,
                        updated_at = CURRENT_TIMESTAMP
                    "#,
                    params![
                        activity_date,
                        XP_PER_FIRST_AC
                    ],
                )?;

                new_ac += 1;
                xp_earned += XP_PER_FIRST_AC;
            }
        }
    }

    let today_xp = get_today_xp(db)?;

    Ok(SyncResult {
        handle,
        fetched: submissions.len(),
        inserted,
        new_ac,
        xp_earned,
        today_xp,
    })
}

fn has_previous_ac(
    conn: &rusqlite::Connection,
    handle: &str,
    contest_id: Option<i64>,
    problem_index: &str,
) -> Result<bool, rusqlite::Error> {
    let exists = match contest_id {
        Some(contest_id) => conn.query_row(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM submissions
                WHERE handle = ?1
                  AND contest_id = ?2
                  AND problem_index = ?3
                  AND verdict = 'OK'
            )
            "#,
            params![
                handle,
                contest_id,
                problem_index
            ],
            |row| row.get(0),
        )?,

        None => conn.query_row(
            r#"
            SELECT EXISTS(
                SELECT 1
                FROM submissions
                WHERE handle = ?1
                  AND contest_id IS NULL
                  AND problem_index = ?2
                  AND verdict = 'OK'
            )
            "#,
            params![
                handle,
                problem_index
            ],
            |row| row.get(0),
        )?,
    };

    Ok(exists)
}

pub fn get_today_xp(db: Arc<Database>) -> Result<i64, CodeforcesError> {
    let today = Local::now().date_naive().to_string();

    let conn = db
        .conn
        .lock()
        .map_err(|_| CodeforcesError::Database("Database lock poisoned".into()))?;

    let xp: Option<i64> = conn
        .query_row(
            r#"
            SELECT xp
            FROM daily_activity
            WHERE activity_date = ?1
            "#,
            params![today],
            |row| row.get(0),
        )
        .optional()?;

    Ok(xp.unwrap_or(0))
}

pub fn get_today_stats(
    db: Arc<Database>,
) -> Result<TodayStats, CodeforcesError> {
    let today = Local::now().date_naive().to_string();

    let conn = db
        .conn
        .lock()
        .map_err(|_| CodeforcesError::Database("Database lock poisoned".into()))?;

    let stats = conn
        .query_row(
            r#"
            SELECT
                xp,
                ac_count
            FROM daily_activity
            WHERE activity_date = ?1
            "#,
            params![today],
            |row| {
                Ok(TodayStats {
                    date: today.clone(),
                    xp: row.get(0)?,
                    ac_count: row.get(1)?,
                })
            },
        )
        .optional()?;

    Ok(stats.unwrap_or(TodayStats {
        date: today,
        xp: 0,
        ac_count: 0,
    }))
}

#[derive(Debug, Serialize)]
pub struct TodayStats {
    pub date: String,
    pub xp: i64,
    pub ac_count: i64,
}

pub fn get_recent_submissions(
    db: Arc<Database>,
) -> Result<Vec<SubmissionDto>, CodeforcesError> {
    let conn = db
        .conn
        .lock()
        .map_err(|_| CodeforcesError::Database("Database lock poisoned".into()))?;

    let mut stmt = conn.prepare(
        r#"
        SELECT
            submission_id,
            handle,
            contest_id,
            problem_index,
            problem_name,
            verdict,
            programming_language,
            submitted_at
        FROM submissions
        ORDER BY submitted_at DESC
        LIMIT 20
        "#,
    )?;

    let rows = stmt.query_map([], |row| {
        let timestamp: i64 = row.get(7)?;

        let submitted_at =
            Utc.timestamp_opt(timestamp, 0)
                .single()
                .map(|dt: DateTime<Utc>| dt.to_rfc3339())
                .unwrap_or_else(|| timestamp.to_string());

        Ok(SubmissionDto {
            submission_id: row.get(0)?,
            handle: row.get(1)?,
            contest_id: row.get(2)?,
            problem_index: row.get(3)?,
            problem_name: row.get(4)?,
            verdict: row.get(5)?,
            programming_language: row.get(6)?,
            submitted_at,
        })
    })?;

    let mut submissions = Vec::new();

    for row in rows {
        submissions.push(row?);
    }

    Ok(submissions)
}