import { describe, expect, it } from "vitest";
import { appendPromptToHistory, createPromptHistoryStore } from "./prompt-history-store";

describe("appendPromptToHistory", () => {
  it("appends a trimmed prompt to the end of history", () => {
    const history = ["first", "second"];
    const result = appendPromptToHistory(history, "  third  ");
    expect(result).toEqual(["first", "second", "third"]);
  });

  it("ignores blank prompts", () => {
    const history = ["first"];
    expect(appendPromptToHistory(history, "")).toEqual(["first"]);
    expect(appendPromptToHistory(history, "   \n\t  ")).toEqual(["first"]);
  });

  it("moves duplicate prompt to the end as most recent", () => {
    const history = ["first", "second", "third"];
    const result = appendPromptToHistory(history, "first");
    expect(result).toEqual(["second", "third", "first"]);
  });

  it("caps history at maxSize", () => {
    const history = ["a", "b", "c"];
    const result = appendPromptToHistory(history, "d", 3);
    expect(result).toEqual(["b", "c", "d"]);
  });
});

describe("createPromptHistoryStore", () => {
  function createMemoryStorage() {
    const memory = new Map<string, string>();
    return {
      getItem: async (key: string) => memory.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: async (key: string) => {
        memory.delete(key);
      },
    };
  }

  it("stores and clears prompts", () => {
    const storage = createMemoryStorage();
    const store = createPromptHistoryStore(storage);

    store.getState().addPrompt("hello world");
    store.getState().addPrompt("second prompt");
    expect(store.getState().getHistory()).toEqual(["hello world", "second prompt"]);

    store.getState().clearHistory();
    expect(store.getState().getHistory()).toEqual([]);
  });
});
