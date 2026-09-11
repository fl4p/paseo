import { create } from "zustand";
import type {
  TerminalSearchInput,
  TerminalSearchResult,
} from "@/terminal/runtime/terminal-emulator-runtime";

/**
 * The terminal whose buffer Find should search, published by the focused
 * terminal pane. A terminal claims Find ahead of an agent transcript: it is
 * the pane the reader clicked into, while a transcript panel merely sits in
 * the active tab.
 */
export interface TerminalFindSource {
  terminalId: string;
  find: (input: TerminalSearchInput) => void;
  /** Drops the match highlights; called when the bar closes or moves on. */
  clear: () => void;
}

interface TerminalFindState {
  source: TerminalFindSource | null;
  /** The search addon's latest answer for the current source. */
  result: TerminalSearchResult | null;
  setSource: (source: TerminalFindSource) => void;
  /** Ignored unless it answers for the terminal that claimed Find. */
  reportResult: (terminalId: string, result: TerminalSearchResult) => void;
  clearSource: (terminalId: string) => void;
}

export const useTerminalFindStore = create<TerminalFindState>((set, get) => ({
  source: null,
  result: null,
  setSource: (source) => set({ source, result: null }),
  reportResult: (terminalId, result) => {
    if (get().source?.terminalId !== terminalId) {
      return;
    }
    set({ result });
  },
  clearSource: (terminalId) => {
    if (get().source?.terminalId === terminalId) {
      set({ source: null, result: null });
    }
  },
}));
