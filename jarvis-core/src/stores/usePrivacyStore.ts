import { create } from 'zustand';

interface PrivacyStore {
  isDemoMode: boolean;
  toggleDemoMode: () => void;
  setDemoMode: (value: boolean) => void;
}

export const usePrivacyStore = create<PrivacyStore>((set) => ({
  isDemoMode: false,
  toggleDemoMode: () => set((state) => ({ isDemoMode: !state.isDemoMode })),
  setDemoMode: (value) => set({ isDemoMode: value }),
}));
