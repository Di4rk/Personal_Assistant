export interface WecodeSubmission {
  submission_id: number;
  assignment_id: number;
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
