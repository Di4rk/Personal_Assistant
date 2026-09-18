import { create } from 'zustand';
import type { WecodeSubmission } from '../types/wecode';

export interface WecodeState {
  assignments: unknown[];
  submissions: WecodeSubmission[];
  stats: unknown | null;
  isLoading: boolean;
  reset: () => void;
  setSubmissions: (submissions: WecodeSubmission[]) => void;
  setIsLoading: (isLoading: boolean) => void;
}

const initialWecodeState = {
  assignments: [],
  submissions: [],
  stats: null,
  isLoading: false,
};

export const useWecodeStore = create<WecodeState>((set) => ({
  ...initialWecodeState,
  reset: () => set(initialWecodeState),
  setSubmissions: (submissions) => set({ submissions }),
  setIsLoading: (isLoading) => set({ isLoading }),
}));
