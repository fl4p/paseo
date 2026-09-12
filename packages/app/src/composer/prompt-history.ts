import { useCallback, useRef } from "react";
import type { ComposerKeyPressEvent } from "./input/input";

export interface PromptHistoryNavigationState {
  historyIndex: number;
  stash: string;
}

export function createInitialPromptHistoryNavigationState(): PromptHistoryNavigationState {
  return {
    historyIndex: -1,
    stash: "",
  };
}

export interface PromptHistoryKeyPressOptions {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  inputText: string;
  history: readonly string[];
  state: PromptHistoryNavigationState;
  replaceText: (text: string, selection?: { start: number; end: number }) => void;
  preventDefault: () => void;
}

export interface PromptHistoryKeyPressResult {
  handled: boolean;
  nextState: PromptHistoryNavigationState;
}

/**
 * Normalizes and deduplicates a list of prompts so that each unique prompt
 * appears only once, preserving its most recent occurrence.
 */
export function deduplicatePrompts(prompts: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let i = prompts.length - 1; i >= 0; i--) {
    const trimmed = prompts[i].trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.unshift(trimmed);
    }
  }
  return result;
}

/**
 * Combines persistent global history with prompts from the current session.
 * Prompts from the current session are placed at the most recent end in chronological
 * order, while earlier global prompts appear before them without duplication.
 */
export function buildCombinedPromptHistory(
  globalHistory: readonly string[],
  sessionPrompts?: readonly string[],
): string[] {
  const dedupedSession = sessionPrompts ? deduplicatePrompts(sessionPrompts) : [];
  if (dedupedSession.length === 0) {
    return deduplicatePrompts(globalHistory);
  }
  const sessionSet = new Set(dedupedSession);
  const combined: string[] = [];
  for (const prompt of globalHistory) {
    const trimmed = prompt.trim();
    if (trimmed && !sessionSet.has(trimmed)) {
      combined.push(trimmed);
    }
  }
  for (const prompt of dedupedSession) {
    combined.push(prompt);
  }
  return combined;
}

function handleEscapeKey(
  state: PromptHistoryNavigationState,
  replaceText: (text: string, selection?: { start: number; end: number }) => void,
  preventDefault: () => void,
): PromptHistoryKeyPressResult {
  if (state.historyIndex === -1) {
    return { handled: false, nextState: state };
  }
  preventDefault();
  replaceText(state.stash, {
    start: state.stash.length,
    end: state.stash.length,
  });
  return {
    handled: true,
    nextState: createInitialPromptHistoryNavigationState(),
  };
}

function handleUpKey(
  state: PromptHistoryNavigationState,
  inputText: string,
  history: readonly string[],
  replaceText: (text: string, selection?: { start: number; end: number }) => void,
  preventDefault: () => void,
): PromptHistoryKeyPressResult {
  if (state.historyIndex === -1) {
    if (inputText.trim().length > 0 || history.length === 0) {
      return { handled: false, nextState: state };
    }
    const targetIndex = history.length - 1;
    const targetPrompt = history[targetIndex];
    preventDefault();
    replaceText(targetPrompt, {
      start: targetPrompt.length,
      end: targetPrompt.length,
    });
    return {
      handled: true,
      nextState: {
        historyIndex: targetIndex,
        stash: inputText,
      },
    };
  }

  const currentItem = history[state.historyIndex];
  if (inputText !== currentItem) {
    return {
      handled: false,
      nextState: createInitialPromptHistoryNavigationState(),
    };
  }

  const targetIndex = Math.max(0, state.historyIndex - 1);
  const targetPrompt = history[targetIndex];
  preventDefault();
  replaceText(targetPrompt, {
    start: targetPrompt.length,
    end: targetPrompt.length,
  });
  return {
    handled: true,
    nextState: {
      ...state,
      historyIndex: targetIndex,
    },
  };
}

function handleDownKey(
  state: PromptHistoryNavigationState,
  inputText: string,
  history: readonly string[],
  replaceText: (text: string, selection?: { start: number; end: number }) => void,
  preventDefault: () => void,
): PromptHistoryKeyPressResult {
  if (state.historyIndex === -1) {
    return { handled: false, nextState: state };
  }

  const currentItem = history[state.historyIndex];
  if (inputText !== currentItem) {
    return {
      handled: false,
      nextState: createInitialPromptHistoryNavigationState(),
    };
  }

  if (state.historyIndex >= history.length - 1) {
    preventDefault();
    replaceText(state.stash, {
      start: state.stash.length,
      end: state.stash.length,
    });
    return {
      handled: true,
      nextState: createInitialPromptHistoryNavigationState(),
    };
  }

  const targetIndex = state.historyIndex + 1;
  const targetPrompt = history[targetIndex];
  preventDefault();
  replaceText(targetPrompt, {
    start: targetPrompt.length,
    end: targetPrompt.length,
  });
  return {
    handled: true,
    nextState: {
      ...state,
      historyIndex: targetIndex,
    },
  };
}

/**
 * Handles ArrowUp / ArrowDown / Escape key events for shell-like prompt history browsing.
 */
export function handlePromptHistoryKeyPress(
  options: PromptHistoryKeyPressOptions,
): PromptHistoryKeyPressResult {
  const {
    key,
    shiftKey,
    metaKey,
    ctrlKey,
    altKey,
    inputText,
    history,
    state,
    replaceText,
    preventDefault,
  } = options;

  if (shiftKey || metaKey || ctrlKey || altKey) {
    return { handled: false, nextState: state };
  }

  if (key === "Escape" || key === "Esc") {
    return handleEscapeKey(state, replaceText, preventDefault);
  }

  if (key === "ArrowUp" || key === "Up") {
    return handleUpKey(state, inputText, history, replaceText, preventDefault);
  }

  if (key === "ArrowDown" || key === "Down") {
    return handleDownKey(state, inputText, history, replaceText, preventDefault);
  }

  return { handled: false, nextState: state };
}

export interface UseComposerPromptHistoryOptions {
  history: readonly string[];
  replaceUserInput: (text: string, selection?: { start: number; end: number }) => void;
}

export interface UseComposerPromptHistoryResult {
  onKeyPress: (event: ComposerKeyPressEvent) => boolean;
  reset: () => void;
  isNavigating: boolean;
}

export function useComposerPromptHistory({
  history,
  replaceUserInput,
}: UseComposerPromptHistoryOptions): UseComposerPromptHistoryResult {
  const stateRef = useRef<PromptHistoryNavigationState>(
    createInitialPromptHistoryNavigationState(),
  );
  const historyRef = useRef(history);
  historyRef.current = history;
  const replaceUserInputRef = useRef(replaceUserInput);
  replaceUserInputRef.current = replaceUserInput;

  const reset = useCallback(() => {
    stateRef.current = createInitialPromptHistoryNavigationState();
  }, []);

  const onKeyPress = useCallback((event: ComposerKeyPressEvent): boolean => {
    const result = handlePromptHistoryKeyPress({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      inputText: event.input.text,
      history: historyRef.current,
      state: stateRef.current,
      replaceText: (text, selection) => replaceUserInputRef.current(text, selection),
      preventDefault: event.preventDefault,
    });
    stateRef.current = result.nextState;
    return result.handled;
  }, []);

  return {
    onKeyPress,
    reset,
    isNavigating: stateRef.current.historyIndex !== -1,
  };
}
