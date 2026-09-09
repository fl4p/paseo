import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { forkAgentSessionNatively, type ForkAgentSessionDeps } from "./fork-agent-session.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

/**
 * The fork's rollback and the import's registration have to agree on what
 * "failed" means.
 *
 * `registerSession` inserts the agent into `AgentManager.agents` BEFORE two
 * awaited persistence writes. When the second one fails the fork request
 * reports an error and rolls back the branched transcript — so unless the
 * registration unwinds itself, a live agent record survives pointing at a file
 * that has just been deleted, and resuming it loses the provider history the
 * native fork exists to preserve.
 *
 * These tests drive the REAL `AgentManager.importProviderSession` (and so the
 * real `registerSession`) against a real `AgentStorage`, because the defect is
 * a property of that method's own failure handling. Only the provider client
 * and the "transcript" are fakes.
 */

const logger = pino({ level: "silent" });

const TEST_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

class ForkTestSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  closed = false;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => {};
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
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

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ForkTestClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly importedSessions: ForkTestSession[] = [];

  constructor(private readonly cwd: string) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new ForkTestSession(config);
  }

  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
      modes: [],
    };
  }

  async resumeSession(): Promise<AgentSession> {
    return new ForkTestSession({ provider: this.provider, cwd: this.cwd });
  }

  async importSession(input: { providerHandleId: string; cwd: string }) {
    const session = new ForkTestSession({ provider: this.provider, cwd: input.cwd });
    this.importedSessions.push(session);
    return {
      session,
      config: { provider: this.provider, cwd: input.cwd },
      persistence: {
        provider: this.provider,
        sessionId: input.providerHandleId,
        nativeHandle: input.providerHandleId,
        metadata: { provider: this.provider, cwd: input.cwd },
      },
      timeline: [
        {
          item: { type: "user_message" as const, text: "forked prompt" },
          timestamp: "2026-01-02T00:00:00.000Z",
        },
      ],
    };
  }
}

const SOURCE_CONFIG: AgentSessionConfig = {
  provider: "codex",
  cwd: "/replaced-in-beforeEach",
  model: "gpt-5.4",
};

const SOURCE_ROWS: AgentTimelineRow[] = [
  { seq: 1, timestamp: "2026-01-01T00:00:01.000Z", item: { type: "user_message", text: "task" } },
];

describe("a fork whose import fails after registering the agent", () => {
  let workdir: string;
  let storage: AgentStorage;
  let manager: AgentManager;
  let client: ForkTestClient;
  let deps: ForkAgentSessionDeps;
  let forkTranscriptPath: string;
  /** How many snapshot writes to let through before failing one. */
  let failSnapshotWriteNumber: number | null;
  let snapshotWrites: number;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "paseo-fork-rollback-"));
    storage = new AgentStorage(join(workdir, "agents"), logger);
    client = new ForkTestClient(workdir);
    manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

    snapshotWrites = 0;
    failSnapshotWriteNumber = null;
    const applySnapshot = storage.applySnapshot.bind(storage);
    storage.applySnapshot = async (agent, options) => {
      snapshotWrites += 1;
      if (snapshotWrites === failSnapshotWriteNumber) {
        throw new Error("snapshot store is full");
      }
      await applySnapshot(agent, options);
    };

    // Stand-in for the branched provider transcript: the fork creates it and
    // the rollback deletes it, which is exactly the file an orphaned agent
    // record would be left pointing at.
    forkTranscriptPath = join(workdir, "forked-session.jsonl");

    deps = {
      loadAgent: vi.fn(async () => ({
        cwd: workdir,
        workspaceId: undefined,
        config: { ...SOURCE_CONFIG, cwd: workdir },
      })),
      fetchTimeline: vi.fn(() => ({ epoch: "epoch-1", rows: SOURCE_ROWS })),
      hasInFlightRun: vi.fn(() => false),
      validateForkTarget: vi.fn(async () => {}),
      forkProviderSession: vi.fn(async () => {
        writeFileSync(forkTranscriptPath, '{"type":"user","uuid":"fork-1"}\n', "utf8");
        return { providerHandleId: "forked-session", provider: "codex" as const, cwd: workdir };
      }),
      importProviderSession: async (input) => {
        const imported = await manager.importProviderSession({
          provider: input.provider,
          providerHandleId: input.providerHandleId,
          cwd: input.cwd,
          workspaceId: input.workspaceId,
          config: input.config,
        });
        return {
          agentId: imported.id,
          timelineSize: manager.getTimeline(imported.id).length,
          createdWorkspace: null,
        };
      },
      registerCreatedWorkspace: vi.fn(async () => {}),
      deleteForkedProviderSession: vi.fn(async () => {
        if (existsSync(forkTranscriptPath)) {
          unlinkSync(forkTranscriptPath);
        }
      }),
      logger,
    };
  });

  afterEach(async () => {
    await manager.flushForShutdown().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });

  it("leaves no agent record behind when the second persistence write fails", async () => {
    // `registerSession` persists twice: once right after inserting the agent,
    // and once after the lifecycle reaches "idle". Fail the second one.
    failSnapshotWriteNumber = 2;

    await expect(
      forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-1" }, deps),
    ).rejects.toThrow("snapshot store is full");

    // Two writes were attempted, so the failure really landed on the second.
    expect(snapshotWrites).toBe(2);
    await manager.flush();
    await storage.flush();

    // No agent survives, in memory or on disk. Either one would be an agent
    // pointing at the transcript the rollback below deleted.
    expect(manager.listAgents()).toEqual([]);
    expect(await storage.list()).toEqual([]);
    // The provider session the failed registration owned is closed, not leaked.
    expect(client.importedSessions.map((session) => session.closed)).toEqual([true]);

    // And the rollback did delete the branch, so nothing offers it for import.
    expect(deps.deleteForkedProviderSession).toHaveBeenCalledWith("agent-source", {
      providerHandleId: "forked-session",
    });
    expect(existsSync(forkTranscriptPath)).toBe(false);
  });

  it("keeps the transcript when the agent survives", async () => {
    // The other half of the invariant: a rollback must never delete a
    // transcript an agent still points at.
    const result = await forkAgentSessionNatively(
      { agentId: "agent-source", requestId: "req-2" },
      deps,
    );

    expect(deps.deleteForkedProviderSession).not.toHaveBeenCalled();
    expect(existsSync(forkTranscriptPath)).toBe(true);
    expect(manager.listAgents().map((agent) => agent.id)).toEqual([result.agentId]);
  });
});
