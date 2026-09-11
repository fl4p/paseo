import { describe, expect, it } from "vitest";
import {
  findTextOccurrences,
  flattenInlineMarkdown,
  timelineItemSearchText,
} from "./timeline-search.js";

describe("flattenInlineMarkdown", () => {
  it("joins a phrase the reader sees but the source splits", () => {
    expect(flattenInlineMarkdown("hello **world**")).toBe("hello world");
    expect(flattenInlineMarkdown("hello _world_")).toBe("hello world");
    expect(flattenInlineMarkdown("hello *w*")).toBe("hello w");
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

describe("timelineItemSearchText", () => {
  it("reads the text each kind of row shows", () => {
    expect(timelineItemSearchText({ type: "user_message", text: "hello **there**" } as never)).toBe(
      "hello there",
    );
    expect(timelineItemSearchText({ type: "reasoning", text: "thinking" } as never)).toBe(
      "thinking",
    );
    expect(timelineItemSearchText({ type: "error", message: "it broke" } as never)).toBe(
      "it broke",
    );
    expect(
      timelineItemSearchText({
        type: "todo",
        items: [
          {
            text: "Deploy it",
            completed: false,
            status: "in_progress",
            activeForm: "Deploying it",
          },
          { text: "Later", completed: false, status: "pending", activeForm: "Doing later" },
        ],
      } as never),
    ).toBe("Deploying it\nLater");
  });

  it("returns nothing for a row with no visible text or a malformed one", () => {
    expect(timelineItemSearchText({ type: "compaction" })).toBe("");
    // Whether a tool call is shown at all depends on the provider; see the doc comment.
    expect(timelineItemSearchText({ type: "tool_call", name: "read_file" } as never)).toBe("");
    expect(timelineItemSearchText({ type: "assistant_message" })).toBe("");
  });
});

describe("findTextOccurrences", () => {
  it("finds non-overlapping, case-insensitive occurrences", () => {
    expect(findTextOccurrences("Widget widget WIDGET", "widget", 10)).toEqual([0, 7, 14]);
    expect(findTextOccurrences("aaaa", "aa", 10)).toEqual([0, 2]);
  });

  it("stops at the limit and finds nothing for an empty query", () => {
    expect(findTextOccurrences("x".repeat(20), "x", 3)).toEqual([0, 1, 2]);
    expect(findTextOccurrences("needle", "", 10)).toEqual([]);
    expect(findTextOccurrences("needle", "needle", 0)).toEqual([]);
  });
});
