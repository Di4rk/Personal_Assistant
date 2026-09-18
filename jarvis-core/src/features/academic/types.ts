/**
 * TypeScript definitions mapped 1:1 with Rust DTOs in
 * `src-tauri/src/db/academic.rs`.
 *
 * All field names follow camelCase to match `#[serde(rename_all = "camelCase")]`
 * in the Rust backend.
 */

// ============================================================
//  Thang điểm chữ theo quy chế ĐHQG-HCM
// ============================================================

export type GradeScale =
  | "APlus"
  | "A"
  | "BPlus"
  | "B"
  | "CPlus"
  | "C"
  | "DPlus"
  | "D"
  | "F";

export const GRADE_SCALE_MAP: Record<GradeScale, { char: string; scale4: number; minScore10: number }> = {
  APlus: { char: "A+", scale4: 4.0, minScore10: 9.0 },
  A: { char: "A", scale4: 3.7, minScore10: 8.5 },
  BPlus: { char: "B+", scale4: 3.5, minScore10: 8.0 },
  B: { char: "B", scale4: 3.0, minScore10: 7.0 },
  CPlus: { char: "C+", scale4: 2.5, minScore10: 6.5 },
  C: { char: "C", scale4: 2.0, minScore10: 5.5 },
  DPlus: { char: "D+", scale4: 1.5, minScore10: 5.0 },
  D: { char: "D", scale4: 1.0, minScore10: 4.0 },
  F: { char: "F", scale4: 0.0, minScore10: 0.0 },
};

// ============================================================
//  Academic Semester Record & Overview DTO
// ============================================================

/**
 * Bản ghi metadata học kỳ lưu trong SQLite `academic_semesters`.
 * Chú ý: bảng này KHÔNG lưu `actual_gpa_*` hay `actual_drl`.
 */
export interface AcademicSemesterRecord {
  id: string;
  academicYear: string;
  semesterTerm: number;
  targetGpa: number | null;
  targetDrl: number | null;
  isCompleted: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * DTO trả về từ IPC command `get_academic_overview`.
 * Gồm metadata học kỳ và các chỉ số GPA/DRL được tính động từ SQL aggregate.
 */
export interface AcademicOverviewDto {
  id: string;
  academicYear: string;
  semesterTerm: number;
  targetGpa: number | null;
  targetDrl: number | null;
  isCompleted: boolean;
  createdAt: number;
  updatedAt: number;
  // Dynamic computed fields (không lưu cứng trong DB)
  actualGpa10: number | null;
  actualGpa4: number | null;
  actualDrl: number;
  passedCredits: number;
  totalCredits: number;
}

/** Alias tương đương với struct SemesterOverview trong db/academic.rs */
export type SemesterOverview = AcademicOverviewDto;

// ============================================================
//  Academic Course Record & Input DTOs
// ============================================================

/**
 * Bản ghi môn học lưu trong SQLite `academic_courses`.
 */
export interface AcademicCourseRecord {
  id: string;
  semesterId: string;
  courseCode: string;
  courseName: string;
  credits: number;
  midtermScore: number | null;
  finalScore: number | null;
  otherScores: string | null;
  summaryScore10: number | null;
  summaryScore4: number | null;
  gradeChar: string | null;
  isPassed: boolean;
  isGpaCalculated: boolean;
  createdAt: number;
  updatedAt: number;
  // Canonical portal score columns
  processPoint?: number | null;
  practicePoint?: number | null;
  finalPoint?: number | null;
  coursePoint?: number | null;
  grade4?: number | null;
  resultStatus?: string | null;
  category?: string | null;
  status?: string | null;
  note?: string | null;
}

/**
 * DTO gửi lên Rust backend để batch upsert môn học.
 */
export interface UpsertCourseDto {
  id?: string | null;
  semesterId: string;
  courseCode: string;
  courseName: string;
  credits: number;
  midtermScore?: number | null;
  finalScore?: number | null;
  otherScores?: string | null;
  summaryScore10?: number | null;
  isGpaCalculated?: boolean | null;
}

/**
 * DTO tạo hoặc cập nhật metadata học kỳ.
 */
export interface UpsertSemesterDto {
  id: string;
  academicYear: string;
  semesterTerm: number;
  targetGpa?: number | null;
  targetDrl?: number | null;
  isCompleted?: boolean | null;
}

// ============================================================
//  UIT Portal Next.js Ingestion Types
// ============================================================

export interface RawPortalCourse {
  courseCode: string;
  courseName: string;
  credits: number;
  processScore?: number | null;
  practiceScore?: number | null;
  midtermScore?: number | null;
  finalScore?: number | null;
  summaryScore10: number;
}

export interface RawPortalSemester {
  header: string; // e.g. "Học kỳ 1/2024-2025" hoặc "2024_2025_HK1"
  courses: RawPortalCourse[];
}

export type PortalSyncStatus =
  | "idle"
  | "awaiting_sso"
  | "ingesting"
  | "completed"
  | "error";

export type UitSyncState =
  | { state: "Opening"; message?: never }
  | { state: "Authenticating"; message?: never }
  | { state: "Extracting"; message?: never }
  | { state: "Parsing"; message?: never }
  | { state: "Persisting"; message?: never }
  | { state: "Completed"; message?: never }
  | { state: "Failed"; message: string };

export interface SemesterRef {
  id: string;
  academicYear: string;
  semesterTerm: number;
}

export interface ParsedCourse {
  courseCode: string;
  courseName: string;
  credits: number;
  midtermScore: number | null;
  finalScore: number | null;
  summaryScore10: number | null;
  summaryScore4: number | null;
  gradeChar: string | null;
  isPassed: boolean;
  isGpaCalculated: boolean;
}

export interface ParsedSemester {
  semester: SemesterRef;
  courses: ParsedCourse[];
}

// ============================================================
//  Academic Macro Metrics SSOT & Ingestion Types
// ============================================================

export interface AcademicMacroMetricSSOT {
  semesterId: string;
  semesterLabel: string;
  yearName: string;
  termGpa: number;
  cumulativeGpa: number;
  termCredits: number;
  cumulativeCredits: number;
  drlScore: number;
  rankLabel: string;
  updatedAt: number;
}

export interface AcademicRadarMetrics {
  semesterId: string;
  termGpa: number;
  cumulativeGpa: number;
  classification: string;
  termCredits: number;
  cumulativeCredits: number;
  drl: number | null;
}

export interface SubjectPayload {
  id: string;
  subject_code: string;
  subject_name: string;
  number_of_credit: number;
  process_point?: string | null;
  midterm_score?: string | null;
  practice_point?: string | null;
  final_point?: string | null;
  course_point: string;
  note?: string | null;
}

export interface SemesterGroupPayload {
  semester_key: string;
  semester_label: string;
  year_name: string;
  total_credit: number;
  average_point: number;
  subjects: SubjectPayload[];
}

export interface DrlItemPayload {
  semester: string;
  point: number;
}

export interface FullPortalIngestionRequest {
  semester_groups: SemesterGroupPayload[];
  drl_history: DrlItemPayload[];
}

// ============================================================
//  UIT Workload & Scholarship Eligibility Types
// ============================================================

export type UitWorkloadTier =
  | "overload"
  | "below_floor"
  | "optimal"
  | "high_pace"
  | "max_limit";

export interface UitWorkloadEvaluation {
  tier: UitWorkloadTier;
  creditsPerTerm: number;
  label: string;
  badgeColor: string;
  advice: string;
  scholarshipEligible: boolean;
  isInvalid: boolean;
}

// ============================================================
//  Degree Audit & Curriculum Engine Types
// ============================================================

export interface AuditCourseItem {
  courseCode: string;
  courseName: string;
  credits: number;
  grade10: number | null;
  gradeChar: string | null;
  semesterId: string;
  isCompulsory: boolean;
  knowledgeBlock: string;
}

export interface BlockAuditResult {
  knowledgeBlock: string;
  blockNameDisplay: string;
  requiredCredits: number;
  completedCredits: number;
  isFulfilled: boolean;
  compulsoryFulfilled: boolean;
  missingCompulsoryCodes: string[];
  passedCourses: AuditCourseItem[];
  remainingElectives?: AuditCourseItem[];
  overflowCredits: number;
}

export interface NonCreditPrerequisites {
  hasGdtc: boolean;
  hasGdqp: boolean;
  hasEnglish: boolean;
  hasDrl65: boolean;
  details: string[];
}

export interface DegreeAuditReport {
  slug: string;
  majorName: string;
  cohortYear: number | null;
  totalDegreeCredits: number;
  totalEarnedCredits: number;
  totalRequiredCredits: number;
  completionPercent: number;
  isGraduationReady: boolean;
  blockAudits: BlockAuditResult[];
  nonCreditPrerequisites: NonCreditPrerequisites;
  unmatchedPassedCourses: AuditCourseItem[];
}

export interface CurriculumIndexDto {
  slug: string;
  majorName: string;
  degreeLevel: string | null;
  cohortYear: number | null;
  cohortNum: number | null;
  totalCredits: number | null;
  trainingDuration: string | null;
  trainingForm: string | null;
  isCached: boolean;
  updatedAt: number | null;
}
