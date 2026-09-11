import { randomUUID } from "node:crypto";

import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, COMPACTION_GATE_BACKSTOP_MS } from "./agent-manager.js";
import { cancelAgentRunCommand } from "./lifecycle-command.js";
import { startAgentRun } from "./agent-prompt.js";
import type {
  AgentClient,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * A provider that reports a compaction as running and then ends the turn WITHOUT closing the
 * marker. Codex and Claude both close theirs; the manager's hold must not depend on that.
 */
class MarkerNeverClosedSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: AgentPromptInput[] = [];
  interruptCount = 0;
  private turnCounter = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(prompt);
    const turnId = `turn-${++this.turnCounter}`;
    const compacts = this.turnCounter === 1;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
      if (compacts) {
        this.push({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "compaction", status: "loading", trigger: "auto" },
        });
      }
    }, 0);
    return { turnId };
  }

  endTurn(): void {
    this.push({
      type: "turn_completed",
      provider: this.provider,
      turnId: `turn-${this.turnCounter}`,
    });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async close(): Promise<void> {}
}

class MarkerNeverClosedClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessions: MarkerNeverClosedSession[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new MarkerNeverClosedSession();
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      modes: [],
    };
  }

  async resumeSession(_handle: unknown, config?: Partial<AgentSessionConfig>) {
    void config;
    return this.createSession();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  // Generous: these run alongside the rest of the server suite, where a 2 s budget flakes.
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a held prompt is released when the turn ends even if the provider never closes its marker", async () => {
  const logger = createTestLogger();
  const client = new MarkerNeverClosedClient();
  const manager = new AgentManager({ clients: { codex: client }, logger });
  const agent = await manager.createAgent({ provider: "codex", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  try {
    await startAgentRun(manager, agent.id, "long task", logger, { replaceRunning: true });
    await waitFor(() => manager.isHoldingPromptsForCompaction(agent.id));
    const session = client.sessions[0]!;

    const dispatched = await startAgentRun(manager, agent.id, "follow up", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(dispatched.disposition).toBe("held");
    expect(session.interruptCount).toBe(0);

    session.endTurn();
    await waitFor(() => session.prompts.length === 2);

    expect(session.prompts).toEqual(["long task", "follow up"]);
    expect(session.interruptCount).toBe(0);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a prompt sent after /compact but BEFORE the provider's first marker is held", async () => {
  const logger = createTestLogger();
  const client = new TurnCompactClient();
  const manager = new AgentManager({ clients: { claude: client }, logger });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  try {
    const compact = await startAgentRun(manager, agent.id, "/compact", logger, {
      replaceRunning: true,
    });
    expect(compact.disposition).toBe("turn_started");
    const session = client.sessions[0]!;
    await waitFor(() => session.prompts.length === 1);
    // The reviewer's window: the compaction turn is running and the provider has emitted NO
    // compaction marker yet.
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(true);

    const followUp = await startAgentRun(manager, agent.id, "follow up", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(followUp.disposition).toBe("held");
    expect(session.interruptCount).toBe(0);
    expect(session.prompts).toEqual(["/compact"]);

    session.startCompaction();
    session.endCompaction();
    session.endTurn();
    await waitFor(() => session.prompts.length === 2);

    expect(session.prompts).toEqual(["/compact", "follow up"]);
    expect(session.interruptCount).toBe(0);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a manual compaction arm that never becomes a compaction stops holding prompts", async () => {
  const logger = createTestLogger();
  const client = new OutOfBandCompactClient();
  const manager = new AgentManager({ clients: { pi: client }, logger });
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  try {
    const session = client.sessions[0]!;
    session.failCompactImmediately = true;
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    await waitFor(() => session.compactCalls === 1);
    await waitFor(() => !manager.isHoldingPromptsForCompaction(agent.id));

    const next = await startAgentRun(manager, agent.id, "next", logger, { replaceRunning: true });
    expect(next.disposition).toBe("turn_started");
    await waitFor(() => session.prompts.length === 1);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a prompt sent during a pi out-of-band compaction is held, never handed to the provider", async () => {
  const logger = createTestLogger();
  const client = new OutOfBandCompactClient();
  const manager = new AgentManager({ clients: { pi: client }, logger });
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  try {
    const compact = await startAgentRun(manager, agent.id, "/compact", logger, {
      replaceRunning: true,
    });
    expect(compact.disposition).toBe("out_of_band");
    const session = client.sessions[0]!;
    await waitFor(() => session.compactCalls === 1);

    // Before the provider's first marker: pi's compaction is out-of-band, so there is no turn
    // in flight and the prompt would otherwise reach pi and come back as a system error.
    const early = await startAgentRun(manager, agent.id, "early", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(early.disposition).toBe("held");

    session.startCompaction();
    const late = await startAgentRun(manager, agent.id, "late", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(late.disposition).toBe("held");
    expect(session.prompts).toEqual([]);

    // Only pi's own compaction end releases them; no turn boundary is involved at all.
    session.endCompaction();
    await waitFor(() => session.prompts.length === 2);
    expect(session.prompts).toEqual(["early", "late"]);
    // The compaction itself was never interrupted, and pi was asked to compact exactly once.
    expect(session.compactCalls).toBe(1);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("a prompt arriving while an earlier held prompt is still dispatching runs after it", async () => {
  const logger = createTestLogger();
  const client = new TurnCompactClient();
  const manager = new AgentManager({ clients: { claude: client }, logger });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    const session = client.sessions[0]!;
    await waitFor(() => session.prompts.length === 1);
    session.startCompaction();

    const first = await startAgentRun(manager, agent.id, "first", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    expect(first.disposition).toBe("held");

    // Release the gate with the compaction turn still running, and stall the held prompt inside
    // its own dispatch. The gate is now closed while an older prompt is still on its way.
    let finishInterrupt!: () => void;
    session.interruptGate = new Promise<void>((resolve) => {
      finishInterrupt = resolve;
    });
    session.endCompaction();
    await waitFor(() => session.interruptCount === 1);

    const second = await startAgentRun(manager, agent.id, "second", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
    });
    // Admission has to see the queue, not only the gate: otherwise this dispatches now and the
    // older prompt's replace then cancels it.
    expect(second.disposition).toBe("held");

    session.interruptGate = null;
    finishInterrupt();
    await waitFor(() => session.prompts.length === 3);
    expect(session.prompts).toEqual(["/compact", "first", "second"]);
  } finally {
    await manager.closeAgent(agent.id);
  }
});

test("closing the agent discards a held prompt and tells the client, keyed by clientMessageId", async () => {
  const logger = createTestLogger();
  const client = new TurnCompactClient();
  const manager = new AgentManager({ clients: { claude: client }, logger });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const discarded: { clientMessageId: string; reason: string }[] = [];
  const unsubscribe = manager.subscribe((event) => {
    if (event.type === "agent_stream" && event.event.type === "prompt_discarded") {
      discarded.push({
        clientMessageId: event.event.clientMessageId,
        reason: event.event.reason,
      });
    }
  });
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    const session = client.sessions[0]!;
    await waitFor(() => session.prompts.length === 1);
    session.startCompaction();

    const held = await startAgentRun(manager, agent.id, "follow up", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
      runOptions: { clientMessageId: "client-message-1" },
    });
    expect(held.disposition).toBe("held");

    await manager.closeAgent(agent.id);
    await waitFor(() => discarded.length === 1);

    expect(discarded[0]!.clientMessageId).toBe("client-message-1");
    expect(discarded[0]!.reason).toContain("the agent was closed");
    expect(session.prompts).toEqual(["/compact"]);
  } finally {
    unsubscribe();
  }
});

test("daemon shutdown discards a held prompt instead of dropping it silently", async () => {
  const logger = createTestLogger();
  const client = new TurnCompactClient();
  const manager = new AgentManager({ clients: { claude: client }, logger });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const discarded: string[] = [];
  const unsubscribe = manager.subscribe((event) => {
    if (event.type === "agent_stream" && event.event.type === "prompt_discarded") {
      discarded.push(event.event.clientMessageId);
    }
  });
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    const session = client.sessions[0]!;
    await waitFor(() => session.prompts.length === 1);
    session.startCompaction();

    const held = await startAgentRun(manager, agent.id, "follow up", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
      runOptions: { clientMessageId: "client-message-shutdown" },
    });
    expect(held.disposition).toBe("held");

    manager.prepareForShutdown();
    await waitFor(() => discarded.length === 1);
    expect(discarded).toEqual(["client-message-shutdown"]);
    expect(session.prompts).toEqual(["/compact"]);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
});

test("Stop discards the prompts held for the agent instead of starting them", async () => {
  const logger = createTestLogger();
  const client = new TurnCompactClient();
  const manager = new AgentManager({ clients: { claude: client }, logger });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const discarded: string[] = [];
  const unsubscribe = manager.subscribe((event) => {
    if (event.type === "agent_stream" && event.event.type === "prompt_discarded") {
      discarded.push(event.event.clientMessageId);
    }
  });
  try {
    await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
    const session = client.sessions[0]!;
    await waitFor(() => session.prompts.length === 1);
    session.startCompaction();

    const held = await startAgentRun(manager, agent.id, "follow up", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
      runOptions: { clientMessageId: "client-message-stop" },
    });
    expect(held.disposition).toBe("held");

    await cancelAgentRunCommand({ agentManager: manager, logger }, agent.id);
    session.endTurn();
    await waitFor(() => discarded.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(discarded).toEqual(["client-message-stop"]);
    // Stop means stop: no new turn started for the message that was waiting.
    expect(session.prompts).toEqual(["/compact"]);
    expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
  }
});

test("a compaction gate whose provider never marks an end or finishes a turn releases on the backstop", async () => {
  const logger = createTestLogger();
  const client = new OutOfBandCompactClient();
  const manager = new AgentManager({ clients: { pi: client }, logger });
  const agent = await manager.createAgent({ provider: "pi", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  const session = client.sessions[0]!;
  try {
    vi.useFakeTimers();
    try {
      await startAgentRun(manager, agent.id, "/compact", logger, { replaceRunning: true });
      await vi.advanceTimersByTimeAsync(1);
      // A `loading` marker the provider never terminalizes, on an out-of-band compaction that
      // runs with no turn at all — so neither a turn end nor the "no run in flight" valve can
      // ever release this gate. Only the backstop can.
      session.startCompaction();
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(true);

      const held = await startAgentRun(manager, agent.id, "follow up", logger, {
        replaceRunning: true,
        activeTurnBehavior: "interrupt",
      });
      expect(held.disposition).toBe("held");

      await vi.advanceTimersByTimeAsync(COMPACTION_GATE_BACKSTOP_MS - 1_000);
      expect(session.prompts).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(manager.isHoldingPromptsForCompaction(agent.id)).toBe(false);
      // Released, not stranded: the prompt reached the provider.
      expect(session.prompts).toEqual(["follow up"]);
    } finally {
      vi.useRealTimers();
    }
  } finally {
    await manager.closeAgent(agent.id);
  }
});

const OUT_OF_BAND_CAPABILITIES = CAPABILITIES;

/**
 * A provider whose `/compact` is out-of-band and runs with NO turn at all — pi's and OMP's shape.
 * The compaction markers are emitted by hand so a test can sit inside the window between the
 * `/compact` dispatch and the provider's first marker.
 */
class OutOfBandCompactSession implements AgentSession {
  readonly provider = "pi" as const;
  readonly capabilities = OUT_OF_BAND_CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: AgentPromptInput[] = [];
  interruptCount = 0;
  compactCalls = 0;
  /** Set when `/compact` must fail before the provider starts compacting. */
  failCompactImmediately = false;
  private emitOutOfBand: ((event: AgentStreamEvent) => void) | null = null;
  private turnCounter = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  tryHandleOutOfBand(prompt: AgentPromptInput) {
    if (prompt !== "/compact") return null;
    return {
      compaction: true,
      run: async ({ emit }: { emit: (event: AgentStreamEvent) => void }) => {
        this.compactCalls += 1;
        if (this.failCompactImmediately) {
          emit({
            type: "timeline",
            provider: this.provider,
            item: { type: "assistant_message", text: "[Error] Failed to compact context" },
          });
          return { compactionStarted: false };
        }
        this.emitOutOfBand = emit;
        return { compactionStarted: true };
      },
    };
  }

  startCompaction(): void {
    this.emitOutOfBand?.({
      type: "timeline",
      provider: this.provider,
      item: { type: "compaction", status: "loading", trigger: "manual" },
    });
  }

  endCompaction(): void {
    this.emitOutOfBand?.({
      type: "timeline",
      provider: this.provider,
      item: { type: "compaction", status: "completed", trigger: "manual" },
    });
    this.emitOutOfBand = null;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(prompt);
    const turnId = `turn-${++this.turnCounter}`;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  endTurn(): void {
    this.push({
      type: "turn_completed",
      provider: this.provider,
      turnId: `turn-${this.turnCounter}`,
    });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  async close(): Promise<void> {}
}

class OutOfBandCompactClient implements AgentClient {
  readonly provider = "pi" as const;
  readonly capabilities = OUT_OF_BAND_CAPABILITIES;
  readonly sessions: OutOfBandCompactSession[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new OutOfBandCompactSession();
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "pi-1", label: "Pi", isDefault: true }],
      modes: [],
    };
  }

  async resumeSession(_handle: unknown, config?: Partial<AgentSessionConfig>) {
    void config;
    return this.createSession();
  }
}

/**
 * A provider whose `/compact` is an ordinary prompt that starts a turn — Claude's shape. The
 * compaction marker is emitted only when the test asks for it.
 */
class TurnCompactSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: AgentPromptInput[] = [];
  interruptCount = 0;
  /** When set, `interrupt` waits on it, holding a replacing dispatch mid-flight. */
  interruptGate: Promise<void> | null = null;
  private turnCounter = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  isManualCompactionPrompt(prompt: AgentPromptInput): boolean {
    return prompt === "/compact";
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.prompts.push(prompt);
    const turnId = `turn-${++this.turnCounter}`;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  startCompaction(): void {
    this.push({
      type: "timeline",
      provider: this.provider,
      turnId: `turn-${this.turnCounter}`,
      item: { type: "compaction", status: "loading", trigger: "manual" },
    });
  }

  endCompaction(): void {
    this.push({
      type: "timeline",
      provider: this.provider,
      turnId: `turn-${this.turnCounter}`,
      item: { type: "compaction", status: "completed", trigger: "manual" },
    });
  }

  endTurn(): void {
    this.push({
      type: "turn_completed",
      provider: this.provider,
      turnId: `turn-${this.turnCounter}`,
    });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    if (this.interruptGate) {
      await this.interruptGate;
    }
    this.push({
      type: "turn_canceled",
      provider: this.provider,
      reason: "interrupted",
      turnId: `turn-${this.turnCounter}`,
    });
  }

  async close(): Promise<void> {}
}

class TurnCompactClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessions: TurnCompactSession[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new TurnCompactSession();
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "sonnet", label: "Sonnet", isDefault: true }],
      modes: [],
    };
  }

  async resumeSession(_handle: unknown, config?: Partial<AgentSessionConfig>) {
    void config;
    return this.createSession();
  }
}
