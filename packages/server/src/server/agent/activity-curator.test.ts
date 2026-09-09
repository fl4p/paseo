import { describe, expect, it, vi } from "vitest";
import {
  buildAgentForkContextAttachment,
  curateAgentActivity,
  loadForkCompactionSummary,
  resolveForkBoundaryMessageId,
} from "./activity-curator.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

function toolCallItem(params: {
  callId: string;
  name: string;
  status?: "running" | "completed" | "failed" | "canceled";
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  detail?: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"];
}): Extract<AgentTimelineItem, { type: "tool_call" }> {
  const status = params.status ?? "completed";
  const detail = params.detail ?? {
    type: "unknown" as const,
    input: params.input ?? null,
    output: params.output ?? null,
  };
  return {
    type: "tool_call",
    callId: params.callId,
    name: params.name,
    status,
    detail,
    error: status === "failed" ? (params.error ?? { message: "failed" }) : null,
    metadata: params.metadata,
  };
}

function row(seq: number, item: AgentTimelineItem): AgentTimelineRow {
  return {
    seq,
    timestamp: `2026-06-28T00:00:${String(seq).padStart(2, "0")}.000Z`,
    item,
  };
}

describe("curateAgentActivity", () => {
  it("renders user/assistant/reasoning entries", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Hello" },
      { type: "assistant_message", text: "Hi" },
      { type: "reasoning", text: "Thinking" },
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[User] Hello");
    expect(result).toContain("Hi");
    expect(result).toContain("[Thought] Thinking");
  });

  it("uses detail enrichment for tool summaries", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "read-1",
        name: "read_file",
        detail: {
          type: "read",
          filePath: "src/index.ts",
          content: "console.log('hi')",
        },
      }),
      toolCallItem({
        callId: "shell-1",
        name: "shell",
        detail: {
          type: "shell",
          command: "npm test",
          output: "ok",
          exitCode: 0,
        },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[Read] src/index.ts");
    expect(result).toContain("[Shell] npm test");
  });

  it("renders terminal tool calls as one-line command summaries", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "terminal-1",
        name: "terminal",
        detail: {
          type: "plain_text",
          label: `skills/paseo-chat/bin/chat.sh post --room storage-revamp --body $'first line

second line'`,
          icon: "square_terminal",
        },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain(
      "[Terminal] skills/paseo-chat/bin/chat.sh post --room storage-revamp --body $'first line second line'",
    );
    expect(result).not.toContain("[Interacted with terminal]");
  });

  it("does not infer summary from raw input when detail is missing", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "shell-no-detail",
        name: "exec_command",
        status: "running",
        input: { command: "npm run lint" },
      }),
      toolCallItem({
        callId: "read-no-detail",
        name: "read_file",
        status: "running",
        input: { path: "src/index.ts" },
      }),
      toolCallItem({
        callId: "search-no-detail",
        name: "web_search",
        status: "running",
        input: { query: "zod union" },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[Exec command]");
    expect(result).toContain("[Read file]");
    expect(result).toContain("[Web search]");
    expect(result).not.toContain("npm run lint");
    expect(result).not.toContain("src/index.ts");
    expect(result).not.toContain("zod union");
  });

  it("falls back to input json for likely external tools", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "mcp-1",
        name: "paseo__create_agent",
        input: { cwd: "/tmp/repo", initialPrompt: "do the thing" },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toBe('[paseo__create_agent] {"cwd":"/tmp/repo","initialPrompt":"do the thing"}');
  });

  it("collapses repeated tool updates by callId", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "task-1",
        name: "Task",
        status: "running",
        detail: {
          type: "sub_agent",
          subAgentType: "Explore",
          description: "Investigate repository",
          log: "[Read] README.md",
        },
      }),
      toolCallItem({
        callId: "task-1",
        name: "Task",
        status: "running",
        detail: {
          type: "sub_agent",
          subAgentType: "Explore",
          description: "Investigate repository",
          log: "[Read] README.md\n[Bash] ls",
        },
      }),
    ];

    const result = curateAgentActivity(timeline);
    const lines = result.split("\n");

    expect(lines.filter((line) => line.startsWith("[Explore]"))).toEqual([
      "[Explore] Investigate repository",
    ]);
  });

  it("keeps nested sub-agent logs beside the sub-agent that produced them", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "assistant_message", text: "Before first child." },
      toolCallItem({
        callId: "child-1",
        name: "Sub-agent",
        detail: {
          type: "sub_agent",
          subAgentType: "Child one",
          description: "First investigation",
          log: "[Assistant] First child result.",
        },
      }),
      { type: "assistant_message", text: "Between children." },
      toolCallItem({
        callId: "child-2",
        name: "Sub-agent",
        detail: {
          type: "sub_agent",
          subAgentType: "Child two",
          description: "Second investigation",
          log: "[Assistant] Second child result.",
        },
      }),
      { type: "assistant_message", text: "After second child." },
    ];

    const result = curateAgentActivity(timeline, { labelAssistantMessages: true });

    expect(result.split("\n")).toEqual([
      "[Assistant] Before first child.",
      "[Child one] First investigation",
      "[Assistant] First child result.",
      "[Assistant] Between children.",
      "[Child two] Second investigation",
      "[Assistant] Second child result.",
      "[Assistant] After second child.",
    ]);
  });

  it("renders todo/error/compaction entries", () => {
    const timeline: AgentTimelineItem[] = [
      {
        type: "todo",
        items: [
          { text: "One", completed: false },
          { text: "Two", completed: true },
        ],
      },
      { type: "error", message: "boom" },
      { type: "compaction", status: "completed", trigger: "auto" },
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[Tasks]");
    expect(result).toContain("- [ ] One");
    expect(result).toContain("- [x] Two");
    expect(result).toContain("[Error] boom");
    expect(result).toContain("[Compacted]");
  });

  it("truncates to maxItems", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Message 1" },
      { type: "user_message", text: "Message 2" },
      { type: "user_message", text: "Message 3" },
      { type: "user_message", text: "Message 4" },
    ];

    const result = curateAgentActivity(timeline, { maxItems: 2 });

    expect(result).not.toContain("Message 1");
    expect(result).not.toContain("Message 2");
    expect(result).toContain("Message 3");
    expect(result).toContain("Message 4");
  });

  it("returns a default message when timeline is empty", () => {
    expect(curateAgentActivity([])).toBe("No activity to display.");
  });

  it("builds fork context from user messages, assistant messages, and tool summaries", () => {
    const result = buildAgentForkContextAttachment({
      agentTitle: "Source Agent",
      cwd: "/repo",
      boundaryMessageId: "assistant-1",
      rows: [
        row(1, { type: "user_message", text: "Ship the thing", messageId: "user-1" }),
        row(2, { type: "reasoning", text: "private chain of thought" }),
        row(
          3,
          toolCallItem({
            callId: "read-1",
            name: "read_file",
            detail: {
              type: "read",
              filePath: "src/index.ts",
              content: "console.log('hi')",
            },
          }),
        ),
        row(
          4,
          toolCallItem({
            callId: "external-1",
            name: "paseo__create_agent",
            input: { initialPrompt: "do not include raw external tool input" },
          }),
        ),
        row(5, {
          type: "assistant_message",
          text: "Done.",
          messageId: "assistant-1",
        }),
        row(6, {
          type: "assistant_message",
          text: "Later answer.",
          messageId: "assistant-2",
        }),
      ],
    });

    expect(result.boundaryMessageId).toBe("assistant-1");
    expect(result.attachment).toMatchObject({
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
    });
    expect(result.attachment.text).toMatch(/^<chat-history-summary>\n/);
    expect(result.attachment.text).toMatch(/\n<\/chat-history-summary>$/);
    expect(result.attachment.text).toContain("Source agent: Source Agent");
    expect(result.attachment.text).toContain("Source directory: /repo");
    expect(result.attachment.text).toContain("[User] Ship the thing");
    expect(result.attachment.text).toContain("[Read] src/index.ts");
    expect(result.attachment.text).toContain("[paseo__create_agent]");
    expect(result.attachment.text).toContain("[Assistant] Done.");
    expect(result.attachment.text).not.toContain("private chain of thought");
    expect(result.attachment.text).not.toContain("do not include raw external tool input");
    expect(result.attachment.text).not.toContain("Later answer.");
  });

  it("does not cap fork context to the generic recent activity limit", () => {
    const messageRows = Array.from({ length: 25 }, (_, index) =>
      row(index + 1, {
        type: "user_message",
        text: `Message ${index + 1}`,
        messageId: `user-${index + 1}`,
      }),
    );
    const result = buildAgentForkContextAttachment({
      boundaryMessageId: "assistant-1",
      rows: [
        ...messageRows,
        row(26, {
          type: "assistant_message",
          text: "Done.",
          messageId: "assistant-1",
        }),
      ],
    });

    expect(result.itemCount).toBe(26);
    expect(result.attachment.text).toContain("[User] Message 1");
    expect(result.attachment.text).toContain("[User] Message 25");
    expect(result.attachment.text).toContain("[Assistant] Done.");
  });

  it("selects the fork boundary before collapsing later tool updates", () => {
    const result = buildAgentForkContextAttachment({
      boundaryMessageId: "assistant-1",
      rows: [
        row(1, { type: "user_message", text: "Run it", messageId: "user-1" }),
        row(
          2,
          toolCallItem({
            callId: "terminal-1",
            name: "terminal",
            status: "running",
            detail: {
              type: "plain_text",
              label: "before boundary",
            },
          }),
        ),
        row(3, {
          type: "assistant_message",
          text: "Partial result.",
          messageId: "assistant-1",
        }),
        row(
          4,
          toolCallItem({
            callId: "terminal-1",
            name: "terminal",
            status: "completed",
            detail: {
              type: "plain_text",
              label: "after boundary",
            },
          }),
        ),
      ],
    });

    expect(result.attachment.text).toContain("[Terminal] before boundary");
    expect(result.attachment.text).toContain("[Assistant] Partial result.");
    expect(result.attachment.text).not.toContain("after boundary");
  });

  it("selects a synthetic assistant error by its timeline cursor", () => {
    const result = buildAgentForkContextAttachment({
      cursorBoundary: {
        timelineEpoch: "timeline-1",
        cursor: { epoch: "timeline-1", seq: 2 },
      },
      rows: [
        row(1, { type: "user_message", text: "Try the task", messageId: "user-1" }),
        row(2, { type: "assistant_message", text: "[System Error] provider failed" }),
        row(3, {
          type: "assistant_message",
          text: "This belongs to a later turn.",
          messageId: "assistant-2",
        }),
      ],
    });

    expect(result.boundaryCursor).toEqual({ epoch: "timeline-1", seq: 2 });
    expect(result.boundaryMessageId).toBeNull();
    expect(result.attachment.text).toContain("[System Error] provider failed");
    expect(result.attachment.text).not.toContain("This belongs to a later turn.");
  });

  it("rejects a cursor from a previous timeline epoch", () => {
    expect(() =>
      buildAgentForkContextAttachment({
        cursorBoundary: {
          timelineEpoch: "timeline-2",
          cursor: { epoch: "timeline-1", seq: 2 },
        },
        rows: [row(2, { type: "assistant_message", text: "Stale result." })],
      }),
    ).toThrow("Selected timeline position is no longer available.");
  });

  it("rejects missing assistant boundaries instead of silently using the wrong context", () => {
    expect(() =>
      buildAgentForkContextAttachment({
        boundaryMessageId: "missing",
        rows: [row(1, { type: "assistant_message", text: "Done.", messageId: "assistant-1" })],
      }),
    ).toThrow("Selected assistant message is no longer available.");
  });
});

describe("fork context budget and compaction boundary", () => {
  it("starts after the last completed compaction instead of replaying pre-compaction history", () => {
    // The source session already summarized everything before the boundary;
    // replaying it is exactly what inflated a <200k-token session into ~700k.
    const result = buildAgentForkContextAttachment({
      rows: [
        row(1, { type: "user_message", text: "ancient task", messageId: "user-1" }),
        row(2, { type: "assistant_message", text: "ancient answer", messageId: "assistant-1" }),
        row(3, { type: "compaction", status: "completed", trigger: "auto" }),
        row(4, { type: "user_message", text: "current task", messageId: "user-2" }),
        row(5, { type: "assistant_message", text: "current answer", messageId: "assistant-2" }),
      ],
    });

    expect(result.attachment.text).not.toContain("ancient task");
    expect(result.attachment.text).not.toContain("ancient answer");
    expect(result.attachment.text).toContain("current task");
    expect(result.attachment.text).toContain("current answer");
    // No summary was available, so the header must say the history is GONE,
    // not that something stands in for it.
    expect(result.attachment.text).toContain("no compaction summary was available");
    expect(result.attachment.text).not.toContain("compaction summary below");
    expect(result.itemCount).toBe(2);
  });

  it("ignores a compaction that has not completed", () => {
    const result = buildAgentForkContextAttachment({
      rows: [
        row(1, { type: "user_message", text: "ancient task", messageId: "user-1" }),
        row(2, { type: "compaction", status: "running", trigger: "auto" }),
        row(3, { type: "user_message", text: "current task", messageId: "user-2" }),
      ],
    });

    expect(result.attachment.text).toContain("ancient task");
    expect(result.attachment.text).not.toContain("The source session was compacted");
  });

  it("only skips history before a compaction that precedes the boundary", () => {
    const result = buildAgentForkContextAttachment({
      boundaryMessageId: "assistant-1",
      rows: [
        row(1, { type: "user_message", text: "early task", messageId: "user-1" }),
        row(2, { type: "assistant_message", text: "early answer", messageId: "assistant-1" }),
        row(3, { type: "compaction", status: "completed", trigger: "auto" }),
        row(4, { type: "user_message", text: "later task", messageId: "user-2" }),
      ],
    });

    // The compaction happened after the selected boundary, so it says nothing
    // about the selected range and must not truncate it.
    expect(result.attachment.text).toContain("early task");
    expect(result.attachment.text).not.toContain("later task");
    expect(result.attachment.text).not.toContain("last compaction omitted");
  });

  it("truncates to the budget, keeping the opening task and the recent tail", () => {
    const filler = "x".repeat(400);
    const rows: AgentTimelineRow[] = [
      row(1, { type: "user_message", text: "THE ORIGINAL TASK", messageId: "user-1" }),
    ];
    for (let index = 0; index < 20; index += 1) {
      rows.push(
        row(index + 2, {
          type: "user_message",
          text: `middle ${index} ${filler}`,
          messageId: `user-mid-${index}`,
        }),
      );
    }
    rows.push(row(100, { type: "user_message", text: "THE LATEST TASK", messageId: "user-last" }));

    const result = buildAgentForkContextAttachment({ rows, maxChars: 2000 });

    expect(result.attachment.text.length).toBeLessThan(3000);
    expect(result.attachment.text).toContain("THE ORIGINAL TASK");
    expect(result.attachment.text).toContain("THE LATEST TASK");
    expect(result.attachment.text).toContain("middle 19");
    expect(result.attachment.text).not.toContain("middle 0 ");
    expect(result.attachment.text).toContain("earlier history omitted");
  });

  it("caps an oversized opening message instead of keeping it whole", () => {
    // The opener is pinned, but pinned is not the same as unbounded: a single
    // 70k-character first message used to walk straight past the budget.
    const rows: AgentTimelineRow[] = [
      row(1, { type: "user_message", text: `OPENING ${"o".repeat(70_000)}`, messageId: "user-1" }),
      row(2, { type: "user_message", text: "middle", messageId: "user-2" }),
      row(3, { type: "user_message", text: "THE LATEST TASK", messageId: "user-3" }),
    ];

    const result = buildAgentForkContextAttachment({ rows, maxChars: 2000 });

    expect(result.attachment.text.length).toBeLessThan(2500);
    expect(result.attachment.text).toContain("OPENING ooo");
    expect(result.attachment.text).toContain("THE LATEST TASK");
    expect(result.attachment.text).toContain("message truncated");
  });

  it("keeps the selected boundary message even when it alone exceeds the budget", () => {
    // The newest entry of a bounded fork IS the message the user picked. The
    // old tail loop broke on it and emitted a header claiming only "earlier"
    // history had been dropped.
    const rows: AgentTimelineRow[] = [
      row(1, { type: "user_message", text: "THE ORIGINAL TASK", messageId: "user-1" }),
      row(2, { type: "user_message", text: "middle", messageId: "user-2" }),
      row(3, {
        type: "assistant_message",
        text: `BOUNDARY ${"b".repeat(70_000)}`,
        messageId: "assistant-3",
      }),
    ];

    const result = buildAgentForkContextAttachment({
      rows,
      boundaryMessageId: "assistant-3",
      maxChars: 2000,
    });

    expect(result.attachment.text).toContain("THE ORIGINAL TASK");
    expect(result.attachment.text).toContain("BOUNDARY bbb");
    expect(result.attachment.text).toContain("message truncated");
    expect(result.attachment.text.length).toBeLessThan(2500);
  });

  it("says in the header that history was omitted, not that it was cut short", () => {
    const filler = "x".repeat(400);
    const rows: AgentTimelineRow[] = [
      row(1, { type: "user_message", text: "THE ORIGINAL TASK", messageId: "user-1" }),
    ];
    for (let index = 0; index < 20; index += 1) {
      rows.push(
        row(index + 2, {
          type: "user_message",
          text: `middle ${index} ${filler}`,
          messageId: `user-mid-${index}`,
        }),
      );
    }
    rows.push(row(100, { type: "user_message", text: "THE LATEST TASK", messageId: "user-last" }));

    const header = buildAgentForkContextAttachment({ rows, maxChars: 2000 }).attachment.text;

    expect(header).toContain("Some earlier history was omitted");
    expect(header).not.toContain("cut short");
  });

  it("says in the header that a message was cut short, not that history was dropped", () => {
    const rows: AgentTimelineRow[] = [
      row(1, { type: "user_message", text: `OPENING ${"o".repeat(9_000)}`, messageId: "user-1" }),
      row(2, { type: "user_message", text: "THE LATEST TASK", messageId: "user-2" }),
    ];

    const header = buildAgentForkContextAttachment({ rows, maxChars: 2000 }).attachment.text;

    // Nothing was dropped here: both entries are still present, one is shorter.
    expect(header).toContain("cut short");
    expect(header).not.toContain("Some earlier history was omitted");
    expect(header).toContain("THE LATEST TASK");
  });

  it("reports both when history was dropped and a message was cut short", () => {
    const rows: AgentTimelineRow[] = [
      row(1, { type: "user_message", text: `OPENING ${"o".repeat(9_000)}`, messageId: "user-1" }),
    ];
    for (let index = 0; index < 20; index += 1) {
      rows.push(
        row(index + 2, {
          type: "user_message",
          text: `middle ${index} ${"x".repeat(400)}`,
          messageId: `user-mid-${index}`,
        }),
      );
    }
    rows.push(row(100, { type: "user_message", text: "THE LATEST TASK", messageId: "user-last" }));

    const header = buildAgentForkContextAttachment({ rows, maxChars: 2000 }).attachment.text;

    expect(header).toContain("Some earlier history was omitted");
    expect(header).toContain("cut short");
  });

  it("leaves a within-budget history untouched", () => {
    const result = buildAgentForkContextAttachment({
      rows: [
        row(1, { type: "user_message", text: "small task", messageId: "user-1" }),
        row(2, { type: "assistant_message", text: "small answer", messageId: "assistant-1" }),
      ],
      maxChars: 2000,
    });

    expect(result.attachment.text).not.toContain("earlier history omitted");
    expect(result.attachment.text).toContain("small task");
    expect(result.attachment.text).toContain("small answer");
  });
});

describe("resolveForkBoundaryMessageId", () => {
  const rows: AgentTimelineRow[] = [
    row(1, { type: "user_message", text: "task", messageId: "user-1" }),
    row(2, { type: "assistant_message", text: "answer", messageId: "assistant-1" }),
    row(3, { type: "todo", items: [{ text: "step", completed: false }] }),
  ];

  it("returns null when no boundary was requested", () => {
    expect(resolveForkBoundaryMessageId({ rows })).toBeNull();
  });

  it("resolves an assistant message id", () => {
    expect(resolveForkBoundaryMessageId({ rows, boundaryMessageId: "assistant-1" })).toBe(
      "assistant-1",
    );
  });

  it("walks back from a cursor row that carries no message id", () => {
    expect(
      resolveForkBoundaryMessageId({
        rows,
        cursorBoundary: { timelineEpoch: "e1", cursor: { epoch: "e1", seq: 3 } },
      }),
    ).toBe("assistant-1");
  });

  it("rejects a stale cursor", () => {
    expect(() =>
      resolveForkBoundaryMessageId({
        rows,
        cursorBoundary: { timelineEpoch: "e2", cursor: { epoch: "e1", seq: 3 } },
      }),
    ).toThrow("Selected timeline position is no longer available.");
  });

  it("rejects a boundary with no provider message before it", () => {
    expect(() =>
      resolveForkBoundaryMessageId({
        rows: [row(1, { type: "todo", items: [] })],
        cursorBoundary: { timelineEpoch: "e1", cursor: { epoch: "e1", seq: 1 } },
      }),
    ).toThrow("no provider message");
  });
});

describe("fork context compaction summary", () => {
  const COMPACTED_ROWS = [
    row(1, { type: "user_message", text: "ancient task", messageId: "user-1" }),
    row(2, { type: "assistant_message", text: "ancient answer", messageId: "assistant-1" }),
    row(3, { type: "compaction", status: "completed", trigger: "auto" }),
    row(4, { type: "user_message", text: "current task", messageId: "user-2" }),
  ] as const;

  it("carries the provider's compaction summary into the attachment body", () => {
    // Without this the fork loses everything the compaction preserved: the
    // pre-compaction turns are deliberately not replayed, and the summary that
    // replaced them was never in the timeline to begin with.
    const result = buildAgentForkContextAttachment({
      rows: [...COMPACTED_ROWS],
      compactionSummary: "The user was refactoring the payment adapter.",
    });

    expect(result.attachment.text).toContain("The user was refactoring the payment adapter.");
    expect(result.attachment.text).toContain("[Compaction summary of the earlier conversation]");
    expect(result.attachment.text).toContain("[Conversation since the compaction]");
    expect(result.attachment.text).toContain("current task");
    // The raw pre-compaction turns stay out; only their summary comes through.
    expect(result.attachment.text).not.toContain("ancient answer");
  });

  it("says the earlier history is summarized, not dropped, when a summary exists", () => {
    const result = buildAgentForkContextAttachment({
      rows: [...COMPACTED_ROWS],
      compactionSummary: "Earlier context.",
    });

    expect(result.attachment.text).toContain(
      "represented by the provider's own compaction summary below",
    );
    expect(result.attachment.text).not.toContain("no compaction summary was available");
  });

  it("says the earlier history was dropped when no summary is available", () => {
    // Non-Claude providers keep no summary; the header must not imply one.
    const result = buildAgentForkContextAttachment({ rows: [...COMPACTED_ROWS] });

    expect(result.attachment.text).toContain("no compaction summary was available");
    expect(result.attachment.text).not.toContain("compaction summary below");
  });

  it("never degrades to the empty placeholder when the compaction is the last row", () => {
    // A session compacted as its newest event has nothing left to replay, which
    // used to produce an attachment that said only "No chat history to display".
    const result = buildAgentForkContextAttachment({
      rows: [
        row(1, { type: "user_message", text: "ancient task", messageId: "user-1" }),
        row(2, { type: "compaction", status: "completed", trigger: "auto" }),
      ],
      compactionSummary: "The user was refactoring the payment adapter.",
    });

    expect(result.attachment.text).not.toContain("No chat history to display.");
    expect(result.attachment.text).toContain("The user was refactoring the payment adapter.");
  });

  it("still says so when there is neither history nor a summary", () => {
    const result = buildAgentForkContextAttachment({
      rows: [
        row(1, { type: "user_message", text: "ancient task", messageId: "user-1" }),
        row(2, { type: "compaction", status: "completed", trigger: "auto" }),
      ],
    });

    expect(result.attachment.text).toContain("No chat history to display.");
    expect(result.attachment.text).toContain("no compaction summary was available");
  });

  it("ignores a summary when the selection did not start at a compaction", () => {
    // Nothing was skipped, so the pre-compaction history is already in the body
    // and repeating its summary would double it.
    const result = buildAgentForkContextAttachment({
      rows: [row(1, { type: "user_message", text: "only task", messageId: "user-1" })],
      compactionSummary: "Earlier context.",
    });

    expect(result.attachment.text).not.toContain("Earlier context.");
    expect(result.attachment.text).not.toContain("Compaction summary");
  });

  it("keeps the summary inside the character budget, truncating rather than dropping it", () => {
    const result = buildAgentForkContextAttachment({
      rows: [...COMPACTED_ROWS],
      compactionSummary: "S".repeat(5_000),
      maxChars: 400,
    });

    expect(result.attachment.text).toContain("[Compaction summary of the earlier conversation]");
    expect(result.attachment.text).toContain("message truncated to fit the context budget");
    // Half the budget for the summary, the rest for the turns after it.
    expect(result.attachment.text.length).toBeLessThan(400 + 600);
    expect(result.attachment.text).toContain("current task");
  });
});

describe("loadForkCompactionSummary", () => {
  const compactedRows = [
    row(1, { type: "user_message", text: "ancient task", messageId: "user-1" }),
    row(2, { type: "compaction", status: "completed", trigger: "auto" }),
  ];

  it("asks the provider only when the source was actually compacted", async () => {
    const read = vi.fn(async () => "summary");
    expect(await loadForkCompactionSummary({ agentId: "agent-1", rows: compactedRows, read })).toBe(
      "summary",
    );
    expect(read).toHaveBeenCalledWith("agent-1");
  });

  it("skips the provider read when nothing was compacted away", async () => {
    // Nothing was skipped, so there is no summary to add and no reason to read
    // a transcript that can be megabytes.
    const read = vi.fn(async () => "summary");
    expect(
      await loadForkCompactionSummary({
        agentId: "agent-1",
        rows: [row(1, { type: "user_message", text: "task", messageId: "user-1" })],
        read,
      }),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("ignores a compaction that never completed", async () => {
    const read = vi.fn(async () => "summary");
    expect(
      await loadForkCompactionSummary({
        agentId: "agent-1",
        rows: [row(1, { type: "compaction", status: "running", trigger: "auto" })],
        read,
      }),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("degrades to no summary rather than failing the fork when the read throws", async () => {
    const warn = vi.fn();
    const read = vi.fn(() => Promise.reject(new Error("transcript unreadable")));
    expect(
      await loadForkCompactionSummary({
        agentId: "agent-1",
        rows: compactedRows,
        read,
        logger: { warn } as unknown as Parameters<typeof loadForkCompactionSummary>[0]["logger"],
      }),
    ).toBeNull();
    // Silently returning null would let the header claim a summary exists; the
    // caller must be able to see that the read failed.
    expect(warn).toHaveBeenCalled();
  });
});
