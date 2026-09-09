import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { FindInPageBar } from "./find-in-page-bar.electron";
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

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function mountBar(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<FindInPageBar />));
  mounted.push({ root, container });
  return container;
}

/** The listener subscription resolves a promise, so let the microtasks drain. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function findInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('[data-testid="find-in-page-input"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Find bar input is not rendered");
  }
  return input;
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
  delete window.paseoDesktop;
});

describe("FindInPageBar", () => {
  it("renders against the initialized English catalog", () => {
    expect(i18n.t("desktop.find.placeholder")).toBe("Find");
  });

  it("stays hidden until the desktop shell asks for it", async () => {
    const host = installFakeHost();
    const container = mountBar();
    await settle();

    expect(container.querySelector('[data-testid="find-in-page-bar"]')).toBeNull();

    act(() => host.emit("find-open", {}));

    expect(container.querySelector('[data-testid="find-in-page-bar"]')).not.toBeNull();
  });

  it("searches as the query is typed and advances on Enter", async () => {
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
  });

  it("reports the match count the shell sends back", async () => {
    const host = installFakeHost();
    const container = mountBar();
    await settle();
    act(() => host.emit("find-open", {}));
    type(findInput(container), "needle");

    act(() => host.emit("find-result", { activeMatchOrdinal: 2, matches: 7, finalUpdate: true }));
    expect(container.querySelector('[data-testid="find-in-page-counter"]')?.textContent).toBe(
      "2 of 7",
    );

    act(() => host.emit("find-result", { activeMatchOrdinal: 0, matches: 0, finalUpdate: true }));
    expect(container.querySelector('[data-testid="find-in-page-counter"]')?.textContent).toBe(
      "No results",
    );
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

    // A stale query would let Find Next keep walking an invisible search.
    act(() => host.emit("find-next", {}));
    expect(host.startCalls).toEqual([]);
  });

  it("stops the search when the window unmounts the bar", async () => {
    const host = installFakeHost();
    mountBar();
    await settle();
    act(() => host.emit("find-open", {}));

    for (const entry of mounted.splice(0)) {
      act(() => entry.root.unmount());
      entry.container.remove();
    }

    expect(host.stopCalls).toContain("clearSelection");
  });
});
