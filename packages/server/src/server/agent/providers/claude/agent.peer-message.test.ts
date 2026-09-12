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
  msg_id: "f1e8257d-5444-4c3f-8a17-07573bea4c61",
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
  messageId: "f1e8257d-5444-4c3f-8a17-07573bea4c61",
};

/**
 * The live shape, captured from Claude Code 2.1.269 by sending a real peer message to a session
 * run with --input-format stream-json: no user frame is emitted for the delivery at all, and the
 * only frame that carries it is the result that ends the turn the message started.
 */
const PEER_RESULT_FRAME = {
  type: "result",
  subtype: "success",
  uuid: "09e2df76-33c5-4f16-95b0-769ac20c1a26",
  session_id: "f6a6b942-ae4d-441d-bdcf-8eea7f75d94f",
  is_error: false,
  origin: PEER_ORIGIN,
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

  test("emits a peer message carried only by the result frame", async () => {
    const session = await createSessionForTest();
    try {
      const frame = PEER_RESULT_FRAME as unknown as SDKMessage;

      const items = session
        .translateMessageToEvents(frame)
        .filter((event) => event.type === "timeline")
        .map((event) => event.item);

      expect(items).toContainEqual(EXPECTED_ITEM);
    } finally {
      await session.close();
    }
  });

  test("does not show a delivery twice when both carriers arrive", async () => {
    const session = await createSessionForTest();
    try {
      session.translateMessageToEvents(PEER_ENTRY as unknown as SDKMessage);

      const repeats = session
        .translateMessageToEvents(PEER_RESULT_FRAME as unknown as SDKMessage)
        .filter((event) => event.type === "timeline")
        .map((event) => event.item)
        .filter((item) => item.type === "user_message");

      expect(repeats).toEqual([]);
    } finally {
      await session.close();
    }
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
