import { create } from 'zustand';
import type { AcademicCourseRecord, AcademicMacroMetricSSOT } from '../features/academic/types';

export interface AcademicState {
  profile: unknown | null;
  courses: AcademicCourseRecord[];
  drl: unknown[];
  macroMetrics: AcademicMacroMetricSSOT[] | null;
  isLoading: boolean;
  reset: () => void;
  setCourses: (courses: AcademicCourseRecord[]) => void;
  setMacroMetrics: (metrics: AcademicMacroMetricSSOT[] | null) => void;
  setIsLoading: (loading: boolean) => void;
}

const initialAcademicState = {
  profile: null,
  courses: [],
  drl: [],
  macroMetrics: null,
  isLoading: false,
};

export const useAcademicStore = create<AcademicState>((set) => ({
  ...initialAcademicState,
  reset: () => set(initialAcademicState),
  setCourses: (courses) => set({ courses }),
  setMacroMetrics: (macroMetrics) => set({ macroMetrics }),
  setIsLoading: (isLoading) => set({ isLoading }),
}));
