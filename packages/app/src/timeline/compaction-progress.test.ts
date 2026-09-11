import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { TURN_LIVENESS_IDLE, type TurnLiveness } from "@/timeline/turn-liveness";
import { isCompactCommandText, resolveCompactionInProgress } from "./compaction-progress";

const at = new Date("2026-09-11T10:00:00.000Z");

function userRow(text: string, extra: { turnId?: string; seq?: number } = {}): StreamItem {
  return {
    kind: "user_message",
    id: `user-${text}-${extra.seq ?? "optimistic"}`,
    clientMessageId: `client-${text}`,
    text,
    timestamp: at,
    ...(extra.turnId ? { turnId: extra.turnId } : {}),
    ...(extra.seq !== undefined ? { timelineCursor: { epoch: "e1", seq: extra.seq } } : {}),
  };
}

function marker(
  status: "loading" | "completed",
  extra: { turnId?: string; outcome?: "canceled" | "failed" } = {},
): StreamItem {
  return {
    kind: "compaction",
    id: `compaction-${status}-${extra.turnId ?? "oob"}`,
    timestamp: at,
    status,
    ...(extra.turnId ? { turnId: extra.turnId } : {}),
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
  };
}

function assistant(text: string): StreamItem {
  return { kind: "assistant_message", id: `assistant-${text}`, text, timestamp: at };
}

const openTurn = (turnId: string | null): TurnLiveness => ({
  phase: "open",
  turnId,
  startedAt: at,
  cancellationRequestId: null,
});

function compacting(tail: StreamItem[], turn: TurnLiveness = TURN_LIVENESS_IDLE, head = []) {
  return resolveCompactionInProgress({ tail, head, turn });
}

describe("isCompactCommandText", () => {
  it("matches /compact with or without instructions, as the providers parse it", () => {
    expect(isCompactCommandText("/compact")).toBe(true);
    expect(isCompactCommandText("  /compact keep the plan  ")).toBe(true);
    expect(isCompactCommandText("/COMPACT")).toBe(true);
  });

  it("does not match other commands or plain text", () => {
    expect(isCompactCommandText("/compacted")).toBe(false);
    expect(isCompactCommandText("/autocompact on")).toBe(false);
    expect(isCompactCommandText("compact")).toBe(false);
    expect(isCompactCommandText("please /compact")).toBe(false);
  });
});

describe("resolveCompactionInProgress", () => {
  it("is compacting while an out-of-band loading marker is open", () => {
    expect(compacting([userRow("/compact", { seq: 1 }), marker("loading")])).toBe(true);
  });

  it("ends on the terminal marker whatever its outcome", () => {
    const row = userRow("/compact", { seq: 1 });
    expect(compacting([row, marker("completed")])).toBe(false);
    expect(compacting([row, marker("completed", { outcome: "canceled" })])).toBe(false);
    expect(compacting([row, marker("completed", { outcome: "failed" })])).toBe(false);
  });

  it("covers the window between dispatching /compact and the provider's first marker", () => {
    expect(compacting([assistant("done"), userRow("/compact")])).toBe(true);
    expect(compacting([assistant("done"), userRow("/compact", { seq: 4 })])).toBe(true);
  });

  it("ends a /compact the provider answered without ever starting a compaction", () => {
    expect(
      compacting([userRow("/compact", { seq: 1 }), assistant("[Error] Failed to compact context")]),
    ).toBe(false);
  });

  it("leaves a turn-bound /compact row to its turn's liveness", () => {
    expect(compacting([userRow("/compact", { seq: 1, turnId: "t1" })])).toBe(false);
  });

  it("treats a turn-bound marker as live only while its turn is open", () => {
    const tail = [
      userRow("/compact", { seq: 1, turnId: "t1" }),
      marker("loading", { turnId: "t1" }),
    ];
    expect(compacting(tail, openTurn("t1"))).toBe(true);
    expect(compacting(tail, openTurn(null))).toBe(true);
    expect(compacting(tail, openTurn("t2"))).toBe(false);
    expect(compacting(tail, TURN_LIVENESS_IDLE)).toBe(false);
  });

  it("ends a stale open marker once a newer prompt reached the timeline", () => {
    expect(compacting([marker("loading"), userRow("next prompt", { seq: 9 })])).toBe(false);
  });

  it("keeps compacting across a side command that landed mid-compaction", () => {
    expect(compacting([marker("loading"), userRow("/autocompact off", { seq: 3 })])).toBe(true);
  });

  it("reads head items as newer than the tail", () => {
    expect(
      resolveCompactionInProgress({
        tail: [userRow("/compact")],
        head: [assistant("[Error] Failed to compact context")],
        turn: TURN_LIVENESS_IDLE,
      }),
    ).toBe(false);
    expect(
      resolveCompactionInProgress({
        tail: [userRow("/compact", { seq: 1 })],
        head: [marker("loading")],
        turn: TURN_LIVENESS_IDLE,
      }),
    ).toBe(true);
  });

  it("is not compacting with no compaction evidence at all", () => {
    expect(compacting([])).toBe(false);
    expect(compacting([assistant("hello")])).toBe(false);
  });
});
