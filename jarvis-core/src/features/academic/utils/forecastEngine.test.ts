import { evaluateUitWorkload } from "./forecastEngine";

export function runWorkloadTests(): void {
  // 1. Vượt trần quy chế (> 30 TC)
  const overload31 = evaluateUitWorkload(31);
  if (
    overload31.tier !== "overload" ||
    overload31.isInvalid !== true ||
    overload31.scholarshipEligible !== false ||
    overload31.label !== "Vượt trần 30 TC"
  ) {
    throw new Error(`Test failed for workload 31: got ${JSON.stringify(overload31)}`);
  }

  const overload35 = evaluateUitWorkload(35);
  if (!overload35.isInvalid || overload35.tier !== "overload") {
    throw new Error(`Test failed for workload 35: got ${JSON.stringify(overload35)}`);
  }

  // 2. Dưới sàn học bổng (< 14 TC)
  const floor12 = evaluateUitWorkload(12);
  if (
    floor12.tier !== "below_floor" ||
    floor12.isInvalid !== false ||
    floor12.scholarshipEligible !== false ||
    floor12.label !== "Mất quyền xét HB (<14 TC)"
  ) {
    throw new Error(`Test failed for workload 12: got ${JSON.stringify(floor12)}`);
  }

  const floor13 = evaluateUitWorkload(13);
  if (floor13.scholarshipEligible !== false || floor13.tier !== "below_floor") {
    throw new Error(`Test failed for workload 13: got ${JSON.stringify(floor13)}`);
  }

  // 3. Mức tải tối ưu (14 - 20 TC)
  const opt14 = evaluateUitWorkload(14);
  if (
    opt14.tier !== "optimal" ||
    opt14.isInvalid !== false ||
    opt14.scholarshipEligible !== true ||
    opt14.label !== "Mức tải tối ưu • Bao HB"
  ) {
    throw new Error(`Test failed for workload 14: got ${JSON.stringify(opt14)}`);
  }

  const opt20 = evaluateUitWorkload(20);
  if (opt20.tier !== "optimal" || !opt20.scholarshipEligible) {
    throw new Error(`Test failed for workload 20: got ${JSON.stringify(opt20)}`);
  }

  // 4. Cường độ cao (21 - 25 TC)
  const high21 = evaluateUitWorkload(21);
  if (
    high21.tier !== "high_pace" ||
    high21.isInvalid !== false ||
    high21.scholarshipEligible !== true ||
    high21.label !== "Cường độ cao • Bao HB"
  ) {
    throw new Error(`Test failed for workload 21: got ${JSON.stringify(high21)}`);
  }

  const high25 = evaluateUitWorkload(25);
  if (high25.tier !== "high_pace" || !high25.scholarshipEligible) {
    throw new Error(`Test failed for workload 25: got ${JSON.stringify(high25)}`);
  }

  // 5. Kịch trần UIT (26 - 30 TC)
  const max26 = evaluateUitWorkload(26);
  if (
    max26.tier !== "max_limit" ||
    max26.isInvalid !== false ||
    max26.scholarshipEligible !== true ||
    max26.label !== "Kịch trần (26-30 TC)"
  ) {
    throw new Error(`Test failed for workload 26: got ${JSON.stringify(max26)}`);
  }

  const max30 = evaluateUitWorkload(30);
  if (
    max30.tier !== "max_limit" ||
    max30.isInvalid !== false ||
    max30.scholarshipEligible !== true ||
    max30.label !== "Kịch trần (26-30 TC)"
  ) {
    throw new Error(`Test failed for workload 30: got ${JSON.stringify(max30)}`);
  }

  console.log("All 5 UIT Workload Evaluation tests passed successfully!");
}

runWorkloadTests();
