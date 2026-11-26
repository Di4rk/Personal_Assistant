import test from "node:test";
import assert from "node:assert/strict";
import { computeGradeMetrics } from "../src/features/academic/utils/grading.ts";
import {
  calculateGraduationForecast,
  computeCategoryRadarData,
  deduplicateCoursesByHighestScore,
} from "../src/features/academic/utils/forecastEngine.ts";
import {
  formatTimeHm,
  getEventCoveredDatesVn,
  toVnDateIso,
} from "../src/utils/scheduleTime.ts";
import type { AcademicCourseRecord } from "../src/features/academic/types";

function makeCourse(overrides: Partial<AcademicCourseRecord>): AcademicCourseRecord {
  return {
    id: "id-1",
    semesterId: "2025-2026.1",
    courseCode: "IT001",
    courseName: "Test Course",
    credits: 4,
    processPoint: null,
    midtermScore: null,
    practicePoint: null,
    finalScore: null,
    finalPoint: null,
    coursePoint: 0,
    status: "normal",
    note: null,
    otherScores: null,
    summaryScore10: 8.0,
    summaryScore4: 3.5,
    grade4: 3.5,
    gradeChar: "B+",
    resultStatus: "Đạt",
    category: "dai_cuong",
    isPassed: true,
    isGpaCalculated: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("grading follows UIT >= 5.0 pass threshold", () => {
  const belowFive = computeGradeMetrics(4.5);
  assert.equal(belowFive.isPassed, false);
  assert.equal(belowFive.gradeChar, "F");
  assert.equal(belowFive.score4, 0.0);

  const exactFive = computeGradeMetrics(5.0);
  assert.equal(exactFive.isPassed, true);
  assert.equal(exactFive.gradeChar, "D+");
  assert.equal(exactFive.score4, 1.5);
});

test("deduplicateCoursesByHighestScore keeps highest score across retakes", () => {
  const rows = [
    makeCourse({ id: "1", semesterId: "2024-2025.1", courseCode: "IT003", summaryScore10: 4.0, isPassed: false }),
    makeCourse({ id: "2", semesterId: "2024-2025.2", courseCode: "IT003", summaryScore10: 8.5, isPassed: true }),
    makeCourse({ id: "3", semesterId: "2024-2025.2", courseCode: "MA006", summaryScore10: 7.0, isPassed: true }),
  ];

  const deduped = deduplicateCoursesByHighestScore(rows);
  assert.equal(deduped.length, 2);
  const it003 = deduped.find((c) => c.courseCode === "IT003");
  assert.equal(it003?.summaryScore10, 8.5);
  assert.equal(it003?.isPassed, true);
});

test("calculateGraduationForecast handles exempt credits and zero creditsPerTerm safely", () => {
  const res = calculateGraduationForecast({
    currentEarnedCredits: 50, // includes 8 exempt credits
    currentGpaCredits: 42,
    currentTotalWeighted10: 42 * 8.0,
    targetGpa10: 8.5,
    totalDegreeCredits: 126,
    estimatedCreditsPerTerm: 0,
  });

  assert.equal(res.remainingCredits, 76);
  assert.equal(res.termsRemaining, 76);
  assert.equal(Number.isFinite(res.requiredAverageGpa10), true);
  // Target total points across 42 + 76 = 118 GPA credits: 8.5 * 118 = 1003; remaining = (1003 - 336) / 76 = 8.78
  assert.equal(res.requiredAverageGpa10, 8.78);
});

test("computeCategoryRadarData excludes non-GPA courses and deduplicates retakes", () => {
  const radar = computeCategoryRadarData([
    makeCourse({ courseCode: "PE231", credits: 0, summaryScore10: 9.0, isGpaCalculated: false }),
    makeCourse({ courseCode: "ENG01", credits: 4, summaryScore10: null, isGpaCalculated: false }),
    makeCourse({ courseCode: "IT001", credits: 4, summaryScore10: 4.0, isPassed: false }),
    makeCourse({ courseCode: "IT001", credits: 4, summaryScore10: 9.0, isPassed: true }),
  ]);

  const general = radar.find((r) => r.category === "general");
  assert.equal(general?.averageScore10, 9.0);
  const aux = radar.find((r) => r.category === "auxiliary");
  assert.equal(aux?.averageScore10, 0);
});

test("scheduleTime handles Asia/Ho_Chi_Minh morning hours and exclusive all-day DTEND", () => {
  // 2026-11-26T19:30:00Z == 2026-11-27 02:30 Asia/Ho_Chi_Minh
  const earlyMorningVnTs = Math.floor(Date.UTC(2026, 10, 26, 19, 30, 0) / 1000);
  assert.equal(toVnDateIso(earlyMorningVnTs), "2026-11-27");
  assert.equal(formatTimeHm(earlyMorningVnTs), "02:30");

  // 1-day all-day: 2026-11-27 00:00+07 to 2026-11-28 00:00+07 (exclusive DTEND)
  const day1Start = Math.floor(Date.UTC(2026, 10, 26, 17, 0, 0) / 1000);
  const day2Start = day1Start + 86400;
  assert.deepEqual(getEventCoveredDatesVn(day1Start, day2Start, true), ["2026-11-27"]);

  // 3-day all-day: 2026-11-27 to 2026-11-30 (exclusive DTEND)
  const day4Start = day1Start + 3 * 86400;
  assert.deepEqual(getEventCoveredDatesVn(day1Start, day4Start, true), [
    "2026-11-27",
    "2026-11-28",
    "2026-11-29",
  ]);
});
