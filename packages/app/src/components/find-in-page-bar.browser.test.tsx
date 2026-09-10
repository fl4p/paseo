import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { FindInPageBar } from "./find-in-page-bar.electron";
import { useTranscriptFindStore } from "@/agent-stream/find/store";
import type { StreamItem } from "@/types/stream";
import type { DesktopFindStartInput, DesktopFindStopAction } from "@/desktop/host";

interface FakeDesktopHost {
  emit: (event: string, payload: unknown) => void;
  startCalls: DesktopFindStartInput[];
  stopCalls: DesktopFindStopAction[];
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
        return Promise.resolve();
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

function installTranscript(items: StreamItem[]): string[] {
  const jumps: string[] = [];
  useTranscriptFindStore.getState().setSource({
    agentId: "agent-1",
    items,
    jumpToItem: (itemId) => jumps.push(itemId),
  });
  return jumps;
}

/** A live turn republishes the source object without changing the match. */
function republishTranscript(items: StreamItem[], jumps: string[]): void {
  act(() =>
    useTranscriptFindStore.getState().setSource({
      agentId: "agent-1",
      items,
      jumpToItem: (itemId) => jumps.push(itemId),
    }),
  );
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
