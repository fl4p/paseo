import { describe, expect, test } from "vitest";

import { readClaudePeerMessage } from "./peer-message.js";

// Shape taken from a Claude Code transcript entry written when another session used SendMessage.
function peerEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "user",
    isMeta: true,
    uuid: "d24c7444-1b8a-48d1-917a-c2d67a118a6e",
    message: {
      role: "user",
      content:
        'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/65428.sock" from-name="dragino" from-mode="bypass">\nI changed things under you on farmgw.\n</cross-session-message>',
    },
    origin: {
      kind: "peer",
      from: "uds:/tmp/cc-socks/65428.sock",
      name: "dragino",
      fromMode: "bypass",
      verifiedPeerPid: 65428,
      body: "I changed things under you on farmgw.",
    },
    ...overrides,
  };
}

describe("readClaudePeerMessage", () => {
  test("reads the sender and the body without the envelope", () => {
    expect(readClaudePeerMessage(peerEntry())).toEqual({
      text: "I changed things under you on farmgw.",
      origin: {
        kind: "peer",
        name: "dragino",
        address: "uds:/tmp/cc-socks/65428.sock",
      },
    });
  });

  test("falls back to the delivered text when the sender predates the decoded body", () => {
    const entry = peerEntry({
      origin: { kind: "peer", from: "uds:/tmp/cc-socks/65428.sock" },
    });

    expect(readClaudePeerMessage(entry)).toEqual({
      text: expect.stringContaining("<cross-session-message"),
      origin: { kind: "peer", address: "uds:/tmp/cc-socks/65428.sock" },
    });
  });

  test("ignores every other origin, including the person at the keyboard", () => {
    expect(readClaudePeerMessage(peerEntry({ origin: { kind: "human" } }))).toBeNull();
    expect(readClaudePeerMessage(peerEntry({ origin: undefined }))).toBeNull();
    expect(readClaudePeerMessage({ type: "user", isMeta: true })).toBeNull();
  });
});
