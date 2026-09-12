import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteForkedPiSession,
  forkPiSession,
  parsePiTranscriptEntries,
  PiForkBoundaryError,
  PiForkInFlightError,
  readPiCompactionSummary,
  resolveForkBoundaryEntryId,
  resolveSafePiForkEntry,
} from "./fork-session.js";

const HEADER = {
  type: "session",
  version: 3,
  id: "session-orig-1",
  timestamp: "2026-09-10T10:00:00.000Z",
  cwd: "/Users/dev/farming",
};

const SAMPLE_ENTRIES = [
  HEADER,
  {
    type: "model_change",
    id: "e1",
    parentId: null,
    timestamp: "2026-09-10T10:00:01.000Z",
    provider: "antigravity",
    modelId: "gemini-3.8-flash",
  },
  {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-09-10T10:00:02.000Z",
    message: { role: "user", content: "hello" },
  },
  {
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: "2026-09-10T10:00:03.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      stopReason: "stop",
    },
  },
  {
    type: "message",
    id: "e4",
    parentId: "e3",
    timestamp: "2026-09-10T10:00:04.000Z",
    message: { role: "user", content: "next command" },
  },
  {
    type: "message",
    id: "e5",
    parentId: "e4",
    timestamp: "2026-09-10T10:00:05.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "all done" }],
      stopReason: "stop",
    },
  },
];

const SAMPLE_TRANSCRIPT = SAMPLE_ENTRIES.map((e) => JSON.stringify(e)).join("\n");

describe("parsePiTranscriptEntries", () => {
  it("skips corrupt/partially flushed trailing lines", () => {
    const entries = parsePiTranscriptEntries(`${SAMPLE_TRANSCRIPT}\n{"type":"mess`);
    expect(entries).toHaveLength(6);
  });

  it("skips blank and whitespace lines", () => {
    const entries = parsePiTranscriptEntries(`\n${SAMPLE_TRANSCRIPT}\n   \n`);
    expect(entries).toHaveLength(6);
  });
});

describe("resolveForkBoundaryEntryId", () => {
  const entries = parsePiTranscriptEntries(SAMPLE_TRANSCRIPT);

  it("resolves by direct entry id", () => {
    expect(resolveForkBoundaryEntryId(entries, "e3")).toBe("e3");
    expect(resolveForkBoundaryEntryId(entries, "e5")).toBe("e5");
  });

  it("returns null for non-existent id or blank string", () => {
    expect(resolveForkBoundaryEntryId(entries, "e999")).toBeNull();
    expect(resolveForkBoundaryEntryId(entries, "   ")).toBeNull();
  });

  it("resolves assistant message by responseId", () => {
    const withResponseId = [
      ...entries,
      {
        type: "message",
        id: "e6",
        parentId: "e5",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          responseId: "chatcmpl-547cf3f357824fc9862b468acae7261a",
          stopReason: "stop",
        },
      },
    ];
    expect(
      resolveForkBoundaryEntryId(withResponseId, "chatcmpl-547cf3f357824fc9862b468acae7261a"),
    ).toBe("e6");
  });

  it("resolves toolResult by toolCallId", () => {
    const withTool = [
      ...entries,
      {
        type: "message",
        id: "e6",
        parentId: "e5",
        message: { role: "toolResult", toolCallId: "call_abc_123" },
      },
    ];
    expect(resolveForkBoundaryEntryId(withTool, "call_abc_123")).toBe("e6");
  });
});

const IN_FLIGHT_PI_TRANSCRIPT = [
  HEADER,
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-09-10T10:00:01.000Z",
    message: { role: "user", content: "run test" },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-09-10T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
    },
  },
  {
    type: "message",
    id: "u2",
    parentId: "a1",
    timestamp: "2026-09-10T10:00:03.000Z",
    message: { role: "user", content: "now compile" },
  },
  {
    type: "message",
    id: "a2",
    parentId: "u2",
    timestamp: "2026-09-10T10:00:04.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_tool_1", name: "bash", arguments: {} }],
      stopReason: "toolUse",
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("resolveSafePiForkEntry", () => {
  const inFlight = parsePiTranscriptEntries(IN_FLIGHT_PI_TRANSCRIPT);

  it("never cuts where a toolCall is still open", () => {
    const safe = resolveSafePiForkEntry(inFlight);
    expect(safe).not.toBeNull();
    expect(safe?.entryId).toBe("u2");
  });

  it("cuts at the last completed turn when asked for requireTurnEnd", () => {
    const safe = resolveSafePiForkEntry(inFlight, { requireTurnEnd: true });
    expect(safe).not.toBeNull();
    expect(safe?.entryId).toBe("a1");
  });

  it("resumes cutting once tool result and final assistant message settle", () => {
    const settled = parsePiTranscriptEntries(
      `${IN_FLIGHT_PI_TRANSCRIPT}\n${JSON.stringify({
        type: "message",
        id: "tr1",
        parentId: "a2",
        message: { role: "toolResult", toolCallId: "call_tool_1", isError: false },
      })}\n${JSON.stringify({
        type: "message",
        id: "a3",
        parentId: "tr1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "finished compile" }],
          stopReason: "stop",
        },
      })}`,
    );

    const safeUnbounded = resolveSafePiForkEntry(settled);
    expect(safeUnbounded?.entryId).toBe("a3");

    const safeTurnEnd = resolveSafePiForkEntry(settled, { requireTurnEnd: true });
    expect(safeTurnEnd?.entryId).toBe("a3");
  });

  it("returns null if requireTurnEnd is true but no assistant turn completed yet", () => {
    const userOnly = parsePiTranscriptEntries(
      `${JSON.stringify(HEADER)}\n${JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: "hi" },
      })}`,
    );
    expect(resolveSafePiForkEntry(userOnly, { requireTurnEnd: true })).toBeNull();
  });
});

describe("forkPiSession", () => {
  let tmpDir: string;
  let sourceSessionPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "pi-fork-test-"));
    sourceSessionPath = path.join(tmpDir, "2026-09-10T10-00-00-000Z_source-pi-1.jsonl");
    writeFileSync(sourceSessionPath, SAMPLE_TRANSCRIPT, "utf8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forks whole session preserving entry IDs, parentIds, and ordering (KV-cache friendly)", async () => {
    const fixedTimestamp = new Date("2026-09-10T11:00:00.000Z");
    const result = await forkPiSession({
      sourceSessionPath,
      newSessionId: "forked-session-uuid-1",
      timestamp: fixedTimestamp,
      sessionDir: tmpDir,
    });

    expect(result.sessionId).toBe("forked-session-uuid-1");
    expect(result.sessionPath).toBe(
      path.join(tmpDir, "2026-09-10T11-00-00-000Z_forked-session-uuid-1.jsonl"),
    );

    const forkedLines = readFileSync(result.sessionPath, "utf8").trim().split("\n");
    expect(forkedLines).toHaveLength(6);

    const forkedHeader = JSON.parse(forkedLines[0]);
    expect(forkedHeader).toEqual({
      type: "session",
      version: 3,
      id: "forked-session-uuid-1",
      timestamp: fixedTimestamp.toISOString(),
      cwd: "/Users/dev/farming",
      parentSession: sourceSessionPath,
    });

    // Check all retained entries are byte-for-byte identical in structure and IDs
    for (let i = 1; i < forkedLines.length; i++) {
      const originalEntry = SAMPLE_ENTRIES[i] as Record<string, unknown>;
      const forkedEntry = JSON.parse(forkedLines[i]);
      expect(forkedEntry.id).toBe(originalEntry.id);
      expect(forkedEntry.parentId).toBe(originalEntry.parentId);
      expect(forkedEntry.type).toBe(originalEntry.type);
      if (originalEntry.message) {
        expect(forkedEntry.message).toEqual(originalEntry.message);
      }
    }
  });

  it("cuts at requested boundaryMessageId", async () => {
    const result = await forkPiSession({
      sourceSessionPath,
      boundaryMessageId: "e3",
      newSessionId: "bounded-pi-1",
      sessionDir: tmpDir,
    });

    const forkedLines = readFileSync(result.sessionPath, "utf8").trim().split("\n");
    // Header + e1 + e2 + e3 = 4 lines
    expect(forkedLines).toHaveLength(4);
    const lastEntry = JSON.parse(forkedLines[3]);
    expect(lastEntry.id).toBe("e3");
  });

  it("throws PiForkBoundaryError for non-existent boundaryMessageId", async () => {
    await expect(
      forkPiSession({
        sourceSessionPath,
        boundaryMessageId: "does-not-exist",
        sessionDir: tmpDir,
      }),
    ).rejects.toThrow(PiForkBoundaryError);
  });

  it("throws PiForkInFlightError when atCompletedTurn is true but no turn completed", async () => {
    const freshSessionPath = path.join(tmpDir, "fresh.jsonl");
    writeFileSync(
      freshSessionPath,
      `${JSON.stringify(HEADER)}\n${JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: "first" },
      })}`,
      "utf8",
    );

    await expect(
      forkPiSession({
        sourceSessionPath: freshSessionPath,
        atCompletedTurn: true,
        sessionDir: tmpDir,
      }),
    ).rejects.toThrow(PiForkInFlightError);
  });

  it("cuts at the last completed turn when atCompletedTurn is true during in-flight turn", async () => {
    const inFlightPath = path.join(tmpDir, "in-flight.jsonl");
    writeFileSync(inFlightPath, IN_FLIGHT_PI_TRANSCRIPT, "utf8");

    const result = await forkPiSession({
      sourceSessionPath: inFlightPath,
      atCompletedTurn: true,
      newSessionId: "turn-cut-1",
      sessionDir: tmpDir,
    });

    const forkedLines = readFileSync(result.sessionPath, "utf8").trim().split("\n");
    // Header + u1 + a1 = 3 lines
    expect(forkedLines).toHaveLength(3);
    const lastEntry = JSON.parse(forkedLines[2]);
    expect(lastEntry.id).toBe("a1");
  });
});

describe("readPiCompactionSummary", () => {
  const COMPACTED_TRANSCRIPT = [
    HEADER,
    {
      type: "message",
      id: "m1",
      parentId: null,
      message: { role: "user", content: "do work" },
    },
    {
      type: "compaction",
      id: "c1",
      parentId: "m1",
      summary: "First summary of early work",
      tokensBefore: 50000,
    },
    {
      type: "message",
      id: "m2",
      parentId: "c1",
      message: { role: "user", content: "more work" },
    },
    {
      type: "compaction",
      id: "c2",
      parentId: "m2",
      summary: "Second summary of later work",
      tokensBefore: 80000,
    },
    {
      type: "message",
      id: "m3",
      parentId: "c2",
      message: { role: "user", content: "final message" },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  it("reads the latest compaction summary when unbounded", () => {
    expect(readPiCompactionSummary(COMPACTED_TRANSCRIPT)).toBe("Second summary of later work");
  });

  it("bounds the compaction summary at or before untilMessageId", () => {
    expect(readPiCompactionSummary(COMPACTED_TRANSCRIPT, { untilMessageId: "m2" })).toBe(
      "First summary of early work",
    );
  });

  it("returns null if untilMessageId is not found", () => {
    expect(
      readPiCompactionSummary(COMPACTED_TRANSCRIPT, { untilMessageId: "missing-msg" }),
    ).toBeNull();
  });

  it("returns null if no compaction exists before untilMessageId", () => {
    expect(readPiCompactionSummary(COMPACTED_TRANSCRIPT, { untilMessageId: "m1" })).toBeNull();
  });

  it("returns null when transcript has no compactions", () => {
    expect(readPiCompactionSummary(SAMPLE_TRANSCRIPT)).toBeNull();
    expect(readPiCompactionSummary(null)).toBeNull();
  });
});

describe("deleteForkedPiSession", () => {
  let tmpDir: string;
  let sourcePath: string;
  let forkPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "pi-del-test-"));
    sourcePath = path.join(tmpDir, "source.jsonl");
    forkPath = path.join(tmpDir, "fork.jsonl");
    writeFileSync(sourcePath, "{}", "utf8");
    writeFileSync(forkPath, "{}", "utf8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes the fork file", async () => {
    await deleteForkedPiSession({
      sourceSessionPath: sourcePath,
      forkSessionPath: forkPath,
    });
    expect(readFileSync(sourcePath, "utf8")).toBe("{}");
    expect(() => readFileSync(forkPath, "utf8")).toThrow();
  });

  it("refuses to delete the source session", async () => {
    await expect(
      deleteForkedPiSession({
        sourceSessionPath: sourcePath,
        forkSessionPath: sourcePath,
      }),
    ).rejects.toThrow(/Refusing to delete the source Pi session/);
  });
});
