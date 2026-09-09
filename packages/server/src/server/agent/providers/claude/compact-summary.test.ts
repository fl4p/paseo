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
