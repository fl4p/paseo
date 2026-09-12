import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export const MAX_PROMPT_HISTORY_SIZE = 500;

export const PromptHistoryPersistedStateSchema = z.strictObject({
  history: z.array(z.string()),
});

export type PromptHistoryPersistedState = z.infer<typeof PromptHistoryPersistedStateSchema>;

export interface PromptHistoryStoreState {
  history: string[];
  addPrompt: (prompt: string) => void;
  clearHistory: () => void;
  getHistory: () => string[];
}

export function appendPromptToHistory(
  current: readonly string[],
  rawPrompt: string,
  maxSize: number = MAX_PROMPT_HISTORY_SIZE,
): string[] {
  const trimmed = rawPrompt.trim();
  if (!trimmed) {
    return [...current];
  }
  // Remove existing duplicate and append to the end (most recent)
  const next = current.filter((item) => item !== trimmed);
  next.push(trimmed);
  if (next.length > maxSize) {
    return next.slice(next.length - maxSize);
  }
  return next;
}

function createSafeStorage(backingStorage: StateStorage): StateStorage {
  return {
    getItem: async (key: string) => {
      try {
        return await backingStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: async (key: string, value: string) => {
      try {
        await backingStorage.setItem(key, value);
      } catch {
        // In node test environments without window/localStorage, fail silently
      }
    },
    removeItem: async (key: string) => {
      try {
        await backingStorage.removeItem(key);
      } catch {
        // In node test environments without window/localStorage, fail silently
      }
    },
  };
}

export function createPromptHistoryStore(backingStorage: StateStorage = AsyncStorage) {
  const safeStorage = createSafeStorage(backingStorage);
  return create<PromptHistoryStoreState>()(
    persist(
      (set, get) => ({
        history: [],
        addPrompt: (prompt) => {
          set((state) => ({
            history: appendPromptToHistory(state.history, prompt),
          }));
        },
        clearHistory: () => set({ history: [] }),
        getHistory: () => get().history,
      }),
      {
        name: "prompt-history",
        storage: createValidatedPersistStorage(safeStorage, PromptHistoryPersistedStateSchema),
        partialize: (state) => ({
          history: state.history,
        }),
        version: 1,
      },
    ),
  );
}

export const usePromptHistoryStore = createPromptHistoryStore();
