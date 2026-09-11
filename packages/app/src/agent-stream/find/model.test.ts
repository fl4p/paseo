import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  flattenInlineMarkdown,
  findTranscriptMatches,
  getSearchableText,
  preserveActiveMatch,
  stepMatchIndex,
  TRANSCRIPT_MATCH_LIMIT,
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

describe("flattenInlineMarkdown", () => {
  it("finds a phrase the reader sees but the source splits", () => {
    expect(flattenInlineMarkdown("hello **world**")).toBe("hello world");
    expect(flattenInlineMarkdown("hello _world_")).toBe("hello world");
    expect(flattenInlineMarkdown("hello ***world***")).toBe("hello world");
    expect(flattenInlineMarkdown("run `npm test` now")).toBe("run npm test now");
    expect(flattenInlineMarkdown("see [the docs](https://example.com)")).toBe("see the docs");
    expect(flattenInlineMarkdown("## Heading")).toBe("Heading");
    expect(flattenInlineMarkdown("> quoted")).toBe("quoted");
  });

  it("leaves text that is not inline markup alone", () => {
    expect(flattenInlineMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(flattenInlineMarkdown("snake_case_name")).toBe("snake_case_name");
    expect(flattenInlineMarkdown("plain sentence")).toBe("plain sentence");
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
      { itemId: "u1", itemIndex: 0, start: 11 },
      { itemId: "a1", itemIndex: 1, start: 14 },
      { itemId: "a1", itemIndex: 1, start: 30 },
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

describe("preserveActiveMatch", () => {
  const matches = [
    { itemId: "a1", itemIndex: 1, start: 5 },
    { itemId: "a1", itemIndex: 1, start: 20 },
    { itemId: "u2", itemIndex: 2, start: 0 },
  ];

  it("keeps the reader on the same hit when the transcript grows", () => {
    expect(preserveActiveMatch({ previous: matches[1] ?? null, matches })).toBe(1);
  });

  it("falls back to the same row when the hit moved", () => {
    expect(
      preserveActiveMatch({ previous: { itemId: "u2", itemIndex: 9, start: 99 }, matches }),
    ).toBe(2);
  });

  it("falls back to the first hit when the row is gone", () => {
    expect(
      preserveActiveMatch({ previous: { itemId: "gone", itemIndex: 0, start: 0 }, matches }),
    ).toBe(0);
  });

  it("handles having nothing to preserve", () => {
    expect(preserveActiveMatch({ previous: null, matches })).toBe(0);
    expect(preserveActiveMatch({ previous: matches[0] ?? null, matches: [] })).toBe(0);
  });
});
