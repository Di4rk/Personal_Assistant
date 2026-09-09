import type { AcademicCourseRecord } from "../types";

export interface ForecastParams {
  currentEarnedCredits: number;
  currentGpaCredits: number;
  currentTotalWeighted10: number; // sum(score_10 * credits)
  targetGpa10: number;            // e.g. 8.5 (Giỏi) hoặc 9.0 (Xuất sắc)
  totalDegreeCredits: number;     // Chuẩn UIT: thường 120 - 130 TC
  estimatedCreditsPerTerm: number;// Mặc định: 20-22 TC
}

export interface ForecastResult {
  remainingCredits: number;
  requiredAverageGpa10: number;
  isAchievable: boolean;
  termsRemaining: number;
}

/**
 * Tính toán dự báo tốt nghiệp và GPA yêu cầu theo mục tiêu.
 */
export function calculateGraduationForecast(params: ForecastParams): ForecastResult {
  const remainingCredits = Math.max(0, params.totalDegreeCredits - params.currentGpaCredits);
  if (remainingCredits === 0) {
    return { remainingCredits: 0, requiredAverageGpa10: 0, isAchievable: true, termsRemaining: 0 };
  }

  const targetTotalPoints = params.targetGpa10 * params.totalDegreeCredits;
  const requiredRemainingPoints = targetTotalPoints - params.currentTotalWeighted10;
  const requiredAverageGpa10 = Number((requiredRemainingPoints / remainingCredits).toFixed(2));

  const isAchievable = requiredAverageGpa10 <= 10.0;
  const termsRemaining = Math.ceil(remainingCredits / params.estimatedCreditsPerTerm);

  return {
    remainingCredits,
    requiredAverageGpa10: isAchievable ? Math.max(0, requiredAverageGpa10) : requiredAverageGpa10,
    isAchievable,
    termsRemaining,
  };
}

// ============================================================
//  UIT Knowledge Category Classification & Stats
// ============================================================

export type CourseCategory = "general" | "foundational" | "specialized" | "auxiliary";

export interface CategoryAxisData {
  category: CourseCategory;
  label: string;
  shortLabel: string;
  averageScore10: number;
  totalCredits: number;
  passedCredits: number;
  courseCount: number;
}

const FOUNDATIONAL_CODES = new Set([
  "IT001",
  "IT002",
  "IT003",
  "IT012",
  "CS005",
  "MA004",
  "MA005",
]);

/**
 * Phân loại danh mục môn học UIT dựa theo mã môn học:
 * - Điều kiện/Bổ trợ: PE*, ME*
 * - Cơ sở ngành: IT001, IT002, IT003, IT012, CS005, MA004, MA005
 * - Đại cương: MA*, PH*, SS*, ENG* (loại trừ các môn cơ sở ngành như MA004, MA005)
 * - Chuyên ngành: Các môn IT/CS nâng cao còn lại.
 */
export function classifyCourseCategory(courseCode: string): CourseCategory {
  const normalized = courseCode.trim().toUpperCase();

  // 1. Điều kiện / Bổ trợ (Thể chất PE*, Giáo dục quốc phòng ME*)
  if (normalized.startsWith("PE") || normalized.startsWith("ME")) {
    return "auxiliary";
  }

  // 2. Cơ sở ngành
  if (FOUNDATIONAL_CODES.has(normalized)) {
    return "foundational";
  }

  // 3. Đại cương (Toán, Vật lý, Lý luận chính trị, Ngoại ngữ)
  if (
    normalized.startsWith("MA") ||
    normalized.startsWith("PH") ||
    normalized.startsWith("SS") ||
    normalized.startsWith("ENG")
  ) {
    return "general";
  }

  // 4. Chuyên ngành (các môn IT/CS còn lại)
  return "specialized";
}

export const CATEGORY_METADATA: Record<CourseCategory, { label: string; shortLabel: string }> = {
  general: { label: "Đại cương", shortLabel: "Đại cương" },
  foundational: { label: "Cơ sở ngành", shortLabel: "Cơ sở ngành" },
  specialized: { label: "Chuyên ngành", shortLabel: "Chuyên ngành" },
  auxiliary: { label: "Điều kiện / Bổ trợ", shortLabel: "Bổ trợ" },
};

/**
 * Tính toán điểm trung bình hệ 10 và tín chỉ theo 4 trục kiến thức
 */
export function computeCategoryRadarData(courses: AcademicCourseRecord[]): CategoryAxisData[] {
  const categories: CourseCategory[] = ["general", "foundational", "specialized", "auxiliary"];

  const accumulators: Record<
    CourseCategory,
    {
      totalWeightedScore: number;
      scoreCredits: number;
      totalCredits: number;
      passedCredits: number;
      courseCount: number;
    }
  > = {
    general: { totalWeightedScore: 0, scoreCredits: 0, totalCredits: 0, passedCredits: 0, courseCount: 0 },
    foundational: { totalWeightedScore: 0, scoreCredits: 0, totalCredits: 0, passedCredits: 0, courseCount: 0 },
    specialized: { totalWeightedScore: 0, scoreCredits: 0, totalCredits: 0, passedCredits: 0, courseCount: 0 },
    auxiliary: { totalWeightedScore: 0, scoreCredits: 0, totalCredits: 0, passedCredits: 0, courseCount: 0 },
  };

  for (const course of courses) {
    const cat = classifyCourseCategory(course.courseCode);
    const acc = accumulators[cat];
    acc.courseCount += 1;
    acc.totalCredits += course.credits;
    if (course.isPassed) {
      acc.passedCredits += course.credits;
    }

    if (course.summaryScore10 !== null && course.summaryScore10 !== undefined) {
      const weight = course.credits > 0 ? course.credits : 1;
      acc.totalWeightedScore += course.summaryScore10 * weight;
      acc.scoreCredits += weight;
    }
  }

  return categories.map((cat) => {
    const acc = accumulators[cat];
    const avg = acc.scoreCredits > 0 ? Number((acc.totalWeightedScore / acc.scoreCredits).toFixed(2)) : 0;
    const meta = CATEGORY_METADATA[cat];

    return {
      category: cat,
      label: meta.label,
      shortLabel: meta.shortLabel,
      averageScore10: avg,
      totalCredits: acc.totalCredits,
      passedCredits: acc.passedCredits,
      courseCount: acc.courseCount,
    };
  });
}
