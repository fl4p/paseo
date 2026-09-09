import { describe, expect, test } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient, convertClaudeHistoryEntry } from "./agent.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

interface TestClaudeSession {
  translateMessageToEvents(message: SDKMessage): AgentStreamEvent[];
  close(): Promise<void>;
}

const PEER_ORIGIN = {
  kind: "peer",
  from: "uds:/tmp/cc-socks/65428.sock",
  name: "dragino",
  fromMode: "bypass",
  verifiedPeerPid: 65428,
  body: "I changed things under you on farmgw.",
} as const;

const PEER_ENTRY = {
  type: "user",
  isMeta: true,
  uuid: "d24c7444-1b8a-48d1-917a-c2d67a118a6e",
  message: {
    role: "user",
    content:
      'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/65428.sock" from-name="dragino">\nI changed things under you on farmgw.\n</cross-session-message>',
  },
  origin: PEER_ORIGIN,
};

const EXPECTED_ITEM = {
  type: "user_message",
  text: "I changed things under you on farmgw.",
  origin: { kind: "peer", name: "dragino", address: "uds:/tmp/cc-socks/65428.sock" },
  messageId: "d24c7444-1b8a-48d1-917a-c2d67a118a6e",
};

async function createSessionForTest(): Promise<TestClaudeSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  return session as unknown as TestClaudeSession;
}

describe("peer messages", () => {
  test("replays a peer message the generic isMeta filter would drop", () => {
    expect(convertClaudeHistoryEntry(PEER_ENTRY, () => [])).toEqual([EXPECTED_ITEM]);
  });

  test("keeps skipping meta entries that carry no peer origin", () => {
    const { origin: _origin, ...withoutOrigin } = PEER_ENTRY;

    expect(convertClaudeHistoryEntry(withoutOrigin, () => [])).toEqual([]);
  });

  test("emits a peer message on the live stream, once per delivery", async () => {
    const session = await createSessionForTest();
    try {
      const message = PEER_ENTRY as unknown as SDKMessage;

      expect(session.translateMessageToEvents(message)).toEqual([
        { type: "timeline", item: EXPECTED_ITEM, provider: "claude" },
      ]);
      expect(session.translateMessageToEvents(message)).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
