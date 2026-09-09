import { describe, expect, it } from "vitest";
import {
  ClaudeForkBoundaryError,
  ClaudeForkInFlightError,
  deleteForkedClaudeSession,
  forkClaudeSession,
  parseTranscriptBoundaryEntries,
  resolveForkBoundaryUuid,
  resolveSafeForkUuid,
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

/**
 * A transcript captured mid-turn: the assistant has emitted a `tool_use` whose
 * `tool_result` has not been written yet. This is exactly what a fork taken
 * while a run is in flight sees.
 */
const IN_FLIGHT_TRANSCRIPT = [
  JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } }),
  JSON.stringify({
    type: "assistant",
    uuid: "a1",
    message: { id: "msg_1", content: [{ type: "text", text: "done" }] },
  }),
  JSON.stringify({ type: "user", uuid: "u2", message: { content: "next" } }),
  JSON.stringify({
    type: "assistant",
    uuid: "a2",
    message: { id: "msg_2", content: [{ type: "tool_use", id: "tool_1", name: "Read" }] },
  }),
].join("\n");

describe("resolveSafeForkUuid", () => {
  const inFlight = parseTranscriptBoundaryEntries(IN_FLIGHT_TRANSCRIPT);

  it("never cuts where a tool_use is still open", () => {
    // Cutting at "a2" would clone a tool call whose result never arrived; the
    // API rejects such a transcript, so the fork would be unusable.
    expect(resolveSafeForkUuid(inFlight)).toBe("u2");
  });

  it("cuts at the last completed turn when asked for one", () => {
    expect(resolveSafeForkUuid(inFlight, { requireTurnEnd: true })).toBe("a1");
  });

  it("resumes cutting once the tool result arrives", () => {
    const settled = parseTranscriptBoundaryEntries(
      `${IN_FLIGHT_TRANSCRIPT}\n${JSON.stringify({
        type: "user",
        uuid: "u3",
        message: { content: [{ type: "tool_result", tool_use_id: "tool_1" }] },
      })}\n${JSON.stringify({
        type: "assistant",
        uuid: "a3",
        message: { id: "msg_3", content: [{ type: "text", text: "ok" }] },
      })}`,
    );
    expect(resolveSafeForkUuid(settled)).toBe("a3");
    expect(resolveSafeForkUuid(settled, { requireTurnEnd: true })).toBe("a3");
  });

  it("ignores a subagent sidechain's own tool pairs", () => {
    const withSidechain = parseTranscriptBoundaryEntries(
      [
        JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          uuid: "s1",
          isSidechain: true,
          message: { content: [{ type: "tool_use", id: "sub_1", name: "Grep" }] },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          message: { id: "msg_1", content: [{ type: "text", text: "done" }] },
        }),
      ].join("\n"),
    );
    expect(resolveSafeForkUuid(withSidechain, { requireTurnEnd: true })).toBe("a1");
  });

  it("stops at the requested boundary", () => {
    expect(resolveSafeForkUuid(inFlight, { untilUuid: "u2" })).toBe("u2");
    expect(resolveSafeForkUuid(inFlight, { untilUuid: "a1" })).toBe("a1");
  });

  it("has no safe position before the first completed turn", () => {
    const nothingDone = parseTranscriptBoundaryEntries(
      [
        JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          message: { content: [{ type: "tool_use", id: "tool_1", name: "Read" }] },
        }),
      ].join("\n"),
    );
    expect(resolveSafeForkUuid(nothingDone, { requireTurnEnd: true })).toBeNull();
  });
});

describe("forkClaudeSession", () => {
  it("cuts an unbounded fork at the last complete position, not at end of file", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.setNextSessionId("forked-whole");
    const result = await forkClaudeSession({
      sdk,
      sessionId: "source-session",
      readTranscript: () => TRANSCRIPT,
    });
    expect(result).toEqual({ sessionId: "forked-whole" });
    // The whole transcript is complete here, so the cut is the last entry --
    // but it is now an EXPLICIT cut, which is what keeps a line appended
    // between our read and the SDK's out of the fork.
    expect(sdk.recordedForkCalls).toEqual([
      { sessionId: "source-session", upToMessageId: "uuid-assistant-2" },
    ]);
  });

  it("falls back to a whole-session fork when the transcript cannot be read", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.setNextSessionId("forked-whole");
    await forkClaudeSession({ sdk, sessionId: "source-session", readTranscript: () => null });
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

  it("forks the last completed turn while a turn is in flight", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.setNextSessionId("forked-in-flight");
    await forkClaudeSession({
      sdk,
      sessionId: "source-session",
      atCompletedTurn: true,
      readTranscript: () => IN_FLIGHT_TRANSCRIPT,
    });
    expect(sdk.recordedForkCalls).toEqual([{ sessionId: "source-session", upToMessageId: "a1" }]);
  });

  it("never clones a tool_use whose result has not arrived", async () => {
    // Even without an in-flight run the transcript is a snapshot of a file the
    // provider may still be appending to, so the invariant is unconditional.
    const sdk = new FakeClaudeSdk();
    await forkClaudeSession({
      sdk,
      sessionId: "source-session",
      readTranscript: () => IN_FLIGHT_TRANSCRIPT,
    });
    expect(sdk.recordedForkCalls).toEqual([{ sessionId: "source-session", upToMessageId: "u2" }]);
  });

  it("refuses an in-flight fork when the transcript cannot be read", async () => {
    const sdk = new FakeClaudeSdk();
    await expect(
      forkClaudeSession({
        sdk,
        sessionId: "source-session",
        atCompletedTurn: true,
        readTranscript: () => null,
      }),
    ).rejects.toBeInstanceOf(ClaudeForkInFlightError);
    expect(sdk.recordedForkCalls).toEqual([]);
  });

  it("refuses an in-flight fork before any turn has completed", async () => {
    const sdk = new FakeClaudeSdk();
    await expect(
      forkClaudeSession({
        sdk,
        sessionId: "source-session",
        atCompletedTurn: true,
        readTranscript: () =>
          [
            JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } }),
            JSON.stringify({
              type: "assistant",
              uuid: "a1",
              message: { content: [{ type: "tool_use", id: "tool_1", name: "Read" }] },
            }),
          ].join("\n"),
      }),
    ).rejects.toThrow(/no turn has completed yet/);
    expect(sdk.recordedForkCalls).toEqual([]);
  });

  it("refuses when the agent has no provider session yet", async () => {
    const sdk = new FakeClaudeSdk();
    await expect(
      forkClaudeSession({ sdk, sessionId: null, readTranscript: () => null }),
    ).rejects.toThrow(/not ready to fork/);
  });
});

describe("deleteForkedClaudeSession", () => {
  it("deletes the fork so a failed import leaves no orphan transcript", async () => {
    const sdk = new FakeClaudeSdk();
    await deleteForkedClaudeSession({
      sdk,
      forkSessionId: "forked-session-1",
      sourceSessionId: "source-session",
    });
    expect(sdk.recordedDeletes).toEqual(["forked-session-1"]);
  });

  it("refuses to delete the source session", async () => {
    // Rollback is the only caller, and a mix-up here would destroy the live
    // conversation the user forked FROM.
    const sdk = new FakeClaudeSdk();
    await expect(
      deleteForkedClaudeSession({
        sdk,
        forkSessionId: "source-session",
        sourceSessionId: "source-session",
      }),
    ).rejects.toThrow(/Refusing to delete the source/);
    expect(sdk.recordedDeletes).toEqual([]);
  });

  it("refuses an empty handle rather than asking the SDK to delete nothing", async () => {
    const sdk = new FakeClaudeSdk();
    await expect(
      deleteForkedClaudeSession({ sdk, forkSessionId: "  ", sourceSessionId: "source-session" }),
    ).rejects.toThrow(/without its id/);
    expect(sdk.recordedDeletes).toEqual([]);
  });
});
