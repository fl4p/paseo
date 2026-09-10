import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
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
  const deadline = Date.now() + 2_000;
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
