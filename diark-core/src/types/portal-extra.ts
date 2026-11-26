export interface PortalRegisteredClass {
  id: number;
  code: string;
  subject_code: string;
  subject_name: string;
  subject_id: number;
  has_syllabus: boolean;
  credit: number;
  lecturer: string;
  method_code: string;
  start_date: string;
  end_date: string;
  slots_json: string;
  hoc_ky: number;
  year_id: number;
  updated_at: number;
}

export interface PortalTimetableSlot {
  id: string;
  ma_lop: string;
  ten_mon_hoc: string;
  ngay: string;
  thu: number;
  tiet_bat_dau: number;
  tiet_ket_thuc: number;
  phong: string;
  hinh_thuc: string;
  ten_giang_vien: string;
  lecturer_title: string;
  subject_id: number;
  trang_thai: string;
  hoc_ky: number;
  nam_hoc: number;
  updated_at: number;
}

export interface PortalTuitionRecord {
  id: number;
  period: string;
  semester: string;
  year_id_name: string;
  subject_codes: string;
  tuition_amount: number;
  must_be_paid: number;
  paid: number;
  remaining: number;
  payment_status: string;
  payment_status_label: string;
  tuition_status: string;
  tuition_status_label: string;
  period_1_due_date: string;
  period_2_due_date: string;
  paid_time_formatted: string;
  details_json: string;
  updated_at: number;
}

export interface PortalCertificate {
  id: string;
  cert_type: string;
  tongdiem: number;
  capdo: string;
  ngaythi: string;
  status: string;
  output_standard: boolean;
  create_date: string;
  updated_at: number;
}

export interface PortalClassActivity {
  id: string;
  ngay: string;
  tiet_bat_dau: number;
  tiet_ket_thuc: number;
  noi_dung: string;
  dia_diem: string;
  gv_chu_tri: string;
  status: string;
  updated_at: number;
}

export interface GoogleCalendarConfig {
  id: string;
  name: string;
  ics_url: string;
  color: string;
  is_enabled: boolean;
  last_synced_at: number;
  created_at: number;
  source: "oauth" | "ics" | string;
  google_calendar_id: string;
  can_write: boolean;
}

export interface GoogleOAuthStatus {
  connected: boolean;
  email: string;
  is_configured: boolean;
  is_embedded_config: boolean;
  has_custom_config: boolean;
}

export interface CreateGoogleEventInput {
  calendar_id: string;
  summary: string;
  date: string;
  end_date?: string;
  start_time: string;
  end_time: string;
  all_day: boolean;
  location: string;
  description: string;
}

export interface PushUitScheduleSummary {
  calendar_id: string;
  calendar_name: string;
  pushed_classes: number;
  pushed_exams: number;
  errors: string[];
}

export interface CalendarEvent {
  uid: string;
  calendar_id: string;
  summary: string;
  description: string;
  location: string;
  start_ts: number;
  end_ts: number;
  all_day: boolean;
  updated_at: number;
}

export interface GoogleCalendarSyncSummary {
  synced_calendars: number;
  total_events: number;
  errors: string[];
}

export interface MoodleGrade {
  course_id: number;
  course_name: string;
  grade_text: string;
  grade_numeric: number | null;
  updated_at: number;
}

export interface MoodleNotification {
  id: number;
  subject: string;
  shortened_subject: string;
  full_message: string;
  is_read: boolean;
  created_at: number;
}
