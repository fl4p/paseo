import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import { startAgentRun } from "../agent-prompt.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentTimelineItem,
} from "../agent-sdk-types.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
} from "./codex/test-utils/fake-app-server.js";

/**
 * The user's sequence, through the real AgentManager and prompt dispatcher against a fake Codex
 * app-server: `/compact`, then a prompt while the compaction turn runs.
 */

const logger = createTestLogger();
const THREAD_ID = "thread-1";

class FakeAppServerCodexClient extends CodexAppServerAgentClient implements AgentClient {
  constructor(private readonly appServer: FakeCodexAppServer) {
    super(logger);
  }

  override async isAvailable(): Promise<boolean> {
    return true;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new CodexAppServerAgentSession(
      config,
      null,
      logger,
      async () => this.appServer.child,
      {},
      false,
      false,
      false,
      launchContext?.agentId,
    );
    await session.connect();
    return session;
  }
}

interface CodexScenario {
  appServer: FakeCodexAppServer;
  manager: AgentManager;
  agentId: string;
  compactions(): Array<Extract<AgentTimelineItem, { type: "compaction" }>>;
  userMessages(): string[];
  requests(method: string): Array<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

async function startCodexScenario(): Promise<CodexScenario> {
  const workdir = mkdtempSync(join(tmpdir(), "codex-compaction-hold-"));
  const appServer = createFakeCodexAppServer({
    "thread/compact/start": () => ({}),
    "turn/interrupt": () => ({}),
  });
  const manager = new AgentManager({
    clients: { codex: new FakeAppServerCodexClient(appServer) },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: workdir, modeId: "auto", model: "gpt-5.4" },
    undefined,
    { workspaceId: undefined },
  );
  const timelineItems = () =>
    events.flatMap((event) =>
      event.type === "agent_stream" && event.event.type === "timeline" ? [event.event.item] : [],
    );
  return {
    appServer,
    manager,
    agentId: agent.id,
    compactions: () =>
      timelineItems().filter(
        (item): item is Extract<AgentTimelineItem, { type: "compaction" }> =>
          item.type === "compaction",
      ),
    userMessages: () =>
      timelineItems().flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
    requests: (method) => appServer.requests().filter((request) => request.method === method),
    cleanup: async () => {
      if (manager.getAgent(agent.id)) {
        await manager.closeAgent(agent.id);
      }
      unsubscribe();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

async function runManualCompactionTurn(scenario: CodexScenario, turnId: string): Promise<void> {
  const dispatched = await startAgentRun(scenario.manager, scenario.agentId, "/compact", logger, {
    replaceRunning: true,
    activeTurnBehavior: "interrupt",
  });
  expect(dispatched.disposition).toBe("out_of_band");
  await scenario.appServer.waitForRequest("thread/compact/start");
  scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId });
  await expect.poll(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle).toBe("running");
}

function sendPrompt(
  scenario: CodexScenario,
  text: string,
  activeTurnBehavior: "interrupt" | "steer",
): ReturnType<typeof startAgentRun> {
  return startAgentRun(scenario.manager, scenario.agentId, text, logger, {
    replaceRunning: true,
    activeTurnBehavior,
    clearPendingPermissions: true,
    runOptions: { clientMessageId: `client-${text}` },
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function promptTextsSent(scenario: CodexScenario): string[] {
  return scenario.requests("turn/start").map((request) => JSON.stringify(request.params));
}

test.each(["interrupt", "steer"] as const)(
  "a %s prompt sent during /compact waits for the compaction and is delivered once",
  async (activeTurnBehavior) => {
    const scenario = await startCodexScenario();
    try {
      await runManualCompactionTurn(scenario, "compact-turn");
      scenario.appServer.startsCompaction({ threadId: THREAD_ID, itemId: "compact-item" });
      await expect
        .poll(() => scenario.manager.isHoldingPromptsForCompaction(scenario.agentId))
        .toBe(true);

      // Not awaited first: the old dispatcher only returned after canceling the compaction.
      const dispatched = sendPrompt(scenario, "follow-up", activeTurnBehavior);
      await settle();
      // The compaction is not canceled to make room, and the prompt has not jumped the queue.
      expect(scenario.requests("turn/interrupt")).toHaveLength(0);
      expect(scenario.requests("turn/steer")).toHaveLength(0);
      expect(scenario.requests("turn/start")).toHaveLength(0);
      expect(scenario.userMessages()).not.toContain("follow-up");
      expect((await dispatched).disposition).toBe("held");

      scenario.appServer.completesCompaction({ threadId: THREAD_ID, itemId: "compact-item" });
      scenario.appServer.completeTurn({ threadId: THREAD_ID });

      await expect.poll(() => scenario.requests("turn/start").length).toBe(1);
      expect(promptTextsSent(scenario)[0]).toContain("follow-up");
      scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId: "follow-up-turn" });
      scenario.appServer.completeTurn({ threadId: THREAD_ID });
      await expect.poll(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle).toBe("idle");
      await settle();

      expect(scenario.requests("turn/interrupt")).toHaveLength(0);
      expect(scenario.requests("turn/start")).toHaveLength(1);
      expect(scenario.userMessages().filter((text) => text === "follow-up")).toHaveLength(1);
      expect(scenario.compactions()).toEqual([
        { type: "compaction", status: "loading", trigger: "manual" },
        { type: "compaction", status: "completed", trigger: "manual" },
      ]);
      scenario.appServer.assertNoErrors();
    } finally {
      await scenario.cleanup();
    }
  },
);

test("Stop still stops a compaction with a held prompt, which then runs once", async () => {
  const scenario = await startCodexScenario();
  try {
    await runManualCompactionTurn(scenario, "compact-turn");
    scenario.appServer.startsCompaction({ threadId: THREAD_ID, itemId: "compact-item" });
    await expect
      .poll(() => scenario.manager.isHoldingPromptsForCompaction(scenario.agentId))
      .toBe(true);
    const dispatched = await sendPrompt(scenario, "follow-up", "interrupt");
    expect(dispatched.disposition).toBe("held");

    const stop = scenario.manager.cancelAgentRun(scenario.agentId);
    await scenario.appServer.waitForRequest("turn/interrupt");
    scenario.appServer.completeTurn({ threadId: THREAD_ID, status: "interrupted" });
    await expect(stop).resolves.toEqual({ status: "settled" });

    // The stopped compaction is never presented as one that compacted.
    expect(scenario.compactions()).toEqual([
      { type: "compaction", status: "loading", trigger: "manual" },
      { type: "compaction", status: "completed", trigger: "manual", outcome: "canceled" },
    ]);

    await expect.poll(() => scenario.requests("turn/start").length).toBe(1);
    scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId: "follow-up-turn" });
    scenario.appServer.completeTurn({ threadId: THREAD_ID });
    await expect.poll(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle).toBe("idle");
    await settle();
    expect(scenario.requests("turn/interrupt")).toHaveLength(1);
    expect(scenario.requests("turn/start")).toHaveLength(1);
    expect(scenario.userMessages().filter((text) => text === "follow-up")).toHaveLength(1);
    scenario.appServer.assertNoErrors();
  } finally {
    await scenario.cleanup();
  }
});

test("a manual compaction stopped before it began does not label the next compaction manual", async () => {
  const scenario = await startCodexScenario();
  try {
    // Stopped before Codex emitted the compaction item: exactly the recorded rollout, where the
    // aborted turn carries no compaction event at all.
    await runManualCompactionTurn(scenario, "compact-turn");
    const stop = scenario.manager.cancelAgentRun(scenario.agentId);
    await scenario.appServer.waitForRequest("turn/interrupt");
    scenario.appServer.completeTurn({ threadId: THREAD_ID, status: "interrupted" });
    await expect(stop).resolves.toEqual({ status: "settled" });
    expect(scenario.compactions()).toEqual([]);

    const dispatched = await sendPrompt(scenario, "long task", "interrupt");
    expect(dispatched.disposition).toBe("turn_started");
    await expect.poll(() => scenario.requests("turn/start").length).toBe(1);
    scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId: "work-turn" });
    scenario.appServer.startsCompaction({ threadId: THREAD_ID, itemId: "auto-compaction" });
    scenario.appServer.completesCompaction({ threadId: THREAD_ID, itemId: "auto-compaction" });
    scenario.appServer.completeTurn({ threadId: THREAD_ID });
    await expect.poll(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle).toBe("idle");

    expect(scenario.compactions()).toEqual([
      { type: "compaction", status: "loading" },
      { type: "compaction", status: "completed" },
    ]);
    scenario.appServer.assertNoErrors();
  } finally {
    await scenario.cleanup();
  }
});

test("/compact armed during a running turn stays manual when that older turn ends first", async () => {
  const scenario = await startCodexScenario();
  try {
    const first = await sendPrompt(scenario, "long task", "interrupt");
    expect(first.disposition).toBe("turn_started");
    await expect.poll(() => scenario.requests("turn/start").length).toBe(1);
    scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId: "work-turn" });
    await expect.poll(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle).toBe("running");

    const compact = await startAgentRun(scenario.manager, scenario.agentId, "/compact", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(compact.disposition).toBe("out_of_band");
    await scenario.appServer.waitForRequest("thread/compact/start");

    // The turn that was already running when /compact was sent ends first...
    scenario.appServer.completeTurn({ threadId: THREAD_ID });
    await expect.poll(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle).toBe("idle");
    // ...and only then does the compaction turn run.
    scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId: "compact-turn" });
    scenario.appServer.startsCompaction({ threadId: THREAD_ID, itemId: "compact-item" });
    scenario.appServer.completesCompaction({ threadId: THREAD_ID, itemId: "compact-item" });
    scenario.appServer.completeTurn({ threadId: THREAD_ID });
    await expect.poll(() => scenario.compactions().length).toBe(2);

    expect(scenario.compactions()).toEqual([
      { type: "compaction", status: "loading", trigger: "manual" },
      { type: "compaction", status: "completed", trigger: "manual" },
    ]);
    scenario.appServer.assertNoErrors();
  } finally {
    await scenario.cleanup();
  }
});

test("a prompt sent after /compact but BEFORE the compaction item does not interrupt it", async () => {
  const scenario = await startCodexScenario();
  try {
    // The reviewer's reproduction: the manual-compaction turn has started, but Codex has not
    // emitted the compaction item yet, so no timeline marker exists to hold behind.
    await runManualCompactionTurn(scenario, "compact-turn");
    expect(scenario.compactions()).toEqual([]);
    expect(scenario.manager.isHoldingPromptsForCompaction(scenario.agentId)).toBe(true);

    const dispatched = await sendPrompt(scenario, "follow-up", "interrupt");
    expect(dispatched.disposition).toBe("held");
    await settle();
    expect(scenario.requests("turn/interrupt")).toHaveLength(0);
    expect(scenario.requests("turn/start")).toHaveLength(0);

    scenario.appServer.startsCompaction({ threadId: THREAD_ID, itemId: "compact-item" });
    scenario.appServer.completesCompaction({ threadId: THREAD_ID, itemId: "compact-item" });
    scenario.appServer.completeTurn({ threadId: THREAD_ID });

    await expect.poll(() => scenario.requests("turn/start").length).toBe(1);
    expect(promptTextsSent(scenario)[0]).toContain("follow-up");
    expect(scenario.requests("turn/interrupt")).toHaveLength(0);
    expect(scenario.compactions()).toEqual([
      { type: "compaction", status: "loading", trigger: "manual" },
      { type: "compaction", status: "completed", trigger: "manual" },
    ]);
    scenario.appServer.assertNoErrors();
  } finally {
    await scenario.cleanup();
  }
});

test("two /compacts armed before either turn starts are both labeled manual", async () => {
  const scenario = await startCodexScenario();
  try {
    const first = await startAgentRun(scenario.manager, scenario.agentId, "/compact", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(first.disposition).toBe("out_of_band");
    await expect.poll(() => scenario.requests("thread/compact/start").length).toBe(1);
    // A second /compact is accepted before the first compaction's turn has even started, so both
    // arms carry the same turn ordinal. Out-of-band commands are never held.
    const second = await startAgentRun(scenario.manager, scenario.agentId, "/compact", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(second.disposition).toBe("out_of_band");
    await expect.poll(() => scenario.requests("thread/compact/start").length).toBe(2);

    scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId: "compact-turn-1" });
    scenario.appServer.startsCompaction({ threadId: THREAD_ID, itemId: "compact-item-1" });
    scenario.appServer.completesCompaction({ threadId: THREAD_ID, itemId: "compact-item-1" });
    scenario.appServer.completeTurn({ threadId: THREAD_ID });
    await expect.poll(() => scenario.compactions().length).toBe(2);

    scenario.appServer.startsTurn({ threadId: THREAD_ID, turnId: "compact-turn-2" });
    scenario.appServer.startsCompaction({ threadId: THREAD_ID, itemId: "compact-item-2" });
    scenario.appServer.completesCompaction({ threadId: THREAD_ID, itemId: "compact-item-2" });
    scenario.appServer.completeTurn({ threadId: THREAD_ID });
    await expect.poll(() => scenario.compactions().length).toBe(4);

    // The first turn's end must not clear the arm belonging to the second /compact.
    expect(scenario.compactions()).toEqual([
      { type: "compaction", status: "loading", trigger: "manual" },
      { type: "compaction", status: "completed", trigger: "manual" },
      { type: "compaction", status: "loading", trigger: "manual" },
      { type: "compaction", status: "completed", trigger: "manual" },
    ]);
    scenario.appServer.assertNoErrors();
  } finally {
    await scenario.cleanup();
  }
});
