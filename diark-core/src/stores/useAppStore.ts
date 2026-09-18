import { create } from 'zustand';

export interface AppState {
  genesisCompleted: boolean;
  currentView: 'genesis' | 'main';
  setGenesisCompleted: (completed: boolean) => void;
  reset: () => void;
}

const initialAppState = {
  genesisCompleted: false,
  currentView: 'genesis' as const,
};

export const useAppStore = create<AppState>((set) => ({
  ...initialAppState,
  setGenesisCompleted: (completed: boolean) =>
    set({
      genesisCompleted: completed,
      currentView: completed ? 'main' : 'genesis',
    }),
  reset: () => set({ genesisCompleted: false, currentView: 'genesis' }),
}));
