import type { ChildProcess } from "node:child_process";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

/**
 * close() runs inside the daemon's 5 s close deadline. Every process enumeration it does may take
 * up to 5 s on its own, so close() needs one deadline across all of them, and a refresh that fails
 * must still end in a kill of the tree it already knows.
 */
const processTree = vi.hoisted(() => ({
  refresh: "real" as "real" | "fail" | "hang",
  terminate: "real" as "real" | "hang",
}));

vi.mock("../../../../utils/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../utils/process-tree.js")>();
  const never = () => new Promise<never>(() => {});
  return {
    ...actual,
    refreshProcessTree: async (snapshot: Parameters<typeof actual.refreshProcessTree>[0]) => {
      if (processTree.refresh === "fail") throw new Error("ps failed");
      if (processTree.refresh === "hang") return never();
      return actual.refreshProcessTree(snapshot);
    },
    terminateCapturedProcessTree: async (
      ...args: Parameters<typeof actual.terminateCapturedProcessTree>
    ) => {
      if (processTree.terminate === "hang") return never();
      return actual.terminateCapturedProcessTree(...args);
    },
  };
});

afterEach(() => {
  processTree.refresh = "real";
  processTree.terminate = "real";
});

function createQueryMock(): Query {
  return {
    next: vi.fn(async () => ({ done: true, value: undefined })),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

/** A Claude session whose process ignores SIGTERM and stays up until killed. */
async function startSessionWithStubbornProcess() {
  let spawn: (() => ChildProcess) | undefined;
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => process.execPath,
    queryFactory: ({ options }) => {
      spawn = () =>
        options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
          ],
          cwd: process.cwd(),
          env: process.env,
          signal: new AbortController().signal,
        }) as ChildProcess;
      return createQueryMock();
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  await session.listCommands?.();
  if (!spawn) throw new Error("Claude query was not created");
  const child = spawn();
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", () => resolve());
  });
  // Let the spawn-time tree capture finish, as it would for a session that has been running.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  return { session, child, exited };
}

function stillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

test.each(["fail", "hang"] as const)(
  "close() kills the known tree within its deadline when the refresh and kill %s",
  async (mode) => {
    const { session, child, exited } = await startSessionWithStubbornProcess();
    try {
      processTree.refresh = mode;
      processTree.terminate = mode === "hang" ? "hang" : "real";
      const started = Date.now();
      await session.close();
      // The daemon gives a close 5 s.
      expect(Date.now() - started).toBeLessThan(4_750);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      expect(stillRunning(child)).toBe(false);
    } finally {
      if (stillRunning(child)) child.kill("SIGKILL");
    }
  },
  15_000,
);
