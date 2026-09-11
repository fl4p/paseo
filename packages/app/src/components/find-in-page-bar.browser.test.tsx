import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { FindInPageBar } from "./find-in-page-bar.electron";
import { useTranscriptFindStore, type TranscriptHistorySearch } from "@/agent-stream/find/store";
import type { HistorySearchResult } from "@/agent-stream/find/model";
import { useTerminalFindStore } from "@/terminal/find/store";
import type { StreamItem } from "@/types/stream";
import type { DesktopFindStartInput, DesktopFindStopAction } from "@/desktop/host";

interface FakeDesktopHost {
  emit: (event: string, payload: unknown) => void;
  startCalls: DesktopFindStartInput[];
  stopCalls: DesktopFindStopAction[];
  /** What the main process answers: whether a browser pane was there to search. */
  searchable: boolean;
}

function installFakeHost(): FakeDesktopHost {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const host: FakeDesktopHost = {
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload);
      }
    },
    startCalls: [],
    stopCalls: [],
    searchable: true,
  };

  window.paseoDesktop = {
    platform: "darwin",
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        const listeners = handlers.get(event) ?? new Set();
        listeners.add(handler);
        handlers.set(event, listeners);
        return Promise.resolve(() => {
          listeners.delete(handler);
        });
      },
    },
    find: {
      start: (input) => {
        host.startCalls.push(input);
        return Promise.resolve({ searched: host.searchable });
      },
      stop: (action) => {
        host.stopCalls.push(action ?? "clearSelection");
        return Promise.resolve();
      },
    },
  };

  return host;
}

const timestamp = new Date(0);

function message(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp };
}

function installTranscript(
  items: StreamItem[],
  history: TranscriptHistorySearch | null = null,
): string[] {
  const jumps: string[] = [];
  useTranscriptFindStore.getState().setSource({
    agentId: "agent-1",
    items,
    jumpToItem: (itemId) => jumps.push(itemId),
    history,
  });
  return jumps;
}

/** A live turn republishes the source object without changing the match. */
function republishTranscript(
  items: StreamItem[],
  jumps: string[],
  history: TranscriptHistorySearch | null = null,
): void {
  act(() =>
    useTranscriptFindStore.getState().setSource({
      agentId: "agent-1",
      items,
      jumpToItem: (itemId) => jumps.push(itemId),
      history,
    }),
  );
}

/** A row the daemon has placed on the timeline. */
function timelineMessage(id: string, text: string, seq: number): StreamItem {
  return { ...message(id, text), timelineCursor: { epoch: "epoch-1", seq } };
}

interface FakeHistory {
  source: TranscriptHistorySearch;
  searches: string[];
  loads: number[];
  /** Resolves the oldest search still waiting for the daemon. */
  answer: (result: Partial<HistorySearchResult>) => Promise<void>;
}

/** The daemon's side of Find, answering when the test says so. */
function fakeHistory(): FakeHistory {
  const waiting: Array<(result: HistorySearchResult) => void> = [];
  const fake: FakeHistory = {
    searches: [],
    loads: [],
    source: {
      epoch: "epoch-1",
      search: (query) => {
        fake.searches.push(query);
        return new Promise((resolve) => waiting.push(resolve));
      },
      load: (seq) => {
        fake.loads.push(seq);
      },
    },
    answer: async (result) => {
      const resolve = waiting.shift();
      if (!resolve) {
        throw new Error("No history search is waiting for an answer");
      }
      await act(async () => {
        resolve({ epoch: "epoch-1", matches: [], truncated: false, ...result });
        await Promise.resolve();
      });
    },
  };
  return fake;
}

/** Lets the bar's pause before a history search run out. */
async function waitForHistorySearch(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 200));
  });
}

interface FakeTerminalSource {
  findCalls: Array<{ query: string; forward: boolean; incremental: boolean }>;
  clearCalls: number;
}

/** The focused terminal pane's find source, as the terminal pane publishes it. */
function installTerminal(): FakeTerminalSource {
  const source: FakeTerminalSource = { findCalls: [], clearCalls: 0 };
  useTerminalFindStore.getState().setSource({
    terminalId: "term-1",
    find: (input) => {
      source.findCalls.push(input);
    },
    clear: () => {
      source.clearCalls += 1;
    },
  });
  return source;
}

/** The search addon answers asynchronously; the pane reports what it said. */
function reportTerminalResult(resultIndex: number, resultCount: number): void {
  act(() => useTerminalFindStore.getState().reportResult("term-1", { resultIndex, resultCount }));
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function mountBar(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<FindInPageBar />));
  mounted.push({ root, container });
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function findInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector(`[aria-label="${i18n.t("paneFind.placeholder")}"]`);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Find input is not rendered");
  }
  return input;
}

function statusText(container: HTMLElement): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

function pressButton(container: HTMLElement, label: string): void {
  const button = container.querySelector(`[aria-label="${label}"]`);
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Missing control: ${label}`);
  }
  act(() => button.click());
}

function type(input: HTMLInputElement, text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(input: HTMLInputElement, key: string, shiftKey = false): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  useTranscriptFindStore.getState().clearSource("agent-1");
  useTerminalFindStore.getState().clearSource("term-1");
  delete window.paseoDesktop;
});

describe("FindInPageBar without a transcript", () => {
  it("stays hidden until the desktop shell asks for it", async () => {
    const host = installFakeHost();
    const container = mountBar();
    await settle();

    expect(container.querySelector('[data-testid="find-in-page-bar"]')).toBeNull();
    act(() => host.emit("find-open", {}));
    expect(container.querySelector('[data-testid="find-in-page-bar"]')).not.toBeNull();
  });

  it("drives Chromium's find and reports what it sends back", async () => {
    const host = installFakeHost();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    const input = findInput(container);
    type(input, "needle");
    pressKey(input, "Enter");
    pressKey(input, "Enter", true);

    expect(host.startCalls).toEqual([
      { query: "needle", forward: true, findNext: false },
      { query: "needle", forward: true, findNext: true },
      { query: "needle", forward: false, findNext: true },
    ]);

    await settle();
    act(() => host.emit("find-result", { activeMatchOrdinal: 2, matches: 7, finalUpdate: true }));
    expect(statusText(container)).toBe("2 of 7");
  });

  it("clears the query and the highlight when Escape closes it", async () => {
    const host = installFakeHost();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    const input = findInput(container);
    type(input, "needle");
    host.startCalls.length = 0;
    pressKey(input, "Escape");

    expect(container.querySelector('[data-testid="find-in-page-bar"]')).toBeNull();
    expect(host.stopCalls).toContain("clearSelection");

    act(() => host.emit("find-next", {}));
    expect(host.startCalls).toEqual([]);
  });
});

describe("FindInPageBar with nothing searchable", () => {
  it("claims nothing when the window has no transcript and no browser pane", async () => {
    const host = installFakeHost();
    host.searchable = false;
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "needle");
    await settle();
    act(() => host.emit("find-result", { activeMatchOrdinal: 0, matches: 0, finalUpdate: true }));

    // "No matches" would be a claim about text nobody searched.
    expect(statusText(container)).toBe("");
  });
});

describe("FindInPageBar highlighting", () => {
  it("paints the hits in mounted transcript rows and clears them on close", async () => {
    const host = installFakeHost();
    installTranscript([message("a", "widget and widget"), message("b", "no match here")]);
    const rows = document.createElement("div");
    rows.innerHTML =
      '<div data-history-row-id="a">widget and widget</div>' +
      '<div data-history-row-id="b">no match here</div>';
    document.body.appendChild(rows);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    const input = findInput(container);
    type(input, "widget");

    expect(CSS.highlights.get("paseo-find")?.size).toBe(2);
    expect(CSS.highlights.get("paseo-find-active")?.size).toBe(1);

    pressKey(input, "Escape");

    expect(CSS.highlights.has("paseo-find")).toBe(false);
    expect(CSS.highlights.has("paseo-find-active")).toBe(false);
    rows.remove();
  });
});

describe("FindInPageBar with a transcript", () => {
  it("finds text in a row the DOM never mounted", async () => {
    const host = installFakeHost();
    // Far more rows than the web transcript mounts, with the hit at the top.
    const items = [
      message("old", "the needle is in this very old message"),
      ...Array.from({ length: 400 }, (_, index) => message(`filler-${index}`, "unrelated chatter")),
    ];
    const jumps = installTranscript(items);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "needle");

    expect(statusText(container)).toBe("1 of 1");
    // Chromium's find would have reported nothing for an unmounted row.
    expect(host.startCalls).toEqual([]);
    expect(jumps).toContain("old");
  });

  it("counts every hit and steps through them in order", async () => {
    const host = installFakeHost();
    const jumps = installTranscript([
      message("a", "widget"),
      message("b", "widget and widget"),
      message("c", "nothing here"),
    ]);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    expect(statusText(container)).toBe("1 of 3");

    pressButton(container, i18n.t("paneFind.next"));
    expect(statusText(container)).toBe("2 of 3");

    pressButton(container, i18n.t("paneFind.next"));
    expect(statusText(container)).toBe("3 of 3");

    // Wraps back to the first hit rather than dead-ending.
    pressButton(container, i18n.t("paneFind.next"));
    expect(statusText(container)).toBe("1 of 3");

    pressButton(container, i18n.t("paneFind.previous"));
    expect(statusText(container)).toBe("3 of 3");

    // Stepping between two hits in the same row does not re-scroll it.
    expect(jumps).toEqual(["a", "b", "a", "b"]);
  });

  it("does not drag the reader back when a live turn republishes the transcript", async () => {
    const host = installFakeHost();
    const items = [message("a", "widget"), message("b", "later")];
    const jumps = installTranscript(items);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    expect(jumps).toEqual(["a"]);

    republishTranscript([...items, message("c", "a new row arrives")], jumps);
    republishTranscript([...items, message("c", "a new row arrives")], jumps);

    // Same hit, same place: the reader keeps their scroll position.
    expect(jumps).toEqual(["a"]);
    expect(statusText(container)).toBe("1 of 1");
  });

  it("never shows a count it has to take back when rows disappear", async () => {
    const host = installFakeHost();
    const jumps = installTranscript([
      message("a", "widget"),
      message("b", "widget"),
      message("c", "widget"),
    ]);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    pressButton(container, i18n.t("paneFind.next"));
    pressButton(container, i18n.t("paneFind.next"));
    expect(statusText(container)).toBe("3 of 3");

    republishTranscript([message("b", "widget"), message("c", "widget")], jumps);

    // The anchored hit is still row c, now second of two — never "3 of 2".
    expect(statusText(container)).toBe("2 of 2");
  });

  it("marks a capped count as a floor rather than a total", async () => {
    const host = installFakeHost();
    installTranscript([message("a", "z".repeat(6000))]);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "z");

    expect(statusText(container)).toBe("1 of 5000+");
  });

  it("hands the open query to Chromium when the transcript goes away", async () => {
    const host = installFakeHost();
    installTranscript([message("a", "widget")]);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    expect(host.startCalls).toEqual([]);

    act(() => useTranscriptFindStore.getState().clearSource("agent-1"));

    // The bar still shows the query, so the new pane has to be searched for it.
    expect(host.startCalls).toEqual([{ query: "widget", forward: true, findNext: false }]);
  });

  it("says so plainly when the transcript has no hit", async () => {
    const host = installFakeHost();
    installTranscript([message("a", "widget")]);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "absent");

    expect(statusText(container)).toBe(i18n.t("paneFind.noMatches"));
    expect(host.startCalls).toEqual([]);
  });
});

describe("FindInPageBar with timeline history the transcript has not loaded", () => {
  it("counts the daemon's hits in unloaded history alongside the loaded ones", async () => {
    const host = installFakeHost();
    const history = fakeHistory();
    const jumps = installTranscript([timelineMessage("recent", "the widget", 50)], history.source);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    // The loaded row answers at once, before the daemon has been asked.
    expect(statusText(container)).toBe("1 of 1");
    expect(history.searches).toEqual([]);

    await waitForHistorySearch();
    expect(history.searches).toEqual(["widget"]);
    await history.answer({
      matches: [
        { seqStart: 3, seqEnd: 3, occurrence: 0 },
        // The loaded row's own hit, which the loaded row already counts.
        { seqStart: 50, seqEnd: 50, occurrence: 0 },
      ],
    });

    // The older hit comes first; the reader stays on the hit they were shown.
    expect(statusText(container)).toBe("2 of 2");
    expect(jumps).toEqual(["recent"]);
    expect(history.loads).toEqual([]);
  });

  it("loads the window around an unloaded hit when the reader steps onto it", async () => {
    const host = installFakeHost();
    const history = fakeHistory();
    const recent = timelineMessage("recent", "the widget", 50);
    const jumps = installTranscript([recent], history.source);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    await waitForHistorySearch();
    await history.answer({
      matches: [
        { seqStart: 2, seqEnd: 3, occurrence: 1 },
        { seqStart: 50, seqEnd: 50, occurrence: 0 },
      ],
    });

    pressButton(container, i18n.t("paneFind.previous"));
    expect(statusText(container)).toBe("1 of 2");
    expect(history.loads).toEqual([3]);
    expect(jumps).toEqual(["recent"]);

    // The window arrives: the history hit is now the second hit in a loaded row.
    republishTranscript(
      [timelineMessage("old", "a widget, then another widget", 3), recent],
      jumps,
      history.source,
    );

    expect(statusText(container)).toBe("2 of 3");
    expect(jumps).toEqual(["recent", "old"]);
    expect(history.loads).toEqual([3]);
  });

  it("drops the daemon's answer for a query the reader has since changed", async () => {
    const host = installFakeHost();
    const history = fakeHistory();
    installTranscript([timelineMessage("recent", "the widget", 50)], history.source);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    const input = findInput(container);
    type(input, "widget");
    await waitForHistorySearch();
    type(input, "widgets");

    // An answer that arrives after the query moved on.
    await history.answer({ matches: [{ seqStart: 3, seqEnd: 3, occurrence: 0 }] });
    expect(statusText(container)).toBe(i18n.t("paneFind.noMatches"));

    // An answer that arrived in time, then outlived its query.
    type(input, "widget");
    await waitForHistorySearch();
    await history.answer({ matches: [{ seqStart: 3, seqEnd: 3, occurrence: 0 }] });
    expect(statusText(container)).toBe("2 of 2");
    type(input, "widgets");
    expect(statusText(container)).toBe(i18n.t("paneFind.noMatches"));

    expect(history.loads).toEqual([]);
  });

  it("drops an answer about a timeline the transcript no longer shows", async () => {
    const host = installFakeHost();
    const history = fakeHistory();
    installTranscript([timelineMessage("recent", "the widget", 50)], history.source);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    await waitForHistorySearch();
    await history.answer({
      epoch: "epoch-0",
      matches: [{ seqStart: 3, seqEnd: 3, occurrence: 0 }],
    });

    expect(statusText(container)).toBe("1 of 1");
  });

  it("marks the count as a floor when the daemon capped its scan", async () => {
    const host = installFakeHost();
    const history = fakeHistory();
    installTranscript([timelineMessage("recent", "the widget", 50)], history.source);
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "widget");
    await waitForHistorySearch();
    await history.answer({
      matches: [{ seqStart: 3, seqEnd: 3, occurrence: 0 }],
      truncated: true,
    });

    expect(statusText(container)).toBe("2 of 2+");
  });
});

describe("FindInPageBar with a focused terminal pane", () => {
  it("does not paint transcript hits behind the terminal that owns Find", async () => {
    const host = installFakeHost();
    installTranscript([message("a", "the needle sits here")]);
    const rows = document.createElement("div");
    rows.innerHTML = '<div data-history-row-id="a">the needle sits here</div>';
    document.body.appendChild(rows);
    installTerminal();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "needle");

    // The reader is searching the terminal; marking transcript text would lie.
    expect(CSS.highlights.has("paseo-find")).toBe(false);
    rows.remove();
  });

  it("searches the terminal's own buffer and reports the addon's count", async () => {
    const host = installFakeHost();
    const terminal = installTerminal();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "needle");

    // The canvas renderer keeps the scrollback out of the DOM, so neither
    // Chromium nor the transcript model may answer for it.
    expect(terminal.findCalls).toEqual([{ query: "needle", forward: true, incremental: true }]);
    expect(host.startCalls).toEqual([]);

    reportTerminalResult(1, 5);
    expect(statusText(container)).toBe("2 of 5");
  });

  it("steps forward and backward through the terminal's matches", async () => {
    const host = installFakeHost();
    const terminal = installTerminal();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    const input = findInput(container);
    type(input, "needle");
    pressKey(input, "Enter");
    pressKey(input, "Enter", true);

    expect(terminal.findCalls.slice(1)).toEqual([
      { query: "needle", forward: true, incremental: false },
      { query: "needle", forward: false, incremental: false },
    ]);
  });

  it("clears the terminal's highlights when Escape closes it", async () => {
    const host = installFakeHost();
    const terminal = installTerminal();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "needle");
    pressKey(findInput(container), "Escape");

    expect(container.querySelector('[data-testid="find-in-page-bar"]')).toBeNull();
    expect(terminal.clearCalls).toBe(1);
    expect(host.stopCalls).toContain("clearSelection");
  });

  it("claims Find ahead of the transcript panel behind it", async () => {
    const host = installFakeHost();
    // A transcript is registered too: the terminal pane is focused, so it wins.
    const jumps = installTranscript([message("a", "the needle sits here")]);
    const terminal = installTerminal();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "needle");

    expect(terminal.findCalls).toEqual([{ query: "needle", forward: true, incremental: true }]);
    expect(jumps).toEqual([]);
    expect(host.startCalls).toEqual([]);
  });

  it("hands the open query to Chromium when the terminal pane stops being focused", async () => {
    const host = installFakeHost();
    const terminal = installTerminal();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "needle");
    act(() => useTerminalFindStore.getState().clearSource("term-1"));
    await settle();

    // The pane the reader left keeps its highlight until it is told to stop.
    expect(terminal.clearCalls).toBe(1);
    // The bar still shows the query, so the remaining pane has to be searched.
    expect(host.startCalls).toEqual([{ query: "needle", forward: true, findNext: false }]);
  });

  it("marks a count past the addon's highlight limit as a floor", async () => {
    const host = installFakeHost();
    installTerminal();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    type(findInput(container), "e");
    // resultIndex -1 is the addon's word for "more matches than I may highlight".
    reportTerminalResult(-1, 20_000);

    expect(statusText(container)).toBe(i18n.t("paneFind.total", { total: "20000+" }));
  });
});
