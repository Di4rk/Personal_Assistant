import test from "node:test";
import assert from "node:assert/strict";
import {
  formatVietnameseName,
  extractVietnameseGivenName,
} from "../src/utils/masking.ts";
import { getTimeBucket, pickRandomGreeting } from "../src/features/home/greetings.ts";

test("formatVietnameseName normalizes Western-ordered Vietnamese student names", () => {
  assert.equal(formatVietnameseName("Huy Lê Quốc"), "Lê Quốc Huy");
  assert.equal(formatVietnameseName("Lê Quốc Huy"), "Lê Quốc Huy");
  assert.equal(formatVietnameseName("Minh Nguyễn Văn"), "Nguyễn Văn Minh");
  assert.equal(formatVietnameseName("An Trần Thị Thu"), "Trần Thị Thu An");
  assert.equal(formatVietnameseName(""), "");
});

test("extractVietnameseGivenName returns the proper given name regardless of SSO order", () => {
  assert.equal(extractVietnameseGivenName("Huy Lê Quốc"), "Huy");
  assert.equal(extractVietnameseGivenName("Lê Quốc Huy"), "Huy");
  assert.equal(extractVietnameseGivenName("Minh Nguyễn Văn"), "Minh");
  assert.equal(extractVietnameseGivenName("An Trần Thị Thu"), "An");
  assert.equal(extractVietnameseGivenName(""), "");
});

test("getTimeBucket maps all hours of day into 6 distinct buckets", () => {
  assert.equal(getTimeBucket(5), "early_morning");
  assert.equal(getTimeBucket(9), "morning");
  assert.equal(getTimeBucket(12), "noon");
  assert.equal(getTimeBucket(15), "afternoon");
  assert.equal(getTimeBucket(19), "evening");
  assert.equal(getTimeBucket(23), "late_night");
  assert.equal(getTimeBucket(2), "late_night");
});

test("pickRandomGreeting varies across seeds and works with or without student name", () => {
  const sampleHours = [5, 9, 12, 15, 19, 23, 2];

  for (const hour of sampleHours) {
    const g1 = pickRandomGreeting(hour, "Huy Lê Quốc", 0.01);
    const g2 = pickRandomGreeting(hour, "Huy Lê Quốc", 0.55);
    const g3 = pickRandomGreeting(hour, "Huy Lê Quốc", 0.95);

    assert.ok(g1.includes("Huy"), `Expected given name in greeting for hour ${hour}: ${g1}`);
    assert.ok(!g1.includes("Lê Quốc"), `Should not split middle/surname as given name: ${g1}`);
    assert.notEqual(g1, g2);
    assert.notEqual(g2, g3);

    const noName = pickRandomGreeting(hour, "", 0.2);
    assert.ok(noName.length > 0);
    assert.ok(!noName.includes("undefined"));
  }
});
