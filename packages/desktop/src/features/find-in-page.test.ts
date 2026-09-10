import { describe, expect, it } from "vitest";
import {
  FIND_RESULT_CHANNEL,
  FindInPageController,
  parseFindInPageStartInput,
  parseFindInPageStopAction,
  type FindInPageContents,
  type FoundInPageResult,
} from "./find-in-page.js";

interface FindCall {
  text: string;
  forward: boolean;
  /** Electron's `findNext`: true begins a new finding session. */
  newSession: boolean;
}

type FoundListener = (event: unknown, result: FoundInPageResult) => void;

class FakeContents implements FindInPageContents {
  public readonly findCalls: FindCall[] = [];
  public readonly stopCalls: string[] = [];
  public readonly listeners = new Set<FoundListener>();
  public readonly destroyListeners: Array<() => void> = [];
  private destroyed = false;

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyListeners.splice(0)) {
      listener();
    }
  }

  public findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
  ): number {
    this.findCalls.push({
      text,
      forward: options?.forward !== false,
      newSession: options?.findNext === true,
    });
    return this.findCalls.length;
  }

  public stopFindInPage(action: string): void {
    this.stopCalls.push(action);
  }

  public on(_event: "found-in-page", listener: FoundListener) {
    this.listeners.add(listener);
    return this;
  }

  public once(_event: "destroyed", listener: () => void) {
    this.destroyListeners.push(listener);
    return this;
  }

  public removeListener(
    event: "found-in-page" | "destroyed",
    listener: FoundListener & (() => void),
  ) {
    if (event === "destroyed") {
      const index = this.destroyListeners.indexOf(listener);
      if (index >= 0) {
        this.destroyListeners.splice(index, 1);
      }
      return this;
    }
    this.listeners.delete(listener);
    return this;
  }

  public emitFound(result: FoundInPageResult): void {
    for (const listener of this.listeners) {
      listener({}, result);
    }
  }
}

class FakeHostContents extends FakeContents {
  public readonly sent: Array<{ channel: string; payload: unknown }> = [];

  public send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

const ZERO_RESULT = {
  channel: FIND_RESULT_CHANNEL,
  payload: { activeMatchOrdinal: 0, matches: 0, finalUpdate: true },
};

/** A window with an active browser pane — the only thing Find may search. */
function setup() {
  const host = new FakeHostContents(1);
  const browser = new FakeContents(42);
  let target: FindInPageContents | null = browser;
  const controller = new FindInPageController(() => target);
  return {
    controller,
    host,
    browser,
    setTarget: (next: FindInPageContents | null) => {
      target = next;
    },
  };
}

describe("FindInPageController", () => {
  it("searches the active browser pane", () => {
    const { controller, host, browser } = setup();

    expect(controller.start(host, { query: "needle" })).toEqual({ searched: true });

    expect(browser.findCalls).toEqual([{ text: "needle", forward: true, newSession: true }]);
    expect(host.findCalls).toEqual([]);
  });

  it("never searches the page that contains the find bar", () => {
    // Measured on Electron 44: searching the host counts the query in the bar's
    // own input (3 matches for 2) and moves focus out of it to BODY.
    const { controller, host, setTarget } = setup();
    setTarget(host);

    expect(controller.start(host, { query: "needle" })).toEqual({ searched: false });

    expect(host.findCalls).toEqual([]);
    expect(host.sent).toEqual([ZERO_RESULT]);
  });

  it("says nothing was searched when there is no browser pane", () => {
    const { controller, host, setTarget } = setup();
    setTarget(null);

    expect(controller.start(host, { query: "needle" })).toEqual({ searched: false });

    expect(host.sent).toEqual([ZERO_RESULT]);
  });

  it("opens a new Chromium session unless it is advancing the query Chromium holds", () => {
    const { controller, host, browser } = setup();

    controller.start(host, { query: "needle" });
    controller.start(host, { query: "needle", findNext: true });
    controller.start(host, { query: "haystack", findNext: true });

    // Electron's `findNext` is "begin a new session": true first, false to continue.
    expect(browser.findCalls.map((call) => call.newSession)).toEqual([true, false, true]);
  });

  it("searches backwards when asked", () => {
    const { controller, host, browser } = setup();

    controller.start(host, { query: "needle" });
    controller.start(host, { query: "needle", findNext: true, forward: false });

    expect(browser.findCalls[1]).toEqual({ text: "needle", forward: false, newSession: false });
  });

  it("forwards match counts to the window that owns the find bar", () => {
    const { controller, host, browser } = setup();

    controller.start(host, { query: "needle" });
    browser.emitFound({ activeMatchOrdinal: 2, matches: 7, finalUpdate: true });

    expect(host.sent).toEqual([
      {
        channel: FIND_RESULT_CHANNEL,
        payload: { activeMatchOrdinal: 2, matches: 7, finalUpdate: true },
      },
    ]);
  });

  it("reports zero matches for an empty query and clears the highlight", () => {
    const { controller, host, browser } = setup();

    controller.start(host, { query: "needle" });
    host.sent.length = 0;

    expect(controller.start(host, { query: "" })).toEqual({ searched: false });
    expect(browser.stopCalls).toEqual(["clearSelection"]);
    expect(host.sent).toEqual([ZERO_RESULT]);
  });

  it("stops listening once the find bar closes", () => {
    const { controller, host, browser } = setup();

    controller.start(host, { query: "needle" });
    controller.stop(host, "clearSelection");

    expect(browser.stopCalls).toEqual(["clearSelection"]);
    expect(browser.listeners.size).toBe(0);
  });

  it("hands the search over when the active pane changes mid-session", () => {
    const { controller, host, browser, setTarget } = setup();
    const other = new FakeContents(43);

    controller.start(host, { query: "needle" });
    setTarget(other);
    controller.start(host, { query: "needle", findNext: true });

    expect(browser.listeners.size).toBe(0);
    // The new pane has not run this query yet, so it starts from the top...
    expect(other.findCalls).toEqual([{ text: "needle", forward: true, newSession: true }]);
    // ...and the pane being left does not keep its highlight.
    expect(browser.stopCalls).toEqual(["clearSelection"]);
  });

  it("invalidates the session and zeroes the count when the pane is destroyed", () => {
    const { controller, host, browser } = setup();

    controller.start(host, { query: "needle" });
    host.sent.length = 0;
    browser.destroy();

    expect(host.sent).toEqual([ZERO_RESULT]);
    // A destroyed pane must not be stopped or searched afterwards.
    controller.stop(host, "clearSelection");
    expect(browser.stopCalls).toEqual([]);
  });

  it("reports nothing searched when the pane is already gone", () => {
    const { controller, host, browser } = setup();

    browser.destroy();

    expect(controller.start(host, { query: "needle" })).toEqual({ searched: false });
    expect(browser.findCalls).toHaveLength(0);
    expect(host.sent).toEqual([ZERO_RESULT]);
  });

  it("clears a pane that outlives the window searching it", () => {
    const { controller, host, browser } = setup();

    controller.start(host, { query: "needle" });
    controller.releaseHost(host.id);

    expect(browser.stopCalls).toEqual(["clearSelection"]);
    expect(browser.listeners.size).toBe(0);
    expect(browser.destroyListeners).toHaveLength(0);
  });
});

describe("parseFindInPageStartInput", () => {
  it("accepts a query with optional direction flags", () => {
    expect(parseFindInPageStartInput({ query: "a", forward: false, findNext: true })).toEqual({
      query: "a",
      forward: false,
      findNext: true,
    });
  });

  it("rejects malformed input", () => {
    expect(parseFindInPageStartInput(null)).toBeNull();
    expect(parseFindInPageStartInput({})).toBeNull();
    expect(parseFindInPageStartInput({ query: 3 })).toBeNull();
    expect(parseFindInPageStartInput({ query: "a", forward: "yes" })).toBeNull();
    expect(parseFindInPageStartInput({ query: "a", findNext: 1 })).toBeNull();
  });
});

describe("parseFindInPageStopAction", () => {
  it("falls back to clearing the highlight", () => {
    expect(parseFindInPageStopAction("keepSelection")).toBe("keepSelection");
    expect(parseFindInPageStopAction("activateSelection")).toBe("activateSelection");
    expect(parseFindInPageStopAction("nonsense")).toBe("clearSelection");
    expect(parseFindInPageStopAction(undefined)).toBe("clearSelection");
  });
});
