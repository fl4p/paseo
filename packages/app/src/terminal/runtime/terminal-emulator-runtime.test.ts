import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class ClipboardAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class ImageAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-ligatures/lib/addon-ligatures.mjs", () => ({
  LigaturesAddon: class LigaturesAddon {
    dispose(): void {}
  },
}));

const searchAddonInstances = vi.hoisted(() => ({
  instances: [] as Array<{
    nextCalls: Array<{ query: string; options?: unknown }>;
    previousCalls: Array<{ query: string; options?: unknown }>;
    clearCalls: number;
  }>,
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class SearchAddon {
    nextCalls: Array<{ query: string; options?: unknown }> = [];
    previousCalls: Array<{ query: string; options?: unknown }> = [];
    clearCalls = 0;
    disposeCalls = 0;
    resultListeners: Array<(result: { resultIndex: number; resultCount: number }) => void> = [];
    onDidChangeResults(
      listener: (result: { resultIndex: number; resultCount: number }) => void,
    ): () => void {
      this.resultListeners.push(listener);
      return () => undefined;
    }
    findNext(query: string, options?: unknown): boolean {
      this.nextCalls.push({ query, options });
      return true;
    }
    findPrevious(query: string, options?: unknown): boolean {
      this.previousCalls.push({ query, options });
      return true;
    }
    clearDecorations(): void {
      this.clearCalls += 1;
    }
    dispose(): void {
      this.disposeCalls += 1;
    }
    constructor() {
      searchAddonInstances.instances.push(this);
    }
  },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class Unicode11Addon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class WebLinksAddon {
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    onContextLoss(): void {}
    dispose(): void {}
  },
}));

const terminalConstructorOptions = vi.hoisted(() => ({
  values: [] as unknown[],
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    rows = 24;
    cols = 80;
    unicode = { activeVersion: "" };
    parser = {
      registerCsiHandler: () => undefined,
    };
    constructor(options: unknown) {
      terminalConstructorOptions.values.push(options);
    }
    loadAddon(): void {}
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    open(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    attachCustomKeyEventHandler(): void {}
    dispose(): void {}
    refresh(): void {}
  },
}));

import {
  createTerminalResizeEvent,
  encodeTerminalOutput,
  TerminalEmulatorRuntime,
} from "./terminal-emulator-runtime";
import { SearchAddon } from "@xterm/addon-search";

/** The SearchAddon mock's call log, unreachable through the real typing. */
interface SearchAddonProbe {
  nextCalls: Array<{ query: string; options?: unknown }>;
  previousCalls: Array<{ query: string; options?: unknown }>;
  clearCalls: number;
  disposeCalls: number;
  resultListeners: Array<(result: { resultIndex: number; resultCount: number }) => void>;
}

function createSearchAddonProbe(): SearchAddonProbe {
  return new SearchAddon() as unknown as SearchAddonProbe;
}

interface StubTerminal {
  write: (data: string | Uint8Array, callback?: () => void) => void;
  reset: () => void;
  resize?: (cols: number, rows: number) => void;
  focus: () => void;
  refresh?: (start: number, end: number) => void;
  options?: { theme?: unknown; scrollback?: number; fontFamily?: string; fontSize?: number };
  rows?: number;
  cols?: number;
}

interface RuntimeFitProbe {
  fitAndEmitResize: (input?: {
    forceRefresh?: boolean;
    shouldClaim?: boolean;
    forceClaim?: boolean;
  }) => void;
}

function createRuntimeWithTerminal(): {
  runtime: TerminalEmulatorRuntime;
  terminal: StubTerminal & {
    resetCalls: number;
  };
  writeCallbacks: Array<() => void>;
  writeTexts: string[];
} {
  const runtime = new TerminalEmulatorRuntime();
  const terminalState = attachStubTerminal(runtime);

  return {
    runtime,
    ...terminalState,
  };
}

function attachStubTerminal(runtime: TerminalEmulatorRuntime): {
  terminal: StubTerminal & {
    resetCalls: number;
  };
  writeCallbacks: Array<() => void>;
  writeTexts: string[];
} {
  const writeCallbacks: Array<() => void> = [];
  const writeTexts: string[] = [];
  let resetCalls = 0;

  const terminal: StubTerminal & { resetCalls: number } = {
    write: (data: string | Uint8Array, callback?: () => void) => {
      const text = decodeTerminalOutput(data);
      // The runtime submits a zero-length sentinel write to gate barrier ops behind the
      // drained write run. Keep its callback (the gate resolves through it) but exclude the
      // empty payload from writeTexts so assertions read like real terminal output.
      if (text.length > 0) {
        writeTexts.push(text);
      }
      if (callback) {
        writeCallbacks.push(callback);
      }
    },
    reset: () => {
      resetCalls += 1;
      terminal.resetCalls = resetCalls;
    },
    resize: () => {},
    focus: () => {},
    refresh: () => {},
    options: { theme: undefined },
    rows: 0,
    cols: 0,
    resetCalls,
  };

  (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;

  return {
    terminal,
    writeCallbacks,
    writeTexts,
  };
}

function terminalOutput(text: string): Uint8Array {
  return encodeTerminalOutput(text);
}

function decodeTerminalOutput(data: string | Uint8Array): string {
  if (typeof data === "string") {
    return data;
  }
  return new TextDecoder().decode(data);
}

interface FindState {
  findQuery: string;
  findResult: { resultIndex: number; resultCount: number };
  findOutputAnchor: unknown;
  searchAddon: unknown;
}

function mountSearchable(): {
  runtime: TerminalEmulatorRuntime;
  state: () => FindState;
  markers: number[];
  searchResults: Array<{ resultIndex: number; resultCount: number }>;
  findResults: Array<{ resultIndex: number; resultCount: number }>;
  addon: () => SearchAddonProbe;
  writeOutput: (text: string) => void;
} {
  const { runtime, terminal } = createRuntimeWithTerminal();
  const markers: number[] = [];
  Object.assign(terminal, {
    buffer: { active: { viewportY: 10, baseY: 40, cursorY: 5 } },
    registerMarker: (offset: number) => {
      markers.push(offset);
      return { line: 10, isDisposed: false, dispose: () => undefined };
    },
    loadAddon: () => undefined,
    getSelectionPosition: () => undefined,
  });
  const searchResults: Array<{ resultIndex: number; resultCount: number }> = [];
  const findResults: Array<{ resultIndex: number; resultCount: number }> = [];
  runtime.setCallbacks({
    callbacks: {
      onSearchResults: (result) => {
        searchResults.push(result);
      },
      onFindResult: (result) => {
        findResults.push({ resultIndex: result.resultIndex, resultCount: result.resultCount });
      },
    },
  });
  const state = () => runtime as unknown as FindState;
  return {
    runtime,
    state,
    markers,
    searchResults,
    findResults,
    addon: () => state().searchAddon as SearchAddonProbe,
    writeOutput: (text) => runtime.write({ data: terminalOutput(text) }),
  };
}

/** Plays a search result into every listener the runtime registered on the addon. */
function emitSearchResult(
  addon: SearchAddonProbe,
  result: { resultIndex: number; resultCount: number },
): void {
  for (const listener of addon.resultListeners) listener(result);
}

describe("terminal-emulator-runtime", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: { __paseoTerminal?: unknown } }).window = {
      __paseoTerminal: undefined,
    };
    terminalConstructorOptions.values = [];
    searchAddonInstances.instances.length = 0;
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.useRealTimers();
  });

  it.each([
    { isMac: true, ctrlKey: true, metaKey: false, opensFind: false },
    { isMac: true, ctrlKey: false, metaKey: true, opensFind: true },
    { isMac: false, ctrlKey: true, metaKey: false, opensFind: true },
    { isMac: false, ctrlKey: false, metaKey: true, opensFind: false },
    { isMac: true, ctrlKey: false, metaKey: true, shiftKey: true, opensFind: false },
    { isMac: true, ctrlKey: false, metaKey: true, altKey: true, opensFind: false },
    { isMac: false, ctrlKey: true, metaKey: false, shiftKey: true, opensFind: false },
    { isMac: false, ctrlKey: true, metaKey: false, altKey: true, opensFind: false },
    { isMac: true, ctrlKey: true, metaKey: true, opensFind: false },
    { isMac: false, ctrlKey: true, metaKey: true, opensFind: false },
  ])(
    "routes Find with isMac=$isMac ctrl=$ctrlKey meta=$metaKey shift=$shiftKey alt=$altKey",
    ({ isMac, ctrlKey, metaKey, shiftKey = false, altKey = false, opensFind }) => {
      const runtime = new TerminalEmulatorRuntime({ isMac });
      let findRequests = 0;
      let prevented = false;
      let stopped = false;
      runtime.setCallbacks({
        callbacks: {
          onFindRequest: () => {
            findRequests += 1;
          },
        },
      });
      const event = {
        type: "keydown",
        key: "f",
        ctrlKey,
        metaKey,
        shiftKey,
        altKey,
        isComposing: false,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {
          stopped = true;
        },
      } as KeyboardEvent;

      let passedToXterm: boolean | undefined;
      runtime.attachKeyEventHandler({
        attachCustomKeyEventHandler: (handler) => {
          passedToXterm = handler(event);
        },
        hasSelection: () => false,
        getSelection: () => "",
        paste: () => {},
        input: () => {},
        scrollToBottom: () => {},
      });
      expect(passedToXterm).toBe(!opensFind);
      expect(findRequests).toBe(opensFind ? 1 : 0);
      expect(prevented).toBe(opensFind);
      expect(stopped).toBe(opensFind);
    },
  );

  it("drains contiguous plain writes without waiting for each commit, gating a clear behind them", () => {
    const { runtime, terminal, writeCallbacks, writeTexts } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      data: terminalOutput("first"),
      onCommitted: () => {
        committed.push("first");
      },
    });
    runtime.write({
      data: terminalOutput("second"),
      onCommitted: () => {
        committed.push("second");
      },
    });
    runtime.clear({
      onCommitted: () => {
        committed.push("clear");
      },
    });
    runtime.write({
      data: terminalOutput("third"),
      onCommitted: () => {
        committed.push("third");
      },
    });

    // Both plain writes are submitted back-to-back; neither waited on the other's callback.
    // The clear and the write after it stay queued behind the barrier gate (sentinel write).
    expect(writeTexts).toEqual(["first", "second"]);
    expect(terminal.resetCalls).toBe(0);
    expect(committed).toEqual([]);

    // writeCallbacks: [0]=first, [1]=second, [2]=barrier-gate sentinel.
    writeCallbacks[0]?.();
    writeCallbacks[1]?.();
    expect(committed).toEqual(["first", "second"]);
    expect(terminal.resetCalls).toBe(0);

    // Resolving the sentinel releases the clear, which resets and then drains "third".
    writeCallbacks[2]?.();
    expect(committed).toEqual(["first", "second", "clear"]);
    expect(terminal.resetCalls).toBe(1);
    expect(writeTexts).toEqual(["first", "second", "third"]);

    // "third" still commits through its own write callback.
    writeCallbacks[3]?.();
    expect(committed).toEqual(["first", "second", "clear", "third"]);
  });

  it("falls back to timeout commit for a barrier op when the gate sentinel never fires", () => {
    vi.useFakeTimers();
    const { runtime, terminal } = createRuntimeWithTerminal();
    const onCommitted = vi.fn();

    // restoreOutput is a barrier; if xterm never commits the gate sentinel, the barrier still
    // applies (and commits) after the 5s safety timeout instead of stalling forever.
    runtime.restoreOutput({
      data: terminalOutput("stuck"),
      onCommitted,
    });

    expect(onCommitted).not.toHaveBeenCalled();
    expect(terminal.resetCalls).toBe(0);
    vi.advanceTimersByTime(5_000);
    // The barrier now runs (write submitted) but its own commit still waits on xterm; advance
    // again to fire the barrier's own write timeout.
    vi.advanceTimersByTime(5_000);
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("reports input mode changes from terminal output and resets them on snapshots", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const inputModeChanges: Array<{
      kittyKeyboardFlags: number;
      win32InputMode: boolean;
      bracketedPaste: boolean;
    }> = [];
    runtime.setCallbacks({
      callbacks: {
        onInputModeChange: (state) => {
          inputModeChanges.push({
            kittyKeyboardFlags: state.kittyKeyboardFlags,
            win32InputMode: state.win32InputMode,
            bracketedPaste: Boolean(state.bracketedPaste),
          });
        },
      },
    });

    runtime.write({ data: terminalOutput("\x1b[>7u") });
    runtime.renderSnapshot({
      state: {
        rows: 2,
        cols: 8,
        scrollback: [],
        grid: [[{ char: "$" }, { char: " " }]],
        cursor: {
          row: 0,
          col: 2,
        },
      },
    });
    // The plain write reports kitty flags synchronously during drain; the snapshot resets
    // them only after its barrier gate (the sentinel write callback) resolves.
    expect(inputModeChanges).toEqual([
      { kittyKeyboardFlags: 7, win32InputMode: false, bracketedPaste: false },
    ]);

    // Commit the plain write, then the sentinel that gates the snapshot.
    writeCallbacks[0]();
    expect(inputModeChanges).toHaveLength(1);
    writeCallbacks[1]();

    expect(inputModeChanges).toEqual([
      { kittyKeyboardFlags: 7, win32InputMode: false, bracketedPaste: false },
      { kittyKeyboardFlags: 0, win32InputMode: false, bracketedPaste: false },
    ]);
  });

  it("exposes the tracked input mode state", () => {
    const { runtime } = createRuntimeWithTerminal();

    runtime.write({ data: terminalOutput("\x1b[?2004h") });

    expect(runtime.getInputModeState()).toMatchObject({
      bracketedPaste: true,
    });
  });

  it("commits each drained plain write through its own xterm callback", () => {
    const { runtime, writeTexts, writeCallbacks } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      data: terminalOutput("first"),
      onCommitted: () => {
        committed.push("first");
      },
    });
    runtime.write({
      data: terminalOutput("second"),
      onCommitted: () => {
        committed.push("second");
      },
    });

    // Both submitted without waiting; each commits independently when its callback fires.
    expect(writeTexts).toEqual(["first", "second"]);
    expect(committed).toEqual([]);

    writeCallbacks[1]?.();
    expect(committed).toEqual(["second"]);

    writeCallbacks[0]?.();
    expect(committed).toEqual(["second", "first"]);
  });

  it("applies a snapshot after the writes ahead of it, never interleaving the reset", () => {
    const { runtime, terminal, writeTexts, writeCallbacks } = createRuntimeWithTerminal();
    const committed: string[] = [];

    runtime.write({
      data: terminalOutput("before-a"),
      onCommitted: () => {
        committed.push("before-a");
      },
    });
    runtime.write({
      data: terminalOutput("before-b"),
      onCommitted: () => {
        committed.push("before-b");
      },
    });
    runtime.restoreOutput({
      data: terminalOutput("snap"),
      onCommitted: () => {
        committed.push("snap");
      },
    });

    // Plain writes are submitted up front; the snapshot's reset+write has not run yet.
    expect(writeTexts).toEqual(["before-a", "before-b"]);

    // writeCallbacks: [0]=before-a, [1]=before-b, [2]=barrier gate sentinel.
    // The snapshot is gated behind the prior writes; resolving the gate runs it after them.
    writeCallbacks[2]?.();
    expect(writeTexts).toEqual(["before-a", "before-b", "csnap"]);

    // Snapshot commit fires only after its own write callback, strictly after the writes.
    writeCallbacks[3]?.();
    expect(committed).toEqual(["snap"]);
    expect(terminal.resetCalls).toBe(0);
  });

  it("applies a barrier immediately when no writes precede it, suppressing input at once", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const readSuppressInput = () =>
      (runtime as unknown as { suppressInput: boolean }).suppressInput;

    expect(readSuppressInput()).toBe(false);

    // No plain writes precede this barrier (mount), so there is nothing to gate: it starts
    // at once with no sentinel, flipping suppressInput synchronously.
    runtime.restoreOutput({ data: terminalOutput("snapshot") });
    expect(readSuppressInput()).toBe(true);

    // writeCallbacks[0] is the barrier's own snapshot write; committing it restores input.
    writeCallbacks[0]?.();
    expect(readSuppressInput()).toBe(false);
  });

  it("gates a barrier behind a preceding plain write before suppressing input", () => {
    const { runtime, writeCallbacks } = createRuntimeWithTerminal();
    const readSuppressInput = () =>
      (runtime as unknown as { suppressInput: boolean }).suppressInput;

    // A plain write is now ungated, so the following barrier must wait on the sentinel.
    runtime.write({ data: terminalOutput("output") });
    runtime.restoreOutput({ data: terminalOutput("snapshot") });

    // The plain write commits first. Only the following sentinel opens the barrier.
    expect(readSuppressInput()).toBe(false);
    writeCallbacks[0]();
    expect(readSuppressInput()).toBe(false);
    writeCallbacks[1]();
    expect(readSuppressInput()).toBe(true);

    // Committing the barrier's snapshot write restores input.
    writeCallbacks[2]();
    expect(readSuppressInput()).toBe(false);
  });

  it("commits pending output operations during unmount to avoid deadlock", () => {
    const { runtime } = createRuntimeWithTerminal();
    const onCommittedA = vi.fn();
    const onCommittedB = vi.fn();

    runtime.write({
      data: terminalOutput("a"),
      onCommitted: onCommittedA,
    });
    runtime.write({
      data: terminalOutput("b"),
      onCommitted: onCommittedB,
    });

    runtime.unmount();

    expect(onCommittedA).toHaveBeenCalledTimes(1);
    expect(onCommittedB).toHaveBeenCalledTimes(1);
  });

  it("clears ungated writes on unmount so remount barriers apply immediately", () => {
    const { runtime } = createRuntimeWithTerminal();

    runtime.write({ data: terminalOutput("before unmount") });
    runtime.unmount();

    const remounted = attachStubTerminal(runtime);
    runtime.restoreOutput({ data: terminalOutput("restored screen") });

    expect(remounted.writeTexts).toEqual(["\u001bcrestored screen"]);
    expect(remounted.writeCallbacks).toHaveLength(1);
  });

  it("replays snapshots through a single write without first painting a reset terminal", () => {
    const { runtime, terminal, writeTexts, writeCallbacks } = createRuntimeWithTerminal();

    runtime.renderSnapshot({
      state: {
        rows: 2,
        cols: 8,
        scrollback: [],
        grid: [
          [{ char: "h" }, { char: "i" }],
          [{ char: "$" }, { char: " " }],
        ],
        cursor: {
          row: 1,
          col: 2,
        },
      },
    });

    // The snapshot is a barrier; its write applies after the gate sentinel (writeCallbacks[0]).
    writeCallbacks[0]?.();

    expect(terminal.resetCalls).toBe(0);
    expect(writeTexts).toHaveLength(1);
    expect(writeTexts[0]?.startsWith("\u001bc")).toBe(true);
    expect(writeTexts[0]).toContain("hi");
  });

  it("restores server-rendered ANSI snapshots through the snapshot write path", () => {
    const { runtime, terminal, writeTexts, writeCallbacks } = createRuntimeWithTerminal();

    runtime.restoreOutput({ data: terminalOutput("restored screen") });

    // restoreOutput is a barrier (suppressInput); it applies after the gate sentinel.
    writeCallbacks[0]?.();

    expect(terminal.resetCalls).toBe(0);
    expect(writeTexts).toEqual(["\u001bcrestored screen"]);
  });

  it("forces a refit when resize is requested", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;

    runtime.resize();
    runtime.resize({ forceRefresh: true, shouldClaim: false });

    expect(fitAndEmitResize).toHaveBeenNthCalledWith(1, undefined);
    expect(fitAndEmitResize).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      shouldClaim: false,
    });
  });

  it("marks explicit resize claims as forced so another client can reclaim the same size", () => {
    expect(
      createTerminalResizeEvent({
        rows: 34,
        cols: 181,
        shouldClaim: true,
        forceClaim: true,
      }),
    ).toEqual({
      rows: 34,
      cols: 181,
      shouldClaim: true,
      forceClaim: true,
    });
  });

  it("updates terminal theme without remounting", () => {
    const runtime = new TerminalEmulatorRuntime();
    const refresh = vi.fn();
    const terminal: StubTerminal = {
      write: () => {},
      reset: () => {},
      focus: () => {},
      refresh,
      options: { theme: { background: "before" } },
      rows: 12,
      cols: 40,
    };
    (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;

    runtime.setTheme({ theme: { background: "after" } as never });

    expect(terminal.options?.theme).toEqual({
      background: "after",
      overviewRulerBorder: "after",
    });
    expect(refresh).toHaveBeenCalledWith(0, 11);
  });

  it("updates terminal scrollback without remounting", () => {
    const runtime = new TerminalEmulatorRuntime();
    const refresh = vi.fn();
    const terminal: StubTerminal = {
      write: () => {},
      reset: () => {},
      focus: () => {},
      refresh,
      options: { scrollback: 10_000 },
      rows: 12,
      cols: 40,
    };
    (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;

    runtime.setScrollback({ lines: 42_000 });

    expect(terminal.options?.scrollback).toBe(42_000);
    expect(refresh).toHaveBeenCalledWith(0, 11);
  });

  it("updates terminal font without remounting", () => {
    const runtime = new TerminalEmulatorRuntime();
    const refresh = vi.fn();
    const fitAndEmitResize = vi.fn();
    const terminal: StubTerminal = {
      write: () => {},
      reset: () => {},
      focus: () => {},
      refresh,
      options: { fontFamily: "before", fontSize: 13 },
      rows: 12,
      cols: 40,
    };
    (runtime as unknown as { terminal: StubTerminal }).terminal = terminal;
    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;

    runtime.setFont({ fontFamily: "  Menlo  ", fontSize: 18 });

    expect(terminal.options?.fontFamily).toBe("Menlo");
    expect(terminal.options?.fontSize).toBe(18);
    expect(fitAndEmitResize).toHaveBeenCalledWith({
      forceRefresh: true,
      shouldClaim: false,
    });
    expect(refresh).toHaveBeenCalledWith(0, 11);
  });

  it("passively refits when the page becomes visible again", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;
    (globalThis as { document?: { visibilityState?: string } }).document = {
      visibilityState: "visible",
    };

    (
      runtime as unknown as {
        handleVisibilityRestore: () => void;
      }
    ).handleVisibilityRestore();

    expect(fitAndEmitResize).toHaveBeenCalledWith({
      forceRefresh: true,
      shouldClaim: false,
    });
  });

  it("does not refit while the page is still hidden", () => {
    const runtime = new TerminalEmulatorRuntime();
    const fitAndEmitResize = vi.fn();

    (runtime as unknown as RuntimeFitProbe).fitAndEmitResize = fitAndEmitResize;
    (globalThis as { document?: { visibilityState?: string } }).document = {
      visibilityState: "hidden",
    };

    (
      runtime as unknown as {
        handleVisibilityRestore: () => void;
      }
    ).handleVisibilityRestore();

    expect(fitAndEmitResize).not.toHaveBeenCalled();
  });

  it("steps the search addon through the pane's buffer with highlight decorations", () => {
    const runtime = new TerminalEmulatorRuntime();
    const addon = createSearchAddonProbe();
    (runtime as unknown as { searchAddon: unknown }).searchAddon = addon;

    expect(runtime.search({ query: "needle", forward: true, incremental: true })).toBe(true);
    expect(runtime.search({ query: "needle", forward: false, incremental: false })).toBe(true);

    expect(addon.nextCalls).toEqual([
      {
        query: "needle",
        options: {
          incremental: true,
          decorations: expect.objectContaining({
            activeMatchBackground: expect.any(String),
            matchOverviewRuler: expect.any(String),
          }),
        },
      },
    ]);
    expect(addon.previousCalls).toEqual([
      {
        query: "needle",
        options: {
          incremental: false,
          decorations: expect.objectContaining({
            activeMatchColorOverviewRuler: expect.any(String),
          }),
        },
      },
    ]);
  });

  it("refuses to search an empty query and ends the search on clear", () => {
    const runtime = new TerminalEmulatorRuntime();
    const addon = createSearchAddonProbe();
    (runtime as unknown as { searchAddon: unknown }).searchAddon = addon;

    expect(runtime.search({ query: "", forward: true, incremental: true })).toBe(false);
    expect(addon.nextCalls).toEqual([]);

    // Clearing ends the search the way the pane widget's clear() does: the
    // addon (and its pending highlight refresh) is disposed, not just cleared.
    runtime.clearSearch();
    expect(addon.disposeCalls).toBe(1);
    expect((runtime as unknown as { searchAddon: unknown }).searchAddon).toBeNull();

    // Without a mounted terminal there is nothing to search or clear; both no-op.
    const bare = new TerminalEmulatorRuntime();
    expect(bare.search({ query: "needle", forward: true, incremental: false })).toBe(false);
    bare.clearSearch();
  });

  describe("one search lifecycle for the pane widget and the desktop Find bar", () => {
    it("anchors the inspected match against arriving output for a desktop Find bar search", () => {
      const desktop = mountSearchable();
      desktop.runtime.search({ query: "needle", forward: true, incremental: true });
      emitSearchResult(desktop.addon(), { resultIndex: 2, resultCount: 3 });
      desktop.writeOutput("more output");

      const pane = mountSearchable();
      pane.runtime.find.search("needle", "next");
      emitSearchResult(pane.addon(), { resultIndex: 2, resultCount: 3 });
      pane.writeOutput("more output");

      // The desktop path records the query, so output arriving while a match
      // is inspected registers the same viewport anchor as the pane widget.
      expect(desktop.state().findQuery).toBe("needle");
      expect(desktop.state().findQuery).toBe(pane.state().findQuery);
      expect(desktop.markers).toEqual([10 - 40 - 5]);
      expect(desktop.markers).toEqual(pane.markers);
      expect(desktop.state().findOutputAnchor).toBeDefined();

      // Both surfaces hear the result, whichever one searched.
      expect(desktop.searchResults).toEqual([{ resultIndex: 2, resultCount: 3 }]);
      expect(pane.searchResults).toEqual([{ resultIndex: 2, resultCount: 3 }]);
      expect(desktop.findResults).toEqual(pane.findResults);
    });

    it("resets query, anchor, addon and counts on a desktop clearSearch like find.clear", () => {
      const desktop = mountSearchable();
      desktop.runtime.search({ query: "needle", forward: true, incremental: true });
      const desktopAddon = desktop.addon();
      emitSearchResult(desktopAddon, { resultIndex: 0, resultCount: 1 });
      desktop.writeOutput("more output");
      desktop.runtime.clearSearch();

      const pane = mountSearchable();
      pane.runtime.find.search("needle", "next");
      const paneAddon = pane.addon();
      emitSearchResult(paneAddon, { resultIndex: 0, resultCount: 1 });
      pane.writeOutput("more output");
      pane.runtime.find.clear();

      for (const [surface, addon] of [
        [desktop, desktopAddon],
        [pane, paneAddon],
      ] as const) {
        expect(surface.state().findQuery).toBe("");
        expect(surface.state().findOutputAnchor).toBeUndefined();
        expect(surface.state().searchAddon).toBeNull();
        expect(surface.state().findResult).toEqual({ resultIndex: -1, resultCount: 0 });
        expect(addon.disposeCalls).toBe(1);
        expect(surface.searchResults.at(-1)).toEqual({ resultIndex: -1, resultCount: 0 });
        expect(surface.findResults.at(-1)).toEqual({ resultIndex: -1, resultCount: 0 });
      }

      // With the search over, arriving output is no longer anchored.
      desktop.writeOutput("later output");
      expect(desktop.markers).toHaveLength(1);
    });

    it("lets the desktop Find bar search again after the pane widget disposed the addon", () => {
      const { runtime, addon } = mountSearchable();
      runtime.find.search("needle", "next");
      runtime.find.clear();
      expect(runtime.search({ query: "needle", forward: false, incremental: false })).toBe(true);
      expect(addon().previousCalls).toEqual([{ query: "needle", options: expect.anything() }]);
    });
  });
});
