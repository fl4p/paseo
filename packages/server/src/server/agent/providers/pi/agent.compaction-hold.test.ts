import pino from "pino";
import { expect, test } from "vitest";

import { AgentManager, type AgentManagerEvent } from "../../agent-manager.js";
import { startAgentRun } from "../../agent-prompt.js";
import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { PiRpcAgentClient } from "./agent.js";
import { FakePi } from "./test-utils/fake-pi.js";

/**
 * The user's sequence against a real Pi session over a fake runtime: `/compact`, then a prompt
 * while the compaction is still running. Pi refuses such a prompt itself ("Cannot submit a prompt
 * while compaction is in progress") and the message is lost, so it must never reach pi at all.
 */
const logger = pino({ level: "silent" });

function timelineItems(events: AgentManagerEvent[]): AgentTimelineItem[] {
  return events.flatMap((event) =>
    event.type === "agent_stream" && event.event.type === "timeline" ? [event.event.item] : [],
  );
}

test("a prompt sent during a Pi compaction is held and delivered once the compaction ends", async () => {
  const pi = new FakePi();
  const manager = new AgentManager({
    clients: { pi: new PiRpcAgentClient({ logger, runtime: pi }) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  try {
    const session = pi.latestSession();
    let endCompaction!: () => void;
    session.compactGate = new Promise<void>((resolve) => {
      endCompaction = resolve;
    });

    const compact = await startAgentRun(manager, agent.id, "/compact", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(compact.disposition).toBe("out_of_band");
    await expect.poll(() => session.compactRequests.length).toBe(1);
    await expect
      .poll(() =>
        timelineItems(events).some(
          (item) => item.type === "compaction" && item.status === "loading",
        ),
      )
      .toBe(true);

    // Pi is compacting. This prompt used to reach pi and come back as a system error.
    const followUp = await startAgentRun(manager, agent.id, "follow up", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
      runOptions: { clientMessageId: "client-follow-up" },
    });
    expect(followUp.disposition).toBe("held");
    expect(session.prompts).toEqual([]);

    endCompaction();
    await expect.poll(() => session.prompts.length).toBe(1);
    expect(session.prompts[0]?.message).toBe("follow up");
    expect(session.compactRequests).toHaveLength(1);
    expect(session.abortRequested).toBe(false);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
});
