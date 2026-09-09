import { describe, expect, it } from "vitest";
import { readClaudeCompactSummary } from "./compact-summary.js";

function jsonl(entries: readonly unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

const SUMMARY_TEXT = "The user was refactoring the payment adapter.";

describe("readClaudeCompactSummary", () => {
  it("reads the summary the compaction wrote", () => {
    const content = jsonl([
      { type: "user", uuid: "u1", message: { content: "old task" } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "c1",
        compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: "s1" } },
      },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { content: SUMMARY_TEXT } },
      { type: "user", uuid: "u2", message: { content: "new task" } },
    ]);

    expect(readClaudeCompactSummary(content)).toBe(SUMMARY_TEXT);
  });

  it("flattens a block-shaped summary message", () => {
    const content = jsonl([
      { type: "system", subtype: "compact_boundary", uuid: "c1" },
      {
        type: "user",
        uuid: "s1",
        isCompactSummary: true,
        message: {
          content: [
            { type: "text", text: "first half" },
            { type: "text", text: "second half" },
          ],
        },
      },
    ]);

    expect(readClaudeCompactSummary(content)).toBe("first half\nsecond half");
  });

  it("answers with the LAST compaction's summary, not an older one", () => {
    // The attachment starts after the last completed compaction, so an older
    // summary would describe history that is already excluded twice over.
    const content = jsonl([
      { type: "system", subtype: "compact_boundary", uuid: "c1" },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { content: "older summary" } },
      { type: "user", uuid: "u1", message: { content: "middle task" } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "c2",
        compactMetadata: { preservedMessages: { anchorUuid: "s2" } },
      },
      { type: "user", uuid: "s2", isCompactSummary: true, message: { content: "newer summary" } },
    ]);

    expect(readClaudeCompactSummary(content)).toBe("newer summary");
  });

  it("falls back to the first summary after the boundary when the anchor is absent", () => {
    const content = jsonl([
      { type: "system", subtype: "compact_boundary", uuid: "c1" },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { content: SUMMARY_TEXT } },
    ]);

    expect(readClaudeCompactSummary(content)).toBe(SUMMARY_TEXT);
  });

  it("returns null when the session was never compacted", () => {
    const content = jsonl([{ type: "user", uuid: "u1", message: { content: "task" } }]);
    expect(readClaudeCompactSummary(content)).toBeNull();
  });

  it("returns null when the boundary has no summary yet", () => {
    // Mid-compaction the boundary is written before the summary; callers must
    // say the history was dropped rather than invent a summary.
    const content = jsonl([
      { type: "user", uuid: "u1", message: { content: "task" } },
      { type: "system", subtype: "compact_boundary", uuid: "c1" },
    ]);
    expect(readClaudeCompactSummary(content)).toBeNull();
  });

  it("returns null for an empty summary and for no transcript at all", () => {
    const content = jsonl([
      { type: "system", subtype: "compact_boundary", uuid: "c1" },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { content: "   " } },
    ]);
    expect(readClaudeCompactSummary(content)).toBeNull();
    expect(readClaudeCompactSummary(null)).toBeNull();
    expect(readClaudeCompactSummary("")).toBeNull();
  });

  it("survives a partially flushed trailing line", () => {
    const content = `${jsonl([
      { type: "system", subtype: "compact_boundary", uuid: "c1" },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { content: SUMMARY_TEXT } },
    ])}\n{"type":"assist`;

    expect(readClaudeCompactSummary(content)).toBe(SUMMARY_TEXT);
  });
});

describe("readClaudeCompactSummary bounded at a fork point", () => {
  const SUMMARY_A = "Summary A: the user set up the payment adapter.";
  const SUMMARY_B = "Summary B: the user then rewrote the refund flow.";

  /** compaction A -> the selected reply -> more conversation -> compaction B. */
  const TWO_COMPACTIONS = jsonl([
    { type: "user", uuid: "u1", message: { content: "first task" } },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "cA",
      compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: "sA" } },
    },
    { type: "user", uuid: "sA", isCompactSummary: true, message: { content: SUMMARY_A } },
    {
      type: "assistant",
      uuid: "aCut",
      message: {
        id: "msg_cut",
        content: [{ type: "text", text: "the selected reply" }],
        stop_reason: "end_turn",
      },
    },
    { type: "user", uuid: "u2", message: { content: "later task" } },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "cB",
      compactMetadata: { trigger: "auto", preservedMessages: { anchorUuid: "sB" } },
    },
    { type: "user", uuid: "sB", isCompactSummary: true, message: { content: SUMMARY_B } },
    {
      type: "assistant",
      uuid: "aAfter",
      message: {
        id: "msg_after",
        content: [{ type: "text", text: "after B" }],
        stop_reason: "end_turn",
      },
    },
  ]);

  it("takes the summary of the compaction the fork actually started after", () => {
    const summary = readClaudeCompactSummary(TWO_COMPACTIONS, { untilMessageId: "aCut" });
    expect(summary).toBe(SUMMARY_A);
    // Nothing unique to B may reach the fork: it describes turns the fork does
    // not contain and content from after the fork point.
    expect(summary).not.toContain("refund flow");
    expect(summary).not.toContain("Summary B");
  });

  it("accepts the live API message id as well as the transcript uuid", () => {
    expect(readClaudeCompactSummary(TWO_COMPACTIONS, { untilMessageId: "msg_cut" })).toBe(
      SUMMARY_A,
    );
  });

  it("still takes the newest summary for an unbounded fork", () => {
    expect(readClaudeCompactSummary(TWO_COMPACTIONS)).toBe(SUMMARY_B);
    expect(readClaudeCompactSummary(TWO_COMPACTIONS, { untilMessageId: "msg_after" })).toBe(
      SUMMARY_B,
    );
  });

  it("has no summary when the fork point precedes every compaction", () => {
    expect(readClaudeCompactSummary(TWO_COMPACTIONS, { untilMessageId: "u1" })).toBeNull();
  });

  it("refuses rather than reading unbounded when the fork point is not in the transcript", () => {
    // Falling back to the whole file is exactly the leak this bound prevents.
    expect(readClaudeCompactSummary(TWO_COMPACTIONS, { untilMessageId: "msg_unknown" })).toBeNull();
  });

  it("does not borrow a later summary for a compaction whose own summary is missing", () => {
    const missingSummary = jsonl([
      { type: "user", uuid: "u1", message: { content: "first task" } },
      { type: "system", subtype: "compact_boundary", uuid: "cA" },
      { type: "system", subtype: "compact_boundary", uuid: "cB" },
      { type: "user", uuid: "sB", isCompactSummary: true, message: { content: SUMMARY_B } },
    ]);
    expect(readClaudeCompactSummary(missingSummary, { untilMessageId: "cA" })).toBeNull();
  });
});
