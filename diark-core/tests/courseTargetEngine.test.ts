import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCourseTarget,
  computeCourseCurrentAverage,
  computeSemesterCurrentGpa,
  getDefaultWeightsForCourse,
  solveSemesterTargetDistribution,
} from "../src/features/academic/utils/courseTargetEngine.ts";

test("calculateCourseTarget flags invalid weight sums", () => {
  const res = calculateCourseTarget(
    { qt: 8, th: null, gk: 8, ck: null },
    { qt: 20, th: 20, gk: 20, ck: 30 },
    8.5
  );
  assert.equal(res.totalWeight, 90);
  assert.equal(res.isValidWeightSum, false);
  assert.equal(res.requiredScore, null);
  assert.equal(res.isAchievable, false);
});

test("calculateCourseTarget solves single remaining component accurately", () => {
  const res = calculateCourseTarget(
    { qt: 9, th: 8.5, gk: 8, ck: null },
    { qt: 20, th: 20, gk: 20, ck: 40 },
    8.5
  );
  assert.equal(res.isValidWeightSum, true);
  assert.deepEqual(res.missingComponents, ["ck"]);
  assert.equal(res.remainingWeight, 40);
  assert.equal(res.requiredScore, 8.5);
  assert.equal(res.isAchievable, true);
  assert.equal(res.isAlreadyGuaranteed, false);
});

test("calculateCourseTarget solves multiple remaining components average", () => {
  const res = calculateCourseTarget(
    { qt: null, th: null, gk: 8.0, ck: null },
    { qt: 20, th: 20, gk: 20, ck: 40 },
    8.5
  );
  assert.deepEqual(res.missingComponents, ["qt", "th", "ck"]);
  assert.equal(res.remainingWeight, 80);
  assert.equal(res.requiredScore, 8.63);
  assert.equal(res.minPossibleScore, 1.6);
  assert.equal(res.maxPossibleScore, 9.6);
  assert.equal(res.isAchievable, true);
});

test("calculateCourseTarget detects impossible target above 10.0", () => {
  const res = calculateCourseTarget(
    { qt: 5.0, th: null, gk: 4.0, ck: null },
    { qt: 20, th: 0, gk: 30, ck: 50 },
    9.0
  );
  assert.equal(res.isAchievable, false);
  assert.equal(res.maxPossibleScore, 7.2);
  assert.equal(res.requiredScore, 13.6);
});

test("calculateCourseTarget detects already guaranteed target", () => {
  const res = calculateCourseTarget(
    { qt: 10, th: 10, gk: 10, ck: null },
    { qt: 20, th: 20, gk: 20, ck: 40 },
    5.0
  );
  assert.equal(res.isAchievable, true);
  assert.equal(res.isAlreadyGuaranteed, true);
  assert.equal(res.minPossibleScore, 6.0);
});

test("calculateCourseTarget computes projectedTotalScore when all weighted components exist", () => {
  const res = calculateCourseTarget(
    { qt: 9.0, th: 8.5, gk: 8.0, ck: 9.0 },
    { qt: 20, th: 20, gk: 20, ck: 40 },
    8.5
  );
  assert.equal(res.remainingWeight, 0);
  assert.equal(res.requiredScore, null);
  assert.equal(res.projectedTotalScore, 8.7);
  assert.equal(res.isAchievable, true);
});

test("getDefaultWeightsForCourse selects theory-only vs lab presets", () => {
  assert.deepEqual(getDefaultWeightsForCourse("SS009", 2, false), {
    qt: 20,
    th: 0,
    gk: 30,
    ck: 50,
  });
  assert.deepEqual(getDefaultWeightsForCourse("IT004", 4, false), {
    qt: 20,
    th: 20,
    gk: 20,
    ck: 40,
  });
});

test("computeCourseCurrentAverage and computeSemesterCurrentGpa ignore missing cells", () => {
  const it004 = computeCourseCurrentAverage(
    { qt: null, th: null, gk: 8.0, ck: null },
    { qt: 0, th: 30, gk: 20, ck: 50 }
  );
  assert.equal(it004.knownWeight, 20);
  assert.equal(it004.currentAvg, 8.0);

  const cs115 = computeCourseCurrentAverage(
    { qt: null, th: null, gk: null, ck: null },
    { qt: 40, th: 0, gk: 0, ck: 60 }
  );
  assert.equal(cs115.knownWeight, 0);
  assert.equal(cs115.currentAvg, null);

  const sem = computeSemesterCurrentGpa([
    { credits: 4, scores: { qt: null, th: null, gk: 8.0, ck: null }, weights: { qt: 0, th: 30, gk: 20, ck: 50 } },
    { credits: 4, scores: { qt: null, th: null, gk: null, ck: null }, weights: { qt: 40, th: 0, gk: 0, ck: 60 } },
    { credits: 2, scores: { qt: 9.0, th: null, gk: 9.0, ck: null }, weights: { qt: 20, th: 0, gk: 30, ck: 50 } },
  ]);
  assert.equal(sem.totalCredits, 10);
  assert.equal(sem.gradedCredits, 6);
  assert.equal(sem.currentGpa10, 8.33);
});

test("solveSemesterTargetDistribution distributes remaining points and respects bounds", () => {
  const basic = solveSemesterTargetDistribution(
    [
      { courseCode: "A", credits: 4, isLocked: true, lockedScore: 7.5, minPossible: 7.5, maxPossible: 7.5 },
      { courseCode: "B", credits: 4, isLocked: false, lockedScore: 8.0, minPossible: 0, maxPossible: 10 },
    ],
    8.5
  );
  assert.equal(basic.isAchievable, true);
  assert.equal(basic.targetsByCode.A, 7.5);
  assert.equal(basic.targetsByCode.B, 9.5);

  const bounded = solveSemesterTargetDistribution(
    [
      { courseCode: "A", credits: 4, isLocked: false, lockedScore: 0, minPossible: 1.0, maxPossible: 8.0 },
      { courseCode: "B", credits: 4, isLocked: false, lockedScore: 0, minPossible: 0, maxPossible: 10 },
    ],
    8.5
  );
  assert.equal(bounded.isAchievable, true);
  assert.equal(bounded.targetsByCode.A, 8.0);
  assert.equal(bounded.targetsByCode.B, 9.0);

  const impossible = solveSemesterTargetDistribution(
    [
      { courseCode: "A", credits: 4, isLocked: true, lockedScore: 7.0, minPossible: 7.0, maxPossible: 7.0 },
      { courseCode: "B", credits: 4, isLocked: false, lockedScore: 0, minPossible: 0, maxPossible: 9.5 },
    ],
    9.0
  );
  assert.equal(impossible.isAchievable, false);
});
