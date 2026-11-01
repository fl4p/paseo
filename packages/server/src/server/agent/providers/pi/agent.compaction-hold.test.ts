import pino from "pino";
import { expect, test } from "vitest";

import { AgentManager, type AgentManagerEvent } from "../../agent-manager.js";
import { startAgentRun } from "../../agent-prompt.js";
import { cancelAgentRunCommand } from "../../lifecycle-command.js";
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

/**
 * The sequence from 2026-11-01 (rpi daemon, agent b43fd9d9): a prompt hangs on a dead provider,
 * the user presses Stop, then sends `/compact` while Pi is still aborting, then a prompt. Pi's abort
 * waits for its agent to go idle, so the Stop settles only after the compaction has started; that
 * settle released the out-of-band compaction's hold and the prompt reached Pi, which refused it.
 */
test("a Stop that settles after /compact was dispatched does not release the compaction's hold", async () => {
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

    // A turn whose provider request never answers.
    const hung = await startAgentRun(manager, agent.id, "?", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(hung.disposition).toBe("turn_started");
    await expect.poll(() => session.prompts.length).toBe(1);
    await expect.poll(() => manager.hasInFlightRun(agent.id)).toBe(true);

    // Stop: Pi's abort does not return until its agent is idle.
    let finishAbort!: () => void;
    session.abortGate = new Promise<void>((resolve) => {
      finishAbort = resolve;
    });
    const stop = manager.cancelAgentRun(agent.id);
    await expect.poll(() => session.abortRequested).toBe(true);

    // /compact while the abort is still in flight.
    let endCompaction!: () => void;
    session.compactGate = new Promise<void>((resolve) => {
      endCompaction = resolve;
    });
    const compact = await startAgentRun(manager, agent.id, "/compact", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(compact.disposition).toBe("out_of_band");
    // Upstream serializes foreground mutations, so the /compact waits behind the Stop. The hold
    // is armed at dispatch, before it waits.
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(true);

    // Real Pi announces the compaction only after its own preparation. Delay compaction_start so
    // the window between the Stop settling and the first marker is real.
    let announceCompaction!: () => void;
    session.compactStartGate = new Promise<void>((resolve) => {
      announceCompaction = resolve;
    });

    // Pi goes idle: the Stop settles while the /compact is still queued behind it.
    finishAbort();
    await expect(stop).resolves.toEqual({ status: "settled" });
    await expect.poll(() => session.compactRequests.length).toBe(1);
    // No marker yet, and the hold must still stand: the Stop did not end a /compact that had not
    // reached Pi when it settled.
    expect(
      timelineItems(events).some((item) => item.type === "compaction" && item.status === "loading"),
    ).toBe(false);
    const inWindow = await startAgentRun(manager, agent.id, "in the window", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
      runOptions: { clientMessageId: "client-in-window" },
    });
    expect(inWindow.disposition).toBe("held");
    announceCompaction();
    await expect
      .poll(() =>
        timelineItems(events).some(
          (item) => item.type === "compaction" && item.status === "loading",
        ),
      )
      .toBe(true);

    const followUp = await startAgentRun(manager, agent.id, "?", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
      runOptions: { clientMessageId: "client-after-stop" },
    });
    expect(followUp.disposition).toBe("held");
    expect(session.prompts.map((prompt) => prompt.message)).toEqual(["?"]);

    endCompaction();
    await expect.poll(() => session.prompts.length).toBeGreaterThanOrEqual(2);
    expect(session.prompts[1]?.message).toBe("in the window");
    expect(session.compactRequests).toHaveLength(1);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
});

/**
 * A `/compact` that never finishes (a hung summary request) must not make Stop useless. Upstream
 * serialises foreground mutations per agent; the out-of-band compaction used to run inside that
 * lane, so Stop and force-stop queued behind it forever and the hold never lifted.
 */
async function startStalledCompaction() {
  const pi = new FakePi();
  const manager = new AgentManager({
    clients: { pi: new PiRpcAgentClient({ logger, runtime: pi }) },
    logger,
  });
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const session = pi.latestSession();
  session.compactGate = new Promise<void>(() => {});
  const compact = await startAgentRun(manager, agent.id, "/compact", logger, {
    replaceRunning: true,
    activeTurnBehavior: "interrupt",
  });
  expect(compact.disposition).toBe("out_of_band");
  await expect.poll(() => session.compactRequests.length).toBe(1);
  const held = await startAgentRun(manager, agent.id, "while compacting", logger, {
    replaceRunning: true,
    activeTurnBehavior: "interrupt",
    runOptions: { clientMessageId: "client-held" },
  });
  expect(held.disposition).toBe("held");
  return { manager, agent, session };
}

test("Stop reaches Pi and lifts the hold while a compaction is stalled", async () => {
  const { manager, agent, session } = await startStalledCompaction();
  try {
    const stopped = await cancelAgentRunCommand({ agentManager: manager, logger }, agent.id);
    expect(stopped.cancelled).toBe(true);
    expect(session.controlRequests).toContain("abort");
    // pi has no RPC that aborts a manual compaction, so the escalation terminates the runtime.
    expect(session.terminated).toBe(true);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
    expect(manager.hasInFlightRun(agent.id)).toBe(false);
    // The held prompt was discarded by the Stop, not delivered.
    expect(session.prompts).toEqual([]);
  } finally {
    await manager.closeAgent(agent.id);
  }
}, 20_000);

test("force-stop reaches Pi and lifts the hold while a compaction is stalled", async () => {
  const { manager, agent, session } = await startStalledCompaction();
  try {
    await expect(manager.forceStopAgentRun(agent.id)).resolves.toMatchObject({
      status: "settled",
    });
    expect(session.controlRequests).toContain("abort");
    expect(session.terminated).toBe(true);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
  } finally {
    await manager.closeAgent(agent.id);
  }
}, 20_000);

test("a Pi compaction that fails after it started is marked failed, not compacted", async () => {
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
    // What pi 0.84 does when the summarization request fails: compaction_end carries the error,
    // then the compact RPC rejects.
    session.emitCompactEnd = false;
    session.compactError = new Error(
      "Summarization failed: this lane lost a rank (rank 1 stopped answering)",
    );
    let failCompaction!: () => void;
    session.compactGate = new Promise<void>((resolve) => {
      failCompaction = resolve;
    });

    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await expect.poll(() => session.compactRequests.length).toBe(1);
    await expect.poll(() => manager.isHoldingPromptsForCompaction(agent.id)).toBe(true);

    session.emit({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      errorMessage: "Compaction failed: Summarization failed: this lane lost a rank",
    });
    failCompaction();

    await expect
      .poll(() =>
        timelineItems(events).some(
          (item) => item.type === "assistant_message" && item.text.includes("Failed to compact"),
        ),
      )
      .toBe(true);
    const ends = timelineItems(events).filter(
      (item) => item.type === "compaction" && item.status === "completed",
    );
    expect(ends).toEqual([
      { type: "compaction", status: "completed", trigger: "manual", outcome: "failed" },
    ]);
    // The hold is gone and a second /compact is accepted again.
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
    session.compactGate = null;
    session.compactError = null;
    session.emitCompactEnd = true;
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await expect.poll(() => session.compactRequests.length).toBe(2);
    expect(
      timelineItems(events).some(
        (item) => item.type === "assistant_message" && item.text.includes("already running"),
      ),
    ).toBe(false);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
});
