import { expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { searchTimeline } from "./index.js";

function rows(items: AgentTimelineItem[]) {
  return items.map((item, index) => ({ item, seq: index + 1, timestamp: "2026-09-12T00:00:00Z" }));
}

it("returns source locations for formatted assistant text and literal user text", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "user_message", text: "hello **world**" },
      { type: "assistant_message", text: "İ😀hello **world** and hello *world*" },
      {
        type: "assistant_message",
        text: "[hello &amp; world](https://example.com)",
        messageId: "separate",
      },
    ]),
    query: "hello world",
  });
  expect(result).toEqual({
    locations: [{ seq: 2, role: "assistant", count: 2 }],
    nextCursor: null,
  });
});

it("finds code and literal punctuation without searching tools, reasoning, or task state", async () => {
  const result = await searchTimeline({
    rows: rows([
      { type: "assistant_message", text: "```ts\nconst value = 'a.b';\n```" },
      { type: "reasoning", text: "a.b" },
      { type: "todo", items: [{ text: "a.b", completed: false }] },
      { type: "user_message", text: "axb" },
      { type: "user_message", text: "a.b" },
    ]),
    query: "a.b",
  });
  expect(result.locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
    { seq: 5, role: "user", count: 1 },
  ]);
});

it("bounds results and resumes without losing locations", async () => {
  const source = rows(
    Array.from({ length: 202 }, () => ({ type: "user_message", text: "target" })),
  );
  const first = await searchTimeline({ rows: source, query: "target" });
  expect(first.locations).toHaveLength(200);
  expect(first.nextCursor).toBe(200);
  const second = await searchTimeline({ rows: source, query: "target", cursor: first.nextCursor! });
  expect(second).toEqual({
    locations: [
      { seq: 201, role: "user", count: 1 },
      { seq: 202, role: "user", count: 1 },
    ],
    nextCursor: null,
  });
});

it("finds ordinary Markdown entities and line breaks without requiring identical parsers", async () => {
  const source = rows([{ type: "assistant_message", text: "hello &amp; **world**\nnext line" }]);
  expect((await searchTimeline({ rows: source, query: "hello & world" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "world next" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
});

it("counts occurrences per rendered block rather than across block boundaries", async () => {
  const source = rows([
    { type: "assistant_message", text: "target one\n\ntarget two\n\n- target three\n- end target" },
    { type: "user_message", text: "TARGET target" },
  ]);
  expect((await searchTimeline({ rows: source, query: "target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 4 },
    { seq: 2, role: "user", count: 2 },
  ]);
  expect((await searchTimeline({ rows: source, query: "end target" })).locations).toEqual([
    { seq: 1, role: "assistant", count: 1 },
  ]);
  expect((await searchTimeline({ rows: source, query: "two target" })).locations).toEqual([]);
  // Rendered text never runs from the end of one block into the start of the next, so
  // neither does a match, however contiguous the Markdown source looks.
  expect((await searchTimeline({ rows: source, query: "one target" })).locations).toEqual([]);
});

it("searches reasoning, tasks and notices for the transcript Find, as its loaded rows do", async () => {
  const source = rows([
    { type: "reasoning", text: "think about the **needle** first" },
    {
      type: "todo",
      items: [
        { text: "find the needle", completed: false },
        { text: "hidden", completed: false, status: "in_progress", activeForm: "Needle hunting" },
        {
          text: "needle not shown while running",
          completed: false,
          status: "in_progress",
          activeForm: "busy",
        },
      ],
    },
    { type: "notification", level: "warning", message: "needle warning" },
    { type: "error", message: "needle failed" },
    {
      type: "tool_call",
      callId: "c1",
      name: "needle_tool",
      status: "completed",
      detail: { type: "unknown", input: null, output: null },
      error: null,
    },
    { type: "user_message", text: "a needle" },
    { type: "assistant_message", text: "needle **needle**" },
  ] as AgentTimelineItem[]);
  expect(
    (await searchTimeline({ rows: source, query: "NEEDLE", scope: "transcript" })).locations,
  ).toEqual([
    { seq: 1, role: "assistant", count: 1 },
    { seq: 2, role: "assistant", count: 2 },
    { seq: 3, role: "assistant", count: 1 },
    { seq: 4, role: "assistant", count: 1 },
    { seq: 6, role: "user", count: 1 },
    { seq: 7, role: "assistant", count: 2 },
  ]);
  // Chat find resolves hits to message rows only, so its default scope is unchanged.
  expect((await searchTimeline({ rows: source, query: "needle" })).locations).toEqual([
    { seq: 6, role: "user", count: 1 },
    { seq: 7, role: "assistant", count: 2 },
  ]);
});

it("skips rows the requesting client cannot render", async () => {
  const source = rows([
    { type: "notification", level: "warning", message: "needle warning" },
    { type: "reasoning", text: "needle" },
  ]);
  const result = await searchTimeline({
    rows: source,
    query: "needle",
    scope: "transcript",
    include: (item) => item.type !== "notification",
  });
  expect(result.locations).toEqual([{ seq: 2, role: "assistant", count: 1 }]);
});

it("pages transcript hits with the same cursor contract", async () => {
  const source = rows(
    // Consecutive reasoning chunks project into one thought, so page over notices.
    Array.from(
      { length: 201 },
      () => ({ type: "notification", level: "info", message: "target" }) as AgentTimelineItem,
    ),
  );
  const first = await searchTimeline({ rows: source, query: "target", scope: "transcript" });
  expect(first.locations).toHaveLength(200);
  expect(first.nextCursor).toBe(200);
  const second = await searchTimeline({
    rows: source,
    query: "target",
    scope: "transcript",
    cursor: first.nextCursor!,
  });
  expect(second).toEqual({
    locations: [{ seq: 201, role: "assistant", count: 1 }],
    nextCursor: null,
  });
});
