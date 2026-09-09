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

class FakeContents implements FindInPageContents {
  public readonly findCalls: FindCall[] = [];
  public readonly stopCalls: string[] = [];
  public readonly listeners = new Set<(event: unknown, result: FoundInPageResult) => void>();
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

  public on(
    _event: "found-in-page",
    listener: (event: unknown, result: FoundInPageResult) => void,
  ) {
    this.listeners.add(listener);
    return this;
  }

  public once(_event: "destroyed", listener: () => void) {
    this.destroyListeners.push(listener);
    return this;
  }

  public removeListener(
    event: "found-in-page" | "destroyed",
    listener: ((event: unknown, result: FoundInPageResult) => void) & (() => void),
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

function setup(target?: FindInPageContents) {
  const host = new FakeHostContents(1);
  const controller = new FindInPageController(() => target ?? host);
  return { controller, host };
}

describe("FindInPageController", () => {
  it("searches the window itself when no browser pane is active", () => {
    const { controller, host } = setup();

    controller.start(host, { query: "needle" });

    expect(host.findCalls).toEqual([{ text: "needle", forward: true, newSession: true }]);
  });

  it("searches the active browser pane instead of the window", () => {
    const browser = new FakeContents(42);
    const { controller, host } = setup(browser);

    controller.start(host, { query: "needle" });

    expect(browser.findCalls).toHaveLength(1);
    expect(host.findCalls).toHaveLength(0);
  });

  it("opens a new Chromium session unless it is advancing the query Chromium holds", () => {
    const { controller, host } = setup();

    controller.start(host, { query: "needle" });
    controller.start(host, { query: "needle", findNext: true });
    controller.start(host, { query: "haystack", findNext: true });

    // Electron's `findNext` is "begin a new session": true first, false to continue.
    expect(host.findCalls.map((call) => call.newSession)).toEqual([true, false, true]);
  });

  it("searches backwards when asked", () => {
    const { controller, host } = setup();

    controller.start(host, { query: "needle" });
    controller.start(host, { query: "needle", findNext: true, forward: false });

    expect(host.findCalls[1]).toEqual({ text: "needle", forward: false, newSession: false });
  });

  it("forwards match counts to the window that owns the find bar", () => {
    const { controller, host } = setup();

    controller.start(host, { query: "needle" });
    host.emitFound({ activeMatchOrdinal: 2, matches: 7, finalUpdate: true });

    expect(host.sent).toEqual([
      {
        channel: FIND_RESULT_CHANNEL,
        payload: { activeMatchOrdinal: 2, matches: 7, finalUpdate: true },
      },
    ]);
  });

  it("reports zero matches for an empty query and clears the highlight", () => {
    const { controller, host } = setup();

    controller.start(host, { query: "needle" });
    host.sent.length = 0;
    controller.start(host, { query: "" });

    expect(host.stopCalls).toEqual(["clearSelection"]);
    expect(host.sent).toEqual([
      {
        channel: FIND_RESULT_CHANNEL,
        payload: { activeMatchOrdinal: 0, matches: 0, finalUpdate: true },
      },
    ]);
  });

  it("stops listening once the find bar closes", () => {
    const { controller, host } = setup();

    controller.start(host, { query: "needle" });
    controller.stop(host, "clearSelection");

    expect(host.stopCalls).toEqual(["clearSelection"]);
    expect(host.listeners.size).toBe(0);
  });

  it("hands the search over when the find target changes mid-session", () => {
    const browser = new FakeContents(42);
    const host = new FakeHostContents(1);
    let target: FindInPageContents = host;
    const controller = new FindInPageController(() => target);

    controller.start(host, { query: "needle" });
    target = browser;
    controller.start(host, { query: "needle", findNext: true });

    expect(host.listeners.size).toBe(0);
    // The new target has not run this query yet, so it starts from the top.
    expect(browser.findCalls).toEqual([{ text: "needle", forward: true, newSession: true }]);
    // ...and the pane being left does not keep its highlight.
    expect(host.stopCalls).toEqual(["clearSelection"]);
  });

  it("invalidates the session and zeroes the count when the target is destroyed", () => {
    const browser = new FakeContents(42);
    const { controller, host } = setup(browser);

    controller.start(host, { query: "needle" });
    host.sent.length = 0;
    browser.destroy();

    expect(host.sent).toEqual([
      {
        channel: FIND_RESULT_CHANNEL,
        payload: { activeMatchOrdinal: 0, matches: 0, finalUpdate: true },
      },
    ]);

    // A destroyed target must not be stopped or searched afterwards.
    controller.stop(host, "clearSelection");
    expect(browser.stopCalls).toEqual([]);
  });

  it("clears a guest pane that outlives the window searching it", () => {
    const browser = new FakeContents(42);
    const { controller, host } = setup(browser);

    controller.start(host, { query: "needle" });
    controller.releaseHost(host.id);

    expect(browser.stopCalls).toEqual(["clearSelection"]);
    expect(browser.listeners.size).toBe(0);
    expect(browser.destroyListeners).toHaveLength(0);
  });

  it("reports no matches when the target is gone", () => {
    const browser = new FakeContents(42);
    const { controller, host } = setup(browser);

    browser.destroy();
    controller.start(host, { query: "needle" });

    expect(browser.findCalls).toHaveLength(0);
    expect(host.sent).toEqual([
      {
        channel: FIND_RESULT_CHANNEL,
        payload: { activeMatchOrdinal: 0, matches: 0, finalUpdate: true },
      },
    ]);
  });

  it("drops the session for a closed window", () => {
    const { controller, host } = setup();

    controller.start(host, { query: "needle" });
    controller.releaseHost(host.id);

    expect(host.listeners.size).toBe(0);
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
