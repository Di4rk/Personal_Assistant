export type ComponentKey = "qt" | "th" | "gk" | "ck";

export interface ComponentWeights {
  qt: number;
  th: number;
  gk: number;
  ck: number;
}

export interface ComponentScores {
  qt: number | null;
  th: number | null;
  gk: number | null;
  ck: number | null;
}

export interface WeightPreset {
  id: string;
  label: string;
  weights: ComponentWeights;
}

export interface CourseTargetCalculation {
  totalWeight: number;
  isValidWeightSum: boolean;
  knownWeight: number;
  remainingWeight: number;
  missingComponents: ComponentKey[];
  knownWeightedPoints: number;
  maxPossibleScore: number;
  minPossibleScore: number;
  requiredScore: number | null;
  isAchievable: boolean;
  isAlreadyGuaranteed: boolean;
  projectedTotalScore: number | null;
}

export const COMPONENT_KEYS: readonly ComponentKey[] = ["qt", "th", "gk", "ck"];

export const COMPONENT_LABELS: Record<ComponentKey, string> = {
  qt: "QT",
  th: "TH",
  gk: "GK",
  ck: "CK",
};

export const UIT_WEIGHT_PRESETS: readonly WeightPreset[] = [
  { id: "20-20-20-40", label: "20 / 20 / 20 / 40", weights: { qt: 20, th: 20, gk: 20, ck: 40 } },
  { id: "10-20-20-50", label: "10 / 20 / 20 / 50", weights: { qt: 10, th: 20, gk: 20, ck: 50 } },
  { id: "20-0-30-50", label: "20 / 0 / 30 / 50", weights: { qt: 20, th: 0, gk: 30, ck: 50 } },
  { id: "0-0-30-70", label: "0 / 0 / 30 / 70", weights: { qt: 0, th: 0, gk: 30, ck: 70 } },
];

export function getDefaultWeightsForCourse(
  courseCode: string,
  credits: number,
  hasPracticeScore: boolean
): ComponentWeights {
  const upper = courseCode.trim().toUpperCase();
  if (
    upper.startsWith("SS") ||
    upper.startsWith("MA") ||
    upper === "CS115" ||
    (credits <= 3 && !hasPracticeScore)
  ) {
    return { qt: 20, th: 0, gk: 30, ck: 50 };
  }
  return { qt: 20, th: 20, gk: 20, ck: 40 };
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function calculateCourseTarget(
  scores: ComponentScores,
  weights: ComponentWeights,
  targetScore: number
): CourseTargetCalculation {
  const totalWeight = COMPONENT_KEYS.reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  const isValidWeightSum = Math.round(totalWeight) === 100;

  let knownWeight = 0;
  let remainingWeight = 0;
  let knownWeightedPoints = 0;
  const missingComponents: ComponentKey[] = [];

  for (const key of COMPONENT_KEYS) {
    const w = Math.max(0, weights[key]);
    if (w <= 0) continue;

    const score = scores[key];
    if (score !== null && score !== undefined && Number.isFinite(score)) {
      knownWeight += w;
      knownWeightedPoints += (Math.min(10, Math.max(0, score)) * w) / 100;
    } else {
      remainingWeight += w;
      missingComponents.push(key);
    }
  }

  const maxPossibleScore = round2(Math.min(10, knownWeightedPoints + remainingWeight * 0.1));
  const minPossibleScore = round2(knownWeightedPoints);

  if (!isValidWeightSum) {
    return {
      totalWeight,
      isValidWeightSum: false,
      knownWeight,
      remainingWeight,
      missingComponents,
      knownWeightedPoints: round2(knownWeightedPoints),
      maxPossibleScore,
      minPossibleScore,
      requiredScore: null,
      isAchievable: false,
      isAlreadyGuaranteed: false,
      projectedTotalScore: null,
    };
  }

  if (remainingWeight === 0) {
    const projectedTotalScore = round2(knownWeightedPoints);
    return {
      totalWeight,
      isValidWeightSum: true,
      knownWeight,
      remainingWeight: 0,
      missingComponents: [],
      knownWeightedPoints: projectedTotalScore,
      maxPossibleScore: projectedTotalScore,
      minPossibleScore: projectedTotalScore,
      requiredScore: null,
      isAchievable: projectedTotalScore + 1e-9 >= targetScore,
      isAlreadyGuaranteed: projectedTotalScore + 1e-9 >= targetScore,
      projectedTotalScore,
    };
  }

  const requiredRaw = (targetScore - knownWeightedPoints) / (remainingWeight / 100);
  const requiredScore = round2(requiredRaw);
  const isAchievable = requiredScore <= 10.0;
  const isAlreadyGuaranteed = requiredScore <= 0.0;

  return {
    totalWeight,
    isValidWeightSum: true,
    knownWeight,
    remainingWeight,
    missingComponents,
    knownWeightedPoints: round2(knownWeightedPoints),
    maxPossibleScore,
    minPossibleScore,
    requiredScore,
    isAchievable,
    isAlreadyGuaranteed,
    projectedTotalScore: null,
  };
}
