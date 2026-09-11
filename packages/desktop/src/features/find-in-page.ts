import { app, ipcMain } from "electron";
import { getActivePaseoBrowserWebContentsForHostWindow } from "./browser-webviews/index.js";

export const FIND_RESULT_CHANNEL = "paseo:event:find-result";
export const FIND_OPEN_CHANNEL = "paseo:event:find-open";
export const FIND_NEXT_CHANNEL = "paseo:event:find-next";
export const FIND_PREVIOUS_CHANNEL = "paseo:event:find-previous";

export type FindInPageStopAction = "clearSelection" | "keepSelection" | "activateSelection";

export interface FoundInPageResult {
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

type FoundInPageListener = (event: unknown, result: FoundInPageResult) => void;

/** The slice of `WebContents` a find target has to provide. */
export interface FindInPageContents {
  id: number;
  isDestroyed(): boolean;
  findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
  ): number;
  stopFindInPage(action: FindInPageStopAction): void;
  on(event: "found-in-page", listener: FoundInPageListener): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "found-in-page", listener: FoundInPageListener): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

/** The window renderer that owns the find bar and receives match counts. */
export interface FindInPageHostContents extends FindInPageContents {
  send(channel: string, payload: unknown): void;
}

export interface FindInPageStartResult {
  /** False when the window had nothing Chromium may search, so there is no count. */
  searched: boolean;
}

export interface FindInPageStartInput {
  query: string;
  /** Search direction; defaults to forward. */
  forward?: boolean;
  /** Advance within the current query instead of restarting the search. */
  findNext?: boolean;
}

interface FindSession {
  target: FindInPageContents;
  listener: FoundInPageListener;
  onTargetDestroyed: () => void;
  query: string;
}

export function parseFindInPageStartInput(value: unknown): FindInPageStartInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (typeof input.query !== "string") {
    return null;
  }
  if (input.forward !== undefined && typeof input.forward !== "boolean") {
    return null;
  }
  if (input.findNext !== undefined && typeof input.findNext !== "boolean") {
    return null;
  }
  return {
    query: input.query,
    ...(input.forward === undefined ? {} : { forward: input.forward }),
    ...(input.findNext === undefined ? {} : { findNext: input.findNext }),
  };
}

export function parseFindInPageStopAction(value: unknown): FindInPageStopAction {
  return value === "keepSelection" || value === "activateSelection" ? value : "clearSelection";
}

/**
 * Runs Chromium's find-in-page for each window's find bar.
 *
 * Only an embedded browser pane is ever searched, never the window's own page.
 * That page contains the find bar, and Chromium's find both counts the query in
 * the bar's input as a match and moves focus out of it — measured on Electron
 * 44: 3 matches for 2, focus to BODY, and refocusing loses it again on the next
 * search. A browser pane is a separate webContents, where neither happens, and
 * the transcript is searched through its stream model in the renderer.
 */
export class FindInPageController {
  private readonly sessionsByHostId = new Map<number, FindSession>();

  public constructor(
    private readonly resolveTarget: (host: FindInPageHostContents) => FindInPageContents | null,
  ) {}

  public start(host: FindInPageHostContents, input: FindInPageStartInput): FindInPageStartResult {
    if (input.query.length === 0) {
      this.stop(host, "clearSelection");
      this.sendResult(host, { activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
      return { searched: false };
    }

    const target = this.resolveTarget(host);
    // Refuse the host even if a resolver offers it; see the class comment.
    if (!target || target.id === host.id || target.isDestroyed()) {
      this.endSession(host.id, null);
      this.sendResult(host, { activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
      return { searched: false };
    }

    const existing = this.sessionsByHostId.get(host.id);
    if (existing && existing.target !== target) {
      // The pane being left keeps its highlight until it is told to stop.
      this.endSession(host.id, "clearSelection");
    }

    const session = this.sessionsByHostId.get(host.id) ?? this.beginSession(host, target);
    // Electron's `findNext` means "begin a new finding session": true for the
    // first request, false for follow-ups. That is the inverse of this bridge's
    // "advance to the next match", and advancing a query Chromium is not
    // already holding has nothing to continue, so that starts a session too.
    const advances = input.findNext === true && session.query === input.query;
    session.query = input.query;
    target.findInPage(input.query, {
      forward: input.forward !== false,
      findNext: !advances,
    });
    return { searched: true };
  }

  public stop(host: FindInPageHostContents, action: FindInPageStopAction): void {
    this.endSession(host.id, action);
  }

  public releaseHost(hostWebContentsId: number): void {
    // A guest pane outlives the window that was searching it, so clear it.
    this.endSession(hostWebContentsId, "clearSelection");
  }

  private beginSession(host: FindInPageHostContents, target: FindInPageContents): FindSession {
    const listener: FoundInPageListener = (_event, result) => {
      this.sendResult(host, result);
    };
    const onTargetDestroyed = () => {
      // Only this session's own target death is ours to clean up; a later
      // session on the same host owns its target from here on.
      if (this.sessionsByHostId.get(host.id) !== session) {
        return;
      }
      this.sessionsByHostId.delete(host.id);
      this.sendResult(host, { activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
    };
    const session: FindSession = { target, listener, onTargetDestroyed, query: "" };
    target.on("found-in-page", listener);
    target.once("destroyed", onTargetDestroyed);
    this.sessionsByHostId.set(host.id, session);
    return session;
  }

  private endSession(hostWebContentsId: number, action: FindInPageStopAction | null): void {
    const session = this.sessionsByHostId.get(hostWebContentsId);
    if (!session) {
      return;
    }
    this.sessionsByHostId.delete(hostWebContentsId);
    if (session.target.isDestroyed()) {
      return;
    }
    session.target.removeListener("found-in-page", session.listener);
    session.target.removeListener("destroyed", session.onTargetDestroyed);
    if (action) {
      session.target.stopFindInPage(action);
    }
  }

  private sendResult(host: FindInPageHostContents, result: FoundInPageResult): void {
    if (host.isDestroyed()) {
      return;
    }
    host.send(FIND_RESULT_CHANNEL, {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    });
  }
}

export function registerFindInPageHandlers(): FindInPageController {
  const controller = new FindInPageController((host) =>
    getActivePaseoBrowserWebContentsForHostWindow(host.id),
  );

  ipcMain.handle("paseo:find:start", (event, rawInput: unknown) => {
    const input = parseFindInPageStartInput(rawInput);
    if (!input) {
      return { searched: false } satisfies FindInPageStartResult;
    }
    return controller.start(event.sender, input);
  });

  ipcMain.handle("paseo:find:stop", (event, rawAction: unknown) => {
    controller.stop(event.sender, parseFindInPageStopAction(rawAction));
  });

  // A closed window never sends `find:stop`, so drop its session here or the
  // map keeps growing one dead entry per window for the life of the process.
  app.on("browser-window-created", (_event, win) => {
    const hostWebContentsId = win.webContents.id;
    win.webContents.once("destroyed", () => {
      controller.releaseHost(hostWebContentsId);
    });
  });

  return controller;
}
