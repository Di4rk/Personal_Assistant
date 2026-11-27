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
  { id: "0-30-20-50", label: "0 / 30 / 20 / 50", weights: { qt: 0, th: 30, gk: 20, ck: 50 } },
  { id: "20-0-30-50", label: "20 / 0 / 30 / 50", weights: { qt: 20, th: 0, gk: 30, ck: 50 } },
  { id: "40-0-0-60", label: "40 / 0 / 0 / 60", weights: { qt: 40, th: 0, gk: 0, ck: 60 } },
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

export interface CourseCurrentAverage {
  currentAvg: number | null;
  knownWeight: number;
  weightedPoints: number;
}

export function computeCourseCurrentAverage(
  scores: ComponentScores,
  weights: ComponentWeights
): CourseCurrentAverage {
  let knownWeight = 0;
  let weightedPoints = 0;

  for (const key of COMPONENT_KEYS) {
    const w = Math.max(0, weights[key]);
    if (w <= 0) continue;
    const score = scores[key];
    if (score !== null && score !== undefined && Number.isFinite(score)) {
      knownWeight += w;
      weightedPoints += (Math.min(10, Math.max(0, score)) * w) / 100;
    }
  }

  return {
    currentAvg: knownWeight > 0 ? round2(weightedPoints / (knownWeight / 100)) : null,
    knownWeight,
    weightedPoints: round2(weightedPoints),
  };
}

export interface SemesterCurrentGpaSummary {
  currentGpa10: number | null;
  gradedCredits: number;
  totalCredits: number;
}

export function computeSemesterCurrentGpa(
  items: ReadonlyArray<{ credits: number; scores: ComponentScores; weights: ComponentWeights }>
): SemesterCurrentGpaSummary {
  let gradedCredits = 0;
  let totalCredits = 0;
  let weightedSum = 0;

  for (const item of items) {
    const cred = Math.max(0, item.credits);
    totalCredits += cred;
    if (cred <= 0) continue;
    const avg = computeCourseCurrentAverage(item.scores, item.weights);
    if (avg.currentAvg !== null) {
      gradedCredits += cred;
      weightedSum += avg.currentAvg * cred;
    }
  }

  return {
    currentGpa10: gradedCredits > 0 ? round2(weightedSum / gradedCredits) : null,
    gradedCredits,
    totalCredits,
  };
}

export interface CourseDistributionInput {
  courseCode: string;
  credits: number;
  isLocked: boolean;
  lockedScore: number;
  minPossible: number;
  maxPossible: number;
}

export interface SemesterTargetDistribution {
  targetsByCode: Record<string, number>;
  isAchievable: boolean;
  requiredFlexAvg: number | null;
}

export function solveSemesterTargetDistribution(
  items: ReadonlyArray<CourseDistributionInput>,
  targetTermGpa: number
): SemesterTargetDistribution {
  const clampedTarget = Math.min(10, Math.max(0, targetTermGpa));
  const targetsByCode: Record<string, number> = {};
  let totalCredits = 0;

  const states = items.map((item) => {
    const cred = Math.max(0, item.credits);
    totalCredits += cred;
    const minP = Math.min(10, Math.max(0, item.minPossible));
    const maxP = Math.max(minP, Math.min(10, item.maxPossible));
    const locked = item.isLocked || cred <= 0;
    const fixedVal = round2(Math.min(10, Math.max(0, item.lockedScore)));
    if (locked) {
      targetsByCode[item.courseCode] = fixedVal;
    }
    return {
      courseCode: item.courseCode,
      credits: cred,
      fixed: locked,
      assigned: fixedVal,
      minPossible: minP,
      maxPossible: maxP,
    };
  });

  if (totalCredits <= 0) {
    return { targetsByCode, isAchievable: true, requiredFlexAvg: null };
  }

  const desiredTotalPoints = clampedTarget * totalCredits;
  let requiredFlexAvg: number | null = null;

  for (let iter = 0; iter < states.length + 1; iter += 1) {
    let fixedPoints = 0;
    let flexCredits = 0;
    for (const s of states) {
      if (s.fixed) {
        fixedPoints += s.assigned * s.credits;
      } else {
        flexCredits += s.credits;
      }
    }

    if (flexCredits <= 0) {
      requiredFlexAvg = null;
      break;
    }

    const rawFlex = (desiredTotalPoints - fixedPoints) / flexCredits;
    requiredFlexAvg = round2(rawFlex);

    let clampedAny = false;
    for (const s of states) {
      if (s.fixed) continue;
      if (rawFlex < s.minPossible - 1e-6) {
        s.fixed = true;
        s.assigned = round2(s.minPossible);
        targetsByCode[s.courseCode] = s.assigned;
        clampedAny = true;
      } else if (rawFlex > s.maxPossible + 1e-6) {
        s.fixed = true;
        s.assigned = round2(s.maxPossible);
        targetsByCode[s.courseCode] = s.assigned;
        clampedAny = true;
      }
    }

    if (!clampedAny) {
      const clampedFlex = round2(Math.min(10, Math.max(0, rawFlex)));
      for (const s of states) {
        if (!s.fixed) {
          s.assigned = clampedFlex;
          targetsByCode[s.courseCode] = clampedFlex;
        }
      }
      break;
    }
  }

  const achievedPoints = states.reduce((sum, s) => sum + s.assigned * s.credits, 0);
  const isAchievable = achievedPoints + 0.05 >= desiredTotalPoints;

  return {
    targetsByCode,
    isAchievable,
    requiredFlexAvg,
  };
}
