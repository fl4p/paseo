import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentLaunchContext } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import type { ClaudeQueryInput } from "./query.js";
import type { ClaudeOptions } from "./query.js";

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

describe("Claude SDK env", () => {
  test("the spawned process receives the selected account even when the SDK and launch context carry other credentials", async () => {
    const captured: ClaudeOptions[] = [];
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      resolveBinary: async () => "/test/claude",
      queryFactory: ({ options }) => {
        captured.push(options);
        return createQueryMock([]);
      },
      runtimeSettings: {
        env: { CLAUDE_CONFIG_DIR: "/tmp/provider-account", ANTHROPIC_API_KEY: "provider-test-key" },
      },
      providerParams: { accounts: { work: { label: "Work", configDir: "/tmp/selected-account" } } },
    });
    const session = await client.createSession(
      { provider: "claude", cwd: process.cwd(), featureValues: { account: "work" } },
      {
        env: {
          CLAUDE_CONFIG_DIR: "/tmp/launch-account",
          CLAUDE_CODE_OAUTH_TOKEN: "launch-test-token",
        },
      },
    );
    try {
      await session.listCommands?.();
      const options = captured[0];
      if (!options?.spawnClaudeCodeProcess) throw new Error("Missing Claude process launcher");
      const child = options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({configDir:process.env.CLAUDE_CONFIG_DIR,hasApiKey:!!process.env.ANTHROPIC_API_KEY,hasToken:!!process.env.CLAUDE_CODE_OAUTH_TOKEN}))",
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: "/tmp/sdk-account",
          ANTHROPIC_API_KEY: "sdk-test-key",
        },
        signal: new AbortController().signal,
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Child exited ${code}`));
        });
      });
      expect(JSON.parse(output)).toEqual({
        configDir: "/tmp/selected-account",
        hasApiKey: false,
        hasToken: false,
      });
    } finally {
      await session.close();
    }
  });

  test("forwards launch-context env through Claude process env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000201",
        PASEO_TEST_FLAG: "launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "managed-agent-env-session",
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

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      runtimeSettings: {
        env: {
          MCP_TIMEOUT: "claude-startup-timeout",
          MCP_TOOL_TIMEOUT: "claude-tool-timeout",
        },
      },
    });
    const session = await client.createSession(
      {
        provider: "claude",
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("env check");
      expect(result.sessionId).toBe("managed-agent-env-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
      expect(capturedEnv?.MCP_TIMEOUT).toBe("claude-startup-timeout");
      expect(capturedEnv?.MCP_TOOL_TIMEOUT).toBe("claude-tool-timeout");
    } finally {
      await session.close();
    }
  });

  test("forwards launch-context env through Claude resume env", async () => {
    let capturedEnv: Record<string, string | undefined> | undefined;
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000202",
        PASEO_TEST_FLAG: "resume-launch-value",
      },
    };
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      capturedEnv = options.env;
      return createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "persisted-session",
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

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "persisted-session",
        metadata: {
          cwd: process.cwd(),
        },
      },
      {
        cwd: process.cwd(),
      },
      launchContext,
    );

    try {
      const result = await session.run("resume env check");
      expect(result.sessionId).toBe("persisted-session");
      expect(capturedEnv?.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
      expect(capturedEnv?.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
    } finally {
      await session.close();
    }
  });
});
