import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

const migrationTest = test.skipIf(process.platform === "win32");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function openQuery() {
  const pending: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let holdOutput = false;
  let delivered = 0;
  let closing: (() => void) | undefined;
  let returnError: Error | undefined;
  const close = () => {
    if (!closed) closing?.();
    closed = true;
    wake?.();
  };
  const query = {
    async next() {
      for (;;) {
        if (pending.length || (closed && !holdOutput)) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (pending.length) delivered++;
      return pending.length
        ? { done: false, value: pending.shift() }
        : { done: true, value: undefined };
    },
    async return() {
      close();
      if (returnError) throw returnError;
      return { done: true, value: undefined };
    },
    close,
    async interrupt() {},
    async supportedModels() {
      return [];
    },
    async supportedCommands() {
      return [];
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    query: query as unknown as Query,
    holdOutputOpen() {
      holdOutput = true;
    },
    get delivered() {
      return delivered;
    },
    beforeClose(callback: () => void) {
      closing = callback;
    },
    rejectReturn(error: Error) {
      returnError = error;
    },
    get closed() {
      return closed;
    },
    push(message: Record<string, unknown>) {
      pending.push(message as SDKMessage);
      wake?.();
    },
  };
}

async function fixture(
  transcript: string | null = JSON.stringify({
    type: "user",
    message: { content: "saved child context" },
  }),
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-migration-"));
  roots.push(root);
  const source = path.join(root, "source"),
    target = path.join(root, "target");
  const sourceId = "00000000-0000-4000-8000-000000000501";
  const project = claudeProjectDirSync(root, { configDir: source });
  const subagents = path.join(project, sourceId, "subagents");
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(
    path.join(project, `${sourceId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: "user-one",
      sessionId: sourceId,
      message: { content: "delegate" },
    }),
  );
  if (transcript !== null)
    await fs.writeFile(path.join(subagents, "agent-child123.jsonl"), transcript);
  await fs.writeFile(
    path.join(subagents, "agent-child123.meta.json"),
    JSON.stringify({ agentType: "general-purpose", toolUseId: "tool-child" }),
  );
  const channels = [openQuery(), openQuery(), openQuery()];
  const launches: ClaudeQueryInput[] = [];
  const events: { type: string; [key: string]: unknown }[] = [];
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: source } },
    providerParams: { accounts: { work: { label: "Work", configDir: target } } },
    resolveBinary: async () => "/test/claude",
    queryFactory(input) {
      launches.push(input);
      return channels[launches.length - 1]!.query;
    },
  });
  const session = await client.resumeSession({
    provider: "claude",
    sessionId: sourceId,
    metadata: { cwd: root },
  });
  session.subscribe((event) => {
    events.push(event);
  });
  await session.startTurn("delegate");
  channels[0]!.push({
    type: "system",
    subtype: "init",
    session_id: sourceId,
    permissionMode: "default",
  });
  channels[0]!.push({
    type: "system",
    subtype: "task_started",
    session_id: sourceId,
    task_id: "child123",
    tool_use_id: "tool-child",
    task_type: "local_agent",
    subagent_type: "general-purpose",
    is_backgrounded: true,
  });
  channels[0]!.push({
    type: "result",
    subtype: "success",
    session_id: sourceId,
    result: "launched",
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
  });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === "turn_completed")).toBe(true),
  );
  return { root, source, target, sourceId, client, session, channels, launches, events };
}

migrationTest(
  "switches a live background agent and submits recovery using its saved native ID",
  async () => {
    const f = await fixture();
    try {
      await f.session.setFeature?.("account", "work");
      expect(f.channels[0]!.closed).toBe(true);
      expect(f.launches).toHaveLength(2);
      expect(f.launches[1]!.options.env?.CLAUDE_CONFIG_DIR).toBe(f.target);
      const handle = f.session.describePersistence();
      expect(f.launches[1]!.options.resume).toBe(handle?.sessionId);
      const prompt = f.launches[1]!.prompt;
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      const recovery = await prompt[Symbol.asyncIterator]().next();
      expect(JSON.stringify(recovery.value)).toContain("child123");
      expect(JSON.stringify(recovery.value)).toContain("SendMessage");
      expect(JSON.stringify(recovery.value)).toContain("do not blindly repeat");
      const copied = path.join(
        claudeProjectDirSync(f.root, { configDir: f.target }),
        handle!.sessionId,
        "subagents",
        "agent-child123.jsonl",
      );
      expect(await fs.readFile(copied, "utf8")).toContain("saved child context");
      f.channels[1]!.push({
        type: "system",
        subtype: "task_started",
        task_id: "child123",
        tool_use_id: "tool-resume",
        task_type: "local_agent",
        subagent_type: "general-purpose",
        is_backgrounded: true,
      });
      await vi.waitFor(() =>
        expect(f.events).toContainEqual(
          expect.objectContaining({
            type: "provider_subagent",
            event: expect.objectContaining({ id: "tool-child", status: "running" }),
          }),
        ),
      );
    } finally {
      await f.session.close();
    }
  },
);

migrationTest.each([null, "", '{"type":"user","message":{"content":"ok"}}\n{broken'])(
  "does not stop work if a child transcript is unavailable: %s",
  async (transcript) => {
    const f = await fixture(transcript);
    try {
      await expect(f.session.setFeature?.("account", "work")).rejects.toThrow("saved transcript");
      expect(f.channels[0]!.closed).toBe(false);
      expect(f.session.describePersistence()?.sessionId).toBe(f.sourceId);
      expect(f.launches).toHaveLength(1);
    } finally {
      await f.session.close();
    }
  },
);

migrationTest.each(["local_bash", "local_workflow", "unknown"])(
  "does not kill or replay a running %s",
  async (task_type) => {
    const f = await fixture();
    try {
      f.channels[0]!.push({
        type: "system",
        subtype: "task_started",
        task_id: "other",
        tool_use_id: "tool-other",
        task_type,
        is_backgrounded: true,
      });
      // A following control-plane message proves the stream has processed the task announcement.
      f.channels[0]!.push({
        type: "system",
        subtype: "task_started",
        task_id: "marker",
        tool_use_id: "tool-marker",
        task_type: "local_agent",
        subagent_type: "general-purpose",
        is_backgrounded: true,
      });
      await vi.waitFor(() =>
        expect(f.events).toContainEqual(
          expect.objectContaining({
            type: "provider_subagent",
            event: expect.objectContaining({ id: "tool-marker" }),
          }),
        ),
      );
      await expect(f.session.setFeature?.("account", "work")).rejects.toThrow(
        "shell commands and workflows",
      );
      expect(f.channels[0]!.closed).toBe(false);
      expect(f.launches).toHaveLength(1);
    } finally {
      await f.session.close();
    }
  },
);

migrationTest(
  "requests recovery on the original account if the target cannot be written",
  async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.target, "not a directory");
      await expect(f.session.setFeature?.("account", "work")).rejects.toThrow("original account");
      expect(f.channels[0]!.closed).toBe(true);
      expect(f.session.describePersistence()?.sessionId).toBe(f.sourceId);
      expect(f.launches[1]!.options.env?.CLAUDE_CONFIG_DIR).toBe(f.source);
      const prompt = f.launches[1]!.prompt;
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      expect(JSON.stringify((await prompt[Symbol.asyncIterator]().next()).value)).toContain(
        "child123",
      );
    } finally {
      await f.session.close();
    }
  },
);

migrationTest.each([
  null,
  "{}",
  '{"agentType":"general-purpose","toolUseId":"tool-child","stoppedByUser":true}',
])("keeps work running if native resume metadata is invalid or stopped: %s", async (metadata) => {
  const f = await fixture();
  try {
    const metaPath = path.join(
      claudeProjectDirSync(f.root, { configDir: f.source }),
      f.sourceId,
      "subagents",
      "agent-child123.meta.json",
    );
    if (metadata === null) await fs.rm(metaPath);
    else await fs.writeFile(metaPath, metadata);
    await expect(f.session.setFeature?.("account", "work")).rejects.toThrow("saved transcript");
    expect(f.channels[0]!.closed).toBe(false);
  } finally {
    await f.session.close();
  }
});

migrationTest("recovers after confirmed process exit even when SDK return rejects", async () => {
  const f = await fixture();
  const spawn = f.launches[0]!.options.spawnClaudeCodeProcess;
  if (!spawn) throw new Error("Missing process launcher");
  const child = spawn({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: { ...process.env },
    cwd: f.root,
    signal: new AbortController().signal,
  });
  f.channels[0]!.rejectReturn(new Error("query shutdown failed"));
  try {
    await expect(f.session.setFeature?.("account", "work")).rejects.toThrow("original account");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(f.launches).toHaveLength(2);
    expect(f.launches[1]!.options.env?.CLAUDE_CONFIG_DIR).toBe(f.source);
  } finally {
    await f.session.close();
  }
});

migrationTest(
  "includes late children and reports shell tasks created while shutting down",
  async () => {
    const f = await fixture();
    try {
      const sidecars = path.join(
        claudeProjectDirSync(f.root, { configDir: f.source }),
        f.sourceId,
        "subagents",
      );
      await fs.copyFile(
        path.join(sidecars, "agent-child123.jsonl"),
        path.join(sidecars, "agent-late.jsonl"),
      );
      await fs.writeFile(
        path.join(sidecars, "agent-late.meta.json"),
        JSON.stringify({ agentType: "general-purpose", toolUseId: "late-tool" }),
      );
      f.channels[0]!.beforeClose(() => {
        f.channels[0]!.push({
          type: "system",
          subtype: "task_started",
          task_id: "late",
          tool_use_id: "late-tool",
          task_type: "local_agent",
          subagent_type: "general-purpose",
          is_backgrounded: true,
        });
        f.channels[0]!.push({
          type: "system",
          subtype: "task_started",
          task_id: "late-shell",
          tool_use_id: "shell-tool",
          task_type: "local_bash",
          is_backgrounded: true,
        });
      });
      await f.session.setFeature?.("account", "work");
      const prompt = f.launches[1]!.prompt;
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      const recovery = JSON.stringify((await prompt[Symbol.asyncIterator]().next()).value);
      expect(recovery).toContain("late");
      expect(recovery).toContain("late-shell");
      expect(recovery).toContain("do not restart those commands");
      expect(recovery).toContain("Do not resume or message descendants");
    } finally {
      await f.session.close();
    }
  },
);

migrationTest("reports a late shell even if the last agent completed during shutdown", async () => {
  const f = await fixture();
  try {
    f.channels[0]!.beforeClose(() => {
      f.channels[0]!.push({
        type: "system",
        subtype: "task_notification",
        task_id: "child123",
        tool_use_id: "tool-child",
        status: "completed",
        summary: "finished",
      });
      f.channels[0]!.push({
        type: "system",
        subtype: "task_started",
        task_id: "late-shell",
        tool_use_id: "shell-tool",
        task_type: "local_bash",
        is_backgrounded: true,
      });
    });
    await f.session.setFeature?.("account", "work");
    expect(f.launches).toHaveLength(2);
    const prompt = f.launches[1]!.prompt;
    if (typeof prompt === "string") throw new Error("Expected streaming input");
    const recovery = JSON.stringify((await prompt[Symbol.asyncIterator]().next()).value);
    expect(recovery).toContain("late-shell");
    expect(recovery).not.toContain("child123");
  } finally {
    await f.session.close();
  }
});

migrationTest("a timed out old pump cannot complete the new recovery turn", async () => {
  const f = await fixture();
  try {
    f.channels[0]!.holdOutputOpen();
    await expect(f.session.setFeature?.("account", "work")).rejects.toThrow("unverified");
    expect(f.launches).toHaveLength(2);
    const completed = f.events.filter((e) => e.type === "turn_completed").length;
    const delivered = f.channels[0]!.delivered;
    f.channels[0]!.push({
      type: "result",
      subtype: "success",
      result: "stale",
      usage: {},
      total_cost_usd: 0,
    });
    await vi.waitFor(() => expect(f.channels[0]!.delivered).toBeGreaterThan(delivered));
    expect(f.events.filter((e) => e.type === "turn_completed")).toHaveLength(completed);
    await expect(f.session.startTurn("another turn")).rejects.toThrow("already active");
  } finally {
    await f.session.close();
  }
});

migrationTest(
  "keeps recovery IDs through a quota failure, session reload, and another account switch",
  async () => {
    const f = await fixture();
    try {
      await f.session.setFeature?.("account", "work");
      expect(f.session.describePersistence()?.metadata?.claudeAccountRecovery).toEqual([
        "child123",
      ]);
      f.channels[1]!.push({
        type: "result",
        subtype: "error_during_execution",
        errors: ["quota exceeded"],
        usage: {},
        total_cost_usd: 0,
      });
      await vi.waitFor(() => expect(f.events.some((e) => e.type === "turn_failed")).toBe(true));
      const handle = f.session.describePersistence();
      if (!handle) throw new Error("Missing saved handle");
      await f.session.close();
      const reopened = await f.client.resumeSession(handle);
      try {
        await reopened.setFeature?.("account", "default");
        expect(f.launches).toHaveLength(3);
        const prompt = f.launches[2]!.prompt;
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        expect(JSON.stringify((await prompt[Symbol.asyncIterator]().next()).value)).toContain(
          "child123",
        );
        expect(reopened.describePersistence()?.metadata?.claudeAccountRecovery).toEqual([
          "child123",
        ]);
        f.channels[2]!.push({
          type: "system",
          subtype: "task_started",
          task_id: "child123",
          tool_use_id: "resumed-child",
          task_type: "local_agent",
          subagent_type: "general-purpose",
          is_backgrounded: true,
        });
        await vi.waitFor(() =>
          expect(reopened.describePersistence()?.metadata?.claudeAccountRecovery).toEqual([]),
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await f.session.close();
    }
  },
);

test.runIf(process.platform === "win32")(
  "refuses live migration without process-group ownership",
  async () => {
    const f = await fixture();
    try {
      await expect(f.session.setFeature?.("account", "work")).rejects.toThrow(
        "not supported on Windows",
      );
      expect(f.channels[0]!.closed).toBe(false);
    } finally {
      await f.session.close();
    }
  },
);
