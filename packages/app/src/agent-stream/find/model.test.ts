import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  findTranscriptMatches,
  getSearchableText,
  mergeTranscriptHits,
  preserveActiveHit,
  stepMatchIndex,
  TRANSCRIPT_MATCH_LIMIT,
  type HistorySearchResult,
  type TranscriptHit,
} from "./model";

const timestamp = new Date(0);

function userMessage(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp };
}

function assistantMessage(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp };
}

describe("getSearchableText", () => {
  it("reads the text the transcript actually shows", () => {
    expect(getSearchableText(userMessage("u1", "hello"))).toBe("hello");
    expect(getSearchableText(assistantMessage("a1", "world"))).toBe("world");
    expect(
      getSearchableText({
        kind: "thought",
        id: "t1",
        text: "pondering",
        timestamp,
        status: "ready",
      }),
    ).toBe("pondering");
    expect(
      getSearchableText({
        kind: "notification",
        sourceType: "error",
        id: "n1",
        timestamp,
        level: "error",
        message: "it broke",
      }),
    ).toBe("it broke");
    expect(
      getSearchableText({
        kind: "todo_list",
        id: "td1",
        timestamp,
        provider: "claude",
        items: [
          { text: "first", completed: true },
          { text: "second", completed: false },
        ],
        activity: { type: "created", count: 2 },
      }),
    ).toBe("first\nsecond");
    expect(
      getSearchableText({
        kind: "tool_call",
        id: "tc1",
        timestamp,
        payload: {
          source: "orchestrator",
          data: { toolCallId: "c1", toolName: "read_file", arguments: {}, status: "completed" },
        },
      }),
    ).toBe("read_file");
  });

  it("reads a running task's active form, which is what the row shows", () => {
    expect(
      getSearchableText({
        kind: "todo_list",
        id: "td2",
        timestamp,
        provider: "claude",
        items: [
          {
            text: "Deploy it",
            completed: false,
            status: "in_progress",
            activeForm: "Deploying it",
          },
          { text: "Later task", completed: false, status: "pending", activeForm: "Doing later" },
        ],
        activity: { type: "created", count: 2 },
      }),
    ).toBe("Deploying it\nLater task");
  });

  it("matches the phrase a Markdown body renders", () => {
    expect(getSearchableText(assistantMessage("a2", "the **deploy** step"))).toBe(
      "the deploy step",
    );
  });

  it("returns nothing for a row with no plain-text body", () => {
    expect(
      getSearchableText({
        kind: "compaction",
        id: "c1",
        timestamp,
        status: "completed",
      }),
    ).toBe("");
  });
});

describe("findTranscriptMatches", () => {
  const items = [
    userMessage("u1", "Deploy the widget"),
    assistantMessage("a1", "Deploying the widget now; the widget is ready"),
    userMessage("u2", "thanks"),
  ];

  it("reports an exact count when nothing was capped", () => {
    expect(findTranscriptMatches({ items, query: "widget" }).truncated).toBe(false);
  });

  it("finds every occurrence across the whole loaded transcript", () => {
    const { matches } = findTranscriptMatches({ items, query: "widget" });

    expect(matches).toEqual([
      { itemId: "u1", itemIndex: 0, start: 11, occurrence: 0 },
      { itemId: "a1", itemIndex: 1, start: 14, occurrence: 0 },
      { itemId: "a1", itemIndex: 1, start: 30, occurrence: 1 },
    ]);
  });

  it("is case-insensitive and literal", () => {
    expect(findTranscriptMatches({ items, query: "DEPLOY" }).matches).toHaveLength(2);
    expect(findTranscriptMatches({ items, query: "w.dget" }).matches).toEqual([]);
  });

  it("reports nothing for an empty query", () => {
    expect(findTranscriptMatches({ items, query: "" }).matches).toEqual([]);
  });

  it("reports nothing for an empty transcript", () => {
    expect(findTranscriptMatches({ items: [], query: "widget" }).matches).toEqual([]);
  });

  it("skips a row shorter than the query instead of scanning it", () => {
    expect(
      findTranscriptMatches({ items, query: "a much longer query than any row" }).matches,
    ).toEqual([]);
  });

  it("terminates on overlapping candidates", () => {
    const { matches } = findTranscriptMatches({ items: [userMessage("u1", "aaaa")], query: "aa" });

    // Non-overlapping occurrences: offsets 0 and 2, and the loop ends.
    expect(matches.map((match) => match.start)).toEqual([0, 2]);
  });

  it("stops at the match limit rather than scanning a pathological transcript", () => {
    const { matches, truncated } = findTranscriptMatches({
      items: [userMessage("u1", "x".repeat(50))],
      query: "x",
      limit: 10,
    });

    expect(matches).toHaveLength(10);
    // The caller must be able to tell a capped scan from an exact count.
    expect(truncated).toBe(true);
  });

  it("defaults to a bounded limit", () => {
    expect(TRANSCRIPT_MATCH_LIMIT).toBeGreaterThan(0);
    const { matches, truncated } = findTranscriptMatches({
      items: [userMessage("u1", "y".repeat(TRANSCRIPT_MATCH_LIMIT + 25))],
      query: "y",
    });

    expect(matches).toHaveLength(TRANSCRIPT_MATCH_LIMIT);
    expect(truncated).toBe(true);
  });
});

describe("stepMatchIndex", () => {
  it("wraps in both directions", () => {
    expect(stepMatchIndex({ current: 0, total: 3, forward: true })).toBe(1);
    expect(stepMatchIndex({ current: 2, total: 3, forward: true })).toBe(0);
    expect(stepMatchIndex({ current: 0, total: 3, forward: false })).toBe(2);
  });

  it("stays put with nothing to step through", () => {
    expect(stepMatchIndex({ current: 0, total: 0, forward: true })).toBe(0);
  });
});

function atSeq(item: StreamItem, seq: number, epoch = "epoch-1"): StreamItem {
  return { ...item, timelineCursor: { epoch, seq } };
}

function history(matches: HistorySearchResult["matches"], epoch = "epoch-1"): HistorySearchResult {
  return { epoch, matches, truncated: false };
}

function loadedHit(itemId: string, seq: number | null, occurrence = 0): TranscriptHit {
  return { kind: "loaded", itemId, seq, occurrence };
}

function historyHit(seqStart: number, seqEnd: number, occurrence = 0): TranscriptHit {
  return { kind: "history", seqStart, seqEnd, occurrence };
}

describe("mergeTranscriptHits", () => {
  it("places history hits by timeline position around the loaded ones", () => {
    const items = [
      atSeq(userMessage("u50", "widget"), 50),
      atSeq(assistantMessage("a52", "widget widget"), 52),
    ];
    const local = findTranscriptMatches({ items, query: "widget" }).matches;

    expect(
      mergeTranscriptHits({
        items,
        local,
        history: history([
          { seqStart: 3, seqEnd: 3, occurrence: 0 },
          { seqStart: 70, seqEnd: 71, occurrence: 0 },
        ]),
      }),
    ).toEqual([
      historyHit(3, 3),
      loadedHit("u50", 50),
      loadedHit("a52", 52, 0),
      loadedHit("a52", 52, 1),
      historyHit(70, 71),
    ]);
  });

  it("lets a loaded row answer for its own history, even after it grew", () => {
    // The daemon answered before the live turn added a second hit to row 52.
    const items = [atSeq(assistantMessage("a52", "widget, and another widget"), 52)];
    const local = findTranscriptMatches({ items, query: "widget" }).matches;

    expect(
      mergeTranscriptHits({
        items,
        local,
        history: history([{ seqStart: 51, seqEnd: 52, occurrence: 0 }]),
      }),
    ).toEqual([loadedHit("a52", 52, 0), loadedHit("a52", 52, 1)]);
  });

  it("keeps history hits in the gap between a loaded window and the tail", () => {
    const items = [
      atSeq(userMessage("u10", "widget"), 10),
      atSeq(userMessage("u90", "widget"), 90),
    ];
    const local = findTranscriptMatches({ items, query: "widget" }).matches;

    expect(
      mergeTranscriptHits({
        items,
        local,
        history: history([
          { seqStart: 10, seqEnd: 10, occurrence: 0 },
          { seqStart: 40, seqEnd: 40, occurrence: 0 },
          { seqStart: 90, seqEnd: 90, occurrence: 0 },
        ]),
      }),
    ).toEqual([loadedHit("u10", 10), historyHit(40, 40), loadedHit("u90", 90)]);
  });

  it("does not treat rows from another timeline epoch as covering history", () => {
    const items = [atSeq(userMessage("old", "widget"), 5, "epoch-0")];
    const local = findTranscriptMatches({ items, query: "widget" }).matches;

    expect(
      mergeTranscriptHits({
        items,
        local,
        history: history([{ seqStart: 5, seqEnd: 5, occurrence: 0 }]),
      }),
    ).toEqual([loadedHit("old", null), historyHit(5, 5)]);
  });

  it("is just the loaded hits when the daemon cannot search history", () => {
    const items = [userMessage("u1", "widget")];
    const local = findTranscriptMatches({ items, query: "widget" }).matches;

    expect(mergeTranscriptHits({ items, local, history: null })).toEqual([loadedHit("u1", null)]);
  });
});

describe("preserveActiveHit", () => {
  const hits = [
    historyHit(3, 4),
    loadedHit("a1", 20, 0),
    loadedHit("a1", 20, 1),
    loadedHit("u2", 22, 0),
  ];

  it("keeps the reader on the same hit when the transcript grows", () => {
    expect(preserveActiveHit({ previous: loadedHit("a1", 20, 1), hits })).toBe(2);
  });

  it("follows a history hit into the row that loading its window produced", () => {
    const loaded = [loadedHit("u3", 4, 0), loadedHit("u3", 4, 1), loadedHit("a1", 20, 0)];

    expect(preserveActiveHit({ previous: historyHit(3, 4, 1), hits: loaded })).toBe(1);
  });

  it("follows a loaded hit into history when its row is unloaded", () => {
    const unloaded = [historyHit(20, 20, 0), historyHit(20, 20, 1), loadedHit("u3", 4, 0)];

    expect(preserveActiveHit({ previous: loadedHit("a1", 20, 1), hits: unloaded })).toBe(1);
  });

  it("falls back to the same row when the hit moved", () => {
    expect(preserveActiveHit({ previous: loadedHit("u2", 22, 7), hits })).toBe(3);
  });

  it("starts, and falls back, on the first loaded hit: that is where the reader is", () => {
    expect(preserveActiveHit({ previous: null, hits })).toBe(1);
    expect(preserveActiveHit({ previous: loadedHit("gone", 99), hits })).toBe(1);
    expect(preserveActiveHit({ previous: null, hits: [historyHit(1, 1)] })).toBe(0);
    expect(preserveActiveHit({ previous: loadedHit("a1", 20), hits: [] })).toBe(0);
  });
});
