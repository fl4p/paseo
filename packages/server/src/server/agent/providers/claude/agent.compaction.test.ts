import { describe, expect, test } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";

interface TestClaudeSession {
  translateMessageToEvents(message: SDKMessage): AgentStreamEvent[];
  close(): Promise<void>;
}

async function createSessionForTest(): Promise<TestClaudeSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });
  return session as unknown as TestClaudeSession;
}

const compactingStatus = {
  type: "system",
  subtype: "status",
  status: "compacting",
} as unknown as SDKMessage;

const compactBoundary = {
  type: "system",
  subtype: "compact_boundary",
  compactMetadata: {
    trigger: "manual",
    preTokens: 120_000,
    postTokens: 20_000,
  },
} as unknown as SDKMessage;

const successResult = {
  type: "result",
  subtype: "success",
  result: "",
  usage: { output_tokens: 12 },
} as unknown as SDKMessage;

function compactionItems(
  events: AgentStreamEvent[],
): Extract<AgentTimelineItem, { type: "compaction" }>[] {
  const items: Extract<AgentTimelineItem, { type: "compaction" }>[] = [];
  for (const event of events) {
    if (event.type === "timeline" && event.item.type === "compaction") {
      items.push(event.item);
    }
  }
  return items;
}

describe("claude compaction markers", () => {
  test("emits one loading marker even when the CLI repeats the compacting status", async () => {
    const session = await createSessionForTest();
    try {
      const emitted = [
        ...compactionItems(session.translateMessageToEvents(compactingStatus)),
        ...compactionItems(session.translateMessageToEvents(compactingStatus)),
        ...compactionItems(session.translateMessageToEvents(compactingStatus)),
      ];

      expect(emitted).toEqual([{ type: "compaction", status: "loading" }]);

      const completed = compactionItems(session.translateMessageToEvents(compactBoundary));
      expect(completed).toEqual([
        {
          type: "compaction",
          status: "completed",
          trigger: "manual",
          preTokens: 120_000,
        },
      ]);

      // A later compaction opens a fresh marker.
      expect(compactionItems(session.translateMessageToEvents(compactingStatus))).toEqual([
        { type: "compaction", status: "loading" },
      ]);
    } finally {
      await session.close();
    }
  });

  test("terminalizes the marker when the turn ends without a compact boundary", async () => {
    const session = await createSessionForTest();
    try {
      expect(compactionItems(session.translateMessageToEvents(compactingStatus))).toEqual([
        { type: "compaction", status: "loading" },
      ]);

      expect(compactionItems(session.translateMessageToEvents(successResult))).toEqual([
        { type: "compaction", status: "completed" },
      ]);

      // Already terminalized: the next result must not add another marker.
      expect(compactionItems(session.translateMessageToEvents(successResult))).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("does not terminalize twice when the boundary arrives before the result", async () => {
    const session = await createSessionForTest();
    try {
      session.translateMessageToEvents(compactingStatus);
      expect(compactionItems(session.translateMessageToEvents(compactBoundary))).toHaveLength(1);
      expect(compactionItems(session.translateMessageToEvents(successResult))).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

const compactionFailedStatus = {
  type: "system",
  subtype: "status",
  status: null,
  compact_result: "failed",
  compact_error: "context too large to summarize",
} as unknown as SDKMessage;

const compactionSucceededStatus = {
  type: "system",
  subtype: "status",
  status: null,
  compact_result: "success",
} as unknown as SDKMessage;

function timelineItems(events: AgentStreamEvent[]): AgentTimelineItem[] {
  return events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
}

describe("claude compaction outcomes", () => {
  test("reports a failed compaction as failed instead of as a successful one", async () => {
    const session = await createSessionForTest();
    try {
      session.translateMessageToEvents(compactingStatus);
      const items = timelineItems(session.translateMessageToEvents(compactionFailedStatus));

      // The marker itself says it failed; the error row survives only to carry the CLI's reason.
      expect(items).toEqual([
        { type: "compaction", status: "completed", outcome: "failed" },
        { type: "error", message: "Compaction failed: context too large to summarize" },
      ]);

      // The marker is closed, so the next compaction is visible again.
      expect(compactionItems(session.translateMessageToEvents(compactingStatus))).toEqual([
        { type: "compaction", status: "loading" },
      ]);
    } finally {
      await session.close();
    }
  });

  test("closes the marker on a successful compact_result without claiming an error", async () => {
    const session = await createSessionForTest();
    try {
      session.translateMessageToEvents(compactingStatus);
      const items = timelineItems(session.translateMessageToEvents(compactionSucceededStatus));

      expect(items).toEqual([{ type: "compaction", status: "completed" }]);
    } finally {
      await session.close();
    }
  });

  test("shows one separator when the result precedes the compact boundary", async () => {
    const session = await createSessionForTest();
    try {
      session.translateMessageToEvents(compactingStatus);
      expect(compactionItems(session.translateMessageToEvents(successResult))).toEqual([
        { type: "compaction", status: "completed" },
      ]);
      // The boundary owns no marker of its own here; a second completed item would render a
      // second "Context compacted" separator.
      expect(compactionItems(session.translateMessageToEvents(compactBoundary))).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
