use serde::Serialize;

/// Công thức leveling: tăng trưởng tam giác (triangular growth).
/// XP tích luỹ cần để đạt level n (n bắt đầu từ 1, level 1 = 0 XP):
///     threshold(n) = 50 * n * (n - 1)
///
/// Ví dụ: level 1 = 0 XP, level 2 = 100 XP, level 3 = 300 XP,
///        level 4 = 600 XP, level 5 = 1000 XP...
/// XP cần cho mỗi level kế tiếp tăng dần -> lên cấp cao khó hơn, đúng cảm giác game.
/// Hệ số 50 chọn sao cho ~1 AC bài Div2 dễ (10 XP) x vài bài/ngày thì lên level đều đặn
/// trong vài tuần đầu, không bị nản vì quá chậm.
const LEVEL_COEFFICIENT: f64 = 50.0;

#[derive(Debug, Serialize, Clone)]
pub struct LevelInfo {
    pub level: i64,
    pub total_xp: i64,
    /// XP đã tích trong level hiện tại (không phải tổng XP)
    pub current_level_xp: i64,
    /// Tổng XP cần để hoàn thành level hiện tại (dùng làm mẫu số progress bar)
    pub xp_needed_for_level: i64,
    /// 0.0 - 100.0, dùng trực tiếp cho width % của progress bar
    pub progress_percent: f64,
}

fn threshold(level: i64) -> i64 {
    (LEVEL_COEFFICIENT * (level * (level - 1)) as f64).round() as i64
}

/// Từ tổng XP tích luỹ, tính ra level hiện tại + % tiến độ lên level tiếp theo.
pub fn calc_level_info(total_xp: i64) -> LevelInfo {
    let xp = total_xp.max(0) as f64;

    // Giải ngược công thức threshold(n) = 50*n*(n-1) <= xp để tìm n lớn nhất thoả mãn.
    // 50n^2 - 50n - xp = 0  =>  n = (50 + sqrt(2500 + 200*xp)) / 100
    let level_f = (LEVEL_COEFFICIENT + (2500.0 + 200.0 * xp).sqrt()) / 100.0;
    let level = (level_f.floor() as i64).max(1);

    let current_threshold = threshold(level);
    let next_threshold = threshold(level + 1);
    let xp_needed_for_level = (next_threshold - current_threshold).max(1);
    let current_level_xp = (total_xp - current_threshold).max(0);

    let progress_percent = (current_level_xp as f64 / xp_needed_for_level as f64 * 100.0)
        .clamp(0.0, 100.0);

    LevelInfo {
        level,
        total_xp,
        current_level_xp,
        xp_needed_for_level,
        progress_percent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_1_at_zero_xp() {
        let info = calc_level_info(0);
        assert_eq!(info.level, 1);
    }

    #[test]
    fn level_boundaries_match_threshold() {
        // Ngay tại mốc 100 XP phải là level 2, 99 XP vẫn là level 1.
        assert_eq!(calc_level_info(99).level, 1);
        assert_eq!(calc_level_info(100).level, 2);
        assert_eq!(calc_level_info(300).level, 3);
        assert_eq!(calc_level_info(299).level, 2);
    }

    #[test]
    fn progress_percent_in_range() {
        let info = calc_level_info(150);
        assert!(info.progress_percent >= 0.0 && info.progress_percent <= 100.0);
    }
}
