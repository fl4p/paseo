import { afterEach, describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { runDefaultSendAction } from "@/composer/input/state";
import {
  selectAgentQueueBusy,
  selectAgentTurnPresentation,
  useSessionStore,
} from "@/stores/session-store";

const SERVER_ID = "queue-busy-host";
const AGENT_ID = "pi-agent";
const at = new Date("2026-09-11T10:00:00.000Z");

function syncTimeline(items: StreamItem[]): void {
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
    items,
    head: [],
    range: { epoch: "e1", startSeq: 1, endSeq: items.length },
    older: "none",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
}

const compactRow: StreamItem = {
  kind: "user_message",
  id: "compact-row",
  clientMessageId: "compact-row",
  text: "/compact",
  timestamp: at,
  timelineCursor: { epoch: "e1", seq: 1 },
};

function compactionMarker(status: "loading" | "completed"): StreamItem {
  return {
    kind: "compaction",
    id: `marker-${status}`,
    timestamp: at,
    status,
    timelineCursor: { epoch: "e1", seq: 2 },
  };
}

function pressEnterInQueueMode(): string[] {
  const session = useSessionStore.getState().sessions[SERVER_ID];
  const calls: string[] = [];
  runDefaultSendAction({
    defaultSendBehavior: "queue",
    isQueueBusy: selectAgentQueueBusy(session, AGENT_ID, "composer"),
    onQueue: () => undefined,
    handleSendMessage: () => calls.push("send"),
    handleQueueMessage: () => calls.push("queue"),
  });
  return calls;
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

describe("queue busy during an out-of-band compaction", () => {
  it("queues a message typed while a turn-less compaction runs, without claiming a turn", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    syncTimeline([compactRow, compactionMarker("loading")]);
    const session = useSessionStore.getState().sessions[SERVER_ID];

    expect(pressEnterInQueueMode()).toEqual(["queue"]);
    // Stop, steer and voice still follow the turn: there is no turn to cancel or steer.
    expect(selectAgentTurnPresentation(session, AGENT_ID).isActive).toBe(false);
  });

  it("sends a message typed once that compaction has completed", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    syncTimeline([compactRow, compactionMarker("completed")]);

    expect(pressEnterInQueueMode()).toEqual(["send"]);
  });

  it("does not guess from a timeline that was never authoritatively synced", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      tail: [compactRow, compactionMarker("loading")],
    });

    expect(pressEnterInQueueMode()).toEqual(["send"]);
  });
});
