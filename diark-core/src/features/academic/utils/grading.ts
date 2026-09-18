export type CompositeRewardRank = 'Xuất sắc' | 'Giỏi' | 'Khá' | 'Trung bình' | 'Không xếp loại';

/**
 * Tính xếp loại thi đua / khen thưởng sinh viên ĐHQG-HCM dựa trên kết hợp đồng thời cả GPA và ĐRL.
 * Compute-on-read thuần túy, không mutate database.
 */
export function calculateCompositeRewardRank(gpa10: number, drl: number): CompositeRewardRank {
  if (gpa10 >= 9.0 && drl >= 90) return 'Xuất sắc';
  if (gpa10 >= 8.0 && drl >= 80) return 'Giỏi';
  if (gpa10 >= 7.0 && drl >= 65) return 'Khá';
  if (gpa10 >= 5.0 && drl >= 50) return 'Trung bình';
  return 'Không xếp loại';
}

/**
 * Phân loại học lực thuần túy theo thang điểm 10 quy chế ĐHQG-HCM.
 */
export function getGpaClassification(gpa10: number): string {
  if (gpa10 >= 9.0) return 'Xuất sắc';
  if (gpa10 >= 8.0) return 'Giỏi';
  if (gpa10 >= 7.0) return 'Khá';
  if (gpa10 >= 5.0) return 'Trung bình';
  if (gpa10 >= 4.0) return 'Yếu';
  return 'Kém';
}

export interface GradeMetrics {
  score4: number;
  gradeChar: string;
  isPassed: boolean;
  classification: string;
}

/**
 * Pure Domain Function tính toán Hệ 4 và Điểm chữ chuẩn Quy chế Đào tạo ĐHQG-HCM.
 * Dùng làm Compute-on-Render fallback khi DB mang giá trị NULL hoặc chưa đồng bộ.
 */
export function computeGradeMetrics(score10: number | null | undefined, isGpaCalculated = true): GradeMetrics {
  if (score10 === null || score10 === undefined || isNaN(score10)) {
    return { score4: 0, gradeChar: '—', isPassed: false, classification: 'Chưa có điểm' };
  }

  const s = Math.min(Math.max(score10, 0), 10);

  if (s >= 9.0) return { score4: 4.0, gradeChar: 'A+', isPassed: true, classification: 'Xuất sắc' };
  if (s >= 8.5) return { score4: 3.7, gradeChar: 'A', isPassed: true, classification: 'Giỏi' };
  if (s >= 8.0) return { score4: 3.5, gradeChar: 'B+', isPassed: true, classification: 'Khá giỏi' };
  if (s >= 7.0) return { score4: 3.0, gradeChar: 'B', isPassed: true, classification: 'Khá' };
  if (s >= 6.0) return { score4: 2.5, gradeChar: 'C+', isPassed: true, classification: 'Trung bình khá' };
  if (s >= 5.5) return { score4: 2.0, gradeChar: 'C', isPassed: true, classification: 'Trung bình' };
  if (s >= 5.0) return { score4: 1.5, gradeChar: 'D+', isPassed: true, classification: 'Trung bình yếu' };
  if (s >= 4.0) return { score4: 1.0, gradeChar: 'D', isPassed: true, classification: 'Yếu' };
  
  return { score4: 0.0, gradeChar: 'F', isPassed: !isGpaCalculated ? s >= 4.0 : false, classification: 'Kém' };
}

