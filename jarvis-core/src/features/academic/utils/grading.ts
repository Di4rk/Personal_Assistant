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
