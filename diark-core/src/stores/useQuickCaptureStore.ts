import { create } from "zustand";

export interface QuickNotePrefill {
  mode: "algo" | "onenote" | "teaching";
  title: string;
  platformLink: string;
  tags: string[];
  codeSnippet?: string;
  prose?: string;
}

interface QuickCaptureStoreState {
  isOpen: boolean;
  prefill: QuickNotePrefill | null;
  openQuickCapture: (prefill?: QuickNotePrefill) => void;
  closeQuickCapture: () => void;
}

export const useQuickCaptureStore = create<QuickCaptureStoreState>((set) => ({
  isOpen: false,
  prefill: null,
  openQuickCapture: (prefill) => set({ isOpen: true, prefill: prefill || null }),
  closeQuickCapture: () => set({ isOpen: false, prefill: null }),
}));
