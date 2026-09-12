import { describe, expect, it, vi } from "vitest";
import {
  buildCombinedPromptHistory,
  createInitialPromptHistoryNavigationState,
  deduplicatePrompts,
  handlePromptHistoryKeyPress,
  type PromptHistoryNavigationState,
} from "./prompt-history";

describe("deduplicatePrompts", () => {
  it("keeps unique prompts and preserves the latest occurrence of duplicates", () => {
    const input = ["apple", "banana", "apple", "cherry"];
    expect(deduplicatePrompts(input)).toEqual(["banana", "apple", "cherry"]);
  });

  it("trims whitespace and ignores empty prompts", () => {
    const input = ["  ", "first", "   ", "second  ", ""];
    expect(deduplicatePrompts(input)).toEqual(["first", "second"]);
  });
});

describe("buildCombinedPromptHistory", () => {
  it("places session prompts at the newest end, preceded by earlier global prompts", () => {
    const globalHistory = ["cmd1", "cmd2", "cmd3"];
    const sessionPrompts = ["cmd2", "cmd4"];

    const combined = buildCombinedPromptHistory(globalHistory, sessionPrompts);
    expect(combined).toEqual(["cmd1", "cmd3", "cmd2", "cmd4"]);
  });

  it("handles empty session prompts", () => {
    const globalHistory = ["cmd1", "cmd2"];
    expect(buildCombinedPromptHistory(globalHistory, [])).toEqual(["cmd1", "cmd2"]);
    expect(buildCombinedPromptHistory(globalHistory, undefined)).toEqual(["cmd1", "cmd2"]);
  });

  it("handles empty global history", () => {
    const sessionPrompts = ["session1", "session2"];
    expect(buildCombinedPromptHistory([], sessionPrompts)).toEqual(["session1", "session2"]);
  });
});

describe("handlePromptHistoryKeyPress", () => {
  const history = ["first prompt", "second prompt", "third prompt"];

  function runKey(input: {
    key: string;
    inputText: string;
    state?: PromptHistoryNavigationState;
    historyList?: string[];
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  }) {
    const replaceText = vi.fn();
    const preventDefault = vi.fn();
    const state = input.state ?? createInitialPromptHistoryNavigationState();

    const result = handlePromptHistoryKeyPress({
      key: input.key,
      shiftKey: input.shiftKey,
      metaKey: input.metaKey,
      ctrlKey: input.ctrlKey,
      altKey: input.altKey,
      inputText: input.inputText,
      history: input.historyList ?? history,
      state,
      replaceText,
      preventDefault,
    });

    return { ...result, replaceText, preventDefault };
  }

  it("starts history navigation on blank prompt input with ArrowUp", () => {
    const step1 = runKey({ key: "ArrowUp", inputText: "" });
    expect(step1.handled).toBe(true);
    expect(step1.preventDefault).toHaveBeenCalled();
    expect(step1.replaceText).toHaveBeenCalledWith("third prompt", { start: 12, end: 12 });
    expect(step1.nextState).toEqual({
      historyIndex: 2,
      stash: "",
    });
  });

  it("supports whitespace-only input as blank", () => {
    const step = runKey({ key: "ArrowUp", inputText: "   " });
    expect(step.handled).toBe(true);
    expect(step.replaceText).toHaveBeenCalledWith("third prompt", { start: 12, end: 12 });
    expect(step.nextState.stash).toBe("   ");
  });

  it("does not intercept ArrowUp if input is not blank and not navigating", () => {
    const step = runKey({ key: "ArrowUp", inputText: "some existing text" });
    expect(step.handled).toBe(false);
    expect(step.preventDefault).not.toHaveBeenCalled();
    expect(step.replaceText).not.toHaveBeenCalled();
  });

  it("does not intercept ArrowUp when history is empty", () => {
    const step = runKey({ key: "ArrowUp", inputText: "", historyList: [] });
    expect(step.handled).toBe(false);
    expect(step.preventDefault).not.toHaveBeenCalled();
  });

  it("scrolls backward through history on repeated ArrowUp and stays at oldest", () => {
    // Step 1: blank input -> newest prompt (index 2: "third prompt")
    const step1 = runKey({ key: "ArrowUp", inputText: "" });
    expect(step1.nextState.historyIndex).toBe(2);

    // Step 2: ArrowUp on "third prompt" -> index 1: "second prompt"
    const step2 = runKey({ key: "ArrowUp", inputText: "third prompt", state: step1.nextState });
    expect(step2.handled).toBe(true);
    expect(step2.replaceText).toHaveBeenCalledWith("second prompt", { start: 13, end: 13 });
    expect(step2.nextState.historyIndex).toBe(1);

    // Step 3: ArrowUp on "second prompt" -> index 0: "first prompt"
    const step3 = runKey({ key: "ArrowUp", inputText: "second prompt", state: step2.nextState });
    expect(step3.handled).toBe(true);
    expect(step3.replaceText).toHaveBeenCalledWith("first prompt", { start: 12, end: 12 });
    expect(step3.nextState.historyIndex).toBe(0);

    // Step 4: ArrowUp at oldest -> stays at index 0
    const step4 = runKey({ key: "ArrowUp", inputText: "first prompt", state: step3.nextState });
    expect(step4.handled).toBe(true);
    expect(step4.preventDefault).toHaveBeenCalled();
    expect(step4.replaceText).toHaveBeenCalledWith("first prompt", { start: 12, end: 12 });
    expect(step4.nextState.historyIndex).toBe(0);
  });

  it("scrolls forward with ArrowDown and restores the blank stash at the end", () => {
    // Start at index 1 ("second prompt") with blank stash
    const state: PromptHistoryNavigationState = { historyIndex: 1, stash: "" };

    // Step 1: ArrowDown -> index 2 ("third prompt")
    const step1 = runKey({ key: "ArrowDown", inputText: "second prompt", state });
    expect(step1.handled).toBe(true);
    expect(step1.replaceText).toHaveBeenCalledWith("third prompt", { start: 12, end: 12 });
    expect(step1.nextState.historyIndex).toBe(2);

    // Step 2: ArrowDown at newest -> restores blank stash and resets index
    const step2 = runKey({ key: "ArrowDown", inputText: "third prompt", state: step1.nextState });
    expect(step2.handled).toBe(true);
    expect(step2.replaceText).toHaveBeenCalledWith("", { start: 0, end: 0 });
    expect(step2.nextState.historyIndex).toBe(-1);
  });

  it("does not intercept ArrowDown when not navigating", () => {
    const step = runKey({ key: "ArrowDown", inputText: "" });
    expect(step.handled).toBe(false);
    expect(step.preventDefault).not.toHaveBeenCalled();
  });

  it("restores stash and exits navigation on Escape", () => {
    const state: PromptHistoryNavigationState = { historyIndex: 1, stash: "draft-stash" };
    const step = runKey({ key: "Escape", inputText: "second prompt", state });
    expect(step.handled).toBe(true);
    expect(step.preventDefault).toHaveBeenCalled();
    expect(step.replaceText).toHaveBeenCalledWith("draft-stash", { start: 11, end: 11 });
    expect(step.nextState.historyIndex).toBe(-1);
  });

  it("exits history navigation if user modified the recalled prompt", () => {
    const state: PromptHistoryNavigationState = { historyIndex: 2, stash: "" };
    // User edited "third prompt" to "third prompt with edits"
    const step = runKey({
      key: "ArrowUp",
      inputText: "third prompt with edits",
      state,
    });
    expect(step.handled).toBe(false);
    expect(step.nextState.historyIndex).toBe(-1);
    expect(step.replaceText).not.toHaveBeenCalled();
  });

  it("ignores keypress when modifier keys are pressed", () => {
    const stepShift = runKey({ key: "ArrowUp", inputText: "", shiftKey: true });
    expect(stepShift.handled).toBe(false);

    const stepMeta = runKey({ key: "ArrowUp", inputText: "", metaKey: true });
    expect(stepMeta.handled).toBe(false);

    const stepCtrl = runKey({ key: "ArrowUp", inputText: "", ctrlKey: true });
    expect(stepCtrl.handled).toBe(false);

    const stepAlt = runKey({ key: "ArrowUp", inputText: "", altKey: true });
    expect(stepAlt.handled).toBe(false);
  });
});
