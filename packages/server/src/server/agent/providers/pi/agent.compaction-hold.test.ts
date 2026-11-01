import pino from "pino";
import { expect, test, vi } from "vitest";

import { AgentManager, type AgentManagerEvent } from "../../agent-manager.js";
import { startAgentRun } from "../../agent-prompt.js";
import { cancelAgentRunCommand } from "../../lifecycle-command.js";
import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { PiRpcAgentClient } from "./agent.js";
import { asInternals } from "../../../test-utils/class-mocks.js";
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
async function startStalledCompaction(
  rescueTimeouts?: ConstructorParameters<typeof AgentManager>[0]["rescueTimeouts"],
) {
  const pi = new FakePi();
  const manager = new AgentManager({
    clients: { pi: new PiRpcAgentClient({ logger, runtime: pi }) },
    logger,
    ...(rescueTimeouts ? { rescueTimeouts } : {}),
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
  return { pi, manager, agent, session };
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
  const { pi, manager, agent, session } = await startStalledCompaction();
  try {
    await expect(manager.forceStopAgentRun(agent.id)).resolves.toMatchObject({
      status: "settled",
    });
    expect(session.controlRequests).toContain("abort");
    expect(session.terminated).toBe(true);
    // Unlike the UI Stop, force-stop does not discard the held prompt: once the hold lifts it is
    // delivered to the reloaded runtime.
    await expect.poll(() => manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
    await expect
      .poll(() => pi.latestSession().prompts.map((prompt) => prompt.message))
      .toEqual(["while compacting"]);
    expect(pi.latestSession()).not.toBe(session);
    expect(session.prompts).toEqual([]);
  } finally {
    await manager.closeAgent(agent.id);
  }
}, 20_000);

function newPiManager() {
  const pi = new FakePi();
  const manager = new AgentManager({
    clients: { pi: new PiRpcAgentClient({ logger, runtime: pi }) },
    logger,
  });
  return { pi, manager };
}

// The next three come from a Codex review of the Stop/force-stop redesign (2026-11-01).

test("a duplicate /compact does not hide the compaction still running from Stop", async () => {
  const { manager, agent, session } = await startStalledCompaction();
  try {
    // Pi refuses the second /compact at once; its completion must not end the first's tracking.
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await new Promise((resolveTick) => setTimeout(resolveTick, 30));
    expect(manager.hasRunningOutOfBandCompaction(agent.id)).toBe(true);
    await expect(manager.cancelAgentRun(agent.id)).resolves.toEqual({ status: "refused" });
    expect(session.controlRequests).toContain("abort");
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(true);
  } finally {
    await manager.closeAgent(agent.id);
  }
}, 15_000);

test("a compaction failed by the kill does not release its hold before the reload", async () => {
  const { pi, manager } = newPiManager();
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const session = pi.latestSession();
  session.compactGate = new Promise<void>(() => {});
  // The real transport rejects pending RPCs first and only then waits for the process to exit.
  session.terminateExitDelayMs = 100;
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await expect.poll(() => session.compactRequests.length).toBe(1);
    const held = await startAgentRun(manager, agent.id, "held across kill", logger, {
      replaceRunning: true,
    });
    expect(held.disposition).toBe("held");
    await expect(manager.forceStopAgentRun(agent.id)).resolves.toEqual({ status: "settled" });
    expect(session.terminated).toBe(true);
    await expect
      .poll(() => pi.latestSession().prompts.map((prompt) => prompt.message))
      .toEqual(["held across kill"]);
    expect(pi.latestSession()).not.toBe(session);
    expect(session.prompts).toEqual([]);
  } finally {
    await manager.closeAgent(agent.id);
  }
}, 15_000);

test("a delayed force-stop escalation does not kill a turn started after the compaction ended", async () => {
  const { pi, manager } = newPiManager();
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const session = pi.latestSession();
  let endCompaction!: () => void;
  let releaseLane: (() => void) | undefined;
  session.compactGate = new Promise<void>((resolve) => {
    endCompaction = resolve;
  });
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await expect.poll(() => session.compactRequests.length).toBe(1);
    // Something else holds the lifecycle lane, so the escalation has to wait for it.
    const lane = asInternals<{
      runLifecycleMutation(agentId: string, run: () => Promise<void>): Promise<void>;
    }>(manager).runLifecycleMutation(
      agent.id,
      () =>
        new Promise<void>((resolve) => {
          releaseLane = resolve;
        }),
    );
    const stopping = manager.forceStopAgentRun(agent.id);
    // The graceful Stop refuses after its 2 s wait; the escalation is now queued.
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
    endCompaction();
    await expect.poll(() => manager.hasRunningOutOfBandCompaction(agent.id)).toBe(false);
    await startAgentRun(manager, agent.id, "new unrelated turn", logger, { replaceRunning: true });
    await expect.poll(() => session.prompts.length).toBe(1);
    releaseLane?.();
    await lane;
    await expect(stopping).resolves.toEqual({ status: "settled" });
    expect(session.terminated).toBe(false);
  } finally {
    releaseLane?.();
    await manager.closeAgent(agent.id);
  }
}, 15_000);

test("a held prompt is discarded, not lost, when the reload after a force-stop fails", async () => {
  const pi = new FakePi();
  const client = new PiRpcAgentClient({ logger, runtime: pi });
  const manager = new AgentManager({ clients: { pi: client }, logger });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const session = pi.latestSession();
  session.compactGate = new Promise<void>(() => {});
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await expect.poll(() => session.compactRequests.length).toBe(1);
    const held = await startAgentRun(manager, agent.id, "held across a failed reload", logger, {
      replaceRunning: true,
      runOptions: { clientMessageId: "client-failed-reload" },
    });
    expect(held.disposition).toBe("held");
    const reloadFailure = new Error("pi failed to start");
    vi.spyOn(client, "resumeSession").mockRejectedValueOnce(reloadFailure);
    vi.spyOn(client, "createSession").mockRejectedValueOnce(reloadFailure);
    await expect(manager.forceStopAgentRun(agent.id)).rejects.toBe(reloadFailure);
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.type === "agent_stream" &&
            event.event.type === "prompt_discarded" &&
            event.event.clientMessageId === "client-failed-reload",
        ),
      )
      .toBe(true);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
    expect(session.prompts).toEqual([]);
    expect(pi.latestSession().prompts).toEqual([]);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id).catch(() => undefined);
  }
}, 15_000);

// From the third Codex review (2026-11-01): the force-stop window must always end, and a /compact
// sent into it must not be lost in the dying runtime.

interface TerminationInternals {
  terminatingAgents: Set<string>;
  finishCanceledRun: (...args: unknown[]) => void;
}

function discardedPrompts(events: AgentManagerEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "agent_stream" && event.event.type === "prompt_discarded"
      ? [event.event.clientMessageId ?? ""]
      : [],
  );
}

test("a terminate that never confirms ends the force-stop window at its deadline", async () => {
  const { manager, agent, session } = await startStalledCompaction({ forceStopTerminateMs: 300 });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  let releaseTerminate!: () => void;
  vi.spyOn(session, "terminate").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseTerminate = resolve;
      }),
  );
  try {
    await expect(manager.forceStopAgentRun(agent.id)).rejects.toThrow(/did not confirm/);
    expect(asInternals<TerminationInternals>(manager).terminatingAgents.has(agent.id)).toBe(false);
    expect(discardedPrompts(events)).toEqual(["client-held"]);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
    expect(session.prompts).toEqual([]);
  } finally {
    releaseTerminate?.();
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
}, 15_000);

test("a failure between the kill and the reload still ends the force-stop window", async () => {
  const { manager, agent, session } = await startStalledCompaction();
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  const internals = asInternals<TerminationInternals>(manager);
  const failure = new Error("post-termination state update failed");
  const spy = vi.spyOn(internals, "finishCanceledRun").mockImplementationOnce(() => {
    throw failure;
  });
  try {
    await expect(manager.forceStopAgentRun(agent.id)).rejects.toBe(failure);
    expect(session.terminated).toBe(true);
    expect(internals.terminatingAgents.has(agent.id)).toBe(false);
    expect(discardedPrompts(events)).toEqual(["client-held"]);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
    expect(session.prompts).toEqual([]);
  } finally {
    spy.mockRestore();
    unsubscribe();
    await manager.closeAgent(agent.id).catch(() => undefined);
  }
}, 15_000);

test("a reload that never finishes ends the force-stop window at its deadline", async () => {
  const pi = new FakePi();
  const client = new PiRpcAgentClient({ logger, runtime: pi });
  const manager = new AgentManager({
    clients: { pi: client },
    logger,
    rescueTimeouts: { forceStopReloadMs: 300 },
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const session = pi.latestSession();
  session.compactGate = new Promise<void>(() => {});
  vi.spyOn(client, "resumeSession").mockImplementationOnce(() => new Promise(() => {}));
  vi.spyOn(client, "createSession").mockImplementationOnce(() => new Promise(() => {}));
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await expect.poll(() => session.compactRequests.length).toBe(1);
    const held = await startAgentRun(manager, agent.id, "held across a hung reload", logger, {
      replaceRunning: true,
      runOptions: { clientMessageId: "client-hung-reload" },
    });
    expect(held.disposition).toBe("held");
    await expect(manager.forceStopAgentRun(agent.id)).rejects.toThrow(/did not come back/);
    expect(asInternals<TerminationInternals>(manager).terminatingAgents.has(agent.id)).toBe(false);
    expect(discardedPrompts(events)).toEqual(["client-hung-reload"]);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
  } finally {
    unsubscribe();
  }
}, 15_000);

test("a /compact sent while a force-stop kills the runtime is refused, not lost", async () => {
  const { pi, manager, agent, session } = await startStalledCompaction();
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  session.terminateExitDelayMs = 400;
  const stopping = manager.forceStopAgentRun(agent.id);
  try {
    await expect.poll(() => session.terminated, { timeout: 4_000 }).toBe(true);
    const before = session.compactRequests.length;
    await startAgentRun(manager, agent.id, "/compact", logger, {
      replaceRunning: true,
      runOptions: { clientMessageId: "client-compact-in-kill" },
    });
    await expect(stopping).resolves.toEqual({ status: "settled" });
    expect(session.compactRequests).toHaveLength(before);
    expect(pi.latestSession()).not.toBe(session);
    expect(discardedPrompts(events)).toEqual(["client-compact-in-kill"]);
    // The prompt held before the kill still reaches the new runtime.
    await expect.poll(() => manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
    await expect
      .poll(() => pi.latestSession().prompts.map((prompt) => prompt.message))
      .toEqual(["while compacting"]);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
}, 15_000);

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
