import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamPiHistory, type PiCapturedUserMessageEntry } from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", messages, userEntries)) {
    events.push(event);
  }
  return events;
}

describe("Pi history mapper", () => {
  test("renders visible custom messages as completed tools and hides private context", async () => {
    const events = await collectHistory([
      {
        role: "custom",
        customType: "project-context",
        content: "Project instructions",
        display: true,
      },
      {
        role: "custom",
        customType: "private-context",
        content: "Hidden instructions",
        display: false,
      },
      { role: "custom", customType: "project-context", content: "Project instructions" },
    ]);
    expect(events.map((event) => event.item)).toEqual(
      [1, 2].map((index) => ({
        type: "tool_call",
        callId: `pi-custom-${index}`,
        name: "project-context",
        status: "completed",
        detail: { type: "plain_text", text: "Project instructions" },
        metadata: { synthetic: true, customType: "project-context" },
        error: null,
      })),
    );
  });

  test("replays user, assistant, reasoning, and completed tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "then answer" },
          ],
        },
        {
          role: "assistant",
          responseId: "response-1",
          content: [
            { type: "thinking", thinking: "checking file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
            { type: "text", text: "done" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "read this\n\nthen answer",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "reasoning", text: "checking file" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "running",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: undefined,
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "done", messageId: "response-1" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: "file contents",
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
    ]);
  });

  test("replays bash execution records as completed shell calls", async () => {
    await expect(
      collectHistory([
        {
          role: "bashExecution",
          command: "echo hi",
          output: "hi\n",
          exitCode: 0,
          timestamp: 123,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-bash-123",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
          error: null,
        },
      },
    ]);
  });

  test("replays custom messages as completed tools, matching the live path", async () => {
    await expect(
      collectHistory([{ role: "custom", content: "Extension command output" }]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-custom-1",
          name: "custom-message",
          status: "completed",
          detail: { type: "plain_text", text: "Extension command output" },
          metadata: { synthetic: true, customType: "custom-message" },
          error: null,
        },
      },
    ]);
  });

  test("skips replayed custom messages that Pi marks display:false", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          customType: "pi-plan-context",
          display: false,
          content: "[PLAN MODE ACTIVE]",
        },
      ]),
    ).resolves.toEqual([]);
  });

  test("uses Pi tree entry ids for replayed user messages", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "first answer",
          messageId: "pi-history-assistant-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });
});

// Ported from upstream #7801: that PR ships a history-replay test that #7331 (the implementation we
// carry) does not. Assertions here are against #7331's semantics, where an image block leaves an
// "[image]" text placeholder behind instead of being dropped.
describe("Pi history mapper tool-result images", () => {
  test("replays tool-result images as assistant markdown images after the tool call", async () => {
    const events = await collectHistory([
      {
        role: "user",
        content: [{ type: "text", text: "show me the render" }],
      },
      {
        role: "assistant",
        responseId: "response-1",
        content: [
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "render.png" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ]);

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({
      type: "timeline",
      provider: "pi",
      item: { type: "user_message", text: "show me the render" },
    });
    expect(events[1].item.type).toBe("tool_call");
    expect(events[1].item).toMatchObject({ status: "running" });
    expect(events[2].item.type).toBe("tool_call");
    expect(events[2].item).toMatchObject({ status: "completed" });
    // Base64 must not reach the replayed tool output.
    expect(JSON.stringify(events[2].item)).not.toContain("aGVsbG8=");
    expect(events[3].item.type).toBe("assistant_message");
    const text = (events[3].item as { text: string }).text;
    expect(text).toMatch(/!\[Image\]\(file:\/\/\/.*paseo-attachments-[^)]+\.png\)/);
  });

  test("leaves an [image] placeholder so image-only results still produce output", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        responseId: "response-1",
        content: [{ type: "toolCall", id: "tool-1", name: "screenshot", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "screenshot",
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      },
    ]);

    const toolResult = events[events.length - 1];
    expect(JSON.stringify(toolResult)).not.toContain("aGVsbG8=");
    const assistantMessages = events.filter((event) => event.item.type === "assistant_message");
    expect(assistantMessages).toHaveLength(1);
  });

  test("text-only tool results stay single events", async () => {
    const events = await collectHistory([
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].item.type).toBe("tool_call");
  });

  test("extracts prefixTokens and prefixTrunkDelta from assistant usage across turns", async () => {
    const events = await collectHistory([
      {
        role: "user",
        content: [{ type: "text", text: "first turn" }],
      },
      {
        role: "assistant",
        responseId: "resp-1",
        content: [{ type: "text", text: "first reply" }],
        usage: { input: 25000, output: 50, cacheRead: 0 },
      } as unknown as PiAgentMessage,
      {
        role: "user",
        content: [{ type: "text", text: "second turn" }],
      },
      {
        role: "assistant",
        responseId: "resp-2",
        content: [{ type: "text", text: "second reply" }],
        usage: { input: 25200, output: 80, cacheRead: 25000 },
      } as unknown as PiAgentMessage,
    ]);

    const userMessages = events.filter((e) => e.item.type === "user_message");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].item).toMatchObject({
      type: "user_message",
      text: "first turn",
      prefixTokens: 25000,
      prefixTrunkDelta: 25000,
      isInitialPrefix: true,
    });
    expect(userMessages[1].item).toMatchObject({
      type: "user_message",
      text: "second turn",
      prefixTokens: 200,
      prefixTrunkDelta: 200,
      isInitialPrefix: false,
    });
  });

  test("selects the first responding assistant message in turns with tool calls", async () => {
    const events = await collectHistory([
      { role: "user", content: [{ type: "text", text: "run tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
        usage: { input: 10000, output: 20, cacheRead: 0 },
      } as unknown as PiAgentMessage,
      { role: "toolResult", toolCallId: "c1", content: "output" } as unknown as PiAgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input: 15000, output: 30, cacheRead: 14000 },
      } as unknown as PiAgentMessage,
    ]);

    const userMessages = events.filter((e) => e.item.type === "user_message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].item).toMatchObject({
      type: "user_message",
      text: "run tool",
      prefixTokens: 10000,
      isInitialPrefix: true,
    });
  });
});
