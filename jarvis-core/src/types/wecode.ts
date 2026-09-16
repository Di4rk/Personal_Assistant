export interface WecodeSubmission {
  submission_id: number;
  assignment_id: number;
  assignment_name?: string;
  classes?: string;
  problem_id: number;
  problem_name: string;
  submit_time_str: string;
  verdict: string;
  score: number;
  execution_time: number;
  memory_kib: number;
  language: string;
  is_final: boolean;
}

export interface WecodeAssignmentMeta {
  id: number;
  name: string;
  classes?: string;
  total_problems: number;
  start_time?: string;
  finish_time?: string;
  base_url?: string;
}

export interface WecodeProblemRecord {
  assignment_id: number;
  problem_id: number;
  problem_name: string;
  problem_order: number;
  max_score: number;
  is_ac: boolean;
  problem_url?: string;
}

export type WecodeDeadlineStatus = 'unlimited' | 'closed' | 'critical' | 'urgent' | 'open';

export interface WecodeDeadlineInfo {
  status: WecodeDeadlineStatus;
  label: string;
  badgeColor: string;
  finishTimeStr: string;
}

export interface WecodeProblemSummary {
  problem_id: number;
  problem_name: string;
  assignment_id: number;
  assignment_name?: string;
  bestSubmission?: WecodeSubmission;
  submissions: WecodeSubmission[]; // Lịch sử submit sắp xếp từ mới nhất -> cũ nhất
  totalAttempts: number;
  isSolved: boolean;
  bestScore: number;
  order?: number;
  maxScore?: number;
  problem_url?: string;
}

export interface WecodeAssignmentGroup {
  id: number;
  name: string;
  classes: string[]; // Ví dụ: ["IT003.Q210.1", "IT003.Q27.1"]
  courseCode: string; // Ví dụ: "IT003", "IT001", hoặc "OTHER"
  problems: WecodeProblemSummary[];
  totalProblems: number;
  solvedProblems: number;
  totalSubmissions: number;
  earnedScore: number;
  start_time?: string;
  finish_time?: string;
  base_url?: string;
  deadlineStatus: WecodeDeadlineStatus;
  deadlineLabel: string;
  deadlineBadgeColor: string;
  primaryClass?: string;
  additionalClasses: string[];
}

export interface WecodeCourseSummary {
  courseCode: string; // Ví dụ: "IT003", "IT001", "CS112"
  totalAssignments: number;
  assignments: WecodeAssignmentGroup[];
  totalProblems: number;
  solvedProblems: number;
}
