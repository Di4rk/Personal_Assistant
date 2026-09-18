import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAcademicOverview,
  getSemesterCourses,
  upsertAcademicCourses,
  upsertAcademicSemester,
} from "../../../lib/tauri-client";
import type {
  AcademicOverviewDto,
  AcademicCourseRecord,
  UpsertCourseDto,
  UpsertSemesterDto,
} from "../types";

export interface UseAcademicRadarOptions {
  /** Tự động nạp overview khi component mount (mặc định: true). */
  autoFetch?: boolean;
  /** ID học kỳ chọn mặc định ban đầu (nếu có). */
  initialSemesterId?: string | null;
}

export interface UseAcademicRadarReturn {
  /** Danh sách học kỳ kèm thống kê động (GPA hệ 10, GPA hệ 4, DRL, tín chỉ). */
  overview: AcademicOverviewDto[];
  /** Học kỳ hiện tại đang được chọn. */
  selectedSemesterId: string | null;
  /** Danh sách môn học của học kỳ đang chọn. */
  courses: AcademicCourseRecord[];
  /** Trạng thái đang tải dữ liệu tổng quan học kỳ. */
  isLoadingOverview: boolean;
  /** Trạng thái đang tải môn học của học kỳ đang chọn. */
  isLoadingCourses: boolean;
  /** Lỗi gần nhất gặp phải (hoặc null nếu bình thường). */
  error: string | null;
  /** Chọn 1 học kỳ để hiển thị chi tiết môn học. */
  selectSemester: (semesterId: string | null) => void;
  /** Tải lại toàn bộ overview từ backend. */
  refetchOverview: () => Promise<void>;
  /** Tải lại danh sách môn học cho 1 học kỳ (mặc định là học kỳ đang chọn). */
  refetchCourses: (semesterId?: string) => Promise<void>;
  /**
   * Batch upsert danh sách môn học.
   * Tự động refetch lại overview và courses sau khi ghi thành công.
   */
  saveCourses: (coursesToSave: UpsertCourseDto[]) => Promise<boolean>;
  /**
   * Tạo hoặc cập nhật metadata học kỳ.
   * Tự động refetch lại overview sau khi ghi thành công.
   */
  saveSemester: (semesterToSave: UpsertSemesterDto) => Promise<boolean>;
}

/**
 * Hook quản lý trạng thái Academic Radar cho React UI.
 *
 * Tuân thủ nghiêm ngặt React 18 StrictMode:
 * 1. Chống zombie state / state update trên component đã unmount qua lifecycle ref.
 * 2. Chống race conditions khi người dùng chuyển đổi qua lại nhanh giữa các học kỳ (request sequence tracking).
 * 3. Tự động đồng bộ các chỉ số tính động (dynamic GPA/credits) sau mỗi thao tác mutation.
 */
export function useAcademicRadar(options: UseAcademicRadarOptions = {}): UseAcademicRadarReturn {
  const { autoFetch = true, initialSemesterId = null } = options;

  const [overview, setOverview] = useState<AcademicOverviewDto[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState<string | null>(initialSemesterId);
  const [courses, setCourses] = useState<AcademicCourseRecord[]>([]);
  const [isLoadingOverview, setIsLoadingOverview] = useState<boolean>(false);
  const [isLoadingCourses, setIsLoadingCourses] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Ref tracking mount lifecycle nhằm chống zombie state khi StrictMode mount/unmount kép
  const isMountedRef = useRef<boolean>(true);
  // Ref tracking ID của request getSemesterCourses mới nhất để chống race condition
  const latestCoursesRequestIdRef = useRef<number>(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchOverviewInternal = useCallback(async () => {
    setIsLoadingOverview(true);
    setError(null);

    try {
      const data = await getAcademicOverview();
      if (isMountedRef.current) {
        setOverview(data);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const message = typeof err === "string" ? err : (err instanceof Error ? err.message : "Lỗi khi lấy dữ liệu tổng quan học kỳ");
        setError(message);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoadingOverview(false);
      }
    }
  }, []);

  const fetchCoursesInternal = useCallback(async (semesterId: string) => {
    const requestId = ++latestCoursesRequestIdRef.current;
    setIsLoadingCourses(true);
    setError(null);

    try {
      const data = await getSemesterCourses(semesterId);
      // Chỉ cập nhật nếu component còn mount VÀ đây là request mới nhất
      if (isMountedRef.current && requestId === latestCoursesRequestIdRef.current) {
        setCourses(data);
      }
    } catch (err) {
      if (isMountedRef.current && requestId === latestCoursesRequestIdRef.current) {
        const message = typeof err === "string" ? err : (err instanceof Error ? err.message : `Lỗi khi nạp danh sách môn học của học kỳ ${semesterId}`);
        setError(message);
        setCourses([]);
      }
    } finally {
      if (isMountedRef.current && requestId === latestCoursesRequestIdRef.current) {
        setIsLoadingCourses(false);
      }
    }
  }, []);

  // Mount effect cho initial overview fetch
  useEffect(() => {
    if (autoFetch) {
      fetchOverviewInternal();
    }
  }, [autoFetch, fetchOverviewInternal]);

  // Effect khi selectedSemesterId thay đổi
  useEffect(() => {
    if (selectedSemesterId) {
      fetchCoursesInternal(selectedSemesterId);
    } else {
      setCourses([]);
      setIsLoadingCourses(false);
    }
  }, [selectedSemesterId, fetchCoursesInternal]);

  const selectSemester = useCallback((semesterId: string | null) => {
    setSelectedSemesterId(semesterId);
  }, []);

  const refetchOverview = useCallback(async () => {
    await fetchOverviewInternal();
  }, [fetchOverviewInternal]);

  const refetchCourses = useCallback(async (semesterId?: string) => {
    const targetId = semesterId ?? selectedSemesterId;
    if (targetId) {
      await fetchCoursesInternal(targetId);
    }
  }, [selectedSemesterId, fetchCoursesInternal]);

  const saveCourses = useCallback(async (coursesToSave: UpsertCourseDto[]): Promise<boolean> => {
    setError(null);
    try {
      await upsertAcademicCourses(coursesToSave);
      // Cập nhật lại cả overview lẫn courses vì điểm môn học ảnh hưởng trực tiếp đến GPA/tín chỉ
      await fetchOverviewInternal();
      if (selectedSemesterId) {
        await fetchCoursesInternal(selectedSemesterId);
      }
      return true;
    } catch (err) {
      if (isMountedRef.current) {
        const message = typeof err === "string" ? err : (err instanceof Error ? err.message : "Lỗi khi lưu danh sách môn học");
        setError(message);
      }
      return false;
    }
  }, [fetchOverviewInternal, fetchCoursesInternal, selectedSemesterId]);

  const saveSemester = useCallback(async (semesterToSave: UpsertSemesterDto): Promise<boolean> => {
    setError(null);
    try {
      await upsertAcademicSemester(semesterToSave);
      await fetchOverviewInternal();
      return true;
    } catch (err) {
      if (isMountedRef.current) {
        const message = typeof err === "string" ? err : (err instanceof Error ? err.message : "Lỗi khi lưu thông tin học kỳ");
        setError(message);
      }
      return false;
    }
  }, [fetchOverviewInternal]);

  return {
    overview,
    selectedSemesterId,
    courses,
    isLoadingOverview,
    isLoadingCourses,
    error,
    selectSemester,
    refetchOverview,
    refetchCourses,
    saveCourses,
    saveSemester,
  };
}
