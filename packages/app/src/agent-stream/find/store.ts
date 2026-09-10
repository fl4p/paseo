import { create } from "zustand";
import type { StreamItem } from "@/types/stream";

/**
 * The transcript that Find should search, published by the mounted agent
 * stream. Find lives in app chrome and the transcript owns the scroll machinery,
 * so the two meet here rather than through the component tree.
 */
export interface TranscriptFindSource {
  agentId: string;
  items: readonly StreamItem[];
  /** Reveals a row that partial virtualization has unmounted, then scrolls to it. */
  jumpToItem: (itemId: string) => void;
}

interface TranscriptFindState {
  source: TranscriptFindSource | null;
  setSource: (source: TranscriptFindSource) => void;
  /** Ignored when another transcript has already taken over. */
  clearSource: (agentId: string) => void;
}

export const useTranscriptFindStore = create<TranscriptFindState>((set, get) => ({
  source: null,
  setSource: (source) => set({ source }),
  clearSource: (agentId) => {
    if (get().source?.agentId === agentId) {
      set({ source: null });
    }
  },
}));
