import { maskStudentId, maskFullName, maskClassName } from "./masking";

export function runMaskingTests(): boolean {
  const maskedId = maskStudentId("21520000");
  if (maskedId !== "2152****") {
    throw new Error(`maskStudentId assertion failed: expected 2152****, got ${maskedId}`);
  }

  const shortId = maskStudentId("12345");
  if (shortId !== "12345") {
    throw new Error(`maskStudentId short assertion failed: expected 12345, got ${shortId}`);
  }

  const maskedName = maskFullName("Nguyễn Văn A");
  if (maskedName !== "N****** V** A") {
    // Check part lengths: Nguyễn (6 chars) -> N + 5*
    const parts = maskedName.split(" ");
    if (parts[0][0] !== "N" || parts[1][0] !== "V" || parts[2] !== "A") {
      throw new Error(`maskFullName assertion failed: got ${maskedName}`);
    }
  }

  const maskedClass = maskClassName("KHMT2021.1");
  if (maskedClass !== "KHMT****") {
    throw new Error(`maskClassName assertion failed: expected KHMT****, got ${maskedClass}`);
  }

  return true;
}
