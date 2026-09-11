import { describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { projectTimelineRows } from "./timeline-projection.js";
import { searchTimelineEntries } from "./timeline-search.js";

function row(seq: number, item: AgentTimelineRow["item"]): AgentTimelineRow {
  return { seq, timestamp: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`, item };
}

function project(rows: AgentTimelineRow[]) {
  return projectTimelineRows({ rows, mode: "projected" });
}

describe("searchTimelineEntries", () => {
  it("reports every hit at the timeline range of the entry that shows it", () => {
    const entries = project([
      row(1, { type: "user_message", text: "deploy the widget" }),
      row(2, { type: "assistant_message", text: "the widget is live; widget ready" }),
    ]);

    expect(searchTimelineEntries(entries, "WIDGET")).toEqual({
      matches: [
        { seqStart: 1, seqEnd: 1, occurrence: 0 },
        { seqStart: 2, seqEnd: 2, occurrence: 0 },
        { seqStart: 2, seqEnd: 2, occurrence: 1 },
      ],
      truncated: false,
    });
  });

  it("finds a phrase split across streamed assistant chunks once, at the merged range", () => {
    const entries = project([
      row(4, { type: "assistant_message", text: "hello **wor" }),
      row(5, { type: "assistant_message", text: "ld** again" }),
    ]);

    // Precondition: the projection is what joins the chunks the app shows as one message.
    expect(entries).toHaveLength(1);
    expect(searchTimelineEntries(entries, "hello world").matches).toEqual([
      { seqStart: 4, seqEnd: 5, occurrence: 0 },
    ]);
  });

  it("searches a running task's active form, and not a tool call's name", () => {
    const entries = project([
      row(1, {
        type: "todo",
        items: [
          {
            text: "Deploy it",
            completed: false,
            status: "in_progress",
            activeForm: "Deploying it",
          },
        ],
      }),
      row(2, {
        type: "tool_call",
        callId: "call-1",
        name: "deploy_service",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: null },
      } as AgentTimelineRow["item"]),
    ]);

    expect(searchTimelineEntries(entries, "deploying").matches).toEqual([
      { seqStart: 1, seqEnd: 1, occurrence: 0 },
    ]);
    expect(searchTimelineEntries(entries, "deploy_service").matches).toEqual([]);
  });

  it("stops at the limit and marks the count as a floor", () => {
    const entries = project([
      row(1, { type: "user_message", text: "x x x" }),
      row(2, { type: "user_message", text: "x x" }),
    ]);

    expect(searchTimelineEntries(entries, "x", 3)).toEqual({
      matches: [
        { seqStart: 1, seqEnd: 1, occurrence: 0 },
        { seqStart: 1, seqEnd: 1, occurrence: 1 },
        { seqStart: 1, seqEnd: 1, occurrence: 2 },
      ],
      truncated: true,
    });
    // A limit reached exactly, with nothing beyond it, is an exact count.
    expect(searchTimelineEntries(entries, "x", 5).truncated).toBe(false);
  });

  it("finds nothing for an empty query", () => {
    const entries = project([row(1, { type: "user_message", text: "anything" })]);

    expect(searchTimelineEntries(entries, "")).toEqual({ matches: [], truncated: false });
  });
});
