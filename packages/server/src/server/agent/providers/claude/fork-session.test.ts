import { describe, expect, it } from "vitest";
import {
  ClaudeForkBoundaryError,
  forkClaudeSession,
  parseTranscriptBoundaryEntries,
  resolveForkBoundaryUuid,
} from "./fork-session.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

const TRANSCRIPT = [
  JSON.stringify({ type: "user", uuid: "uuid-user-1", message: { content: "hi" } }),
  JSON.stringify({
    type: "assistant",
    uuid: "uuid-assistant-1",
    message: { id: "msg_live_1", content: [] },
  }),
  JSON.stringify({ type: "user", uuid: "uuid-user-2", message: { content: "again" } }),
  JSON.stringify({
    type: "assistant",
    uuid: "uuid-assistant-2",
    message: { id: "msg_live_2", content: [] },
  }),
].join("\n");

describe("parseTranscriptBoundaryEntries", () => {
  it("skips a partially flushed trailing line instead of failing the fork", () => {
    const entries = parseTranscriptBoundaryEntries(`${TRANSCRIPT}\n{"type":"assist`);
    expect(entries).toHaveLength(4);
  });
});

describe("resolveForkBoundaryUuid", () => {
  const entries = parseTranscriptBoundaryEntries(TRANSCRIPT);

  it("passes a transcript uuid straight through", () => {
    expect(resolveForkBoundaryUuid(entries, "uuid-assistant-1")).toBe("uuid-assistant-1");
  });

  it("maps a live API message id onto its transcript uuid", () => {
    // Live streamed assistant messages carry the Anthropic `msg_…` id, but
    // forkSession slices on transcript uuids, so the two must be bridged.
    expect(resolveForkBoundaryUuid(entries, "msg_live_2")).toBe("uuid-assistant-2");
  });

  it("returns null for a message that is not in the transcript", () => {
    expect(resolveForkBoundaryUuid(entries, "msg_unknown")).toBeNull();
    expect(resolveForkBoundaryUuid(entries, "  ")).toBeNull();
  });
});

describe("forkClaudeSession", () => {
  it("forks the whole session when no boundary is given", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.setNextSessionId("forked-whole");
    const result = await forkClaudeSession({
      sdk,
      sessionId: "source-session",
      readTranscript: () => {
        throw new Error("transcript must not be read without a boundary");
      },
    });
    expect(result).toEqual({ sessionId: "forked-whole" });
    expect(sdk.recordedForkCalls).toEqual([
      { sessionId: "source-session", upToMessageId: undefined },
    ]);
  });

  it("slices at the transcript uuid behind a live message id", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.setNextSessionId("forked-sliced");
    const result = await forkClaudeSession({
      sdk,
      sessionId: "source-session",
      boundaryMessageId: "msg_live_1",
      readTranscript: () => TRANSCRIPT,
    });
    expect(result).toEqual({ sessionId: "forked-sliced" });
    expect(sdk.recordedForkCalls).toEqual([
      { sessionId: "source-session", upToMessageId: "uuid-assistant-1" },
    ]);
  });

  it("refuses rather than forking everything when the boundary is unknown", async () => {
    const sdk = new FakeClaudeSdk();
    await expect(
      forkClaudeSession({
        sdk,
        sessionId: "source-session",
        boundaryMessageId: "msg_missing",
        readTranscript: () => TRANSCRIPT,
      }),
    ).rejects.toBeInstanceOf(ClaudeForkBoundaryError);
    expect(sdk.recordedForkCalls).toEqual([]);
  });

  it("refuses when the transcript cannot be read", async () => {
    const sdk = new FakeClaudeSdk();
    await expect(
      forkClaudeSession({
        sdk,
        sessionId: "source-session",
        boundaryMessageId: "uuid-user-1",
        readTranscript: () => null,
      }),
    ).rejects.toBeInstanceOf(ClaudeForkBoundaryError);
    expect(sdk.recordedForkCalls).toEqual([]);
  });

  it("refuses when the agent has no provider session yet", async () => {
    const sdk = new FakeClaudeSdk();
    await expect(
      forkClaudeSession({ sdk, sessionId: null, readTranscript: () => null }),
    ).rejects.toThrow(/not ready to fork/);
  });
});
