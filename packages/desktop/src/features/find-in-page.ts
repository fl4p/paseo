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
  removeListener(event: "found-in-page", listener: FoundInPageListener): unknown;
}

/** The window renderer that owns the find bar and receives match counts. */
export interface FindInPageHostContents extends FindInPageContents {
  send(channel: string, payload: unknown): void;
}

export interface FindInPageStartInput {
  query: string;
  forward?: boolean;
  findNext?: boolean;
}

interface FindSession {
  target: FindInPageContents;
  listener: FoundInPageListener;
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
 * A find bar searches whatever the window is showing: an embedded browser pane
 * when one is active, otherwise the Paseo UI itself. That is the same target
 * choice the Reload menu item makes, so the two stay consistent.
 */
export class FindInPageController {
  private readonly sessionsByHostId = new Map<number, FindSession>();

  public constructor(
    private readonly resolveTarget: (host: FindInPageHostContents) => FindInPageContents | null,
  ) {}

  public start(host: FindInPageHostContents, input: FindInPageStartInput): void {
    if (input.query.length === 0) {
      this.stop(host, "clearSelection");
      this.sendResult(host, { activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
      return;
    }

    const target = this.resolveTarget(host);
    if (!target || target.isDestroyed()) {
      this.endSession(host.id);
      this.sendResult(host, { activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
      return;
    }

    const existing = this.sessionsByHostId.get(host.id);
    if (existing && existing.target !== target) {
      this.endSession(host.id);
    }

    const session = this.sessionsByHostId.get(host.id) ?? this.beginSession(host, target);
    // `findNext` only means "advance" while Chromium is still holding the
    // previous query; asking it to advance a query it never ran finds nothing.
    const findNext = input.findNext === true && session.query === input.query;
    session.query = input.query;
    target.findInPage(input.query, { forward: input.forward !== false, findNext });
  }

  public stop(host: FindInPageHostContents, action: FindInPageStopAction): void {
    const session = this.sessionsByHostId.get(host.id);
    if (!session) {
      return;
    }
    if (!session.target.isDestroyed()) {
      session.target.stopFindInPage(action);
    }
    this.endSession(host.id);
  }

  public releaseHost(hostWebContentsId: number): void {
    this.endSession(hostWebContentsId);
  }

  private beginSession(host: FindInPageHostContents, target: FindInPageContents): FindSession {
    const listener: FoundInPageListener = (_event, result) => {
      this.sendResult(host, result);
    };
    target.on("found-in-page", listener);
    const session: FindSession = { target, listener, query: "" };
    this.sessionsByHostId.set(host.id, session);
    return session;
  }

  private endSession(hostWebContentsId: number): void {
    const session = this.sessionsByHostId.get(hostWebContentsId);
    if (!session) {
      return;
    }
    this.sessionsByHostId.delete(hostWebContentsId);
    if (!session.target.isDestroyed()) {
      session.target.removeListener("found-in-page", session.listener);
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
  const controller = new FindInPageController(
    (host) => getActivePaseoBrowserWebContentsForHostWindow(host.id) ?? host,
  );

  ipcMain.handle("paseo:find:start", (event, rawInput: unknown) => {
    const input = parseFindInPageStartInput(rawInput);
    if (!input) {
      return;
    }
    controller.start(event.sender, input);
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
