import { create } from "zustand";
import type { HistorySearchResult } from "@/agent-stream/find/model";
import type { StreamItem } from "@/types/stream";

/**
 * The daemon's side of transcript Find: the full timeline, including history
 * the transcript has not loaded.
 */
export interface TranscriptHistorySearch {
  /** The timeline epoch the loaded rows belong to; results from another epoch do not apply. */
  epoch: string;
  search: (query: string) => Promise<HistorySearchResult>;
  /** Loads the history window around a timeline position into the transcript. */
  load: (seq: number) => void;
}

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
  /** Null when the host daemon cannot search timeline history. */
  history: TranscriptHistorySearch | null;
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
