//! Academic Task Engine & Active Horizon Classifier
//!
//! Provides classification logic for academic assignments and quests,
//! preventing "zombie deadlines" (old assignments from past years) from
//! polluting urgent dashboards.

use serde::{Deserialize, Serialize};

/// Categorical urgency status for an academic task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskUrgencyStatus {
    /// Due within the next 24 hours (due >= now && due <= now + 86400)
    Urgent,
    /// Overdue within the last 30 days (due < now && due >= now - 30*86400)
    RecentlyOverdue,
    /// Overdue more than 30 days ago (due < now - 30*86400) - Stale Zombie!
    StaleZombie,
    /// Due between 1 and 7 days from now
    Upcoming,
    /// Due more than 7 days in the future
    Future,
    /// No strict deadline or open-ended practice (due <= 0)
    OpenEnded,
}

/// Detailed classification flags for an academic task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskUrgencyClassification {
    pub is_urgent: bool,
    pub is_recently_overdue: bool,
    pub is_stale_zombie: bool,
    pub is_open_ended: bool,
    pub status: TaskUrgencyStatus,
}

const SECONDS_PER_DAY: i64 = 86_400;
const ZOMBIE_THRESHOLD_DAYS: i64 = 30;
const ZOMBIE_THRESHOLD_SECONDS: i64 = ZOMBIE_THRESHOLD_DAYS * SECONDS_PER_DAY;

/// Classifies a task based on its unix timestamp `due_date` and current reference unix timestamp `now`.
///
/// Rules:
/// - `due_date <= 0`: Open-ended practice.
/// - `due_date < now - 30 * 86400`: Stale Zombie (should be archived, never urgent).
/// - `due_date < now`: Recently Overdue (within 30 days).
/// - `due_date <= now + 86400`: Urgent (due within 24h).
/// - `due_date <= now + 7 * 86400`: Upcoming (due in 2 to 7 days).
/// - `due_date > now + 7 * 86400`: Future.
pub fn classify_task_urgency(due_date: i64, now: i64) -> TaskUrgencyClassification {
    if due_date <= 0 {
        return TaskUrgencyClassification {
            is_urgent: false,
            is_recently_overdue: false,
            is_stale_zombie: false,
            is_open_ended: true,
            status: TaskUrgencyStatus::OpenEnded,
        };
    }

    let diff = due_date - now;

    if diff < -ZOMBIE_THRESHOLD_SECONDS {
        TaskUrgencyClassification {
            is_urgent: false,
            is_recently_overdue: false,
            is_stale_zombie: true,
            is_open_ended: false,
            status: TaskUrgencyStatus::StaleZombie,
        }
    } else if diff < 0 {
        TaskUrgencyClassification {
            is_urgent: false,
            is_recently_overdue: true,
            is_stale_zombie: false,
            is_open_ended: false,
            status: TaskUrgencyStatus::RecentlyOverdue,
        }
    } else if diff <= SECONDS_PER_DAY {
        TaskUrgencyClassification {
            is_urgent: true,
            is_recently_overdue: false,
            is_stale_zombie: false,
            is_open_ended: false,
            status: TaskUrgencyStatus::Urgent,
        }
    } else if diff <= 7 * SECONDS_PER_DAY {
        TaskUrgencyClassification {
            is_urgent: false,
            is_recently_overdue: false,
            is_stale_zombie: false,
            is_open_ended: false,
            status: TaskUrgencyStatus::Upcoming,
        }
    } else {
        TaskUrgencyClassification {
            is_urgent: false,
            is_recently_overdue: false,
            is_stale_zombie: false,
            is_open_ended: false,
            status: TaskUrgencyStatus::Future,
        }
    }
}

/// Helper to determine if a task should be listed in the Critical / Urgent dashboard block.
///
/// Only urgent (<24h) or recently overdue (<30d) tasks that are not yet submitted qualify.
pub fn should_render_in_critical_block(due_date: i64, now: i64, is_submitted: bool) -> bool {
    if is_submitted {
        return false;
    }
    let classification = classify_task_urgency(due_date, now);
    classification.is_urgent || classification.is_recently_overdue
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_open_ended_tasks() {
        let now = 1_700_000_000;
        let c0 = classify_task_urgency(0, now);
        assert_eq!(c0.status, TaskUrgencyStatus::OpenEnded);
        assert!(c0.is_open_ended);
        assert!(!c0.is_urgent);

        let c_neg = classify_task_urgency(-1, now);
        assert_eq!(c_neg.status, TaskUrgencyStatus::OpenEnded);
    }

    #[test]
    fn test_classify_urgent_tasks_under_24h() {
        let now = 1_700_000_000;

        // Due right now
        let c_now = classify_task_urgency(now, now);
        assert_eq!(c_now.status, TaskUrgencyStatus::Urgent);
        assert!(c_now.is_urgent);

        // Due in 23 hours
        let c_23h = classify_task_urgency(now + 23 * 3600, now);
        assert_eq!(c_23h.status, TaskUrgencyStatus::Urgent);
        assert!(c_23h.is_urgent);

        // Due in exactly 24 hours
        let c_24h = classify_task_urgency(now + 86400, now);
        assert_eq!(c_24h.status, TaskUrgencyStatus::Urgent);
        assert!(c_24h.is_urgent);

        // Due in 24 hours + 1 second -> Upcoming
        let c_24h_1s = classify_task_urgency(now + 86401, now);
        assert_eq!(c_24h_1s.status, TaskUrgencyStatus::Upcoming);
        assert!(!c_24h_1s.is_urgent);
    }

    #[test]
    fn test_classify_recently_overdue_tasks() {
        let now = 1_700_000_000;

        // Overdue 1 minute ago
        let c_1m = classify_task_urgency(now - 60, now);
        assert_eq!(c_1m.status, TaskUrgencyStatus::RecentlyOverdue);
        assert!(c_1m.is_recently_overdue);
        assert!(!c_1m.is_stale_zombie);

        // Overdue 29 days ago
        let c_29d = classify_task_urgency(now - 29 * 86400, now);
        assert_eq!(c_29d.status, TaskUrgencyStatus::RecentlyOverdue);
        assert!(c_29d.is_recently_overdue);
        assert!(!c_29d.is_stale_zombie);

        // Overdue exactly 30 days ago
        let c_30d = classify_task_urgency(now - 30 * 86400, now);
        assert_eq!(c_30d.status, TaskUrgencyStatus::RecentlyOverdue);
        assert!(c_30d.is_recently_overdue);
    }

    #[test]
    fn test_classify_stale_zombies_older_than_30_days() {
        let now = 1_700_000_000;

        // Overdue 30 days + 1 second ago
        let c_30d_1s = classify_task_urgency(now - (30 * 86400 + 1), now);
        assert_eq!(c_30d_1s.status, TaskUrgencyStatus::StaleZombie);
        assert!(c_30d_1s.is_stale_zombie);
        assert!(!c_30d_1s.is_recently_overdue);
        assert!(!c_30d_1s.is_urgent);

        // Overdue 3 years ago (courses from 2021 or 2023)
        let c_3years = classify_task_urgency(now - (3 * 365 * 86400), now);
        assert_eq!(c_3years.status, TaskUrgencyStatus::StaleZombie);
        assert!(c_3years.is_stale_zombie);
        assert!(!should_render_in_critical_block(
            now - (3 * 365 * 86400),
            now,
            false
        ));
    }

    #[test]
    fn test_critical_block_filter_logic() {
        let now = 1_700_000_000;

        // Urgent not submitted -> true
        assert!(should_render_in_critical_block(now + 3600, now, false));
        // Urgent but submitted -> false
        assert!(!should_render_in_critical_block(now + 3600, now, true));

        // Recently overdue not submitted -> true
        assert!(should_render_in_critical_block(now - 86400, now, false));

        // Stale zombie (2021/2023 deadline) -> NEVER in critical block
        assert!(!should_render_in_critical_block(now - 90 * 86400, now, false));
    }
}
