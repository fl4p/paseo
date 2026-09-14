import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type {
  Options,
  Query,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
import * as treeKill from "../../../../utils/tree-kill.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

function createChildProcessStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  // This fixture never starts an OS process; cleanup must observe that fact.
  child.exitCode = 0;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  return child;
}

describe("Claude spawn override", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each(["timeout", "error"])(
    "keeps the account unchanged if process termination is uncertain: %s",
    async (failure) => {
      const captured: Options[] = [];
      vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
      const terminate = vi.spyOn(treeKill, "terminateWithTreeKill");
      if (failure === "timeout") terminate.mockResolvedValue("kill-timeout");
      else terminate.mockRejectedValue(new Error("termination probe failed"));
      const expectedError =
        failure === "timeout" ? "Claude has not exited" : "termination probe failed";
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveBinary: async () => "/test/claude",
        queryFactory: ({ options }) => {
          captured.push(options);
          return createQueryMock([]);
        },
        providerParams: { accounts: { work: { label: "Work", configDir: "/tmp/claude-work" } } },
      });
      const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
      try {
        await session.listCommands?.();
        const launch = captured[0]?.spawnClaudeCodeProcess;
        if (!launch) throw new Error("No Claude process launcher");
        launch({
          command: "/test/claude",
          args: [],
          cwd: process.cwd(),
          env: {},
          signal: new AbortController().signal,
        });
        await expect(session.setFeature?.("account", "work")).rejects.toThrow(expectedError);
        expect(session.features).toContainEqual(
          expect.objectContaining({ id: "account", value: "default" }),
        );
        await expect(session.listCommands?.()).rejects.toThrow(expectedError);
      } finally {
        terminate.mockResolvedValue("already-exited");
        await session.close();
      }
    },
  );

  test("bypasses the shell when spawning Claude Code", async () => {
    let capturedOptions: Options | undefined;
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedOptions = options;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "claude-spawn-shell-regression-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          message: { content: "done" },
        },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
          total_cost_usd: 0,
        },
      ]);
    });
    const spawnSpy = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(createChildProcessStub());
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
    });

    try {
      await session.run("spawn shell regression");
      capturedOptions?.spawnClaudeCodeProcess?.({
        command: "node",
        args: ["claude.js", "--mcp-config", '{"mcpServers":{"paseo":{"type":"http"}}}'],
        cwd: process.cwd(),
        env: {},
        signal: new AbortController().signal,
      } satisfies ClaudeSpawnOptions);
    } finally {
      await session.close();
    }

    const claudeSpawnCall = spawnSpy.mock.calls.find(([, args]) => args[0] === "claude.js");
    expect(claudeSpawnCall).toBeDefined();
    const spawnOptions = claudeSpawnCall?.[2];
    expect(spawnOptions?.shell).toBe(false);
    expect(spawnOptions?.detached).toBe(process.platform !== "win32");
  });
});
