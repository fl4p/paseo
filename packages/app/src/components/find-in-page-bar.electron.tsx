import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PaneFind, type PaneFindHandle } from "@/pane-find";
import {
  findTranscriptMatches,
  mergeTranscriptHits,
  preserveActiveHit,
  stepMatchIndex,
  type HistorySearchResult,
  type TranscriptHit,
} from "@/agent-stream/find/model";
import { useTranscriptFindStore, type TranscriptFindSource } from "@/agent-stream/find/store";
import { useTerminalFindStore, type TerminalFindSource } from "@/terminal/find/store";
import {
  afterRowSettles,
  applyTranscriptHighlights,
  clearTranscriptHighlights,
  revealRange,
  type ActiveTranscriptHit,
} from "@/agent-stream/find/highlight";
import { getDesktopHost, type DesktopFindResult } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";

const EMPTY_RESULT: DesktopFindResult = {
  activeMatchOrdinal: 0,
  matches: 0,
  finalUpdate: true,
};

const NO_TRANSCRIPT_HITS: { hits: TranscriptHit[]; truncated: boolean } = {
  hits: [],
  truncated: false,
};

/** A live turn mutates the DOM every few dozen milliseconds; repaint at most this often. */
const HIGHLIGHT_REFRESH_MS = 150;

/** Scanning the whole timeline waits for a pause in typing rather than chasing every key. */
const HISTORY_SEARCH_DELAY_MS = 150;

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

/**
 * The active hit is the n-th hit in its row, counted the same way in the model
 * and the DOM. A hit in unloaded history has no row to paint yet.
 */
function activeHitFor(
  hits: readonly TranscriptHit[],
  activeMatchIndex: number,
): ActiveTranscriptHit | null {
  const hit = hits[activeMatchIndex];
  return hit?.kind === "loaded" ? { itemId: hit.itemId, occurrence: hit.occurrence } : null;
}

/**
 * The daemon's hits across the transcript's whole timeline, for the query the
 * bar is showing. An answer is dropped once it no longer applies — the reader
 * typed on, the transcript changed, or the timeline was replaced — rather than
 * merged into hits for something else.
 */
function useHistorySearch(input: {
  enabled: boolean;
  query: string;
  source: TranscriptFindSource | null;
}): HistorySearchResult | null {
  const { enabled, query, source } = input;
  const history = source?.history ?? null;
  const epoch = history?.epoch ?? null;
  // The source is republished on every stream update; only these change the question.
  const key =
    enabled && source !== null && epoch !== null && query.length > 0
      ? JSON.stringify([source.agentId, epoch, query])
      : null;
  const historyRef = useRef(history);
  historyRef.current = history;
  const [answer, setAnswer] = useState<{ key: string; result: HistorySearchResult } | null>(null);

  useEffect(() => {
    const search = historyRef.current?.search;
    if (key === null || !search) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(query)
        .then((result) => {
          if (!cancelled) {
            setAnswer({ key, result });
          }
          return undefined;
        })
        .catch((error: unknown) => {
          console.warn("Find could not search the timeline history", error);
        });
    }, HISTORY_SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, query]);

  if (answer === null || answer.key !== key || answer.result.epoch !== epoch) {
    return null;
  }
  return answer.result;
}

/**
 * Chromium's find painted its matches; the transcript search paints its own
 * (see agent-stream/find/highlight.web.ts). It paints only while the transcript
 * owns Find: a focused terminal outranks it, and transcript hits painted behind
 * the terminal would mark text the reader is not searching. Kept out of
 * FindInPageBar so the bar stays a router between backends.
 */
function useTranscriptHighlights(input: {
  visible: boolean;
  owned: boolean;
  query: string;
  hits: readonly TranscriptHit[];
  activeMatchIndex: number;
}): void {
  const { visible, owned, query, hits, activeMatchIndex } = input;
  const activeHit = useMemo(() => activeHitFor(hits, activeMatchIndex), [activeMatchIndex, hits]);
  const activeHitRef = useRef(activeHit);
  activeHitRef.current = activeHit;
  const highlightQuery = visible && owned ? query : "";

  useEffect(() => {
    if (highlightQuery.length === 0) {
      clearTranscriptHighlights();
      return;
    }
    let pending: number | null = null;
    let lastPaint = 0;
    const paint = () => {
      pending = null;
      lastPaint = Date.now();
      applyTranscriptHighlights({ query: highlightQuery, active: activeHitRef.current });
    };
    paint();
    // Rows mount as the transcript scrolls, and grow while a turn streams.
    const observer = new MutationObserver(() => {
      if (pending !== null) {
        return;
      }
      pending = window.setTimeout(
        paint,
        Math.max(0, HIGHLIGHT_REFRESH_MS - (Date.now() - lastPaint)),
      );
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (pending !== null) {
        window.clearTimeout(pending);
      }
      clearTranscriptHighlights();
    };
  }, [highlightQuery]);

  // Reveal the exact hit once the jump has settled: a long message can put it far
  // below the row top the transcript scrolls to.
  const activeHitKey = activeHit ? `${activeHit.itemId}#${activeHit.occurrence}` : null;
  useEffect(() => {
    const hit = activeHitRef.current;
    if (highlightQuery.length === 0 || !hit || activeHitKey === null) {
      return;
    }
    return afterRowSettles(hit.itemId, () => {
      const { activeRange } = applyTranscriptHighlights({ query: highlightQuery, active: hit });
      if (activeRange) {
        revealRange(activeRange);
      }
    });
  }, [activeHitKey, highlightQuery]);
}

/**
 * Moves the transcript to the active hit whenever it becomes a different hit.
 * The transcript is read through a ref: its source is republished on every
 * stream update, and depending on it would drag the reader back to the active
 * hit on each update of a live turn. A hit in unloaded history loads its window
 * first; the anchor then follows it into the loaded row, whose new key makes
 * the jump.
 */
function useJumpToActiveHit(input: {
  visible: boolean;
  activeHit: TranscriptHit | null;
  transcriptRef: { readonly current: TranscriptFindSource | null };
}): void {
  const { visible, activeHit, transcriptRef } = input;
  const activeHitRef = useRef(activeHit);
  activeHitRef.current = activeHit;
  let jumpKey: string | null = null;
  if (activeHit?.kind === "loaded") {
    jumpKey = `item:${activeHit.itemId}`;
  } else if (activeHit?.kind === "history") {
    jumpKey = `seq:${activeHit.seqEnd}`;
  }
  useEffect(() => {
    const hit = activeHitRef.current;
    if (!visible || jumpKey === null || !hit) {
      return;
    }
    if (hit.kind === "loaded") {
      transcriptRef.current?.jumpToItem(hit.itemId);
    } else {
      transcriptRef.current?.history?.load(hit.seqEnd);
    }
  }, [jumpKey, transcriptRef, visible]);
}

interface FindCounts {
  total: number;
  /** 1-based; 0 when there is no active match to point at. */
  current: number;
  truncated: boolean;
}

const NO_COUNTS: FindCounts = { total: 0, current: 0, truncated: false };

function terminalCounts(
  result: { resultIndex: number; resultCount: number } | null | undefined,
): FindCounts {
  const total = result?.resultCount ?? 0;
  const index = result?.resultIndex ?? -1;
  return {
    total,
    current: index >= 0 ? index + 1 : 0,
    // The addon reports index -1 once its highlight limit is exceeded: the
    // count is then a floor, and the bar says so instead of pinning it.
    truncated: total > 0 && index < 0,
  };
}

function formatStatus(input: {
  current: number;
  total: number;
  truncated: boolean;
  hasQuery: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}): string {
  if (input.total > 0) {
    if (input.current <= 0) {
      // No active match to point at — the terminal's search addon stops
      // tracking the active index once its highlight limit is exceeded — so
      // the bar states the count it knows, as a floor rather than a total.
      return input.t("paneFind.total", {
        total: input.truncated ? `${input.total}+` : `${input.total}`,
      });
    }
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
 * It searches whichever of three things the window is showing. An agent
 * transcript is searched through its own stream model, because the web
 * transcript only mounts its recent rows and Chromium's find would report a
 * confident "No matches" for text that is plainly in the conversation. A
 * focused terminal pane is searched through its own xterm search addon — the
 * canvas renderer keeps the scrollback out of the DOM, so no other backend
 * can see it — and claims Find ahead of a merely-presented transcript, since
 * the reader clicked into it. Anything else — settings, an embedded browser
 * pane — is searched with Chromium's find-in-page from the main process.
 */
export function FindInPageBar(): React.ReactElement | null {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [chromiumResult, setChromiumResult] = useState<DesktopFindResult>(EMPTY_RESULT);
  // Unknown until the main process answers whether it had a browser pane to search.
  const [chromiumSearchable, setChromiumSearchable] = useState<boolean | null>(null);
  const findRef = useRef<PaneFindHandle>(null);
  const transcript = useTranscriptFindStore((state) => state.source);
  const terminal = useTerminalFindStore((state) => state.source);
  const terminalResult = useTerminalFindStore((state) => state.result);
  // A focused terminal pane is the pane the reader clicked into; it answers
  // Find ahead of a transcript panel that merely sits in the active tab.
  const usingTerminal = terminal !== null;
  const usingTranscript = !usingTerminal && transcript !== null;

  const history = useHistorySearch({
    enabled: visible && usingTranscript,
    query,
    source: transcript,
  });
  // Loaded rows answer at once; the daemon's hits in unloaded history join them
  // when its answer arrives.
  const { hits, truncated: truncatedMatches } = useMemo(() => {
    if (!transcript || query.length === 0) {
      return NO_TRANSCRIPT_HITS;
    }
    const local = findTranscriptMatches({ items: transcript.items, query });
    return {
      hits: mergeTranscriptHits({ items: transcript.items, local: local.matches, history }),
      truncated: local.truncated || history?.truncated === true,
    };
  }, [history, query, transcript]);

  // The selection is an anchor on a hit, not an index. A live turn appends rows
  // and renumbers the list, and loading history turns a history hit into a
  // loaded one; deriving the index here rather than repairing it in an effect
  // means the bar never renders a count it has to take back.
  const [anchor, setAnchor] = useState<TranscriptHit | null>(null);
  const activeMatchIndex = useMemo(
    () => preserveActiveHit({ previous: anchor, hits }),
    [anchor, hits],
  );

  const searchChromium = useCallback((nextQuery: string, forward: boolean, findNext: boolean) => {
    const find = getDesktopHost()?.find;
    if (nextQuery.length === 0) {
      setChromiumResult(EMPTY_RESULT);
      void find?.stop?.("clearSelection");
      return;
    }
    void find
      ?.start?.({ query: nextQuery, forward, findNext })
      ?.then((result) => {
        setChromiumSearchable(result?.searched !== false);
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  const stopChromium = useCallback(() => {
    setChromiumResult(EMPTY_RESULT);
    setChromiumSearchable(null);
    void getDesktopHost()?.find?.stop?.("clearSelection");
  }, []);

  const stopTerminal = useCallback(() => {
    useTerminalFindStore.getState().source?.clear();
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setQuery("");
    setAnchor(null);
    stopChromium();
    stopTerminal();
  }, [stopChromium, stopTerminal]);

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      setAnchor(null);
      if (usingTerminal) {
        if (nextQuery.length === 0) {
          terminal?.clear();
        } else {
          // Incremental: typing keeps the current match selected when it still
          // fits the longer query, instead of jumping back to the first hit.
          terminal?.find({ query: nextQuery, forward: true, incremental: true });
        }
        return;
      }
      if (transcript) {
        // The jump follows from the recomputed match list, not from here.
        return;
      }
      searchChromium(nextQuery, true, false);
    },
    [searchChromium, terminal, transcript, usingTerminal],
  );

  // Typing moves the transcript to the first hit; stepping moves it to the next.
  // The source object is republished on every stream update, so it is read
  // through a ref: depending on it here would re-scroll the reader back to the
  // active hit on each update of a live turn.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  // Only a transcript that actually answers Find may jump the reader: a
  // focused terminal pane outranks it, and jumping behind the terminal's own
  // scroll would move text the reader is not looking at.
  useJumpToActiveHit({
    visible,
    activeHit: usingTranscript ? (hits[activeMatchIndex] ?? null) : null,
    transcriptRef,
  });

  useTranscriptHighlights({
    visible,
    owned: usingTranscript,
    query,
    hits,
    activeMatchIndex,
  });

  const step = useCallback(
    (forward: boolean) => {
      if (usingTerminal) {
        terminal?.find({ query, forward, incremental: false });
        return;
      }
      if (transcript) {
        const next = stepMatchIndex({
          current: activeMatchIndex,
          total: hits.length,
          forward,
        });
        // The jump belongs to the effect above, which owns it for every route
        // into a new match — typing, stepping, or the menu's Find Next.
        setAnchor(hits[next] ?? null);
        return;
      }
      searchChromium(query, forward, true);
    },
    [activeMatchIndex, hits, query, searchChromium, terminal, transcript, usingTerminal],
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

  // Moving between panes while the bar is open has to hand the open query
  // over: leaving a backend's highlight behind, or leaving the new pane
  // unsearched while the bar still shows a count, both lie.
  const queryRef = useRef(query);
  queryRef.current = query;
  // The terminal that last claimed Find, kept so its highlights can be
  // cleared when the claim moves on — the store has already forgotten it by
  // the time the effect below runs.
  const lastTerminalRef = useRef<TerminalFindSource | null>(null);
  if (terminal) {
    lastTerminalRef.current = terminal;
  }
  useEffect(() => {
    if (usingTerminal) {
      stopChromium();
      if (queryRef.current.length > 0) {
        terminal?.find({ query: queryRef.current, forward: true, incremental: false });
      }
      return;
    }
    lastTerminalRef.current?.clear();
    if (usingTranscript) {
      stopChromium();
      return;
    }
    if (queryRef.current.length > 0) {
      searchChromium(queryRef.current, true, false);
    }
  }, [searchChromium, stopChromium, terminal, usingTerminal, usingTranscript]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    findRef.current?.focus();
  }, [visible]);

  if (!visible) {
    return null;
  }

  // With none of a terminal, a transcript, or a browser pane there is nothing
  // Find may search, and "No matches" there would be a claim about text
  // nobody read.
  const searchable = usingTerminal || usingTranscript || chromiumSearchable === true;
  let counts: FindCounts = NO_COUNTS;
  if (usingTerminal) {
    counts = terminalCounts(terminalResult);
  } else if (usingTranscript) {
    counts = { total: hits.length, current: activeMatchIndex + 1, truncated: truncatedMatches };
  } else if (searchable) {
    counts = {
      total: chromiumResult.matches,
      current: chromiumResult.activeMatchOrdinal,
      truncated: false,
    };
  }
  const { total, current, truncated } = counts;
  const status = formatStatus({
    current,
    total,
    truncated,
    hasQuery: searchable && query.length > 0,
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
