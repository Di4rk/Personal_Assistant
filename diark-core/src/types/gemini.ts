// Types for Gemini AI Copilot (BYOK, Socratic Debugger, Smart Task Extractor)

export interface GeminiConfig {
  api_key: string;
  model: string;
}

export interface GeminiStreamChunk {
  session_id: string;
  chunk: string;
  is_done: boolean;
  error?: string | null;
}

export interface SocraticDebugRequest {
  session_id: string;
  problem_name: string;
  problem_id?: number | null;
  verdict: string;
  score: number;
  execution_time: number;
  memory_kib: number;
  language: string;
  code_snippet?: string | null;
  user_query?: string | null;
}

export interface TaskExtractionRequest {
  prose_text: string;
  course_hint?: string | null;
}

export interface ExtractedTask {
  title: string;
  course_code: string;
  course_name: string;
  due_date_str: string;
  due_timestamp: number;
  priority: 'urgent' | 'high' | 'normal' | string;
  description: string;
  task_type: 'assignment' | 'quiz' | 'lab' | 'report' | 'exam' | 'general' | string;
}
