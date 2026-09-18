import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PrivacyStore {
  isDemoMode: boolean;
  toggleDemoMode: () => void;
  setDemoMode: (value: boolean) => void;
}

export const usePrivacyStore = create<PrivacyStore>()(
  persist(
    (set) => ({
      isDemoMode: false,
      toggleDemoMode: () => set((state) => ({ isDemoMode: !state.isDemoMode })),
      setDemoMode: (value) => set({ isDemoMode: value }),
    }),
    {
      name: 'diark-privacy-mode',
    }
  )
);
