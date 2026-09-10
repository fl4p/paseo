import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import {
  findTranscriptMatches,
  preserveActiveMatch,
  stepMatchIndex,
  type TranscriptMatch,
  type TranscriptSearchResult,
} from "@/agent-stream/find/model";
import { useTranscriptFindStore } from "@/agent-stream/find/store";
import { getDesktopHost, type DesktopFindResult } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";

const EMPTY_RESULT: DesktopFindResult = {
  activeMatchOrdinal: 0,
  matches: 0,
  finalUpdate: true,
};

const NO_TRANSCRIPT_RESULT: TranscriptSearchResult = { matches: [], truncated: false };

function isFindResult(value: unknown): value is DesktopFindResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return typeof result.activeMatchOrdinal === "number" && typeof result.matches === "number";
}

/** Subscribes to a main-process event for as long as the bar is mounted. */
function useDesktopEvent(event: string, handler: (payload: unknown) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!getDesktopHost()?.events?.on) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenToDesktopEvent(event, (payload: unknown) => {
      handlerRef.current(payload);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
        return undefined;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}

function formatStatus(input: {
  current: number;
  total: number;
  truncated: boolean;
  hasQuery: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}): string {
  if (input.total > 0) {
    return input.t("paneFind.position", {
      current: input.current,
      // A capped scan knows a floor, not a total, and says so rather than
      // presenting the cap as the answer.
      total: input.truncated ? `${input.total}+` : input.total,
    });
  }
  return input.hasQuery ? input.t("paneFind.noMatches") : "";
}

/**
 * The desktop Find bar.
 *
 * It searches whichever of two things the window is showing. An agent
 * transcript is searched through its own stream model, because the web
 * transcript only mounts its recent rows and Chromium's find would report a
 * confident "No matches" for text that is plainly in the conversation. Anything
 * else — settings, an embedded browser pane — is searched with Chromium's
 * find-in-page from the main process.
 *
 * Terminal panes are in neither camp: xterm paints its scrollback to a canvas,
 * so that text is not searchable by either backend.
 */
export function FindInPageBar(): React.ReactElement | null {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [chromiumResult, setChromiumResult] = useState<DesktopFindResult>(EMPTY_RESULT);
  const findRef = useRef<PaneFindHandle>(null);
  const transcript = useTranscriptFindStore((state) => state.source);

  const { matches, truncated } = useMemo<TranscriptSearchResult>(() => {
    if (!transcript || query.length === 0) {
      return NO_TRANSCRIPT_RESULT;
    }
    return findTranscriptMatches({ items: transcript.items, query });
  }, [query, transcript]);

  // The selection is an anchor on a hit, not an index. A live turn appends rows
  // and renumbers the list, and deriving the index here rather than repairing it
  // in an effect means the bar never renders a count it has to take back.
  const [anchor, setAnchor] = useState<TranscriptMatch | null>(null);
  const activeMatchIndex = useMemo(
    () => preserveActiveMatch({ previous: anchor, matches }),
    [anchor, matches],
  );

  const searchChromium = useCallback((nextQuery: string, forward: boolean, findNext: boolean) => {
    const find = getDesktopHost()?.find;
    if (nextQuery.length === 0) {
      setChromiumResult(EMPTY_RESULT);
      void find?.stop?.("clearSelection");
      return;
    }
    void find?.start?.({ query: nextQuery, forward, findNext });
  }, []);

  const stopChromium = useCallback(() => {
    setChromiumResult(EMPTY_RESULT);
    void getDesktopHost()?.find?.stop?.("clearSelection");
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setQuery("");
    setAnchor(null);
    stopChromium();
  }, [stopChromium]);

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      setAnchor(null);
      if (transcript) {
        // The jump follows from the recomputed match list, not from here.
        return;
      }
      searchChromium(nextQuery, true, false);
    },
    [searchChromium, transcript],
  );

  // Typing moves the transcript to the first hit; stepping moves it to the next.
  // The source object is republished on every stream update, so it is read
  // through a ref: depending on it here would re-scroll the reader back to the
  // active hit on each update of a live turn.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const jumpTargetId = transcript ? (matches[activeMatchIndex]?.itemId ?? null) : null;
  useEffect(() => {
    if (visible && jumpTargetId) {
      transcriptRef.current?.jumpToItem(jumpTargetId);
    }
  }, [jumpTargetId, visible]);

  const step = useCallback(
    (forward: boolean) => {
      if (transcript) {
        const next = stepMatchIndex({
          current: activeMatchIndex,
          total: matches.length,
          forward,
        });
        // The jump belongs to the effect above, which owns it for every route
        // into a new match — typing, stepping, or the menu's Find Next.
        setAnchor(matches[next] ?? null);
        return;
      }
      searchChromium(query, forward, true);
    },
    [activeMatchIndex, matches, query, searchChromium, transcript],
  );

  const onNext = useCallback(() => step(true), [step]);
  const onPrevious = useCallback(() => step(false), [step]);

  useDesktopEvent("find-open", () => {
    setVisible(true);
    findRef.current?.focus();
  });

  useDesktopEvent("find-next", () => {
    if (query.length > 0) {
      setVisible(true);
      onNext();
    }
  });

  useDesktopEvent("find-previous", () => {
    if (query.length > 0) {
      setVisible(true);
      onPrevious();
    }
  });

  useDesktopEvent("find-result", (payload) => {
    if (isFindResult(payload)) {
      setChromiumResult(payload);
    }
  });

  useEffect(() => {
    return () => {
      void getDesktopHost()?.find?.stop?.("clearSelection");
    };
  }, []);

  // Moving between a transcript and another pane while the bar is open has to
  // hand the open query over: leaving Chromium's highlight behind, or leaving
  // the new pane unsearched while the bar still shows a count, both lie.
  const usingTranscript = transcript !== null;
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (usingTranscript) {
      stopChromium();
      return;
    }
    if (queryRef.current.length > 0) {
      searchChromium(queryRef.current, true, false);
    }
  }, [searchChromium, stopChromium, usingTranscript]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    findRef.current?.focus();
  }, [visible]);

  if (!visible) {
    return null;
  }

  const total = transcript ? matches.length : chromiumResult.matches;
  const current = transcript ? activeMatchIndex + 1 : chromiumResult.activeMatchOrdinal;
  const status = formatStatus({
    current,
    total,
    truncated: transcript !== null && truncated,
    hasQuery: query.length > 0,
    t,
  });

  return (
    <View style={styles.anchor} testID="find-in-page-bar">
      <PaneFind
        ref={findRef}
        query={query}
        status={status}
        canNavigate={total > 0}
        onQueryChange={handleQueryChange}
        onNext={onNext}
        onPrevious={onPrevious}
        onClose={close}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[3],
    zIndex: 1000,
  },
}));
