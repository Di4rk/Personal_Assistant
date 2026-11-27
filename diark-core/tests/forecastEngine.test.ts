import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDynamicTermPresets,
  getRecommendedTerms,
} from "../src/features/academic/utils/forecastEngine.ts";

describe("buildDynamicTermPresets & getRecommendedTerms", () => {
  it("handles year 1 student (126 remaining, 0 completed)", () => {
    const presets = buildDynamicTermPresets(126, 0);
    assert.deepEqual(
      presets.map((p) => p.terms),
      [5, 6, 7, 8]
    );
    assert.equal(getRecommendedTerms(126, 0), 7);
  });

  it("handles year 2 semester 1 student (84 remaining, 2 completed)", () => {
    const presets = buildDynamicTermPresets(84, 2);
    assert.deepEqual(
      presets.map((p) => p.terms),
      [3, 4, 5, 6]
    );
    const fourTerms = presets.find((p) => p.terms === 4);
    assert.ok(fourTerms);
    assert.equal(fourTerms.pace, 21);
    assert.equal(fourTerms.estimatedYears, "3.0");
  });

  it("handles year 2 semester 2 student (63 remaining, 3 completed)", () => {
    const presets = buildDynamicTermPresets(63, 3);
    assert.deepEqual(
      presets.map((p) => p.terms),
      [3, 4, 5, 6]
    );
    const threeTerms = presets.find((p) => p.terms === 3);
    assert.ok(threeTerms);
    assert.equal(threeTerms.pace, 21);
    assert.equal(threeTerms.estimatedYears, "3.0");
  });

  it("handles year 4 student (30 remaining, 6 completed)", () => {
    const presets = buildDynamicTermPresets(30, 6);
    assert.deepEqual(
      presets.map((p) => p.terms),
      [1, 2, 3, 4]
    );
    assert.equal(getRecommendedTerms(30, 6), 2);
  });

  it("handles year 6/7 student (10 remaining, 11 completed)", () => {
    const presets = buildDynamicTermPresets(10, 11);
    assert.deepEqual(
      presets.map((p) => p.terms),
      [1, 2, 3, 4]
    );
    assert.deepEqual(
      presets.map((p) => p.estimatedYears),
      ["6.0", "6.5", "7.0", "7.5"]
    );
  });

  it("handles edge cases when remaining credits are very small or zero", () => {
    const smallPresets = buildDynamicTermPresets(2, 5);
    assert.deepEqual(
      smallPresets.map((p) => p.terms),
      [1, 2]
    );

    assert.deepEqual(buildDynamicTermPresets(0, 8), []);
    assert.equal(getRecommendedTerms(0, 8), 0);
  });
});
